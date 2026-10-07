import { describe, expect, it, vi } from 'vitest';
import {
  checkEligibility,
  classifyMergeableState,
  nextInterval,
  parseList,
  parsePullRequest,
  parseRepository,
  readInputs,
  runBypass,
  selectChecksToOverride,
  selectStatusesToOverride,
  waitForMergeable,
  type BackoffOptions,
  type BypassClient,
  type Clock,
  type Config,
  type PullRequestInfo,
} from './bypass.ts';

// A clock whose sleep() advances time instantly and records each requested delay.
function fakeClock(start = 0): Clock & { sleeps: number[] } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const BACKOFF: BackoffOptions = { timeoutMs: 60_000, initialIntervalMs: 1_000, maxIntervalMs: 5_000, backoffFactor: 2 };

const PR: PullRequestInfo = {
  number: 42,
  author: 'bot',
  headSha: 'sha1',
  labels: ['auto-merge-bypass'],
  state: 'open',
  triggerLabel: 'auto-merge-bypass',
  sender: 'bot',
};

const CONFIG: Config = { allowedUsers: ['bot'], allowedLabelers: ['bot', 'maintainer'], bypassLabel: 'auto-merge-bypass', requiredCommitStatuses: [], mergeMethod: 'squash' };

describe('parseList', () => {
  it('splits, trims, and drops empty entries', () => {
    expect(parseList(' a, b ,,c , ')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for an empty string', () => {
    expect(parseList('')).toEqual([]);
  });
});

describe('readInputs', () => {
  const base = { INPUT_TOKEN: 'tok', INPUT_ALLOWED_USERS: 'a, b' };

  it('applies defaults and falls back approve-token to token and allowed-labelers to allowed-users', () => {
    expect(readInputs(base)).toEqual({
      token: 'tok',
      approveToken: 'tok',
      allowedUsers: ['a', 'b'],
      allowedLabelers: ['a', 'b'],
      bypassLabel: 'auto-merge-bypass',
      requiredCommitStatuses: [],
      mergeMethod: 'squash',
    });
  });

  it('reads every provided input', () => {
    const inputs = readInputs({
      ...base,
      INPUT_APPROVE_TOKEN: 'approver',
      INPUT_ALLOWED_LABELERS: 'alice, bob',
      INPUT_BYPASS_LABEL: 'go',
      INPUT_REQUIRED_COMMIT_STATUSES: 'ci, lint',
      INPUT_MERGE_METHOD: 'rebase',
    });

    expect(inputs).toMatchObject({ approveToken: 'approver', allowedLabelers: ['alice', 'bob'], bypassLabel: 'go', requiredCommitStatuses: ['ci', 'lint'], mergeMethod: 'rebase' });
  });

  it.each(['INPUT_TOKEN', 'INPUT_ALLOWED_USERS'])('throws when %s is missing', (key) => {
    expect(() => readInputs({ ...base, [key]: '  ' })).toThrow(/is required/);
  });

  it('rejects an unknown merge method', () => {
    expect(() => readInputs({ ...base, INPUT_MERGE_METHOD: 'yolo' })).toThrow(/merge-method/);
  });
});

describe('parseRepository', () => {
  it('splits owner/repo', () => {
    expect(parseRepository('acme/widgets')).toEqual({ owner: 'acme', repo: 'widgets' });
  });

  it.each([undefined, '', 'acme', 'acme/', 'a/b/c'])('rejects %j', (value) => {
    expect(() => parseRepository(value)).toThrow(/GITHUB_REPOSITORY/);
  });
});

describe('parsePullRequest', () => {
  it('extracts the fields used by the action', () => {
    const event = {
      pull_request: { number: 5, user: { login: 'bot' }, head: { sha: 'abc' }, labels: [{ name: 'x' }, { name: 'y' }], state: 'open' },
      label: { name: 'y' },
      sender: { login: 'maintainer' },
    };

    expect(parsePullRequest(event)).toEqual({
      number: 5,
      author: 'bot',
      headSha: 'abc',
      labels: ['x', 'y'],
      state: 'open',
      triggerLabel: 'y',
      sender: 'maintainer',
    });
  });

  it('sets triggerLabel to null for non-labeled events', () => {
    const event = { pull_request: { number: 5, user: { login: 'bot' }, head: { sha: 'abc' }, labels: [], state: 'open' } };

    expect(parsePullRequest(event)?.triggerLabel).toBeNull();
  });

  it('returns null for non-PR events', () => {
    expect(parsePullRequest({ push: {} })).toBeNull();
  });
});

describe('checkEligibility', () => {
  it('accepts an open PR from an allowed user with the label', () => {
    expect(checkEligibility(PR, CONFIG)).toEqual({ eligible: true });
  });

  it('rejects a closed PR', () => {
    expect(checkEligibility({ ...PR, state: 'closed' }, CONFIG)).toEqual({ eligible: false, reason: expect.stringContaining('not open') });
  });

  it('rejects an author not in the allow list', () => {
    expect(checkEligibility({ ...PR, author: 'human' }, CONFIG)).toEqual({ eligible: false, reason: expect.stringContaining('"human"') });
  });

  it('rejects a PR missing the bypass label', () => {
    expect(checkEligibility({ ...PR, labels: ['other'] }, CONFIG)).toEqual({ eligible: false, reason: expect.stringContaining('label') });
  });

  it('rejects a run triggered by adding a different label', () => {
    expect(checkEligibility({ ...PR, labels: ['auto-merge-bypass', 'docs'], triggerLabel: 'docs' }, CONFIG)).toEqual({
      eligible: false,
      reason: expect.stringContaining('"docs"'),
    });
  });

  it('rejects a run not triggered by a labeled event', () => {
    expect(checkEligibility({ ...PR, triggerLabel: null }, CONFIG).eligible).toBe(false);
  });

  it('accepts the label being added by any allowed labeler', () => {
    expect(checkEligibility({ ...PR, sender: 'maintainer' }, CONFIG)).toEqual({ eligible: true });
  });

  it('rejects the label being added by someone not in the allowed labelers list', () => {
    expect(checkEligibility({ ...PR, sender: 'triager' }, CONFIG)).toEqual({ eligible: false, reason: expect.stringContaining('"triager"') });
  });

  it('matches the author case-sensitively', () => {
    expect(checkEligibility({ ...PR, author: 'BOT' }, CONFIG).eligible).toBe(false);
  });
});

describe('selectChecksToOverride', () => {
  it('keeps failing, pending, and in-progress runs but drops passing ones', () => {
    const runs = [
      { name: 'ok', status: 'completed', conclusion: 'success' },
      { name: 'skip', status: 'completed', conclusion: 'skipped' },
      { name: 'neutral', status: 'completed', conclusion: 'neutral' },
      { name: 'bad', status: 'completed', conclusion: 'failure' },
      { name: 'timeout', status: 'completed', conclusion: 'timed_out' },
      { name: 'running', status: 'in_progress', conclusion: null },
    ];

    expect(selectChecksToOverride(runs).map((r) => r.name)).toEqual(['bad', 'timeout', 'running']);
  });
});

describe('selectStatusesToOverride', () => {
  it('returns contexts for every non-success status', () => {
    const statuses = [
      { state: 'success', context: 'a' },
      { state: 'pending', context: 'b' },
      { state: 'failure', context: 'c' },
      { state: 'error', context: 'd' },
    ];

    expect(selectStatusesToOverride(statuses)).toEqual(['b', 'c', 'd']);
  });
});

describe('classifyMergeableState', () => {
  it.each([
    ['clean', 'ready'],
    ['unstable', 'ready'],
    ['has_hooks', 'ready'],
    ['dirty', 'fail'],
    ['behind', 'fail'],
    ['blocked', 'wait'],
    ['unknown', 'wait'],
    ['draft', 'wait'],
  ] as const)('%s -> %s', (state, verdict) => {
    expect(classifyMergeableState(state)).toBe(verdict);
  });
});

describe('nextInterval', () => {
  it('multiplies by the backoff factor', () => {
    expect(nextInterval(2_000, { backoffFactor: 1.5, maxIntervalMs: 120_000 })).toBe(3_000);
  });

  it('caps at the max interval', () => {
    expect(nextInterval(100_000, { backoffFactor: 1.5, maxIntervalMs: 120_000 })).toBe(120_000);
  });
});

describe('waitForMergeable', () => {
  function clientReturning(...states: string[]) {
    const getMergeableState = vi.fn<(n: number) => Promise<string>>();
    for (const s of states) getMergeableState.mockResolvedValueOnce(s);
    return { getMergeableState };
  }

  it('returns once the PR becomes ready, backing off between polls', async () => {
    const client = clientReturning('unknown', 'blocked', 'blocked', 'clean');
    const clock = fakeClock();

    await waitForMergeable(client, 42, { clock, backoff: BACKOFF });

    expect(client.getMergeableState).toHaveBeenCalledTimes(4);
    expect(client.getMergeableState).toHaveBeenCalledWith(42);
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000, 5_000]);
  });

  it('fails fast on a terminal state', async () => {
    const client = clientReturning('blocked', 'dirty');

    await expect(waitForMergeable(client, 42, { clock: fakeClock(), backoff: BACKOFF })).rejects.toThrow(/dirty/);
    expect(client.getMergeableState).toHaveBeenCalledTimes(2);
  });

  it('times out if the PR never becomes mergeable', async () => {
    const client = { getMergeableState: vi.fn(async () => 'blocked') };
    const clock = fakeClock(1_000_000);

    await expect(waitForMergeable(client, 42, { clock, backoff: BACKOFF })).rejects.toThrow(/Timed out after 1 minutes/);
    // Total slept time reaches the timeout without overshooting by more than one interval.
    const total = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(BACKOFF.timeoutMs);
    expect(total).toBeLessThan(BACKOFF.timeoutMs + BACKOFF.maxIntervalMs);
  });

  it('propagates API errors', async () => {
    const client = { getMergeableState: vi.fn().mockRejectedValue(new Error('boom')) };

    await expect(waitForMergeable(client, 42, { clock: fakeClock(), backoff: BACKOFF })).rejects.toThrow('boom');
  });
});

