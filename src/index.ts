import { readFileSync } from 'node:fs';
import { parsePullRequest, parseRepository, readInputs, runBypass } from './bypass.ts';
import { GitHubClient } from './github.ts';

async function main(): Promise<void> {
  const inputs = readInputs(process.env);

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');
  const pr = parsePullRequest(JSON.parse(readFileSync(eventPath, 'utf8')));
  if (!pr) throw new Error('This action must be triggered by a pull_request or pull_request_target event');

  const { owner, repo } = parseRepository(process.env.GITHUB_REPOSITORY);

  await runBypass({
    client: new GitHubClient(inputs.token, owner, repo),
    approveClient: new GitHubClient(inputs.approveToken, owner, repo),
    pr,
    config: inputs,
    log: console.log,
  });
}

main().catch((error) => {
  console.error(`::error::${error instanceof Error ? error.message : 'An unexpected error occurred'}`);
  process.exitCode = 1;
});
