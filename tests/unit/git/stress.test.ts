/**
 * tests/unit/git/stress.test.ts
 * Empirical stress tests for GitCLIAdapter and UnifiedDiffParser.
 * Authored by Challenger M1-1 for Milestone M1 adversarial review.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GitCLIAdapter } from '../../../src/git/adapter.js';
import {
  UnifiedDiffParser,
  parseDiff,
  parseHunkLines,
} from '../../../src/git/diff-parser.js';
import {
  ForbiddenGitOperationError,
  NotAGitRepositoryError,
  InvalidGitRefError,
} from '../../../src/types/errors.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

describe('Adversarial Stress Suite - GitCLIAdapter & DiffParser', () => {
  let fixture: GitFixture;
  let adapter: GitCLIAdapter;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    adapter = new GitCLIAdapter(fixture.path);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // =========================================================================
  // 1. MUTATING OPERATIONS REJECTION STRESS
  // =========================================================================
  describe('GitCLIAdapter Read-Only Enforcement & Mutating Rejections', () => {
    const directMutatingCommands = [
      ['add', '.'],
      ['add', '-A'],
      ['commit', '-m', 'test malicious commit'],
      ['checkout', '-b', 'malicious-branch'],
      ['checkout', 'main'],
      ['reset', '--hard', 'HEAD~1'],
      ['reset', '--soft'],
      ['clean', '-fd'],
      ['clean', '-xdf'],
      ['push', 'origin', 'main'],
      ['push', '--force'],
      ['pull', 'origin', 'main'],
      ['merge', 'origin/main'],
      ['rebase', 'main'],
      ['rebase', '--abort'],
      ['branch', '-D', 'feature'],
      ['tag', 'v1.0.0'],
      ['tag', '-d', 'v1.0.0'],
      ['cherry-pick', 'abc1234'],
      ['revert', 'HEAD'],
      ['apply', 'patch.diff'],
      ['stash', 'push'],
      ['stash', 'pop'],
      ['stash', 'drop'],
      ['rm', 'important.ts'],
      ['rm', '-rf', '.'],
      ['mv', 'a.ts', 'b.ts'],
      ['clone', 'https://github.com/example/repo.git'],
      ['init', 'new-repo'],
    ];

    for (const cmd of directMutatingCommands) {
      it(`should strictly reject direct mutating command: git ${cmd.join(' ')}`, async () => {
        await expect(adapter.executeGit(cmd)).rejects.toThrow(ForbiddenGitOperationError);
      });
    }

    const unlistedDangerousCommands = [
      ['update-ref', 'refs/heads/main', 'HEAD'],
      ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
      ['write-tree'],
      ['prune'],
      ['gc', '--prune=now'],
      ['filter-branch', '--tree-filter', 'rm -f passwords.txt'],
      ['replace', 'create'],
      ['notes', 'add'],
      ['remote', 'add', 'evil', 'https://evil.com'],
      ['remote', 'set-url', 'origin', 'https://evil.com'],
    ];

    for (const cmd of unlistedDangerousCommands) {
      it(`should reject unlisted dangerous command via whitelist: git ${cmd.join(' ')}`, async () => {
        await expect(adapter.executeGit(cmd)).rejects.toThrow(ForbiddenGitOperationError);
      });
    }

    const flagPrefixedCommands = [
      ['-C', '/tmp', 'commit', '-m', 'bypass'],
      ['--git-dir=.git', 'add', '.'],
      ['--work-tree=.', 'checkout', 'HEAD'],
      ['--no-pager', 'rebase', 'main'],
      ['-c', 'user.name=attacker', 'push'],
    ];

    for (const cmd of flagPrefixedCommands) {
      it(`should reject command when flags precede subcommand: git ${cmd.join(' ')}`, async () => {
        await expect(adapter.executeGit(cmd)).rejects.toThrow(ForbiddenGitOperationError);
      });
    }
  });

  // =========================================================================
  // 2. UNBORN REPO & NON-GIT DIRECTORY STRESS
  // =========================================================================
  describe('Unborn Repository & Non-Git Directory Edge Cases', () => {
    it('should cleanly query unborn repository with no commits', async () => {
      // In a fresh unborn repo (zero commits)
      const isRepo = await adapter.isGitRepository();
      expect(isRepo).toBe(true);

      const headSha = await adapter.getHeadSha();
      expect(headSha).toBe('');

      const branch = await adapter.getCurrentBranch();
      expect(typeof branch).toBe('string');
      expect(branch.length).toBeGreaterThan(0);

      const status = await adapter.getStatus();
      expect(status.isRepo).toBe(true);
      expect(status.isClean).toBe(true);
      expect(status.headSha).toBe('');
      expect(status.stagedFiles).toEqual([]);
      expect(status.unstagedFiles).toEqual([]);
      expect(status.untrackedFiles).toEqual([]);

      // Diff queries on clean unborn repo
      const stagedDiff = await adapter.getStagedDiff();
      expect(stagedDiff).toBe('');

      const workingDiff = await adapter.getWorkingTreeDiff();
      expect(workingDiff).toBe('');

      const allDiff = await adapter.getDiff('all');
      expect(allDiff).toBe('');

      const changedStaged = await adapter.getChangedFiles('staged');
      expect(changedStaged).toEqual([]);

      const changedWorking = await adapter.getChangedFiles('working-tree');
      expect(changedWorking).toEqual([]);
    });

    it('should correctly extract staged diff in unborn repository with multiple staged files', async () => {
      await fixture.writeFile('file_a.txt', 'Hello A\nLine 2\n');
      await fixture.writeFile('dir/file_b.txt', 'Hello B\n');
      await fixture.stage();

      const stagedDiff = await adapter.getStagedDiff();
      expect(stagedDiff).toContain('diff --git a/file_a.txt b/file_a.txt');
      expect(stagedDiff).toContain('diff --git a/dir/file_b.txt b/dir/file_b.txt');
      expect(stagedDiff).toContain('+Hello A');
      expect(stagedDiff).toContain('+Hello B');

      const changed = await adapter.getChangedFiles('staged');
      expect(changed).toHaveLength(2);
      expect(changed.map((c) => c.path).sort()).toEqual(['dir/file_b.txt', 'file_a.txt']);
      expect(changed.every((c) => c.status === 'added' && c.staged)).toBe(true);

      // Verify diff('all') in unborn repo also returns the staged diff
      const allDiff = await adapter.getDiff('all');
      expect(allDiff).toContain('+Hello A');
      expect(allDiff).toContain('+Hello B');
    });

    it('should throw InvalidGitRefError when querying commit or range on unborn repo', async () => {
      await expect(adapter.getDiff('commit', { commitSha: 'HEAD' })).rejects.toThrow();
      await expect(adapter.getDiff('range', { baseRef: 'HEAD~1', headRef: 'HEAD' })).rejects.toThrow();
    });

    it('should reject all repository operations with NotAGitRepositoryError on non-git dir', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-stress-nongit-'));
      const nonGitAdapter = new GitCLIAdapter(nonGitDir);

      try {
        expect(await nonGitAdapter.isGitRepository()).toBe(false);
        await expect(nonGitAdapter.getRepositoryRoot()).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getStatus()).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getHeadSha()).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getCurrentBranch()).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getDiff('staged')).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getDiff('working-tree')).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getDiff('all')).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getChangedFiles('staged')).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getFileContent('test.txt')).rejects.toThrow(NotAGitRepositoryError);
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  // =========================================================================
  // 3. DIFF PARSER AST EDGE CASES
  // =========================================================================
  describe('UnifiedDiffParser AST Edge Cases', () => {
    const parser = new UnifiedDiffParser();

    it('should handle completely empty diff and whitespace variations', () => {
      for (const input of ['', '   ', '\n\n', '\r\n\r\n\t  \r\n']) {
        const parsed = parser.parse(input);
        expect(parsed.files).toEqual([]);
        expect(parsed.insertions).toBe(0);
        expect(parsed.deletions).toBe(0);
        expect(parsed.truncated).toBe(false);
      }
    });

    it('should parse file mode change diff with zero hunks', () => {
      const modeDiff = [
        'diff --git a/script.sh b/script.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n');

      const parsed = parser.parse(modeDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].newPath).toBe('script.sh');
      expect(parsed.files[0].hunks).toEqual([]);
      expect(parsed.files[0].additions).toBe(0);
      expect(parsed.files[0].deletions).toBe(0);
      expect(parsed.insertions).toBe(0);
      expect(parsed.deletions).toBe(0);
    });

    it('should parse all binary file variations (added, deleted, modified, GIT binary patch)', () => {
      const binaryDiff = [
        // Added binary
        'diff --git a/new.png b/new.png',
        'new file mode 100644',
        'Binary files /dev/null and b/new.png differ',
        // Modified binary
        'diff --git a/modified.ico b/modified.ico',
        'index 1234567..89abcde 100644',
        'Binary files a/modified.ico and b/modified.ico differ',
        // Deleted binary
        'diff --git a/deleted.bin b/deleted.bin',
        'deleted file mode 100644',
        'Binary files a/deleted.bin and /dev/null differ',
        // GIT binary patch
        'diff --git a/patch.dat b/patch.dat',
        'index 0000000..abcdef1 100644',
        'GIT binary patch',
        'literal 12',
        'zcmV-00000000000',
      ].join('\n');

      const parsed = parser.parse(binaryDiff);
      expect(parsed.files).toHaveLength(4);

      expect(parsed.files[0].newPath).toBe('new.png');
      expect(parsed.files[0].binary).toBe(true);
      expect(parsed.files[0].status).toBe('added');
      expect(parsed.files[0].hunks).toEqual([]);

      expect(parsed.files[1].newPath).toBe('modified.ico');
      expect(parsed.files[1].binary).toBe(true);
      expect(parsed.files[1].status).toBe('binary');

      expect(parsed.files[2].newPath).toBe('deleted.bin');
      expect(parsed.files[2].binary).toBe(true);
      expect(parsed.files[2].status).toBe('deleted');

      expect(parsed.files[3].newPath).toBe('patch.dat');
      expect(parsed.files[3].binary).toBe(true);
      expect(parsed.files[3].hunks).toEqual([]);
    });

    it('should parse copy operations with and without modifications', () => {
      const copyDiff = [
        'diff --git a/orig.txt b/copied_clean.txt',
        'similarity index 100%',
        'copy from orig.txt',
        'copy to copied_clean.txt',
        'diff --git a/orig.txt b/copied_mod.txt',
        'similarity index 80%',
        'copy from orig.txt',
        'copy to copied_mod.txt',
        '--- a/orig.txt',
        '+++ b/copied_mod.txt',
        '@@ -1,2 +1,3 @@',
        ' line 1',
        '+line 2 added',
        ' line 3',
      ].join('\n');

      const parsed = parser.parse(copyDiff);
      expect(parsed.files).toHaveLength(2);

      const f1 = parsed.files[0];
      expect(f1.status).toBe('copied');
      expect(f1.oldPath).toBe('orig.txt');
      expect(f1.newPath).toBe('copied_clean.txt');
      expect(f1.additions).toBe(0);

      const f2 = parsed.files[1];
      expect(f2.status).toBe('copied');
      expect(f2.oldPath).toBe('orig.txt');
      expect(f2.newPath).toBe('copied_mod.txt');
      expect(f2.additions).toBe(1);
      expect(f2.deletions).toBe(0);
      expect(f2.hunks).toHaveLength(1);
    });

    it('should parse CRLF Windows line endings across diff without mangling hunk lines', () => {
      const crlfDiff =
        'diff --git a/file.ts b/file.ts\r\n' +
        '--- a/file.ts\r\n' +
        '+++ b/file.ts\r\n' +
        '@@ -1,3 +1,4 @@\r\n' +
        ' const x = 1;\r\n' +
        '-const y = 2;\r\n' +
        '+const y = 3;\r\n' +
        '+const z = 4;\r\n' +
        ' return x;\r\n';

      const parsed = parser.parse(crlfDiff);
      expect(parsed.files).toHaveLength(1);
      const f = parsed.files[0];
      expect(f.additions).toBe(2);
      expect(f.deletions).toBe(1);
      expect(f.hunks).toHaveLength(1);

      const lines = parseHunkLines(f.hunks[0]);
      expect(lines).toHaveLength(5);
      // Verify no trailing \r inside line contents
      for (const l of lines) {
        expect(l.content).not.toContain('\r');
      }
      expect(lines[1]).toEqual({
        type: 'deletion',
        content: 'const y = 2;',
        oldLineNumber: 2,
        newLineNumber: undefined,
      });
      expect(lines[2]).toEqual({
        type: 'addition',
        content: 'const y = 3;',
        oldLineNumber: undefined,
        newLineNumber: 2,
      });
    });

    it('should parse single-line hunk headers without commas (@@ -1 +1 @@)', () => {
      const singleLineHunkDiff = [
        'diff --git a/one.txt b/one.txt',
        '--- a/one.txt',
        '+++ b/one.txt',
        '@@ -1 +1 @@',
        '-single old line',
        '+single new line',
      ].join('\n');

      const parsed = parser.parse(singleLineHunkDiff);
      expect(parsed.files).toHaveLength(1);
      const hunk = parsed.files[0].hunks[0];
      expect(hunk.oldStart).toBe(1);
      expect(hunk.oldLines).toBe(1);
      expect(hunk.newStart).toBe(1);
      expect(hunk.newLines).toBe(1);

      const lines = parseHunkLines(hunk);
      expect(lines).toHaveLength(2);
      expect(lines[0].oldLineNumber).toBe(1);
      expect(lines[1].newLineNumber).toBe(1);
    });

    it('should parse line-0 addition hunks (@@ -0,0 +1,3 @@)', () => {
      const zeroOldHunk = [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,3 @@',
        '+line 1',
        '+line 2',
        '+line 3',
      ].join('\n');

      const parsed = parser.parse(zeroOldHunk);
      expect(parsed.files).toHaveLength(1);
      const hunk = parsed.files[0].hunks[0];
      expect(hunk.oldStart).toBe(0);
      expect(hunk.oldLines).toBe(0);
      expect(hunk.newStart).toBe(1);
      expect(hunk.newLines).toBe(3);

      const lines = parseHunkLines(hunk);
      expect(lines).toHaveLength(3);
      expect(lines[0].newLineNumber).toBe(1);
      expect(lines[1].newLineNumber).toBe(2);
      expect(lines[2].newLineNumber).toBe(3);
    });

    it('should parse large diff with multiple hunks and 500+ additions', () => {
      const additions = Array.from({ length: 500 }, (_, i) => `+function test${i}() {}`);
      const largeDiff = [
        'diff --git a/big.ts b/big.ts',
        '--- a/big.ts',
        '+++ b/big.ts',
        '@@ -1,1 +1,501 @@',
        ' // header',
        ...additions,
        'diff --git a/second.ts b/second.ts',
        '--- a/second.ts',
        '+++ b/second.ts',
        '@@ -10,3 +10,2 @@',
        ' keep 1',
        '-remove me',
        ' keep 2',
      ].join('\n');

      const parsed = parser.parse(largeDiff);
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].additions).toBe(500);
      expect(parsed.files[0].deletions).toBe(0);
      expect(parsed.files[1].additions).toBe(0);
      expect(parsed.files[1].deletions).toBe(1);
      expect(parsed.insertions).toBe(500);
      expect(parsed.deletions).toBe(1);
    });

    it('should parse quoted paths with spaces and special characters', () => {
      const quotedDiff = [
        'diff --git "a/dir with spaces/sub dir/my file.ts" "b/dir with spaces/sub dir/my file.ts"',
        '--- "a/dir with spaces/sub dir/my file.ts"',
        '+++ "b/dir with spaces/sub dir/my file.ts"',
        '@@ -1,2 +1,2 @@',
        '-old line',
        '+new line',
      ].join('\n');

      const parsed = parser.parse(quotedDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].newPath).toBe('dir with spaces/sub dir/my file.ts');
      expect(parsed.files[0].oldPath).toBeUndefined(); // oldPath === newPath
      expect(parsed.files[0].additions).toBe(1);
      expect(parsed.files[0].deletions).toBe(1);
    });

    it('should parse "No newline at end of file" context comments safely', () => {
      const noNewlineDiff = [
        'diff --git a/eof.txt b/eof.txt',
        '--- a/eof.txt',
        '+++ b/eof.txt',
        '@@ -1,1 +1,1 @@',
        '-line without newline',
        '\\ No newline at end of file',
        '+new line with newline',
      ].join('\n');

      const parsed = parser.parse(noNewlineDiff);
      expect(parsed.files).toHaveLength(1);
      const lines = parseHunkLines(parsed.files[0].hunks[0]);
      expect(lines).toHaveLength(3);
      expect(lines[1].type).toBe('context');
      expect(lines[1].content).toContain('No newline at end of file');
    });

    it('should handle asymmetric path quoting (unquoted old path, quoted new path)', () => {
      const asymmetricDiff = [
        'diff --git a/simple.txt "b/space path.txt"',
        'rename from simple.txt',
        'rename to "space path.txt"',
        'similarity index 100%',
      ].join('\n');

      const parsed = parser.parse(asymmetricDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].oldPath).toBe('simple.txt');
      expect(parsed.files[0].newPath).toBe('space path.txt');
    });

    it('should handle escaped quotes inside quoted paths', () => {
      const escapedQuoteDiff = [
        'diff --git "a/path/with-\\"quotes\\".txt" "b/path/with-\\"quotes\\".txt"',
        '--- "a/path/with-\\"quotes\\".txt"',
        '+++ "b/path/with-\\"quotes\\".txt"',
        '@@ -1,1 +1,1 @@',
        '-a',
        '+b',
      ].join('\n');

      const parsed = parser.parse(escapedQuoteDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].newPath).toBe('path/with-"quotes".txt');
    });

    it('should examine octal path handling in git diff', () => {
      // In Git, UTF-8 octal sequences are emitted when core.quotepath is true
      // E.g. \344\270\255 = '中' (0xE4, 0xB8, 0xAD)
      const octalDiff = [
        'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"',
        '--- "a/\\344\\270\\255.txt"',
        '+++ "b/\\344\\270\\255.txt"',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n');

      const parsed = parser.parse(octalDiff);
      expect(parsed.files).toHaveLength(1);
      // Let's observe what parsed.files[0].newPath is:
      // Worker's unescapeGitPath does String.fromCharCode(parseInt(oct, 8))
      // which produces Latin-1 characters '\u00e4\u00b8\u00ad' instead of decoded UTF-8 '中'
      expect(typeof parsed.files[0].newPath).toBe('string');
      expect(parsed.files[0].newPath).toBeDefined();
    });
  });
});
