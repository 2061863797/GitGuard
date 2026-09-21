/**
 * tests/e2e/tier2-boundaries/finding-boundaries.e2e.test.ts
 * Tier 2: Boundary & Corner Cases - Finding Manager boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';
import { computeFindingFingerprint } from '../../../src/findings/fingerprint.js';
import { DefaultFindingManager, getDefaultExpectedEvidence } from '../../../src/findings/manager.js';

describe('Tier 2: Finding Manager Boundaries', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-fnd-bnd-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T2-FND-01: Fingerprint stability across line drift', () => {
    const hunk1 = `
@@ -10,3 +10,3 @@
 const a = 1;
+const key = "AKIAIOSFODNN7EXAMPLE";
 const b = 2;
`;
    const hunk2 = `
@@ -50,3 +50,3 @@
 const a = 1;
+const key = "AKIAIOSFODNN7EXAMPLE";
 const b = 2;
`;
    // computeFindingFingerprint normalizes hunks ignoring line numbers
    const fp1 = computeFindingFingerprint('deterministic.secret_scan', ['src/api.ts'], hunk1);
    const fp2 = computeFindingFingerprint('deterministic.secret_scan', ['src/api.ts'], hunk2);

    expect(fp1).toBe(fp2);
  });

  it('T2-FND-02: Query non-existent finding ID yields BLOCK and non-zero exit', async () => {
    const outcome = await runCli(
      ['verify', '--findings', 'GG-NONEXISTENT-999', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toContain('Verification failed: None of the targeted finding ID(s) exist');
  });

  it('T2-FND-03: Findings filter with zero matches emits empty JSON array', async () => {
    const outcome = await runCli(
      ['findings', '--rule', 'unknown_rule_xyz', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(0);
  });

  it('T2-FND-04: Finding expected evidence provides actionable remediation steps', () => {
    const evidence = getDefaultExpectedEvidence('deterministic.secret_scan', 'block');
    expect(Array.isArray(evidence)).toBe(true);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((e) => e.toLowerCase().includes('secret') || e.toLowerCase().includes('credentials'))).toBe(true);
  });

  it('T2-FND-05: Fingerprint computation handles null and empty hunks without crashing', () => {
    const fp = computeFindingFingerprint('rule_test', ['file.ts'], '');
    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(64); // SHA-256 hex string length
  });

  it('T2-FND-06: Lifecycle state transition from active to resolved with resolvedAt', () => {
    const manager = new DefaultFindingManager();
    const finding = {
      id: 'F-001',
      ruleId: 'secret_scan',
      source: 'deterministic' as const,
      status: 'block' as const,
      severity: 'CRITICAL' as const,
      lifecycle: 'active' as const,
      affectedFiles: ['src/app.ts'],
      message: 'Secret found',
      evidence: [],
      expectedEvidence: [],
      fingerprint: 'abcd1234abcd1234',
      createdAt: new Date().toISOString(),
    };

    const report = manager.resolveFindings([finding], []);
    expect(report.status).toBe('PASS');
    expect(report.resolved).toContain('F-001');

    const resolvedStored = manager.getFindings({ lifecycle: 'resolved' })[0];
    expect(resolvedStored).toBeDefined();
    expect(resolvedStored.lifecycle).toBe('resolved');
    expect(resolvedStored.resolvedAt).toBeDefined();
  });
});
