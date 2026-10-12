#!/usr/bin/env node
/**
 * Smoke test for the committed plugin bundle: start it over stdio from the plugin's
 * server directory (as Codex does), list tools, and run a question-free check on a temp repo.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = path.join(repoRoot, 'plugins', 'gitguard', 'server');
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-bundle-smoke-'));
const git = (args) => execFileSync('git', args, { cwd: tempDir, windowsHide: true });

const env = { PATH: process.env.PATH ?? '' };
if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['gitguard-mcp.mjs'],
  cwd: serverDir,
  env,
  stderr: 'pipe',
});
const client = new Client({ name: 'gitguard-bundle-smoke', version: '1.0.0' }, { capabilities: {} });

try {
  git(['init', '-q']);
  git(['config', 'user.email', 'smoke@example.invalid']);
  git(['config', 'user.name', 'GitGuard Smoke']);
  await fs.writeFile(path.join(tempDir, 'README.md'), '# smoke\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  await fs.writeFile(path.join(tempDir, 'app.js'), 'export const value = 1;\n');

  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, packageJson.version);
  assert.match(client.getInstructions() ?? '', /GitGuard/);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['check', 'verify']);

  const result = await client.callTool({ name: 'check', arguments: { cwd: tempDir } });
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.equal(result.structuredContent.status, 'PASS');
  assert.equal(result.structuredContent.diffSummary.filesChanged, 1);

  process.stdout.write(`Bundle smoke test passed (GitGuard ${packageJson.version}).\n`);
} finally {
  await client.close().catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
