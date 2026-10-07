// Minimal GitHub REST client. `fetch` is injectable so tests can stub the network.

export type FetchFn = typeof fetch;

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CommitStatus {
  state: string;
  context: string;
}

export interface MergeResult {
  merged: boolean;
  message: string;
  sha: string;
}

export interface LivePullRequest {
  state: string;
  labels: string[];
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export class GitHubClient {
  readonly #token: string;
  readonly #owner: string;
  readonly #repo: string;
  readonly #fetch: FetchFn;
  readonly #baseUrl: string;

  constructor(token: string, owner: string, repo: string, fetchFn: FetchFn = fetch, baseUrl = 'https://api.github.com') {
    this.#token = token;
    this.#owner = owner;
    this.#repo = repo;
    this.#fetch = fetchFn;
    this.#baseUrl = baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}/repos/${this.#owner}/${this.#repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'elastic/es-pr-bypass',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} responded ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async listCheckRuns(ref: string): Promise<CheckRun[]> {
    const runs: CheckRun[] = [];
    let page = 1;

    while (true) {
      const data = await this.request<{ total_count: number; check_runs: CheckRun[] }>(
        'GET',
        `/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`
      );
      runs.push(...data.check_runs);
      if (data.check_runs.length === 0 || runs.length >= data.total_count) break;
      page++;
    }

    return runs;
  }

  async createSuccessCheckRun(name: string, headSha: string): Promise<void> {
    await this.request('POST', '/check-runs', {
      name,
      head_sha: headSha,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'Bypassed', summary: 'This check was bypassed by the pr-bypass action.' },
    });
  }

  async listCommitStatuses(sha: string): Promise<CommitStatus[]> {
    const data = await this.request<{ statuses: CommitStatus[] }>('GET', `/commits/${sha}/status`);
    return data.statuses;
  }

  async createSuccessCommitStatus(sha: string, context: string): Promise<void> {
    await this.request('POST', `/statuses/${sha}`, {
      state: 'success',
      context,
      description: 'Bypassed by pr-bypass action.',
    });
  }

  async getPullRequest(prNumber: number): Promise<LivePullRequest> {
    const pr = await this.request<{ state: string; labels: { name: string }[] }>('GET', `/pulls/${prNumber}`);
    return { state: pr.state, labels: pr.labels.map((l) => l.name) };
  }

  async getMergeableState(prNumber: number): Promise<string> {
    const pr = await this.request<{ mergeable_state: string }>('GET', `/pulls/${prNumber}`);
    return pr.mergeable_state;
  }

  async approvePullRequest(prNumber: number): Promise<void> {
    await this.request('POST', `/pulls/${prNumber}/reviews`, {
      event: 'APPROVE',
      body: 'Auto-approved by pr-bypass action.',
    });
  }

  async mergePullRequest(prNumber: number, mergeMethod: MergeMethod): Promise<MergeResult> {
    return this.request('PUT', `/pulls/${prNumber}/merge`, { merge_method: mergeMethod });
  }
}
