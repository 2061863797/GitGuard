/**
 * End-to-end: the PreToolUse hook as a real subprocess, fed the event JSON that Claude Code and Codex send.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { DefaultGitGuardEngine } from '../../src/core/engine.js';
import { createTempGitRepo, type GitFixture } from '../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../helpers/online-semantic-stub.js';
import { PROJECT_ROOT } from './helpers/e2e-harness.js';

const HOOK_PATH = path.join(PROJECT_ROOT, 'dist', 'hook.js');

function runHook(event: unknown): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  return { status: result.status, stderr: result.stderr };
}

const bash = (command: string, cwd: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
});

describe('GitGuard commit hook (subprocess)', () => {
  let repo: GitFixture;

  beforeEach(async () => {
    repo = await createTempGitRepo('gitguard-hook-');
    await repo.writeFile('.gitguard.yml', 'version: 1\n');
    await repo.writeFile('README.md', '# fixture\n');
    await repo.stage();
    await repo.commit('initial');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('ignores non-Bash tools, non-commit commands and malformed input', () => {
    expect(runHook({ tool_name: 'Edit', tool_input: { file_path: 'x' }, cwd: repo.repoPath }).status).toBe(0);
    expect(runHook(bash('git status && pnpm test', repo.repoPath)).status).toBe(0);
    const garbage = spawnSync(process.execPath, [HOOK_PATH], { input: 'not json', encoding: 'utf8', windowsHide: true });
    expect(garbage.status).toBe(0);
  });

  it('blocks an unchecked commit with exit code 2 and an actionable message, then allows it after a check', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    const blocked = runHook(bash('git add -A && git commit -m "feat: a"', repo.repoPath));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/Run the GitGuard check tool/);

    await new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() }).check({ cwd: repo.repoPath });
    expect(runHook(bash('git add -A && git commit -m "feat: a"', repo.repoPath)).status).toBe(0);
    await repo.stage();
    expect(runHook(bash('git commit -m "feat: a"', repo.repoPath)).status).toBe(0);
  });

  it('blocks "git add -A && git commit" when an unchecked file would be staged by the same command', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() }).check({ cwd: repo.repoPath });
    await repo.writeFile('src/later.ts', 'export const b = 2;\n');
    const blocked = runHook(bash('git add -A && git commit -m x', repo.repoPath));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('src/later.ts');
  });

  it('resolves the repository from cd and git -C', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    const parent = path.dirname(repo.repoPath);
    const name = path.basename(repo.repoPath);
    expect(runHook(bash(`cd ${name} && git commit -m x`, parent)).status).toBe(2);
    expect(runHook(bash(`git -C ${name} commit -m x`, parent)).status).toBe(2);
  });

  it('lets commits through outside Git repositories', () => {
    expect(runHook(bash('git commit -m x', path.parse(repo.repoPath).root)).status).toBe(0);
  });
});
