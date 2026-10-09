import type { CheckRun, CommitStatus, GitHubClient, MergeMethod } from './github.ts';

// --- Inputs ---

export interface Config {
  allowedUsers: string[];
  // Users permitted to add the bypass label (the event sender).
  allowedLabelers: string[];
  bypassLabel: string;
  requiredCommitStatuses: string[];
  mergeMethod: MergeMethod;
}

export interface Inputs extends Config {
  token: string;
  approveToken: string;
}

const MERGE_METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase'];

export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// Env vars are set explicitly by the composite action step using INPUT_<UPPER_SNAKE> naming.
export function getInput(env: NodeJS.ProcessEnv, name: string, required = false): string {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const value = (env[key] ?? '').trim();
  if (required && !value) throw new Error(`Input '${name}' is required`);
  return value;
}

export function readInputs(env: NodeJS.ProcessEnv): Inputs {
  const token = getInput(env, 'token', true);
  const mergeMethod = getInput(env, 'merge-method') || 'squash';
  if (!MERGE_METHODS.includes(mergeMethod as MergeMethod)) {
    throw new Error(`Input 'merge-method' must be one of ${MERGE_METHODS.join(', ')} (got "${mergeMethod}")`);
  }

  const allowedUsers = parseList(getInput(env, 'allowed-users', true));
  const allowedLabelers = parseList(getInput(env, 'allowed-labelers'));

  return {
    token,
    approveToken: getInput(env, 'approve-token') || token,
    allowedUsers,
    allowedLabelers: allowedLabelers.length > 0 ? allowedLabelers : allowedUsers,
    bypassLabel: getInput(env, 'bypass-label') || 'auto-merge-bypass',
    requiredCommitStatuses: parseList(getInput(env, 'required-commit-statuses')),
    mergeMethod: mergeMethod as MergeMethod,
  };
}

export function parseRepository(value: string | undefined): { owner: string; repo: string } {
  const [owner, repo, ...rest] = (value ?? '').split('/');
  if (!owner || !repo || rest.length > 0) throw new Error(`GITHUB_REPOSITORY is invalid: "${value ?? ''}"`);
  return { owner, repo };
}

// --- Pull request evaluation ---

export interface PullRequestInfo {
  number: number;
  author: string;
  headSha: string;
  labels: string[];
  state: string;
  // Label whose addition triggered this run (`event.label`), or null for non-labeled events.
  triggerLabel: string | null;
  // User who triggered this run (`event.sender`), i.e. who added the label.
  sender: string;
}

export function parsePullRequest(event: any): PullRequestInfo | null {
  const pr = event?.pull_request;
  if (!pr) return null;
  return {
    number: pr.number,
    author: pr.user.login,
    headSha: pr.head.sha,
    labels: (pr.labels ?? []).map((l: { name: string }) => l.name),
    state: pr.state,
    triggerLabel: event.label?.name ?? null,
    sender: event.sender?.login ?? '',
  };
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string };

export type EligibilityConfig = Pick<Config, 'allowedUsers' | 'allowedLabelers' | 'bypassLabel'>;

export function checkEligibility(pr: PullRequestInfo, config: EligibilityConfig): Eligibility {
  if (pr.state !== 'open') {
    return { eligible: false, reason: `PR is not open (state: ${pr.state})` };
  }
  if (!config.allowedUsers.includes(pr.author)) {
    return { eligible: false, reason: `Author "${pr.author}" is not in the allowed users list` };
  }
  if (!pr.labels.includes(config.bypassLabel)) {
    return { eligible: false, reason: `Bypass label "${config.bypassLabel}" not found on PR` };
  }
  // Only the act of adding the bypass label may trigger a bypass. Otherwise, while the label is present,
  // adding any other label would re-run the bypass against whatever commit is now at the head.
  if (pr.triggerLabel !== config.bypassLabel) {
    return { eligible: false, reason: `Run was not triggered by adding the bypass label (trigger label: "${pr.triggerLabel ?? 'none'}")` };
  }
  if (!config.allowedLabelers.includes(pr.sender)) {
    return { eligible: false, reason: `Bypass label was added by "${pr.sender}", who is not in the allowed labelers list` };
  }
  return { eligible: true };
}

const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export function selectChecksToOverride(runs: CheckRun[]): CheckRun[] {
  return runs.filter((cr) => !PASSING_CHECK_CONCLUSIONS.has(cr.conclusion ?? ''));
}

export function selectStatusesToOverride(statuses: CommitStatus[]): string[] {
  return statuses.filter((s) => s.state !== 'success').map((s) => s.context);
}

// The event payload is a snapshot from when the label was added. Re-check against the live PR so that removing
// the label, closing the PR, or pushing a new commit cancels an in-flight bypass.
export async function recheckEligibility(
  client: Pick<GitHubClient, 'getPullRequest'>,
  pr: PullRequestInfo,
  config: EligibilityConfig
): Promise<Eligibility> {
  const live = await client.getPullRequest(pr.number);
  // The label authorized the commit that was at the head when it was added — never anything pushed afterwards.
  if (live.headSha !== pr.headSha) {
    return { eligible: false, reason: `PR head moved from ${pr.headSha} to ${live.headSha} after the bypass label was added` };
  }
  return checkEligibility({ ...pr, state: live.state, labels: live.labels }, config);
}

// --- Waiting for mergeability ---

// States where we can proceed to merge
const READY_STATES = new Set(['clean', 'unstable', 'has_hooks']);
// States that indicate a real problem that won't resolve by waiting
const TERMINAL_FAIL_STATES = new Set(['dirty', 'behind']);

export type MergeableVerdict = 'ready' | 'fail' | 'wait';

