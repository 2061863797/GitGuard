/**
 * tests/e2e/tier2-boundaries/git-boundaries.e2e.test.ts
 * Tier 2: Boundary & Corner Cases - Git boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  runCli,
  spawnMcpClient,
  createTempGitRepo,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 2: Git Boundaries', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-git-bnd-');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T2-GIT-01: Unborn repository with zero commits inspects safely', async () => {
    const outcome = await runCli(['inspect'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('Status: PASS');
  });

  it('T2-GIT-02: Unborn repository detects staged files against empty tree', async () => {
    await fixture.writeFile('initial.txt', 'hello from unborn\n');
    await fixture.stage('initial.txt');

    const outcome = await runCli(['inspect', '--scope', 'staged'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('initial.txt');
    expect(outcome.stdout).toContain('Files: 1');
  });

  it('T2-GIT-03: Non-git directory returns exit code 3 (NotAGitRepositoryError)', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-dir-'));
    try {
      const outcome = await runCli(['inspect'], { cwd: nonGitDir });
      expect(outcome.exitCode).toBe(3);
      expect(outcome.stderr.toLowerCase()).toContain('not a git repository');
    } finally {
      await fs.rm(nonGitDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('T2-GIT-04: Non-git directory via MCP returns tool error', async () => {
    const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-mcp-'));
    const session = await spawnMcpClient(fixture.repoPath);
    try {
      const res = await session.client.callTool({
        name: 'inspect_changes',
        arguments: { cwd: nonGitDir },
      });
      // MCP returns tool call failure or error payload
      const text = (res.content as any)[0]?.text || '';
      expect(res.isError || text.includes('not a git repository')).toBeTruthy();
    } finally {
      await session.close();
      await fs.rm(nonGitDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('T2-GIT-05: Detached HEAD operates normally without errors', async () => {
    await fixture.writeFile('file.txt', 'commit 1\n');
    await fixture.stage('file.txt');
    const sha1 = await fixture.commit('commit 1');

    await fixture.writeFile('file.txt', 'commit 2\n');
    await fixture.stage('file.txt');
    await fixture.commit('commit 2');

    await fixture.checkout(sha1);

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T2-GIT-06: Non-existent commit ref exits with non-zero code', async () => {
    await fixture.writeFile('file.txt', 'base\n');
    await fixture.stage('file.txt');
    await fixture.commit('initial');

    const outcome = await runCli(['check', 'nonexistent_sha_12345', '--offline'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  it('T2-GIT-07: Non-existent commit range A..B gracefully rejected', async () => {
    await fixture.writeFile('file.txt', 'base\n');
    await fixture.stage('file.txt');
    await fixture.commit('initial');

    const outcome = await runCli(['check', 'deadbeef..cafebabe', '--offline'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  it('T2-GIT-08: Read-only guarantee preserves repository state and rev-parse HEAD', async () => {
    await fixture.writeFile('staged.txt', 'staged content\n');
    await fixture.stage('staged.txt');
    await fixture.commit('feat: base commit');

    await fixture.writeFile('working.txt', 'unstaged content\n');
    await fixture.writeFile('staged_again.txt', 'new staged\n');
    await fixture.stage('staged_again.txt');

    const beforeStatus = await fixture.exec(['status', '-s']);
    const beforeHead = await fixture.exec(['rev-parse', 'HEAD']);

    // Run inspect and check
    await runCli(['inspect'], { cwd: fixture.repoPath });
    await runCli(['check', '--offline'], { cwd: fixture.repoPath });

    const afterStatus = await fixture.exec(['status', '-s']);
    const afterHead = await fixture.exec(['rev-parse', 'HEAD']);

    expect(afterStatus.stdout).toBe(beforeStatus.stdout);
    expect(afterHead.stdout).toBe(beforeHead.stdout);
  });
});
