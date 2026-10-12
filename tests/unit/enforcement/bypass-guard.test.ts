import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findHookBypass, isGitGuardRepository } from '../../../src/enforcement/bypass-guard.js';

describe('findHookBypass', () => {
  it.each([
    'git commit --no-verify -m x',
    'bash -c "git add -A && git commit --no-verify -m x"',
    'git commit -n -m x',
    'git commit -nm x',
    'git commit -anm x',
    'pwsh -Command "git commit -n -m x"',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git config core.hooksPath .nohooks',
    'rm .git/hooks/pre-commit',
    'echo "{}" > .git/gitguard/last-check.json',
    'Remove-Item .git\\hooks\\pre-commit',
  ])('flags %s', (command) => {
    expect(findHookBypass(command)).not.toBeNull();
  });

  it.each([
    'git commit -m "feat: add login"',
    'git commit -am "quick fix"',
    'git commit --amend --no-edit',
    'git log -n 5',
    'git commit -m x && git log -n 3',
    'pnpm test',
    'git status',
  ])('allows %s', (command) => {
    expect(findHookBypass(command)).toBeNull();
  });
});

describe('isGitGuardRepository', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('finds the config at the repository root from a nested directory', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitguard-guard-'));
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    expect(isGitGuardRepository(path.join(dir, 'src', 'deep'))).toBe(false);
    fs.writeFileSync(path.join(dir, '.gitguard.yml'), 'version: 1\n');
    expect(isGitGuardRepository(path.join(dir, 'src', 'deep'))).toBe(true);
  });
});
