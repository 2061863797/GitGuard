/**
 * tests/e2e/tier4-scenarios/scenario-f-provenance.e2e.test.ts
 * Tier 4 Scenario F: Baseline Drift & Provenance Integrity.
 * Verifies that committing violating code (instead of remediating it) does NOT trick
 * verify into marking findings as resolved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario F: Baseline Drift & Provenance Integrity', () => {
  let fixture: GitFixture;

  const configYml = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan:
    enabled: true
    block_on_detection: true
rules:
  security_sensitive: { enabled: false }
  tests_required: { enabled: false }
  unrelated_changes: { enabled: false }
`;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-f-');
    await fixture.writeFile('.gitguard.yml', configYml);
    await fixture.stage('.gitguard.yml');
    await fixture.commit('chore: init config');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T4-SCEN-F1: Committing a secret into HEAD does NOT resolve finding during verify', async () => {
    // 1. Introduce a secret in working tree
    const fakeAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    await fixture.writeFile('src/config.ts', `export const AWS_KEY = "${fakeAwsKey}";\n`);
    await fixture.stage('src/config.ts');

    // 2. Check changes - must fail with BLOCK and produce secret_scan finding
    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(checkRes.exitCode).toBe(1);
    const checkJson = checkRes.json();
    expect(checkJson.status).toBe('BLOCK');

    const secretFinding = checkJson.findings.find((f: any) =>
      f.id.includes('secret') || f.ruleId.includes('secret')
    );
    expect(secretFinding).toBeDefined();
    expect(secretFinding.provenance).toBeDefined();
    expect(secretFinding.provenance.detectedHeadSha).toBeTruthy();

    // 3. Deceptive action: Commit the secret into git history so working/staged diff becomes empty!
    await fixture.commit('feat: stealthily commit secret to clear diff');

    // 4. Run verify targeting the finding ID
    const verifyRes = await runCli(
      ['verify', '--findings', secretFinding.id, '--target-only', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );

    // Baseline drift defense must catch that the secret is still present at HEAD!
    expect(verifyRes.exitCode).toBe(1);
    const verifyJson = verifyRes.json();
    expect(verifyJson.status).toBe('BLOCK');
    expect(verifyJson.targetsResolved).toBe(false);
    expect(verifyJson.allResolved).toBe(false);
    expect(verifyJson.resolved).not.toContain(secretFinding.id);
    expect(verifyJson.remaining).toContain(secretFinding.id);
    expect(verifyJson.verdictSummary).toContain('remain unresolved');

    // 5. Genuine remediation: Remove the secret from src/config.ts
    await fixture.writeFile('src/config.ts', 'export const AWS_KEY = "dummy_safe_key";\n');
    await fixture.stage('src/config.ts');
    await fixture.commit('fix: remove sensitive credential from codebase');

    // 6. Run verify again - now it must genuinely pass
    const verifyCleanRes = await runCli(
      ['verify', '--findings', secretFinding.id, '--target-only', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(verifyCleanRes.exitCode).toBe(0);
    const verifyCleanJson = verifyCleanRes.json();
    expect(verifyCleanJson.status).toBe('PASS');
    expect(verifyCleanJson.targetsResolved).toBe(true);
    expect(verifyCleanJson.allResolved).toBe(true);
    expect(verifyCleanJson.resolved).toContain(secretFinding.id);
  });
});
