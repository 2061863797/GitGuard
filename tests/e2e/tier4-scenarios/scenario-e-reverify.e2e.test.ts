/**
 * tests/e2e/tier4-scenarios/scenario-e-reverify.e2e.test.ts
 * Tier 4 Scenario E: Targeted Multi-Finding Remediation Loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario E: Targeted Multi-Finding Remediation Loop', () => {
  let fixture: GitFixture;

  const customConfig = `
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
  unrelated_changes:
    enabled: true
    block: 0.70
`;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-e-');
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.stage('.gitguard.yml');
    await fixture.commit('chore: init config');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T4-SCEN-E1: Detects multiple concurrent findings with unique fingerprints', async () => {
    await fixture.writeFile('dirA/aws.ts', 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('dirB/fileB.ts', 'console.log("b");\n');
    await fixture.writeFile('dirC/fileC.ts', 'console.log("c");\n');
    await fixture.stage();

    const res = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
    expect(json.findings.length).toBeGreaterThanOrEqual(2);

    const fingerprints = new Set(json.findings.map((f: any) => f.fingerprint));
    expect(fingerprints.size).toBe(json.findings.length);
  });

  it('T4-SCEN-E2: Targeted single-finding resolution resolves targeted finding ID', async () => {
    // 1. Introduce 2 findings
    await fixture.writeFile('dirA/aws.ts', 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('dirB/fileB.ts', 'console.log("b");\n');
    await fixture.writeFile('dirC/fileC.ts', 'console.log("c");\n');
    await fixture.stage();

    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    const checkJson = checkRes.json();
    const secretFinding = checkJson.findings.find((f: any) =>
      f.id.includes('secret_scan')
    );
    expect(secretFinding).toBeDefined();

    // 2. Fix ONLY the secret
    await fixture.writeFile('dirA/aws.ts', 'export const key = "clean_value";\n');
    await fixture.stage('dirA/aws.ts');

    // 3. Verify targeted finding ID
    const verifyRes = await runCli(
      ['verify', '--findings', secretFinding.id, '--scope', 'staged', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(verifyRes.exitCode).toBe(0);
    const verifyJson = verifyRes.json();
    expect(verifyJson.status).toBe('PASS');
    expect(verifyJson.resolved).toContain(secretFinding.id);
  });

  it('T4-SCEN-E3: Global verification confirms remaining finding until all resolved', async () => {
    // 1. Introduce 2 findings
    await fixture.writeFile('dirA/aws.ts', 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('dirB/fileB.ts', 'console.log("b");\n');
    await fixture.writeFile('dirC/fileC.ts', 'console.log("c");\n');
    await fixture.stage();

    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    const checkJson = checkRes.json();
    const allIds = checkJson.findings.map((f: any) => f.id);
    expect(allIds.length).toBeGreaterThanOrEqual(2);

    // 2. Fix only the secret
    await fixture.writeFile('dirA/aws.ts', 'export const key = "clean_value";\n');
    await fixture.stage('dirA/aws.ts');

    // 3. Verify both findings -> remaining unrelated_changes finding blocks
    const partialVerify = await runCli(
      ['verify', '--findings', allIds.join(','), '--scope', 'staged', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(partialVerify.exitCode).toBe(1);
    const partialJson = partialVerify.json();
    expect(partialJson.status).toBe('BLOCK');
    expect(partialJson.resolved.length).toBeGreaterThan(0);
    expect(partialJson.remaining.length).toBeGreaterThan(0);

    // 4. Revert unrelated directories
    await fixture.deleteFile('dirB/fileB.ts');
    await fixture.deleteFile('dirC/fileC.ts');
    await fixture.stage();

    // 5. Verify again -> everything passes cleanly
    const fullVerify = await runCli(
      ['verify', '--findings', allIds.join(','), '--scope', 'staged', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(fullVerify.exitCode).toBe(0);
    const fullJson = fullVerify.json();
    expect(fullJson.status).toBe('PASS');
    expect(fullJson.remaining.length).toBe(0);
  });
});
