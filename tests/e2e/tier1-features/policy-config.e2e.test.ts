/**
 * tests/e2e/tier1-features/policy-config.e2e.test.ts
 * Tier 1: Feature Coverage - Policy Configuration & Baseline Defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 1: Policy Configuration & Baseline Defaults', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cfg-');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CFG-01: Zero-config repository falls back gracefully to default policy', async () => {
    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T1-CFG-02: Evaluates custom repository semantic rules defined in .gitguard.yml', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan: { enabled: false }
custom_rules:
  - id: check_license_headers
    description: "Ensure license header exists"
    files: ["src/**"]
    question: "Does this file contain an Apache-2.0 license header?"
    primitive: noul
    warn: 0.1
    review: 0.5
    block: 0.9
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('src/test.ts', 'export const a = 1;\n');
    await fixture.stage('src/test.ts');

    const outcome = await runCli(['check', '--offline', '--json'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    const json = outcome.json();
    expect(json).toHaveProperty('status');
  });

  it('T1-CFG-03: Honors explicit --config path over root .gitguard.yml', async () => {
    await fixture.writeFile('.gitguard.yml', 'version: 1\n');
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
    warn: 0.01
`;
    await fixture.writeFile('configs/custom.yml', customConfig);
    await fixture.writeFile('file.txt', 'hello\n');
    await fixture.stage('file.txt');

    const outcome = await runCli(
      ['check', '-c', 'configs/custom.yml', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate:');
  });

  it('T1-CFG-04: Highly sensitive threshold override triggers warning', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan: { enabled: false }
rules:
  security_sensitive:
    enabled: false
  tests_required:
    enabled: false
  unrelated_changes:
    enabled: true
    warn: 0.01
    review: 0.8
    block: 0.95
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('dir1/a.ts', 'export const a = 1;\n');
    await fixture.writeFile('dir2/b.ts', 'export const b = 2;\n');
    await fixture.stage();

    const outcome = await runCli(
      ['check', '--task', 'Only touch dir1', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: WARN');
  });

  it('T1-CFG-05: Inverted threshold (block_below: 0.9) triggers BLOCK on low task completion', async () => {
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
    block_below: 0.90
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('src/app.ts', 'export const test = 123;\n');
    await fixture.stage('src/app.ts');

    const outcome = await runCli(
      ['check', '--task', 'Build an entire rocket engine subsystem', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: BLOCK');
  });

  it('T1-CFG-06: Handles YAML with anchors, aliases, and comments cleanly', async () => {
    const complexYaml = `
version: 1
common_thresholds: &defaults
  warn: 0.5
  review: 0.7
  block: 0.9

rules:
  unrelated_changes:
    enabled: true
    <<: *defaults
`;
    await fixture.writeFile('.gitguard.yml', complexYaml);

    const outcome = await runCli(['inspect'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Inspect Summary');
  });
});
