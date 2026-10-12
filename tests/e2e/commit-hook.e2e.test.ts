/**
 * End-to-end: the Git pre-commit hook installed by a check, exercised with real `git commit`
 * invocations, plus the PreToolUse guard that stops agents from skipping it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { DefaultGitGuardEngine } from '../../src/core/engine.js';
import { createTempGitRepo, type GitFixture } from '../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../helpers/online-semantic-stub.js';
import { PROJECT_ROOT } from './helpers/e2e-harness.js';

const PRE_COMMIT = path.join(PROJECT_ROOT, 'dist', 'pre-commit.js');
const GUARD = path.join(PROJECT_ROOT, 'dist', 'hook.js');

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function shell(cwd: string, command: string) {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function guard(command: string, cwd: string, toolName = 'Bash') {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { command }, cwd }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('GitGuard pre-commit hook (real git commits)', () => {
  let repo: GitFixture;
  let engine: DefaultGitGuardEngine;
  const head = () => git(repo.repoPath, ['rev-parse', 'HEAD']).output.trim();

  beforeEach(async () => {
    repo = await createTempGitRepo('gitguard-hook-');
    await repo.writeFile('.gitguard.yml', 'version: 1\n');
    await repo.writeFile('README.md', '# fixture\n');
    await repo.stage();
    await repo.commit('initial');
    engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub(), preCommitScript: PRE_COMMIT });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('is installed by the first check and then gates commits', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    const checked = await engine.check({ cwd: repo.repoPath });
    expect(checked.metadata.commitHook).toMatch(/^installed/);

    await repo.writeFile('src/later.ts', 'export const b = 2;\n');
    await repo.stage();
    const before = head();
    const blocked = git(repo.repoPath, ['commit', '-m', 'x']);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('src/later.ts');
    expect(head()).toBe(before);

    await engine.check({ cwd: repo.repoPath });
    expect(git(repo.repoPath, ['commit', '-m', 'checked']).status).toBe(0);
    expect(head()).not.toBe(before);
  });

  it('checks what `git commit <path>` really commits from the working tree', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repo.repoPath });
    await repo.writeFile('src/app.ts', 'export const a = "changed after the check";\n');
    const result = git(repo.repoPath, ['commit', '-m', 'x', 'src/app.ts']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('src/app.ts');
  });

  it('checks `git commit -a` and commits run through nested shells and aliases', async () => {
    await repo.writeFile('README.md', '# checked\n');
    await engine.check({ cwd: repo.repoPath });
    await repo.writeFile('README.md', '# changed after the check\n');
    git(repo.repoPath, ['config', 'alias.ci', 'commit']);

    expect(git(repo.repoPath, ['commit', '-a', '-m', 'x']).status).not.toBe(0);
    expect(git(repo.repoPath, ['ci', '-a', '-m', 'x']).status).not.toBe(0);
    expect(shell(repo.repoPath, 'sh -c "git commit -a -m x"').status).not.toBe(0);
  });

  it('blocks a BLOCK verdict until verify passes', async () => {
    const secret = ['ghp', '123456789012345678901234567890123456'].join('_');
    await repo.writeFile('src/config.ts', `export const token = "${secret}";\n`);
    const checked = await engine.check({ cwd: repo.repoPath });
    await repo.stage();
    const blocked = git(repo.repoPath, ['commit', '-m', 'x']);
    expect(blocked.status).not.toBe(0);
    expect(blocked.output).toContain('returned BLOCK');

    await repo.writeFile('src/config.ts', 'export const token = process.env.TOKEN;\n');
    await engine.verify({ cwd: repo.repoPath, findingIds: [checked.findings[0].id] });
    await repo.stage();
    expect(git(repo.repoPath, ['commit', '-m', 'fixed']).status).toBe(0);
  });

  it('lets a person skip it once with --no-verify', async () => {
    await engine.check({ cwd: repo.repoPath });
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    expect(git(repo.repoPath, ['commit', '-m', 'x']).status).not.toBe(0);
    expect(git(repo.repoPath, ['commit', '--no-verify', '-m', 'x']).status).toBe(0);
  });
});

describe('GitGuard PreToolUse guard (subprocess)', () => {
  let repo: GitFixture;

  beforeEach(async () => {
    repo = await createTempGitRepo('gitguard-guard-');
    await repo.writeFile('.gitguard.yml', 'version: 1\n');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('blocks attempts to skip the hook in a GitGuard repository, for Bash and PowerShell', () => {
    const blocked = guard('git add -A && git commit --no-verify -m x', repo.repoPath);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/--no-verify/);
    expect(guard('bash -c "git commit -n -m x"', repo.repoPath).status).toBe(2);
    expect(guard('Remove-Item .git\\hooks\\pre-commit', repo.repoPath, 'PowerShell').status).toBe(2);
  });

  it('allows normal commands, other tools, other repositories and malformed input', () => {
    expect(guard('git commit -m "feat: x"', repo.repoPath).status).toBe(0);
    expect(guard('pnpm test', repo.repoPath).status).toBe(0);
    expect(spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: repo.repoPath }), encoding: 'utf8',
    }).status).toBe(0);
    expect(guard('git commit --no-verify -m x', path.parse(repo.repoPath).root).status).toBe(0);
    expect(spawnSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8' }).status).toBe(0);
  });
});
