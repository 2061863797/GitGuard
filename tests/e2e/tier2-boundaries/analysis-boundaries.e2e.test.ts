/**
 * tests/e2e/tier2-boundaries/analysis-boundaries.e2e.test.ts
 * Tier 2: Boundary & Corner Cases - Analysis & Secret Scanner boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 2: Analysis & Secret Scanner Boundaries', () => {
  let fixture: GitFixture;

  const secretScanTestConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan:
    enabled: true
    block_on_detection: true
rules:
  security_sensitive:
    enabled: false
  tests_required:
    enabled: false
`;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-ana-bnd-');
    await setupGitGuardRepo(fixture, secretScanTestConfig);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T2-ANA-01: Ignores common false positive placeholder string', async () => {
    await fixture.writeFile('src/config.ts', 'const apiKey = "placeholder";\n');
    await fixture.stage('src/config.ts');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T2-ANA-02: Ignores placeholder string changeme', async () => {
    await fixture.writeFile('src/auth.ts', 'const password = "CHANGEME";\n');
    await fixture.stage('src/auth.ts');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T2-ANA-03: Redacts secret in output and never prints raw credentials', async () => {
    const rawSecret = 'AKIAIOSFODNN7EXAMPLE';
    await fixture.writeFile('src/aws.ts', `const awsKey = "${rawSecret}";\n`);
    await fixture.stage('src/aws.ts');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: BLOCK');
    expect(outcome.stdout).not.toContain(rawSecret);
    expect(outcome.stdout).toMatch(/REDACTED|\*\*\*/);
  });

  it('T2-ANA-04: Consecutive multiline window scanner detects split secret', async () => {
    const multilineSecret = 'const clientSecret =\n  "sk-1234567890abcdef1234567890abcdef12345678";\n';
    await fixture.writeFile('src/multiline.ts', multilineSecret);
    await fixture.stage('src/multiline.ts');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: BLOCK');
  });

  it('T2-ANA-05: Deduplicates identical rule violations in same file', async () => {
    const duplicateSecrets = `
const key1 = "AKIAIOSFODNN7EXAMPLE";
const key2 = "AKIAIOSFODNN7EXAMPLE";
`;
    await fixture.writeFile('src/duplicate.ts', duplicateSecrets);
    await fixture.stage('src/duplicate.ts');

    const outcome = await runCli(['check', '--json', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(1);
    const json = outcome.json();
    const secretFindings = json.findings.filter(
      (f: any) => f.ruleId === 'deterministic.secret_scan'
    );
    // Unique fingerprints for findings
    const fingerprints = new Set(secretFindings.map((f: any) => f.fingerprint));
    expect(fingerprints.size).toBe(secretFindings.length);
  });

  it('T2-ANA-06: Bypasses secret detection when secret_scan is disabled', async () => {
    const disabledConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan:
    enabled: false
rules:
  security_sensitive:
    enabled: false
  tests_required:
    enabled: false
`;
    await fixture.writeFile('.gitguard.yml', disabledConfig);
    await fixture.writeFile('src/bypass.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/bypass.ts');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });
});
