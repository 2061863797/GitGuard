/**
 * tests/e2e/tier1-features/cli-inspect.e2e.test.ts
 * Tier 1: Feature Coverage - CLI `inspect` subcommand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 1: CLI inspect subcommand', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-insp-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CLI-INSP-01: Clean repository (no uncommitted changes)', async () => {
    const outcome = await runCli(['inspect'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Inspect Summary');
    expect(outcome.stdout).toContain('Status: PASS');
    expect(outcome.stdout).toContain('Files: 0');
  });

  it('T1-CLI-INSP-02: Staged file with insertions in staged scope', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n';
    await fixture.writeFile('src/user.ts', content);
    await fixture.stage('src/user.ts');

    const outcome = await runCli(['inspect', '--scope', 'staged'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('src/user.ts');
    expect(outcome.stdout).toContain('Files: 1');
    expect(outcome.stdout).toContain('+10');
  });

  it('T1-CLI-INSP-03: Unstaged modification in working tree scope', async () => {
    await fixture.writeFile('README.md', '# Initial Docs\n');
    await fixture.stage('README.md');
    await fixture.commit('docs: add initial readme');

    await fixture.writeFile('README.md', '# Initial Docs\nUpdated content in working tree.\n');

    const outcome = await runCli(['inspect', '--scope', 'working'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('README.md');
    expect(outcome.stdout).toContain('Files: 1');
  });

  it('T1-CLI-INSP-04: JSON output format with modified file', async () => {
    await fixture.writeFile('math.ts', 'export const x = 0;\n');
    await fixture.stage('math.ts');
    await fixture.commit('feat: initial math file');

    await fixture.writeFile('math.ts', 'export function add(a: number, b: number): number { return a + b; }\n');

    const outcome = await runCli(['inspect', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.status).toBe('PASS');
    expect(json.summary.filesChanged).toBe(1);
    expect(json.summary.insertions).toBeGreaterThan(0);
    expect(Array.isArray(json.changedFiles)).toBe(true);
    expect(json.changedFiles[0].path).toBe('math.ts');
  });

  it('T1-CLI-INSP-05: Preliminary deterministic checks via --check-deterministic', async () => {
    await fixture.writeFile('util.ts', 'export const greeting = "hello world";\n');
    await fixture.stage('util.ts');

    const outcome = await runCli(['inspect', '--check-deterministic', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.hasDeterministicFailures).toBe(false);
    expect(json.status).toBe('PASS');
  });
});
