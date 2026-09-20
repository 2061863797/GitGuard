/**
 * tests/e2e/tier4-scenarios/scenario-a-pre-commit.e2e.test.ts
 * Tier 4 Scenario A: Developer Pre-Commit Hook Simulation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  runCli,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario A: Developer Pre-Commit Hook Simulation', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-a-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T4-SCEN-A1: Pre-commit hook blocks accidental secret leak', async () => {
    const rsaKey = `export const privateKey = \`-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1234567890abcdefghijklmnopqrstuvwxyzABCDEFGH
-----END RSA PRIVATE KEY-----\`;\n`;
    await fixture.writeFile('src/server.ts', rsaKey);
    await fixture.stage('src/server.ts');

    const res = await runCli(
      ['check', '--staged', '--strict', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(res.exitCode).toBe(1);
    const json = res.json();
    expect(json.status).toBe('BLOCK');
    expect(json.findings.length).toBeGreaterThan(0);
    expect(json.findings[0].affectedFiles).toContain('src/server.ts');
    expect(json.findings[0].expectedEvidence.length).toBeGreaterThan(0);
  });

  it('T4-SCEN-A2: Pre-commit allows clean commit after secret removal', async () => {
    // 1. Initial blocked state
    await fixture.writeFile(
      'src/server.ts',
      'export const key = "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----";\n'
    );
    await fixture.stage('src/server.ts');
    const blockedRes = await runCli(
      ['check', '--staged', '--strict', '--offline'],
      { cwd: fixture.repoPath }
    );
    expect(blockedRes.exitCode).toBe(1);

    // 2. Developer remediates by removing secret and committing clean code
    await fixture.writeFile('src/server.ts', 'export const port = 3000;\n');
    await fixture.stage('src/server.ts');

    const cleanRes = await runCli(
      ['check', '--staged', '--strict', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(cleanRes.exitCode).toBe(0);
    const json = cleanRes.json();
    expect(json.status).toBe('PASS');
    expect(json.findings.length).toBe(0);

    // Verify git commit succeeds
    const head = await fixture.commit('feat: clean app implementation');
    expect(head).toBeTruthy();
  });

  it('T4-SCEN-A3: Pre-commit hook strictly evaluates staged changes only', async () => {
    // Baseline commit
    await fixture.writeFile('src/tracked.ts', 'console.log("init");\n');
    await fixture.stage();
    await fixture.commit('init');

    // Clean staged file
    await fixture.writeFile('src/app.ts', 'export const version = "1.0.0";\n');
    await fixture.stage('src/app.ts');

    // Unstaged draft containing secret in working directory
    await fixture.writeFile('src/draft.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');

    const res = await runCli(
      ['check', '--staged', '--strict', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(res.exitCode).toBe(0);
    const json = res.json();
    expect(json.status).toBe('PASS');
  });
});
