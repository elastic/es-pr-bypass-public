import { readFileSync } from 'fs';

// --- Actions I/O ---
// Env vars are set explicitly by the composite action step using INPUT_<UPPER_SNAKE> naming.

function getInput(name: string, required = false): string {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  const value = (process.env[key] ?? '').trim();
  if (required && !value) throw new Error(`Input '${name}' is required`);
  return value;
}

function info(msg: string): void {
  console.log(msg);
}

function setFailed(msg: string): void {
  console.error(`::error::${msg}`);
  process.exitCode = 1;
}

// --- GitHub REST API ---

interface RequestOptions {
  method?: string;
  body?: unknown;
}

async function githubFetch<T>(token: string, path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'elastic/es-pr-bypass',
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} responded ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

async function listCheckRuns(token: string, owner: string, repo: string, ref: string): Promise<CheckRun[]> {
  const runs: CheckRun[] = [];
  let page = 1;

  while (true) {
    const data = await githubFetch<{ total_count: number; check_runs: CheckRun[] }>(
      token,
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`
    );
    runs.push(...data.check_runs);
    if (runs.length >= data.total_count) break;
    page++;
  }

  return runs;
}

async function createSuccessCheckRun(token: string, owner: string, repo: string, name: string, headSha: string): Promise<void> {
  await githubFetch(token, `/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    body: {
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Bypassed', summary: 'This check was bypassed by the pr-bypass action.' },
    },
  });
}

async function createSuccessCommitStatus(
  token: string,
  owner: string,
  repo: string,
  sha: string,
  context: string
): Promise<void> {
  await githubFetch(token, `/repos/${owner}/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: { state: 'success', context, description: 'Bypassed by pr-bypass action.' },
  });
}

async function listNonSuccessfulCommitStatuses(
  token: string,
  owner: string,
  repo: string,
  sha: string
): Promise<string[]> {
  const data = await githubFetch<{
    state: string;
    statuses: Array<{ state: string; context: string }>;
  }>(token, `/repos/${owner}/${repo}/commits/${sha}/status`);

  return data.statuses.filter(s => s.state !== 'success').map(s => s.context);
}

async function approvePR(token: string, owner: string, repo: string, prNumber: number): Promise<void> {
  await githubFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
    method: 'POST',
    body: { event: 'APPROVE', body: 'Auto-approved by pr-bypass action.' },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// States where we can proceed to merge
const READY_STATES = new Set(['clean', 'unstable', 'has_hooks']);
// States that indicate a real problem that won't resolve by waiting
const TERMINAL_FAIL_STATES = new Set(['dirty', 'behind']);

async function waitForMergeable(token: string, owner: string, repo: string, prNumber: number): Promise<void> {
  const TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
  const INITIAL_INTERVAL_MS = 2_000;
  const MAX_INTERVAL_MS = 120_000;
  const BACKOFF_FACTOR = 1.5;

  const deadline = Date.now() + TIMEOUT_MS;
  let interval = INITIAL_INTERVAL_MS;

  while (Date.now() < deadline) {
    await sleep(interval);

    const pr = await githubFetch<{ mergeable: boolean | null; mergeable_state: string }>(token, `/repos/${owner}/${repo}/pulls/${prNumber}`);

    const { mergeable_state } = pr;

    if (READY_STATES.has(mergeable_state)) {
      info(`PR is ready to merge (mergeable_state: ${mergeable_state})`);
      return;
    }

    if (TERMINAL_FAIL_STATES.has(mergeable_state)) {
      throw new Error(`PR cannot be merged and will not recover (mergeable_state: ${mergeable_state})`);
    }

    // 'blocked', 'unknown', or anything else: GitHub is still processing — keep waiting
    const elapsed = Math.round((Date.now() - (deadline - TIMEOUT_MS)) / 1000);
    info(`Waiting for PR to become mergeable (mergeable_state: ${mergeable_state}, elapsed: ${elapsed}s)`);
    interval = Math.min(Math.round(interval * BACKOFF_FACTOR), MAX_INTERVAL_MS);
  }

  throw new Error('Timed out after 2 hours waiting for PR to become mergeable');
}

async function mergePR(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  mergeMethod: string
): Promise<{ merged: boolean; message: string; sha: string }> {
  return githubFetch(token, `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: { merge_method: mergeMethod },
  });
}

