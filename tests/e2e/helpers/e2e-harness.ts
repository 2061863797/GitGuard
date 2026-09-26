/**
 * tests/e2e/helpers/e2e-harness.ts
 * Shared E2E runner, process spawner, and MCP stdio client helper.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTempGitRepo, GitFixture } from '../../helpers/git-fixture.js';

const execFileAsync = promisify(execFile);
export const PROJECT_ROOT = process.cwd();
export const BIN_PATH = path.join(PROJECT_ROOT, 'bin', 'gitguard.js');

export interface CliOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  json<T = any>(): T;
}

export interface RunCliOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Spawns GitGuard CLI as an opaque external process and captures stdout/stderr/exitCode.
 */
export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliOutcome> {
  const cwd = options.cwd || PROJECT_ROOT;
  const timeout = options.timeoutMs ?? 20000;

  try {
    const res = await execFileAsync(process.execPath, [BIN_PATH, ...args], {
      cwd,
      timeout,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: 'C',
        ...options.env,
      },
    });

    const stdout = res.stdout.toString();
    const stderr = res.stderr.toString();

    return {
      stdout,
      stderr,
      exitCode: 0,
      json<T>(): T {
        return JSON.parse(stdout);
      },
    };
  } catch (err: any) {
    const stdout = err.stdout ? err.stdout.toString() : '';
    const stderr = err.stderr ? err.stderr.toString() : err.message || '';
    const exitCode = typeof err.code === 'number' ? err.code : 1;

    return {
      stdout,
      stderr,
      exitCode,
      json<T>(): T {
        return JSON.parse(stdout);
      },
    };
  }
}

export interface McpSession {
  client: Client;
  transport: StdioClientTransport;
  close: () => Promise<void>;
}

/**
 * Spawns a real GitGuard MCP stdio server subprocess and connects an official MCP Client.
 */
export async function spawnMcpClient(cwd: string = PROJECT_ROOT): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN_PATH, 'mcp'],
    cwd,
    stderr: 'pipe',
    env: {
      TYPESAFE_API_KEY: ['gitguard', 'e2e-test-key'].join('-'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(path.join(PROJECT_ROOT, 'tests', 'helpers', 'typesafe-fetch-preload.mjs')).href}`].filter(Boolean).join(' '),
    },
  });

  const client = new Client(
    { name: 'gitguard-e2e-client', version: '1.0.0' },
    { capabilities: {} }
  );

  await client.connect(transport);

  return {
    client,
    transport,
    async close() {
      try {
        await client.close();
      } catch {
        // ignore
      }
      try {
        await transport.close();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Helper to configure a temporary repository with deterministic checks disabled or mocked
 * to allow pure semantic / secret testing without failing external package runners.
 */
export async function setupGitGuardRepo(
  fixture: GitFixture,
  customConfig?: string
): Promise<void> {
  const defaultConfig = `
version: 1
deterministic:
  test:
    enabled: false
  lint:
    enabled: false
  typecheck:
    enabled: false
  secret_scan:
    enabled: true
    block_on_detection: true
rules:
  task_completed:
    enabled: true
    review_below: 0.6
    block_below: 0.2
  unrelated_changes:
    enabled: true
    warn: 0.55
    review: 0.75
    block: 0.95
  tests_required:
    enabled: true
    warn: 0.6
    review: 0.8
  security_sensitive:
    enabled: true
    warn: 0.5
    review: 0.65
    block: 0.9
`;

  await fixture.writeFile('.gitguard.yml', customConfig || defaultConfig);
  await fixture.stage('.gitguard.yml');
  await fixture.commit('chore: initialize gitguard configuration');
}

export { createTempGitRepo, GitFixture };
