/**
 * tests/e2e/tier4-scenarios/scenario-b-ci-pr.e2e.test.ts
 * Tier 4 Scenario B: CI Pull-Request Branch Range Check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario B: CI Pull-Request Branch Range Check', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-b-');
    await setupGitGuardRepo(fixture);
    // Baseline commit on main
    await fixture.writeFile('src/main.ts', 'export const app = "gitguard";\n');
    await fixture.stage();
    await fixture.commit('initial main commit');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T4-SCEN-B1: CI blocks PR with failing check or secret blocker', async () => {
    // Create feature-auth branch
    await fixture.exec(['checkout', '-b', 'feature-auth']);
    await fixture.writeFile('src/auth.ts', 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage();
    await fixture.commit('feat: introduce auth with secret');

    // Run CI branch check: main..feature-auth
    const res = await runCli(['check', 'HEAD~1..HEAD', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
    expect(json.findings.length).toBeGreaterThan(0);
  });

  it('T4-SCEN-B2: CI passes PR with clean implementation and task', async () => {
    await fixture.exec(['checkout', '-b', 'feature-service']);
    await fixture.writeFile(
      'src/greeting.ts',
      'export class GreetingService { greet(name: string) { return `Hello, ${name}`; } }\n'
    );
    await fixture.stage();
    await fixture.commit('feat: add greeting service implementation');

    const res = await runCli(
      ['check', 'HEAD~1..HEAD', '--task', 'Add greeting service', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.status).toBe('PASS');
    expect(json.findings.length).toBe(0);
  });

  it('T4-SCEN-B3: CI formats PR check summary as JSON with required metrics', async () => {
    await fixture.exec(['checkout', '-b', 'feature-metrics']);
    await fixture.writeFile('src/metric.ts', 'export const count = 100;\n');
    await fixture.stage();
    await fixture.commit('feat: metrics');

    const res = await runCli(
      ['check', 'HEAD~1..HEAD', '--format', 'json', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json).toHaveProperty('diffSummary');
    expect(json).toHaveProperty('findings');
    expect(json).toHaveProperty('verdictSummary');
    expect(json).toHaveProperty('metadata');
    expect(json.metadata).toHaveProperty('headSha');
    expect(json.metadata.headSha).toBeTruthy();
  });
});
