import { describe, it, expect } from 'vitest';
import { findGitCommits } from '../../../src/enforcement/commit-command.js';

describe('findGitCommits', () => {
  it.each([
    ['git commit -m "msg"', [{ dir: undefined, all: false, stagesFirst: false }]],
    ['git add -A && git commit -m "feat: x"', [{ dir: undefined, all: false, stagesFirst: true }]],
    ['git rm old.ts; git commit -m x', [{ dir: undefined, all: false, stagesFirst: true }]],
    ['git commit -am "quick"', [{ dir: undefined, all: true, stagesFirst: false }]],
    ['git commit --all -m x', [{ dir: undefined, all: true, stagesFirst: false }]],
    ['git commit --amend --no-edit', [{ dir: undefined, all: false, stagesFirst: false }]],
    ['git -C repo commit -m x', [{ dir: 'repo', all: false, stagesFirst: false }]],
    ['cd packages/app && git commit -m x', [{ dir: 'packages/app', all: false, stagesFirst: false }]],
    ['cd /abs/repo; git -C sub commit -m x', [{ dir: '/abs/repo/sub', all: false, stagesFirst: false }]],
    ['git -c user.name=bot commit -m x', [{ dir: undefined, all: false, stagesFirst: false }]],
    ['"C:/Program Files/Git/bin/git.exe" commit -m x', [{ dir: undefined, all: false, stagesFirst: false }]],
  ])('detects %s', (command, expected) => {
    expect(findGitCommits(command)).toEqual(expected);
  });

  it.each([
    'git status',
    'git log --oneline',
    'echo "git commit -m x"',
    'git commit-tree HEAD^{tree}',
    'pnpm test',
    'git add . && git diff --cached',
  ])('ignores %s', (command) => {
    expect(findGitCommits(command)).toEqual([]);
  });

  it('does not treat words inside the commit message as flags', () => {
    expect(findGitCommits('git commit -m "-a looks like a flag"')).toEqual([{ dir: undefined, all: false, stagesFirst: false }]);
  });

  it('finds every commit in a chained command', () => {
    expect(findGitCommits('git commit -m one && git -C other commit -am two')).toEqual([
      { dir: undefined, all: false, stagesFirst: false },
      { dir: 'other', all: true, stagesFirst: false },
    ]);
  });
});
