/**
 * tests/e2e/helpers/e2e-harness.ts
 * Spawns the built GitGuard MCP server over stdio and connects an official MCP client.
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { GitFixture } from '../../helpers/git-fixture.js';

export const PROJECT_ROOT = process.cwd();
/** Built by `pnpm build` (the pretest hook). */
export const SERVER_PATH = path.join(PROJECT_ROOT, 'dist', 'main.js');

export interface McpSession {
  client: Client;
  call<T = any>(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: T; text: string }>;
  close: () => Promise<void>;
}

/**
 * Spawns a real GitGuard MCP stdio server subprocess. TypeSafe HTTP calls are answered by a
 * preloaded fetch stub: question ids starting with `problem_` get "yes", all others "no".
 */
export async function spawnMcpClient(options: { serverPath?: string; withKey?: boolean } = {}): Promise<McpSession> {
  const env: Record<string, string> = {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(path.join(PROJECT_ROOT, 'tests', 'helpers', 'typesafe-fetch-preload.mjs')).href}`].filter(Boolean).join(' '),
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (options.withKey !== false) env.TYPESAFE_API_KEY = ['gitguard', 'e2e-test-key'].join('-');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.serverPath ?? SERVER_PATH],
    // The plugin launches the server from its own directory, never from the user's repository.
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env,
  });

  const client = new Client({ name: 'gitguard-e2e-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      return { isError: Boolean(result.isError), data: (result.structuredContent ?? {}) as any, text };
    },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

/**
 * Writes a .gitguard.yml with project commands disabled and commits it.
 */
export async function setupGitGuardRepo(fixture: GitFixture, extraYaml = ''): Promise<void> {
  await fixture.writeFile('.gitguard.yml', `version: 1
deterministic:
  test:
    enabled: false
  lint:
    enabled: false
  typecheck:
    enabled: false
${extraYaml}`);
  await fixture.writeFile('README.md', '# e2e fixture\n');
  await fixture.stage();
  await fixture.commit('initial');
}
