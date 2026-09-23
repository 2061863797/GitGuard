import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

if (process.platform !== 'win32') {
  throw new Error('Windows is required to test GitGuard.exe');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exePath = path.join(repoRoot, 'dist-exe', 'GitGuard.exe');
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const gitPath = execFileSync('where.exe', ['git'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .find((line) => line.trim());
assert.ok(gitPath, 'Git must be available for the standalone EXE');

const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key.toLowerCase() === 'path' || key === 'NODE_OPTIONS') {
    delete childEnv[key];
  }
}
childEnv.PATH = [
  path.dirname(gitPath),
  path.join(systemRoot, 'System32'),
  systemRoot,
].join(path.delimiter);

const tempRoot = path.resolve(os.tmpdir());
const tempDir = await fs.mkdtemp(path.join(tempRoot, 'gitguard-exe-smoke-'));
const isolatedExePath = path.join(tempDir, 'GitGuard.exe');
await fs.copyFile(exePath, isolatedExePath);
const runGit = (args) => execFileSync(gitPath, args, {
  cwd: tempDir,
  encoding: 'utf8',
  windowsHide: true,
});

const runExe = (args) => {
  const result = spawnSync(isolatedExePath, args, {
    cwd: tempDir,
    env: childEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
};

try {
  assert.equal(runExe(['--version']).stdout.trim(), packageJson.version);
  assert.match(runExe(['--help']).stdout, /inspect/);

  runGit(['init', '-q']);
  runGit(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(tempDir, '.gitguard.yml'), [
    'version: 1',
    'deterministic:',
    '  test:',
    '    enabled: false',
    '  lint:',
    '    enabled: false',
    '  typecheck:',
    '    enabled: false',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(tempDir, 'hello.txt'), 'initial\n', 'utf8');
  runGit(['add', '.']);
  runGit(['-c', 'user.name=GitGuard Smoke', '-c', 'user.email=smoke@example.invalid',
    'commit', '-q', '-m', 'init']);
  await fs.writeFile(path.join(tempDir, 'hello.txt'), 'updated\n', 'utf8');

  const inspected = runExe(['inspect', '--working', '--cwd', tempDir, '--json']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const inspection = JSON.parse(inspected.stdout);
  assert.equal(inspection.summary.filesChanged, 1);
  assert.equal(inspection.changedFiles[0].path, 'hello.txt');

  const checked = runExe(['check', '--offline', '--working', '--cwd', tempDir,
    '--task', 'update hello.txt', '--json']);
  assert.notEqual(checked.status, 2, checked.stderr);
  const check = JSON.parse(checked.stdout);
  assert.equal(check.diffSummary.filesChanged, 1);
  assert.ok(Array.isArray(check.deterministicResults));
  assert.ok(['PASS', 'WARN', 'REVIEW', 'BLOCK'].includes(check.status));

  const transport = new StdioClientTransport({
    command: isolatedExePath,
    args: ['mcp'],
    cwd: tempDir,
    env: childEnv,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'gitguard-exe-smoke', version: '1.0.0' },
    { capabilities: {} });
  try {
    await client.connect(transport);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('inspect_changes'));
    assert.ok(toolNames.includes('check_before_commit'));
  } finally {
    await client.close();
    await transport.close();
  }

  console.log('GitGuard.exe passed standalone CLI, Git, offline check and MCP smoke tests');
} finally {
  const resolvedTemp = path.resolve(tempDir);
  if (!resolvedTemp.startsWith(tempRoot + path.sep)) {
    throw new Error('Refusing to remove a directory outside the temporary root');
  }
  await fs.rm(resolvedTemp, { recursive: true, force: true });
}
