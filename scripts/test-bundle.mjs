#!/usr/bin/env node
/**
 * Smoke test for the committed plugin bundles: start the MCP server over stdio from the plugin's
 * server directory (as Codex does), list tools, run a rule-free check on a temp repo, confirm the
 * check installs a working Git pre-commit hook, and run the PreToolUse guard from hooks/hooks.json.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

  // Opting in with a .gitguard.yml makes the next check install the Git pre-commit hook from the bundle.
  await fs.writeFile(path.join(tempDir, '.gitguard.yml'), 'version: 1\n');
  const optedIn = await client.callTool({ name: 'check', arguments: { cwd: tempDir } });
  assert.match(String(optedIn.structuredContent.metadata.commitHook), /^installed/, JSON.stringify(optedIn.structuredContent.metadata));
  await fs.writeFile(path.join(tempDir, 'unchecked.js'), 'export const later = 2;\n');
  git(['add', '-A']);
  const commit = spawnSync('git', ['commit', '-m', 'x'], { cwd: tempDir, encoding: 'utf8', windowsHide: true });
  assert.notEqual(commit.status, 0, 'the pre-commit hook must reject unchecked content');
  assert.match(`${commit.stdout}${commit.stderr}`, /unchecked\.js/);

  // PreToolUse guard, launched exactly as the plugins do.
  const hooks = JSON.parse(await fs.readFile(path.join(repoRoot, 'plugins', 'gitguard', 'hooks', 'hooks.json'), 'utf8'));
  const hookCommand = hooks.hooks.PreToolUse[0].hooks[0].command;
  const runGuard = (command) => spawnSync(hookCommand, {
    shell: true,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tempDir }),
    env: { ...env, PLUGIN_ROOT: path.join(repoRoot, 'plugins', 'gitguard') },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(runGuard('git commit -m x').status, 0);
  const guarded = runGuard('git commit --no-verify -m x');
  assert.equal(guarded.status, 2, guarded.stderr);
  assert.match(guarded.stderr, /GitGuard/);

  process.stdout.write(`Bundle smoke test passed (GitGuard ${packageJson.version}).\n`);
} finally {
  await client.close().catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
}
