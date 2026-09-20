/**
 * tests/unit/git/adapter.test.ts
 * Unit and integration tests for GitCLIAdapter using isolated temporary Git fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { GitCLIAdapter } from '../../../src/git/adapter.js';
import {
  NotAGitRepositoryError,
  ForbiddenGitOperationError,
  InvalidGitRefError,
} from '../../../src/types/errors.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

describe('GitCLIAdapter', () => {
  let fixture: GitFixture;
  let adapter: GitCLIAdapter;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    adapter = new GitCLIAdapter(fixture.path);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('Repository & Safety Verification', () => {
    it('should confirm directory is a git repository', async () => {
      const isRepo = await adapter.isGitRepository();
      expect(isRepo).toBe(true);

      const root = await adapter.getRepositoryRoot();
      expect(root.toLowerCase()).toBe(fixture.path.toLowerCase());
    });

    it('should throw NotAGitRepositoryError when executed outside git repo', async () => {
      const emptyTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-non-git-'));
      const nonGitAdapter = new GitCLIAdapter(emptyTempDir);

      try {
        const isRepo = await nonGitAdapter.isGitRepository();
        expect(isRepo).toBe(false);

        await expect(nonGitAdapter.getRepositoryRoot()).rejects.toThrow(NotAGitRepositoryError);
        await expect(nonGitAdapter.getStatus()).rejects.toThrow(NotAGitRepositoryError);
      } finally {
        await fs.rm(emptyTempDir, { recursive: true, force: true });
      }
    });

    it('should strictly reject mutating operations with ForbiddenGitOperationError', async () => {
      const forbiddenOperations = [
        ['add', '.'],
        ['commit', '-m', 'bad'],
        ['checkout', 'main'],
        ['reset', '--hard'],
        ['clean', '-fd'],
        ['push', 'origin', 'main'],
        ['merge', 'feat'],
        ['rebase', 'main'],
        ['rm', 'file.txt'],
      ];

      for (const args of forbiddenOperations) {
        await expect(adapter.executeGit(args)).rejects.toThrow(ForbiddenGitOperationError);
      }
    });
  });

  describe('Unborn Repository (Zero Commits)', () => {
    it('should handle unborn repository without commits safely', async () => {
      const status = await adapter.getStatus();
      expect(status.isRepo).toBe(true);
      expect(status.headSha).toBe('');
      expect(status.isClean).toBe(true);
      expect(status.stagedFiles).toEqual([]);
      expect(status.unstagedFiles).toEqual([]);
      expect(status.untrackedFiles).toEqual([]);

      const branch = await adapter.getCurrentBranch();
      expect(typeof branch).toBe('string');
      expect(branch.length).toBeGreaterThan(0);

      const headSha = await adapter.getHeadSha();
      expect(headSha).toBe('');
    });

    it('should get diff in unborn repository when files are staged', async () => {
      await fixture.writeFile('init.txt', 'Initial unborn content\n');
      await fixture.stage('init.txt');

      const stagedDiff = await adapter.getStagedDiff();
      expect(stagedDiff).toContain('diff --git a/init.txt b/init.txt');
      expect(stagedDiff).toContain('+Initial unborn content');

      const changed = await adapter.getChangedFiles('staged');
      expect(changed).toHaveLength(1);
      expect(changed[0].path).toBe('init.txt');
      expect(changed[0].status).toBe('added');
      expect(changed[0].staged).toBe(true);
      expect(changed[0].additions).toBe(1);
    });
  });

  describe('Clean and Dirty Status Tracking', () => {
    it('should track staged, unstaged, and untracked files accurately', async () => {
      // 1. Initial commit
      await fixture.writeFile('committed.txt', 'v1\n');
      await fixture.stage();
      await fixture.commit('feat: initial commit');

      let status = await adapter.getStatus();
      expect(status.isClean).toBe(true);
      expect(status.headSha).toHaveLength(40);

      // 2. Stage a change
      await fixture.writeFile('staged-file.txt', 'staged line\n');
      await fixture.stage('staged-file.txt');

      // 3. Unstaged modification
      await fixture.writeFile('committed.txt', 'v2 updated\n');

      // 4. Untracked file
      await fixture.writeFile('untracked.txt', 'scratch\n');

      status = await adapter.getStatus();
      expect(status.isClean).toBe(false);
      expect(status.stagedFiles).toContain('staged-file.txt');
      expect(status.unstagedFiles).toContain('committed.txt');
      expect(status.untrackedFiles).toContain('untracked.txt');
    });
  });

  describe('Diff Scope Extractions', () => {
    it('should isolate staged, working-tree, and all diffs', async () => {
      await fixture.writeFile('file1.txt', 'line 1\n');
      await fixture.stage();
      await fixture.commit('initial');

      // Staged change
      await fixture.writeFile('file1.txt', 'line 1\nstaged line 2\n');
      await fixture.stage('file1.txt');

      // Working tree unstaged change
      await fixture.writeFile('file2.txt', 'working tree line\n');
      await fixture.writeFile('file1.txt', 'line 1\nstaged line 2\nunstaged line 3\n');

      const stagedDiff = await adapter.getStagedDiff();
      expect(stagedDiff).toContain('+staged line 2');
      expect(stagedDiff).not.toContain('+unstaged line 3');

      const workingDiff = await adapter.getWorkingTreeDiff();
      expect(workingDiff).toContain('+unstaged line 3');
      expect(workingDiff).not.toContain('+staged line 2');

      const allDiff = await adapter.getDiff('all');
      expect(allDiff).toContain('+staged line 2');
      expect(allDiff).toContain('+unstaged line 3');
    });

    it('should extract commit and range diffs', async () => {
      await fixture.writeFile('base.txt', 'base\n');
      await fixture.stage();
      const sha1 = await fixture.commit('commit 1');

      await fixture.writeFile('base.txt', 'base\nupdate in commit 2\n');
      await fixture.stage();
      const sha2 = await fixture.commit('commit 2');

      // Commit diff
      const commitDiff = await adapter.getDiff('commit', { commitSha: sha2 });
      expect(commitDiff).toContain('+update in commit 2');

      // Range diff
      const rangeDiff = await adapter.getDiff('range', { baseRef: sha1, headRef: sha2 });
      expect(rangeDiff).toContain('+update in commit 2');
    });

    it('should throw InvalidGitRefError when invalid commit or range ref provided', async () => {
      await fixture.writeFile('base.txt', 'base\n');
      await fixture.stage();
      await fixture.commit('commit 1');

      await expect(
        adapter.getDiff('commit', { commitSha: 'invalid_sha_12345' })
      ).rejects.toThrow(InvalidGitRefError);

      await expect(
        adapter.getDiff('range', { baseRef: 'nonexistent_branch', headRef: 'HEAD' })
      ).rejects.toThrow(InvalidGitRefError);
    });

    it('should extract pull-request 3-dot diff', async () => {
      await fixture.writeFile('root.txt', 'root\n');
      await fixture.stage();
      await fixture.commit('root commit');

      // Create feature branch
      await fixture.createBranch('feat/login');
      await fixture.writeFile('login.ts', 'export const login = () => true;\n');
      await fixture.stage();
      await fixture.commit('feat: login');

      const prDiff = await adapter.getDiff('pull-request', { baseRef: 'HEAD~1', headRef: 'HEAD' });
      expect(prDiff).toContain('diff --git a/login.ts b/login.ts');
      expect(prDiff).toContain('+export const login = () => true;');
    });

    it('should support pathFilters in diff extraction', async () => {
      await fixture.writeFile('src/a.ts', 'a\n');
      await fixture.writeFile('src/b.ts', 'b\n');
      await fixture.stage();
      await fixture.commit('init');

      await fixture.writeFile('src/a.ts', 'a modified\n');
      await fixture.writeFile('src/b.ts', 'b modified\n');
      await fixture.stage();

      const filteredDiff = await adapter.getDiff('staged', { pathFilters: ['src/a.ts'] });
      expect(filteredDiff).toContain('src/a.ts');
      expect(filteredDiff).not.toContain('src/b.ts');
    });
  });

  describe('File Content Retrieval', () => {
    it('should read working tree content and specific ref content', async () => {
      await fixture.writeFile('config.json', '{"version": 1}');
      await fixture.stage();
      const initialSha = await fixture.commit('v1');

      await fixture.writeFile('config.json', '{"version": 2}');

      // Working tree has version 2
      const workingContent = await adapter.getFileContent('config.json');
      expect(workingContent).toBe('{"version": 2}');

      // Ref HEAD (or initialSha) has version 1
      const refContent = await adapter.getFileContent('config.json', initialSha);
      expect(refContent).toBe('{"version": 1}');

      // Non-existent file returns null
      const missing = await adapter.getFileContent('missing.txt');
      expect(missing).toBeNull();

      const missingInRef = await adapter.getFileContent('missing.txt', initialSha);
      expect(missingInRef).toBeNull();
    });
  });

  describe('Detached HEAD', () => {
    it('should report HEAD when in detached state', async () => {
      await fixture.writeFile('root.txt', 'v1\n');
      await fixture.stage();
      const sha = await fixture.commit('root');

      await fixture.checkout(sha);
      const branch = await adapter.getCurrentBranch();
      expect(branch).toBe('HEAD');
    });
  });
});
