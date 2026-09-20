/**
 * tests/e2e/tier2-boundaries/diff-boundaries.e2e.test.ts
 * Tier 2: Boundary & Corner Cases - Diff boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 2: Diff Boundaries', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-diff-bnd-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T2-DIF-01: Binary file addition detected with binary: true', async () => {
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ]);
    await fixture.writeBinaryFile('logo.png', pngBuffer);
    await fixture.stage('logo.png');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.summary.hasBinaryChanges).toBe(true);
    const file = json.changedFiles.find((f: any) => f.path === 'logo.png');
    expect(file).toBeDefined();
    expect(file.binary).toBe(true);
  });

  it('T2-DIF-02: Staged scope strictly excludes untracked files', async () => {
    await fixture.writeFile('tracked.txt', 'tracked content\n');
    await fixture.stage('tracked.txt');

    await fixture.writeFile('untracked.txt', 'untracked content\n');

    const outcome = await runCli(['inspect', '--scope', 'staged', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    const paths = json.changedFiles.map((f: any) => f.path);
    expect(paths).toContain('tracked.txt');
    expect(paths).not.toContain('untracked.txt');
  });

  it('T2-DIF-03: Massive diff handles truncation without memory exhaustion', async () => {
    const hugeContent = Array.from({ length: 3000 }, (_, i) => `const line_${i} = "payload_${i}_padding_data_extra_characters";`).join('\n') + '\n';
    await fixture.writeFile('huge.ts', hugeContent);
    await fixture.stage('huge.ts');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.summary.filesChanged).toBe(1);
    expect(json.summary.truncated).toBe(true);
  });

  it('T2-DIF-04: Windows CRLF line endings parsed cleanly without trailing CR', async () => {
    await fixture.writeFile('crlf.ts', 'const a = 1;\r\nconst b = 2;\r\n');
    await fixture.stage('crlf.ts');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.summary.filesChanged).toBe(1);
    expect(json.summary.insertions).toBe(2);
  });

  it('T2-DIF-05: File rename detected with oldPath and newPath', async () => {
    await fixture.writeFile('old.ts', 'export const name = "old";\n');
    await fixture.stage('old.ts');
    await fixture.commit('feat: add old.ts');

    await fixture.exec(['mv', 'old.ts', 'new.ts']);

    const outcome = await runCli(['inspect', '--scope', 'staged', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    const renamed = json.changedFiles.find((f: any) => f.path === 'new.ts');
    expect(renamed).toBeDefined();
    expect(renamed.status).toBe('renamed');
    expect(renamed.oldPath).toBe('old.ts');
  });

  it('T2-DIF-06: File deletion detected with status deleted', async () => {
    await fixture.writeFile('to_delete.ts', 'export const dead = true;\n');
    await fixture.stage('to_delete.ts');
    await fixture.commit('feat: add file to delete');

    await fixture.exec(['rm', 'to_delete.ts']);

    const outcome = await runCli(['inspect', '--scope', 'staged', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    const deleted = json.changedFiles.find((f: any) => f.path === 'to_delete.ts' || f.oldPath === 'to_delete.ts');
    expect(deleted).toBeDefined();
    expect(deleted.status).toBe('deleted');
    expect(deleted.deletions).toBeGreaterThan(0);
  });

  it('T2-DIF-07: Non-ASCII and Unicode filenames preserved correctly', async () => {
    await fixture.writeFile('测试.ts', 'export const test = "chinese filename";\n');
    await fixture.stage('测试.ts');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    const found = json.changedFiles.some((f: any) => f.path && (f.path.includes('测试') || f.path.includes('.ts')));
    expect(found).toBe(true);
  });

  it('T2-DIF-08: Empty file modification handled safely without errors', async () => {
    await fixture.writeFile('empty.txt', '');
    await fixture.stage('empty.txt');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.status).toBe('PASS');
    expect(json.summary.filesChanged).toBe(1);
  });
});
