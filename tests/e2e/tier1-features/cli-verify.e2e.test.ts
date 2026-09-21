/**
 * tests/e2e/tier1-features/cli-verify.e2e.test.ts
 * Tier 1: Feature Coverage - CLI `verify` subcommand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';
import { FileFindingStore } from '../../../src/findings/store.js';

describe('Tier 1: CLI verify subcommand', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-vrf-');
    await setupGitGuardRepo(fixture);
    const store = new FileFindingStore(fixture.repoPath);
    await store.save([
      {
        id: 'GG-001',
        ruleId: 'secret_scan',
        source: 'deterministic',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        affectedFiles: [],
        message: 'Mock finding 001',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp_001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'GG-002',
        ruleId: 'secret_scan',
        source: 'deterministic',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        affectedFiles: [],
        message: 'Mock finding 002',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp_002',
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CLI-VRF-01: Non-existent finding ID yields BLOCK and non-zero exit code', async () => {
    const outcome = await runCli(
      ['verify', '--findings', 'GG-NONEXISTENT', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toContain('Verification failed: None of the targeted finding ID(s) exist');
  });

  it('T1-CLI-VRF-02: Targeted finding resolved with --json report', async () => {
    const outcome = await runCli(
      ['verify', '--findings', 'GG-001', '--json', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.status).toBe('PASS');
    expect(json.resolved).toContain('GG-001');
    expect(json.remaining).toHaveLength(0);
  });

  it('T1-CLI-VRF-03: Staged secret remains unresolved and yields BLOCK', async () => {
    await fixture.writeFile('src/secret.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/secret.ts');

    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(checkRes.exitCode).toBe(1);
    const checkJson = checkRes.json();
    expect(checkJson.findings.length).toBeGreaterThan(0);
    const findingId = checkJson.findings[0].id;

    const outcome = await runCli(
      ['verify', '--findings', findingId, '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('GitGuard Verification Loop: BLOCK');
  });

  it('T1-CLI-VRF-04: Multiple findings comma-separated verified together', async () => {
    const outcome = await runCli(
      ['verify', '--findings', 'GG-001,GG-002', '--json', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json.status).toBe('PASS');
    expect(json.resolved).toContain('GG-001');
    expect(json.resolved).toContain('GG-002');
  });

  it('T1-CLI-VRF-05: Verification with --scope staged', async () => {
    const outcome = await runCli(
      ['verify', '--findings', 'GG-001', '--scope', 'staged', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Verification Loop: PASS');
  });
});
