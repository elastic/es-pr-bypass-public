import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, type FetchFn } from './github.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeClient(...responses: Response[]) {
  const fetchFn = vi.fn<FetchFn>();
  for (const r of responses) fetchFn.mockResolvedValueOnce(r);
  return { client: new GitHubClient('tok', 'acme', 'widgets', fetchFn), fetchFn };
}

function call(fetchFn: ReturnType<typeof vi.fn<FetchFn>>, index = 0) {
  const [url, init] = fetchFn.mock.calls[index];
  return { url, init: init!, body: init?.body ? JSON.parse(init.body as string) : undefined };
}

describe('GitHubClient.request', () => {
  it('sends auth and API headers to the repo-scoped URL', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({ ok: true }));

    await client.request('GET', '/pulls/1');

    const { url, init } = call(fetchFn);
    expect(url).toBe('https://api.github.com/repos/acme/widgets/pulls/1');
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    expect(init.body).toBeUndefined();
  });

  it('throws with method, path, status and body on non-2xx responses', async () => {
    const { client } = makeClient(new Response('nope', { status: 403 }));

    await expect(client.request('POST', '/check-runs', {})).rejects.toThrow('GitHub API POST /check-runs responded 403: nope');
  });
});

describe('GitHubClient.listCheckRuns', () => {
  it('paginates until total_count is reached', async () => {
    const { client, fetchFn } = makeClient(
      jsonResponse({ total_count: 3, check_runs: [{ name: 'a' }, { name: 'b' }] }),
      jsonResponse({ total_count: 3, check_runs: [{ name: 'c' }] })
    );

    const runs = await client.listCheckRuns('abc123');

    expect(runs.map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(call(fetchFn, 0).url).toContain('/commits/abc123/check-runs?per_page=100&page=1');
    expect(call(fetchFn, 1).url).toContain('page=2');
  });

  it('stops on an empty page even if total_count disagrees', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({ total_count: 5, check_runs: [{ name: 'a' }] }), jsonResponse({ total_count: 5, check_runs: [] }));

    const runs = await client.listCheckRuns('abc123');

    expect(runs).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe('GitHubClient write endpoints', () => {
  it('createSuccessCheckRun posts a completed/success check run', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({}));

    await client.createSuccessCheckRun('lint', 'sha1');

    const { url, init, body } = call(fetchFn);
    expect(url).toMatch(/\/repos\/acme\/widgets\/check-runs$/);
    expect(init.method).toBe('POST');
    expect(body).toMatchObject({ name: 'lint', head_sha: 'sha1', status: 'completed', conclusion: 'success' });
  });

  it('createSuccessCommitStatus posts a success status for the context', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({}));

    await client.createSuccessCommitStatus('sha1', 'ci/build');

    const { url, body } = call(fetchFn);
    expect(url).toMatch(/\/statuses\/sha1$/);
    expect(body).toMatchObject({ state: 'success', context: 'ci/build' });
  });

  it('approvePullRequest submits an APPROVE review', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({}));

    await client.approvePullRequest(7);

    const { url, body } = call(fetchFn);
    expect(url).toMatch(/\/pulls\/7\/reviews$/);
    expect(body).toMatchObject({ event: 'APPROVE' });
  });

  it('mergePullRequest PUTs the merge method and returns the result', async () => {
    const { client, fetchFn } = makeClient(jsonResponse({ merged: true, sha: 'm1', message: 'ok' }));

    const result = await client.mergePullRequest(7, 'rebase');

    const { url, init, body } = call(fetchFn);
    expect(url).toMatch(/\/pulls\/7\/merge$/);
    expect(init.method).toBe('PUT');
    expect(body).toEqual({ merge_method: 'rebase' });
    expect(result).toEqual({ merged: true, sha: 'm1', message: 'ok' });
  });
});

describe('GitHubClient read endpoints', () => {
  it('listCommitStatuses returns the combined status entries', async () => {
    const statuses = [{ state: 'failure', context: 'ci' }];
    const { client, fetchFn } = makeClient(jsonResponse({ state: 'failure', statuses }));

    expect(await client.listCommitStatuses('sha1')).toEqual(statuses);
    expect(call(fetchFn).url).toMatch(/\/commits\/sha1\/status$/);
  });

  it('getMergeableState returns mergeable_state from the PR', async () => {
    const { client } = makeClient(jsonResponse({ mergeable: true, mergeable_state: 'clean' }));

    expect(await client.getMergeableState(7)).toBe('clean');
  });
});
