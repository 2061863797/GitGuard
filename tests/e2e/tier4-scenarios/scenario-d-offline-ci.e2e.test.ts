/**
 * tests/e2e/tier4-scenarios/scenario-d-offline-ci.e2e.test.ts
 * Tier 4 Scenario D: Air-Gapped Offline CI Run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario D: Air-Gapped Offline CI Run', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-d-');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T4-SCEN-D1: Executes without TYPESAFE_API_KEY without network errors', async () => {
    await setupGitGuardRepo(fixture);
    await fixture.writeFile('src/app.ts', 'export const server = 1;\n');
    await fixture.stage('src/app.ts');

    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;

    const res = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
      env,
    });
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.status).toBe('PASS');
    expect(json.findings.length).toBe(0);
  });

  it('T4-SCEN-D2: Deterministic fallback heuristics execute predictably', async () => {
    await setupGitGuardRepo(fixture);
    await fixture.writeFile('src/calc.ts', 'export function multiply(a: number, b: number) { return a * b; }\n');
    await fixture.stage('src/calc.ts');

    const res = await runCli(
      ['check', '--staged', '--task', 'Implement multiplication math function', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.semanticDecisions).toHaveProperty('task_completed');
    expect(json.semanticDecisions).toHaveProperty('unrelated_changes');
    expect(json.semanticDecisions).toHaveProperty('tests_required');
    expect(json.semanticDecisions.task_completed.provider).toBe('mock');
  });

  it('T4-SCEN-D3: Zero-config default fallback in offline CI', async () => {
    // Zero-config repo (no .gitguard.yml)
    await fixture.writeFile('src/lib.ts', 'export const version = "2.0.0";\n');
    await fixture.stage();
    await fixture.commit('initial commit');

    const res = await runCli(['check', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.status).toBe('PASS');
  });
});