describe('runBypass', () => {
  function setup(overrides: Partial<BypassClient> = {}) {
    const calls: string[] = [];
    const record =
      <A extends unknown[], R>(name: string, result: R) =>
      async (...args: A) => {
        calls.push(`${name}(${args.join(',')})`);
        return result;
      };

    const client: BypassClient = {
      listCheckRuns: vi.fn(
        record('listCheckRuns', [
          { name: 'lint', status: 'completed', conclusion: 'failure' },
          { name: 'tests', status: 'completed', conclusion: 'success' },
          { name: 'build', status: 'in_progress', conclusion: null },
        ])
      ),
      createSuccessCheckRun: vi.fn(record('createSuccessCheckRun', undefined)),
      listCommitStatuses: vi.fn(
        record('listCommitStatuses', [
          { state: 'pending', context: 'ci/legacy' },
          { state: 'success', context: 'ci/ok' },
        ])
      ),
      createSuccessCommitStatus: vi.fn(record('createSuccessCommitStatus', undefined)),
      getPullRequest: vi.fn(record('getPullRequest', { state: 'open', labels: ['auto-merge-bypass'] })),
      getMergeableState: vi.fn(record('getMergeableState', 'clean')),
      mergePullRequest: vi.fn(record('mergePullRequest', { merged: true, sha: 'merged-sha', message: '' })),
      ...overrides,
    };
    const approveClient = { approvePullRequest: vi.fn(record('approvePullRequest', undefined)) };

    return { client, approveClient, calls, clock: fakeClock(), log: vi.fn() };
  }

  it('overrides checks and statuses, approves, waits, then merges — in that order', async () => {
    const deps = setup();

    const result = await runBypass({ ...deps, pr: PR, config: { ...CONFIG, requiredCommitStatuses: ['gate'] }, backoff: BACKOFF });

    expect(result).toEqual({ status: 'merged', sha: 'merged-sha' });
    expect(deps.calls).toEqual([
      'listCheckRuns(sha1)',
      'createSuccessCheckRun(lint,sha1)',
      'createSuccessCheckRun(build,sha1)',
      'listCommitStatuses(sha1)',
      'createSuccessCommitStatus(sha1,ci/legacy)',
      'createSuccessCommitStatus(sha1,gate)',
      'getPullRequest(42)',
      'approvePullRequest(42)',
      'getMergeableState(42)',
      'getPullRequest(42)',
      'mergePullRequest(42,squash)',
    ]);
  });

  it('uses the configured merge method', async () => {
    const deps = setup();

    await runBypass({ ...deps, pr: PR, config: { ...CONFIG, mergeMethod: 'rebase' }, backoff: BACKOFF });

    expect(deps.client.mergePullRequest).toHaveBeenCalledWith(42, 'rebase');
  });

  it.each([
    ['closed PR', { ...PR, state: 'closed' }],
    ['disallowed author', { ...PR, author: 'human' }],
    ['missing label', { ...PR, labels: [] }],
    ['different trigger label', { ...PR, triggerLabel: 'docs' }],
    ['disallowed labeler', { ...PR, sender: 'triager' }],
  ])('skips without touching the API for a %s', async (_, pr) => {
    const deps = setup();

    const result = await runBypass({ ...deps, pr, config: CONFIG, backoff: BACKOFF });

    expect(result.status).toBe('skipped');
    expect(deps.calls).toEqual([]);
  });

  it.each([
    ['the bypass label was removed', { state: 'open', labels: [] }],
    ['the PR was closed', { state: 'closed', labels: ['auto-merge-bypass'] }],
  ])('does not approve or merge if %s before approval', async (_, live) => {
    const deps = setup({ getPullRequest: vi.fn(async () => live) });

    const result = await runBypass({ ...deps, pr: PR, config: CONFIG, backoff: BACKOFF });

    expect(result.status).toBe('skipped');
    expect(deps.approveClient.approvePullRequest).not.toHaveBeenCalled();
    expect(deps.client.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['the bypass label was removed', { state: 'open', labels: ['other'] }],
    ['the PR was closed', { state: 'closed', labels: ['auto-merge-bypass'] }],
  ])('does not merge if %s while waiting', async (_, live) => {
    const getPullRequest = vi.fn().mockResolvedValueOnce({ state: 'open', labels: ['auto-merge-bypass'] }).mockResolvedValueOnce(live);
    const deps = setup({ getPullRequest });

    const result = await runBypass({ ...deps, pr: PR, config: CONFIG, backoff: BACKOFF });

    expect(result).toEqual({ status: 'skipped', reason: expect.any(String) });
    expect(deps.approveClient.approvePullRequest).toHaveBeenCalled();
    expect(deps.client.mergePullRequest).not.toHaveBeenCalled();
  });

  it('throws when the merge API reports merged: false', async () => {
    const deps = setup({ mergePullRequest: vi.fn(async () => ({ merged: false, sha: '', message: 'Base branch was modified' })) });

    await expect(runBypass({ ...deps, pr: PR, config: CONFIG, backoff: BACKOFF })).rejects.toThrow(/merge failed: Base branch was modified/);
  });

  it('does not merge when the PR ends up in a terminal state', async () => {
    const deps = setup({ getMergeableState: vi.fn(async () => 'dirty') });

    await expect(runBypass({ ...deps, pr: PR, config: CONFIG, backoff: BACKOFF })).rejects.toThrow(/dirty/);
    expect(deps.client.mergePullRequest).not.toHaveBeenCalled();
  });

  it('skips override calls when everything is already passing', async () => {
    const deps = setup({
      listCheckRuns: vi.fn(async () => [{ name: 'ok', status: 'completed', conclusion: 'success' }]),
      listCommitStatuses: vi.fn(async () => [{ state: 'success', context: 'ok' }]),
    });

    await runBypass({ ...deps, pr: PR, config: CONFIG, backoff: BACKOFF });

    expect(deps.client.createSuccessCheckRun).not.toHaveBeenCalled();
    expect(deps.client.createSuccessCommitStatus).not.toHaveBeenCalled();
    expect(deps.client.mergePullRequest).toHaveBeenCalled();
  });
});
