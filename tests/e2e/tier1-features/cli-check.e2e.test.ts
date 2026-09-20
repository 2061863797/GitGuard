/**
 * tests/e2e/tier1-features/cli-check.e2e.test.ts
 * Tier 1: Feature Coverage - CLI `check` subcommand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 1: CLI check subcommand', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-chk-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CLI-CHK-01: Clean repository yields PASS and exit code 0', async () => {
    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T1-CLI-CHK-02: Staged AWS secret triggers BLOCK and exit code 1', async () => {
    await fixture.writeFile('src/aws.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/aws.ts');

    const outcome = await runCli(['check', '--staged', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: BLOCK');
    expect(outcome.stdout).toContain('deterministic.secret_scan');
  });

  it('T1-CLI-CHK-03: Non-secret change matching task succeeds', async () => {
    await fixture.writeFile('src/helper.ts', 'export function helper(): string { return "ok"; }\n');
    await fixture.stage('src/helper.ts');

    const outcome = await runCli(
      ['check', '--task', 'Add helper function', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T1-CLI-CHK-04: JSON output contains expected structural fields', async () => {
    const outcome = await runCli(['check', '--json', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('diffSummary');
    expect(json).toHaveProperty('findings');
    expect(json).toHaveProperty('verdictSummary');
  });

  it('T1-CLI-CHK-05: Strict mode elevates non-PASS verdict to exit code 1', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan: { enabled: false }
rules:
  unrelated_changes:
    enabled: true
    warn: 0.1
    review: 0.5
    block: 0.9
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('src/drift.ts', 'export const drift = true;\n');
    await fixture.stage('src/drift.ts');

    const outcome = await runCli(
      ['check', '--task', 'Unrelated task description', '--strict', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(1);
  });

  it('T1-CLI-CHK-06: --fail-on-warn with clean changeset exits with 0', async () => {
    const outcome = await runCli(['check', '--fail-on-warn', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });
});
