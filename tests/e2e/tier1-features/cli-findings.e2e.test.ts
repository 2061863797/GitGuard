/**
 * tests/e2e/tier1-features/cli-findings.e2e.test.ts
 * Tier 1: Feature Coverage - CLI `findings` subcommand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runCli, setupGitGuardRepo, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';
import { findingsCommand } from '../../../src/interfaces/cli/findings.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import type { Finding } from '../../../src/types/finding.js';

describe('Tier 1: CLI findings subcommand', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-fnd-');
    await setupGitGuardRepo(fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CLI-FND-01: Displays active finding details in text format', async () => {
    const engine = new DefaultGitGuardEngine();
    const mockFinding: Finding = {
      id: 'F-DETERMINISTIC-SECRET-001',
      ruleId: 'deterministic.secret_scan',
      source: 'deterministic',
      status: 'block',
      severity: 'CRITICAL',
      lifecycle: 'active',
      affectedFiles: ['src/config.ts'],
      message: 'Unredacted AWS access key detected',
      evidence: [],
      expectedEvidence: ['Remove the leaked key.'],
      fingerprint: 'abcd1234efgh5678',
      createdAt: new Date().toISOString(),
    };
    (engine as any).findingManager.storeFinding(mockFinding);

    const outcome = await findingsCommand({ silent: true }, engine);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.output).toContain('F-DETERMINISTIC-SECRET-001');
    expect(outcome.output).toContain('CRITICAL');
    expect(outcome.output).toContain('Unredacted AWS access key detected');
    expect(outcome.output).toContain('deterministic.secret_scan');
  });

  it('T1-CLI-FND-02: Returns JSON array of findings with --json', async () => {
    const engine = new DefaultGitGuardEngine();
    const mockFinding: Finding = {
      id: 'F-DETERMINISTIC-SECRET-002',
      ruleId: 'deterministic.secret_scan',
      source: 'deterministic',
      status: 'block',
      severity: 'CRITICAL',
      lifecycle: 'active',
      affectedFiles: ['src/token.ts'],
      message: 'Staged secret token',
      evidence: [],
      expectedEvidence: ['Rotate token.'],
      fingerprint: 'fedcba9876543210',
      createdAt: new Date().toISOString(),
    };
    (engine as any).findingManager.storeFinding(mockFinding);

    const outcome = await findingsCommand({ json: true, silent: true }, engine);
    expect(outcome.exitCode).toBe(0);
    const json = JSON.parse(outcome.output);
    expect(Array.isArray(json)).toBe(true);
    expect(json[0].id).toBe('F-DETERMINISTIC-SECRET-002');
    expect(json[0].fingerprint).toBe('fedcba9876543210');
    expect(json[0].severity).toBe('CRITICAL');
  });

  it('T1-CLI-FND-03: Filters findings by severity', async () => {
    const engine = new DefaultGitGuardEngine();
    const criticalFinding: Finding = {
      id: 'F-CRIT-1',
      ruleId: 'rule_crit',
      source: 'deterministic',
      status: 'block',
      severity: 'CRITICAL',
      lifecycle: 'active',
      affectedFiles: ['a.ts'],
      message: 'Critical error',
      evidence: [],
      expectedEvidence: [],
      fingerprint: '1111',
      createdAt: new Date().toISOString(),
    };
    const warnFinding: Finding = {
      id: 'F-WARN-1',
      ruleId: 'rule_warn',
      source: 'semantic',
      status: 'warn',
      severity: 'WARN',
      lifecycle: 'active',
      affectedFiles: ['b.ts'],
      message: 'Advisory warning',
      evidence: [],
      expectedEvidence: [],
      fingerprint: '2222',
      createdAt: new Date().toISOString(),
    };
    (engine as any).findingManager.storeFinding(criticalFinding);
    (engine as any).findingManager.storeFinding(warnFinding);

    const outcome = await findingsCommand(
      { severity: 'CRITICAL', json: true, silent: true },
      engine
    );
    expect(outcome.exitCode).toBe(0);
    const json = JSON.parse(outcome.output);
    expect(json).toHaveLength(1);
    expect(json[0].severity).toBe('CRITICAL');
    expect(json[0].id).toBe('F-CRIT-1');
  });

  it('T1-CLI-FND-04: Filters findings by rule ID', async () => {
    const engine = new DefaultGitGuardEngine();
    const secretFinding: Finding = {
      id: 'F-SEC-1',
      ruleId: 'deterministic.secret_scan',
      source: 'deterministic',
      status: 'block',
      severity: 'CRITICAL',
      lifecycle: 'active',
      affectedFiles: ['c.ts'],
      message: 'Secret detected',
      evidence: [],
      expectedEvidence: [],
      fingerprint: '3333',
      createdAt: new Date().toISOString(),
    };
    const otherFinding: Finding = {
      id: 'F-OTH-1',
      ruleId: 'other_rule',
      source: 'semantic',
      status: 'warn',
      severity: 'WARN',
      lifecycle: 'active',
      affectedFiles: ['d.ts'],
      message: 'Other issue',
      evidence: [],
      expectedEvidence: [],
      fingerprint: '4444',
      createdAt: new Date().toISOString(),
    };
    (engine as any).findingManager.storeFinding(secretFinding);
    (engine as any).findingManager.storeFinding(otherFinding);

    const outcome = await findingsCommand(
      { rule: 'deterministic.secret_scan', json: true, silent: true },
      engine
    );
    expect(outcome.exitCode).toBe(0);
    const json = JSON.parse(outcome.output);
    expect(json).toHaveLength(1);
    expect(json[0].ruleId).toBe('deterministic.secret_scan');
  });

  it('T1-CLI-FND-05: Clean repository reports zero active findings via CLI subprocess', async () => {
    const outcome = await runCli(['findings', '--cwd', fixture.repoPath]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('GitGuard Active Findings (0)');
    expect(outcome.stdout).toContain('No active findings found.');
  });
});
