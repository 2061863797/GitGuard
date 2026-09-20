/**
 * tests/e2e/tier3-pairwise/scope-policy.e2e.test.ts
 * Tier 3: Scope Isolation & Policy Combinations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 3: Scope Isolation & Policy Combinations', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scope-pol-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T3-SCP-01: Secret in working tree ignored when scope is --staged', async () => {
    // Baseline tracked file
    await fixture.writeFile('src/tracked.ts', 'const key = "clean_initial";\n');
    await fixture.stage();
    await fixture.commit('initial tracked');

    // 1. Clean staged file
    await fixture.writeFile('src/clean.ts', 'export const clean = 1;\n');
    await fixture.stage('src/clean.ts');

    // 2. Secret in unstaged working tree (tracked file modified)
    await fixture.writeFile('src/tracked.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    // --staged only inspects staged index
    const res = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.status).toBe('PASS');
    expect(json.findings.length).toBe(0);
  });

  it('T3-SCP-02: Secret in working tree caught with --working scope', async () => {
    await fixture.writeFile('src/tracked.ts', 'const key = "clean_initial";\n');
    await fixture.stage();
    await fixture.commit('initial tracked');

    await fixture.writeFile('src/clean.ts', 'export const clean = 1;\n');
    await fixture.stage('src/clean.ts');
    await fixture.writeFile('src/tracked.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const res = await runCli(['check', '--working', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
    expect(json.findings.length).toBeGreaterThan(0);
  });

  it('T3-SCP-03: Secret in working tree caught with --all scope', async () => {
    await fixture.writeFile('src/tracked.ts', 'const key = "clean_initial";\n');
    await fixture.stage();
    await fixture.commit('initial tracked');

    await fixture.writeFile('src/clean.ts', 'export const clean = 1;\n');
    await fixture.stage('src/clean.ts');
    await fixture.writeFile('src/tracked.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const res = await runCli(['check', '--all', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
  });

  it('T3-SCP-04: Strict mode converts WARN policy verdict into exit code 1', async () => {
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
    review: 0.85
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    // Touch 3 root dirs to trigger unrelated_changes (prob = 0.72 >= 0.50 WARN)
    await fixture.writeFile('dirA/file.ts', 'a\n');
    await fixture.writeFile('dirB/file.ts', 'b\n');
    await fixture.stage();

    // Standard run: WARN exits 0
    const normalRes = await runCli(['check', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(normalRes.exitCode).toBe(0);
    const normalJson = normalRes.json();
    expect(normalJson.status).toBe('WARN');

    // Strict run: WARN exits 1
    const strictRes = await runCli(['check', '--strict', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(strictRes.exitCode).toBe(1);
    const strictJson = strictRes.json();
    expect(strictJson.status).toBe('WARN');
  });

  it('T3-SCP-05: --fail-on-warn converts WARN policy verdict into exit code 1', async () => {
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
    review: 0.85
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('dirX/file.ts', 'x\n');
    await fixture.writeFile('dirY/file.ts', 'y\n');
    await fixture.stage();

    const res = await runCli(['check', '--fail-on-warn', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('WARN');
  });

  it('T3-SCP-06: Worst-case verdict hierarchy prioritizes BLOCK over WARN and REVIEW', async () => {
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
  unrelated_changes:
    enabled: true
    warn: 0.50
    review: 0.85
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    // Introduce secret (BLOCK) AND multiple directories (WARN)
    await fixture.writeFile('dir1/secret.ts', 'const s = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('dir2/file.ts', 'console.log(1);\n');
    await fixture.stage();

    const res = await runCli(['check', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
  });
});