// --- Main ---

async function run(): Promise<void> {
  const token = getInput('token', true);
  const approveToken = getInput('approve-token') || token;
  const allowedUsers = getInput('allowed-users', true)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  const bypassLabel = getInput('bypass-label') || 'auto-merge-bypass';
  const requiredCommitStatuses = getInput('required-commit-statuses')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const mergeMethod = getInput('merge-method') || 'squash';

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));

  const pr = event.pull_request;
  if (!pr) {
    setFailed('This action must be triggered by a pull_request or pull_request_target event');
    return;
  }

  if (pr.state !== 'open') {
    info(`PR is not open (state: ${pr.state}). Skipping.`);
    return;
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  const prNumber: number = pr.number;
  const prAuthor: string = pr.user.login;
  const headSha: string = pr.head.sha;
  const labels: string[] = pr.labels.map((l: { name: string }) => l.name);

  info(`Evaluating PR #${prNumber} by ${prAuthor} — labels: [${labels.join(', ')}]`);

  if (!allowedUsers.includes(prAuthor)) {
    info(`Author "${prAuthor}" is not in the allowed users list. Skipping.`);
    return;
  }

  if (!labels.includes(bypassLabel)) {
    info(`Bypass label "${bypassLabel}" not found on PR. Skipping.`);
    return;
  }

  info(`Conditions met — proceeding with bypass merge for PR #${prNumber}`);

  const checkRuns = await listCheckRuns(token, owner, repo, headSha);
  info(`Found ${checkRuns.length} existing check run(s)`);

  const checksToOverride = checkRuns.filter((cr) => cr.conclusion !== 'success' && cr.conclusion !== 'skipped' && cr.conclusion !== 'neutral');

  if (checksToOverride.length > 0) {
    info(`Overriding ${checksToOverride.length} non-successful check run(s):`);
    for (const check of checksToOverride) {
      info(`  "${check.name}" (was: ${check.conclusion ?? check.status})`);
      await createSuccessCheckRun(token, owner, repo, check.name, headSha);
    }
  }

  const nonSuccessStatuses = await listNonSuccessfulCommitStatuses(token, owner, repo, headSha);
  if (nonSuccessStatuses.length > 0) {
    info(`Overriding ${nonSuccessStatuses.length} non-successful commit status(es):`);
    for (const context of nonSuccessStatuses) {
      info(`  "${context}"`);
      await createSuccessCommitStatus(token, owner, repo, headSha, context);
    }
  }

  if (requiredCommitStatuses.length > 0) {
    info(`Ensuring ${requiredCommitStatuses.length} required commit status(es) are successful:`);
    for (const context of requiredCommitStatuses) {
      info(`  "${context}"`);
      await createSuccessCommitStatus(token, owner, repo, headSha, context);
    }
  }

  info(`Waiting for PR #${prNumber} to become mergeable...`);
  await waitForMergeable(token, owner, repo, prNumber);

  info(`Approving PR #${prNumber}`);
  await approvePR(approveToken, owner, repo, prNumber);

  info(`Merging PR #${prNumber} (method: ${mergeMethod})`);
  const result = await mergePR(token, owner, repo, prNumber, mergeMethod);

  if (result.merged) {
    info(`PR #${prNumber} merged successfully — sha: ${result.sha}`);
  } else {
    setFailed(`PR #${prNumber} merge failed: ${result.message}`);
  }
}

run().catch((error) => {
  setFailed(error instanceof Error ? error.message : 'An unexpected error occurred');
});