export function classifyMergeableState(state: string): MergeableVerdict {
  if (READY_STATES.has(state)) return 'ready';
  if (TERMINAL_FAIL_STATES.has(state)) return 'fail';
  // 'blocked', 'unknown', or anything else: GitHub is still processing — keep waiting
  return 'wait';
}

export interface BackoffOptions {
  timeoutMs: number;
  initialIntervalMs: number;
  maxIntervalMs: number;
  backoffFactor: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  timeoutMs: 2 * 60 * 60 * 1000, // 2 hours
  initialIntervalMs: 2_000,
  maxIntervalMs: 120_000,
  backoffFactor: 1.5,
};

export function nextInterval(current: number, options: Pick<BackoffOptions, 'maxIntervalMs' | 'backoffFactor'>): number {
  return Math.min(Math.round(current * options.backoffFactor), options.maxIntervalMs);
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type Logger = (msg: string) => void;

export async function waitForMergeable(
  client: Pick<GitHubClient, 'getMergeableState'>,
  prNumber: number,
  { clock = systemClock, log = () => {}, backoff = DEFAULT_BACKOFF }: { clock?: Clock; log?: Logger; backoff?: BackoffOptions } = {}
): Promise<void> {
  const start = clock.now();
  const deadline = start + backoff.timeoutMs;
  let interval = backoff.initialIntervalMs;

  while (clock.now() < deadline) {
    await clock.sleep(interval);

    const state = await client.getMergeableState(prNumber);
    const verdict = classifyMergeableState(state);

    if (verdict === 'ready') {
      log(`PR is ready to merge (mergeable_state: ${state})`);
      return;
    }
    if (verdict === 'fail') {
      throw new Error(`PR cannot be merged and will not recover (mergeable_state: ${state})`);
    }

    const elapsed = Math.round((clock.now() - start) / 1000);
    log(`Waiting for PR to become mergeable (mergeable_state: ${state}, elapsed: ${elapsed}s)`);
    interval = nextInterval(interval, backoff);
  }

  throw new Error(`Timed out after ${Math.round(backoff.timeoutMs / 60_000)} minutes waiting for PR to become mergeable`);
}

// --- Orchestration ---

export type BypassClient = Pick<
  GitHubClient,
  'listCheckRuns' | 'createSuccessCheckRun' | 'listCommitStatuses' | 'createSuccessCommitStatus' | 'getPullRequest' | 'getMergeableState' | 'mergePullRequest'
>;

export interface BypassDeps {
  client: BypassClient;
  // Used only for the approval, so the approver identity can differ from `client`.
  approveClient: Pick<GitHubClient, 'approvePullRequest'>;
  pr: PullRequestInfo;
  config: Config;
  log?: Logger;
  clock?: Clock;
  backoff?: BackoffOptions;
}

export type BypassResult = { status: 'skipped'; reason: string } | { status: 'merged'; sha: string };

export async function runBypass({ client, approveClient, pr, config, log = () => {}, clock, backoff }: BypassDeps): Promise<BypassResult> {
  log(`Evaluating PR #${pr.number} by ${pr.author}, labeled by ${pr.sender} — labels: [${pr.labels.join(', ')}]`);

  const eligibility = checkEligibility(pr, config);
  if (!eligibility.eligible) {
    log(`${eligibility.reason}. Skipping.`);
    return { status: 'skipped', reason: eligibility.reason };
  }

  log(`Conditions met — proceeding with bypass merge for PR #${pr.number}`);

  const checkRuns = await client.listCheckRuns(pr.headSha);
  log(`Found ${checkRuns.length} existing check run(s)`);

  const checksToOverride = selectChecksToOverride(checkRuns);
  if (checksToOverride.length > 0) {
    log(`Overriding ${checksToOverride.length} non-successful check run(s):`);
    for (const check of checksToOverride) {
      log(`  "${check.name}" (was: ${check.conclusion ?? check.status})`);
      await client.createSuccessCheckRun(check.name, pr.headSha);
    }
  }

  const statusesToOverride = selectStatusesToOverride(await client.listCommitStatuses(pr.headSha));
  if (statusesToOverride.length > 0) {
    log(`Overriding ${statusesToOverride.length} non-successful commit status(es):`);
    for (const context of statusesToOverride) {
      log(`  "${context}"`);
      await client.createSuccessCommitStatus(pr.headSha, context);
    }
  }

  if (config.requiredCommitStatuses.length > 0) {
    log(`Ensuring ${config.requiredCommitStatuses.length} required commit status(es) are successful:`);
    for (const context of config.requiredCommitStatuses) {
      log(`  "${context}"`);
      await client.createSuccessCommitStatus(pr.headSha, context);
    }
  }

  const beforeApprove = await recheckEligibility(client, pr, config);
  if (!beforeApprove.eligible) {
    log(`${beforeApprove.reason}. Aborting before approval.`);
    return { status: 'skipped', reason: beforeApprove.reason };
  }

  log(`Approving PR #${pr.number}`);
  await approveClient.approvePullRequest(pr.number, pr.headSha);

  log(`Waiting for PR #${pr.number} to become mergeable...`);
  await waitForMergeable(client, pr.number, { clock, log, backoff });

  const beforeMerge = await recheckEligibility(client, pr, config);
  if (!beforeMerge.eligible) {
    log(`${beforeMerge.reason}. Aborting before merge.`);
    return { status: 'skipped', reason: beforeMerge.reason };
  }

  log(`Merging PR #${pr.number} (method: ${config.mergeMethod})`);
  const result = await client.mergePullRequest(pr.number, config.mergeMethod, pr.headSha);
  if (!result.merged) {
    throw new Error(`PR #${pr.number} merge failed: ${result.message}`);
  }

  log(`PR #${pr.number} merged successfully — sha: ${result.sha}`);
  return { status: 'merged', sha: result.sha };
}
