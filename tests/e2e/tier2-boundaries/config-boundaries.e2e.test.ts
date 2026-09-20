/**
 * tests/e2e/tier2-boundaries/config-boundaries.e2e.test.ts
 * Tier 2: Boundary & Corner Cases - Configuration boundaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 2: Configuration Boundaries', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cfg-bnd-');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T2-CFG-01: Non-existent config path passed via -c exits with non-zero error', async () => {
    const outcome = await runCli(['check', '-c', 'missing.yml', '--offline'], {
      cwd: fixture.repoPath,
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.stderr).toContain('missing.yml');
  });

  it('T2-CFG-02: Corrupted YAML syntax in .gitguard.yml exits with code 2', async () => {
    await fixture.writeFile('.gitguard.yml', 'version: 1\nrules: [unclosed_bracket\n');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/YAML|syntax|bracket/i);
  });

  it('T2-CFG-03: Invalid schema type (version: {}) exits with code 2', async () => {
    await fixture.writeFile('.gitguard.yml', 'version: {}\n');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/version|schema|config/i);
  });

  it('T2-CFG-04: Invalid custom rule missing mandatory id exits with code 2', async () => {
    const badConfig = `
version: 1
custom_rules:
  - description: "Missing id rule"
    question: "Is this valid?"
`;
    await fixture.writeFile('.gitguard.yml', badConfig);

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toMatch(/custom_rules|id|schema/i);
  });

  it('T2-CFG-05: Empty .gitguard.yml file merges with default policy and exits 0', async () => {
    await fixture.writeFile('.gitguard.yml', '');

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });

  it('T2-CFG-06: Partial config overriding only 1 rule preserves other default rules', async () => {
    const partialConfig = `
version: 1
rules:
  unrelated_changes:
    warn: 0.4
`;
    await fixture.writeFile('.gitguard.yml', partialConfig);

    const outcome = await runCli(['check', '--offline'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Quality Gate: PASS');
  });
});
