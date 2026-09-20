/**
 * tests/e2e/tier3-pairwise/cli-lifecycle.e2e.test.ts
 * Tier 3: Cross-Feature Combinations - CLI Verification Lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 3: CLI Verification Lifecycle', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-lc-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T3-CLI-LC-01: Full lifecycle (Secret -> Check BLOCK -> Remove -> Verify PASS)', async () => {
    // 1. Add secret and stage
    await fixture.writeFile('src/config.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/config.ts');

    // 2. Check returns BLOCK with finding ID
    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(checkRes.exitCode).toBe(1);
    const checkJson = checkRes.json();
    expect(checkJson.status).toBe('BLOCK');
    expect(checkJson.findings.length).toBeGreaterThan(0);
    const findingId = checkJson.findings[0].id;

    // 3. Remove secret and stage
    await fixture.writeFile('src/config.ts', 'const key = process.env.AWS_KEY;\n');
    await fixture.stage('src/config.ts');

    // 4. Verify targeted finding
    const verifyRes = await runCli(
      ['verify', '--findings', findingId, '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(verifyRes.exitCode).toBe(0);
    const verifyJson = verifyRes.json();
    expect(verifyJson.status).toBe('PASS');
    expect(verifyJson.resolved).toContain(findingId);
    expect(verifyJson.remaining).toHaveLength(0);
  });

  it('T3-CLI-LC-02: Task completion lifecycle resolves semantic check', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan: { enabled: false }
rules:
  task_completed:
    enabled: true
    review_below: 0.95
    block_below: 0.20
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('src/unrelated.ts', 'export const x = 1;\n');
    await fixture.stage('src/unrelated.ts');

    const checkRes = await runCli(
      ['check', '--task', 'Build complete billing engine', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(checkRes.json().status).toBe('REVIEW');

    // Add matching code
    await fixture.writeFile('src/billing.ts', 'export class BillingEngine {}\n');
    await fixture.stage();

    const verifyRes = await runCli(
      ['verify', '--findings', 'GG-DUMMY', '--task', 'Build complete billing engine', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(verifyRes.exitCode).toBe(0);
    expect(verifyRes.json().status).toBe('PASS');
  });

  it('T3-CLI-LC-03: Multi-step workflow with --strict enforcement', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan: { enabled: false }
rules:
  security_sensitive: { enabled: false }
  tests_required: { enabled: false }
  unrelated_changes:
    enabled: true
    warn: 0.50
    review: 0.80
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('dir1/file1.ts', 'export const a = 1;\n');
    await fixture.writeFile('dir2/file2.ts', 'export const b = 2;\n');
    await fixture.stage();

    // 1. Strict mode fails on WARN
    const outcome1 = await runCli(
      ['check', '--task', 'Only touch dir1', '--strict', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome1.exitCode).toBe(1);

    // 2. Fix code to clean state
    await fixture.deleteFile('dir2/file2.ts');
    await fixture.stage();

    // 3. Strict mode passes on single directory
    const outcome2 = await runCli(
      ['check', '--task', 'Work on dir1', '--strict', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome2.exitCode).toBe(0);
  });

  it('T3-CLI-LC-04: Incomplete fix partitions into resolved and remaining findings', async () => {
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
custom_rules:
  - id: forbid_eval
    description: "Forbid eval"
    files: ["src/**"]
    question: "Does this change introduce dangerous eval usage?"
    primitive: noul
    block: 0.1
`;
    await fixture.writeFile('.gitguard.yml', customConfig);

    // 1. Introduce secret in aws.ts and dangerous eval in eval.ts
    await fixture.writeFile('src/aws.ts', 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('src/eval.ts', 'eval("dangerousCode();");\n');
    await fixture.stage();

    const checkRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(checkRes.exitCode).toBe(1);
    const checkJson = checkRes.json();
    expect(checkJson.findings.length).toBeGreaterThanOrEqual(2);
    const findingIds = checkJson.findings.map((f: any) => f.id);

    // 2. Remove ONLY the secret in aws.ts
    await fixture.writeFile('src/aws.ts', 'const k = "cleanKey";\n');
    await fixture.stage('src/aws.ts');

    // 3. Verify both findings
    const verifyRes = await runCli(
      ['verify', '--findings', findingIds.join(','), '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(verifyRes.exitCode).toBe(1);
    const verifyJson = verifyRes.json();
    expect(verifyJson.status).toBe('BLOCK');
    expect(verifyJson.resolved.length).toBeGreaterThan(0);
    expect(verifyJson.remaining.length).toBeGreaterThan(0);
  });
});
