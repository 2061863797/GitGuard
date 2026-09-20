import { describe, it, expect, beforeEach } from 'vitest';
import { DefaultFindingManager, getDefaultExpectedEvidence } from '../../../src/findings/manager.js';
import type { RuleMatch } from '../../../src/types/policy.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { Finding } from '../../../src/types/finding.js';

describe('DefaultFindingManager', () => {
  let manager: DefaultFindingManager;
  let mockContext: EvaluationContext;

  beforeEach(() => {
    manager = new DefaultFindingManager();
    mockContext = {
      task: {
        task: 'Implement authentication token refresh',
        source: 'cli',
      },
      diff: {
        raw: 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -10,3 +10,4 @@\n-const oldAuth = true;\n+const newAuth = true;\n',
        files: [
          {
            newPath: 'src/auth.ts',
            status: 'modified',
            binary: false,
            additions: 1,
            deletions: 1,
            hunks: [
              {
                oldStart: 10,
                oldLines: 3,
                newStart: 10,
                newLines: 4,
                header: '@@ -10,3 +10,4 @@',
                lines: ['-const oldAuth = true;', '+const newAuth = true;'],
              },
            ],
          },
        ],
        insertions: 1,
        deletions: 1,
        truncated: false,
      },
      files: [],
      instructions: [],
      relatedTests: [],
      repository: {
        root: '/mock/repo',
        branch: 'main',
        headSha: 'abc123456789',
        isClean: false,
      },
    };
  });

  describe('createFindings', () => {
    it('should return empty array when ruleMatches is empty', () => {
      const findings = manager.createFindings([], mockContext);
      expect(findings).toEqual([]);
    });

    it('should create structured finding from RuleMatch and extract diff hunks', () => {
      const ruleMatches: RuleMatch[] = [
        {
          ruleId: 'tests_required',
          source: 'semantic',
          status: 'review',
          severity: 'ERROR',
          message: 'Behavior change requires test coverage',
          probability: 0.85,
          affectedFiles: ['src/auth.ts'],
          evidence: [
            {
              type: 'behavior_change',
              path: 'src/auth.ts',
              lines: '10-14',
              message: 'Authentication token modification',
            },
          ],
          expectedEvidence: [],
        },
      ];

      const findings = manager.createFindings(ruleMatches, mockContext);
      expect(findings).toHaveLength(1);

      const finding = findings[0];
      expect(finding.ruleId).toBe('tests_required');
      expect(finding.source).toBe('semantic');
      expect(finding.status).toBe('review');
      expect(finding.severity).toBe('ERROR');
      expect(finding.lifecycle).toBe('active');
      expect(finding.probability).toBe(0.85);
      expect(finding.affectedFiles).toEqual(['src/auth.ts']);
      expect(finding.message).toBe('Behavior change requires test coverage');
      expect(finding.id).toMatch(/^finding_tests_required_[a-f0-9]{8}$/);
      expect(finding.fingerprint).toHaveLength(64);
      expect(finding.expectedEvidence.length).toBeGreaterThan(0);
      expect(finding.createdAt).toBeDefined();
    });

    it('should fallback to evidence snippet when file hunks are not in context', () => {
      const ruleMatches: RuleMatch[] = [
        {
          ruleId: 'deterministic.lint',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          message: 'Lint errors detected in untracked file',
          affectedFiles: ['src/untracked.ts'],
          evidence: [
            {
              type: 'lint_error',
              path: 'src/untracked.ts',
              snippet: 'const x: any = 123;',
              message: 'Unexpected any',
            },
          ],
          expectedEvidence: ['Fix all lint errors'],
        },
      ];

      const findings = manager.createFindings(ruleMatches, mockContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].fingerprint).toHaveLength(64);
      expect(findings[0].expectedEvidence).toEqual(['Fix all lint errors']);
    });

    it('should fallback to rule message when both file hunks and evidence snippets are absent', () => {
      const ruleMatches: RuleMatch[] = [
        {
          ruleId: 'task_completed',
          source: 'semantic',
          status: 'block',
          severity: 'CRITICAL',
          message: 'Incomplete task requirements',
          affectedFiles: [],
          evidence: [],
          expectedEvidence: [],
        },
      ];

      const findings = manager.createFindings(ruleMatches, mockContext);
      expect(findings).toHaveLength(1);
      expect(findings[0].fingerprint).toHaveLength(64);
    });

    it('should attach metadata such as score if present on match', () => {
      const ruleMatches: RuleMatch[] = [
        {
          ruleId: 'regression_risk',
          source: 'semantic',
          status: 'warn',
          severity: 'WARN',
          message: 'Moderate regression risk',
          score: 'medium',
          affectedFiles: ['src/auth.ts'],
          evidence: [],
          expectedEvidence: [],
        },
      ];

      const findings = manager.createFindings(ruleMatches, mockContext);
      expect(findings[0].metadata).toEqual({ score: 'medium' });
    });
  });

  describe('computeFingerprint', () => {
    it('should compute fingerprint from FindingFingerprintInput', () => {
      const fp = manager.computeFingerprint({
        ruleId: 'tests_required',
        affectedFiles: ['src/auth.ts'],
        normalizedDiffHunks: '+function verifyToken() {}',
      });

      expect(fp).toHaveLength(64);
    });

    it('should compute fingerprint from Omit<Finding, "id" | "fingerprint">', () => {
      const partialFinding: Omit<Finding, 'id' | 'fingerprint'> = {
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'ERROR',
        lifecycle: 'active',
        affectedFiles: ['src/auth.ts'],
        message: 'Missing tests',
        evidence: [
          {
            type: 'missing_test',
            snippet: '+function verifyToken() {}',
          },
        ],
        expectedEvidence: [],
        createdAt: new Date().toISOString(),
      };

      const fp = manager.computeFingerprint(partialFinding);
      expect(fp).toHaveLength(64);
    });
  });

  describe('resolveFindings', () => {
    it('should mark all findings as resolved when fresh findings is empty', () => {
      const prevFinding: Finding = {
        id: 'finding_01',
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'ERROR',
        lifecycle: 'active',
        affectedFiles: ['src/auth.ts'],
        message: 'Tests needed',
        evidence: [],
        expectedEvidence: ['Add tests'],
        fingerprint: '1111111111111111111111111111111111111111111111111111111111111111',
        createdAt: '2026-09-20T00:00:00.000Z',
      };

      const report = manager.resolveFindings([prevFinding], []);

      expect(report.status).toBe('PASS');
      expect(report.resolved).toEqual(['finding_01']);
      expect(report.remaining).toEqual([]);
      expect(report.resolvedFindings).toEqual(['finding_01']);
      expect(report.remainingFindings).toEqual([]);
      expect(report.findings).toEqual([]);
      expect(report.verdictSummary).toContain('All 1 finding(s) successfully resolved');
    });

    it('should preserve finding ID and creation timestamp for persistent findings', () => {
      const prevFinding: Finding = {
        id: 'finding_persistent',
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'ERROR',
        lifecycle: 'active',
        affectedFiles: ['src/auth.ts'],
        message: 'Tests still needed',
        evidence: [],
        expectedEvidence: ['Add tests'],
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        createdAt: '2026-09-20T00:00:00.000Z',
      };

      const freshFinding: Finding = {
        id: 'finding_new_temp_id',
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'ERROR',
        lifecycle: 'active',
        affectedFiles: ['src/auth.ts'],
        message: 'Tests still needed',
        evidence: [],
        expectedEvidence: ['Add tests'],
        fingerprint: '2222222222222222222222222222222222222222222222222222222222222222',
        createdAt: '2026-09-20T01:00:00.000Z',
      };

      const report = manager.resolveFindings([prevFinding], [freshFinding]);

      expect(report.status).toBe('REVIEW');
      expect(report.resolved).toEqual([]);
      expect(report.remaining).toEqual(['finding_persistent']);
      expect(report.findings[0].id).toBe('finding_persistent');
      expect(report.findings[0].createdAt).toBe('2026-09-20T00:00:00.000Z');
      expect(report.verdictSummary).toContain('Gate status: REVIEW');
    });

    it('should correctly partition resolved, persistent, and new findings in mixed scenarios', () => {
      const fpResolved = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const fpPersistent = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const fpNew = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

      const prevFindings: Finding[] = [
        {
          id: 'finding_resolved',
          ruleId: 'deterministic.test',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          lifecycle: 'active',
          affectedFiles: ['src/a.ts'],
          message: 'Test failed',
          evidence: [],
          expectedEvidence: [],
          fingerprint: fpResolved,
          createdAt: '2026-09-20T00:00:00.000Z',
        },
        {
          id: 'finding_persistent',
          ruleId: 'unrelated_changes',
          source: 'semantic',
          status: 'warn',
          severity: 'WARN',
          lifecycle: 'active',
          affectedFiles: ['src/b.ts'],
          message: 'Extraneous file',
          evidence: [],
          expectedEvidence: [],
          fingerprint: fpPersistent,
          createdAt: '2026-09-20T00:00:00.000Z',
        },
      ];

      const freshFindings: Finding[] = [
        {
          id: 'finding_persistent_fresh',
          ruleId: 'unrelated_changes',
          source: 'semantic',
          status: 'warn',
          severity: 'WARN',
          lifecycle: 'active',
          affectedFiles: ['src/b.ts'],
          message: 'Extraneous file',
          evidence: [],
          expectedEvidence: [],
          fingerprint: fpPersistent,
          createdAt: '2026-09-20T01:00:00.000Z',
        },
        {
          id: 'finding_brand_new',
          ruleId: 'tests_required',
          source: 'semantic',
          status: 'review',
          severity: 'ERROR',
          lifecycle: 'active',
          affectedFiles: ['src/c.ts'],
          message: 'New untested code',
          evidence: [],
          expectedEvidence: [],
          fingerprint: fpNew,
          createdAt: '2026-09-20T01:00:00.000Z',
        },
      ];

      const report = manager.resolveFindings(prevFindings, freshFindings);

      expect(report.status).toBe('REVIEW'); // 'review' dominates 'warn'
      expect(report.resolved).toEqual(['finding_resolved']);
      expect(report.remaining).toEqual(['finding_persistent', 'finding_brand_new']);
      expect(report.findings).toHaveLength(2);
      expect(report.findings.find((f) => f.id === 'finding_persistent')).toBeDefined();
      expect(report.findings.find((f) => f.id === 'finding_brand_new')).toBeDefined();
    });

    it('should return PASS when both previous and fresh findings are empty', () => {
      const report = manager.resolveFindings([], []);
      expect(report.status).toBe('PASS');
      expect(report.resolved).toEqual([]);
      expect(report.remaining).toEqual([]);
      expect(report.verdictSummary).toContain('All checks passed cleanly with 0 active findings');
    });

    it('should return BLOCK when remaining findings include a block finding', () => {
      const freshFindings: Finding[] = [
        {
          id: 'f_block',
          ruleId: 'deterministic.test',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          lifecycle: 'active',
          affectedFiles: ['src/a.ts'],
          message: 'Broken test',
          evidence: [],
          expectedEvidence: [],
          fingerprint: 'block_fp_1',
          createdAt: new Date().toISOString(),
        },
      ];

      const report = manager.resolveFindings([], freshFindings);
      expect(report.status).toBe('BLOCK');
      expect(report.remaining).toEqual(['f_block']);
    });

    it('should return WARN when remaining findings only contain warn findings', () => {
      const freshFindings: Finding[] = [
        {
          id: 'f_warn',
          ruleId: 'unrelated_changes',
          source: 'semantic',
          status: 'warn',
          severity: 'WARN',
          lifecycle: 'active',
          affectedFiles: ['src/b.ts'],
          message: 'Extra docs',
          evidence: [],
          expectedEvidence: [],
          fingerprint: 'warn_fp_1',
          createdAt: new Date().toISOString(),
        },
      ];

      const report = manager.resolveFindings([], freshFindings);
      expect(report.status).toBe('WARN');
      expect(report.remaining).toEqual(['f_warn']);
    });
  });

  describe('Finding Store & Queries', () => {
    it('should store findings and allow filtering by ruleId, status, and file', () => {
      const finding1: Finding = {
        id: 'f1',
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'ERROR',
        lifecycle: 'active',
        affectedFiles: ['src/auth.ts'],
        message: 'm1',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp1',
        createdAt: '2026-09-20T00:00:00.000Z',
      };
      const finding2: Finding = {
        id: 'f2',
        ruleId: 'deterministic.lint',
        source: 'deterministic',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        affectedFiles: ['src/payment.ts'],
        message: 'm2',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp2',
        createdAt: '2026-09-20T00:00:00.000Z',
      };

      manager.storeFinding(finding1);
      manager.storeFinding(finding2);

      expect(manager.getFindings()).toHaveLength(2);
      expect(manager.getFindings({ ruleId: 'tests_required' })).toEqual([finding1]);
      expect(manager.getFindings({ status: 'block' })).toEqual([finding2]);
      expect(manager.getFindings({ severity: 'ERROR' })).toEqual([finding1]);
      expect(manager.getFindings({ file: 'src/auth.ts' })).toEqual([finding1]);
      expect(manager.getFindings({ file: 'src\\auth.ts' })).toEqual([finding1]);
      expect(manager.getFindings({ lifecycle: 'active' })).toHaveLength(2);

      manager.clear();
      expect(manager.getFindings()).toHaveLength(0);
    });
  });

  describe('getDefaultExpectedEvidence', () => {
    it('should return appropriate instructions for various rule IDs', () => {
      expect(getDefaultExpectedEvidence('deterministic.test', 'block')).toContain(
        'Fix all failing tests reported in the execution output.'
      );
      expect(getDefaultExpectedEvidence('deterministic.lint', 'block')).toContain(
        'Resolve all reported linting errors and formatting violations.'
      );
      expect(getDefaultExpectedEvidence('deterministic.typecheck', 'block')).toContain(
        'Fix TypeScript compiler errors and type mismatches.'
      );
      expect(getDefaultExpectedEvidence('deterministic.secret_scan', 'block')).toContain(
        'Remove sensitive credentials, tokens, or private keys from the diff.'
      );
      expect(getDefaultExpectedEvidence('task_completed', 'review')).toContain(
        'Implement the missing requirements declared in the task specification.'
      );
      expect(getDefaultExpectedEvidence('unrelated_changes', 'warn')).toContain(
        'Remove or isolate changes that are not directly relevant to the assigned task.'
      );
      expect(getDefaultExpectedEvidence('tests_required', 'review')).toContain(
        'Add automated unit or integration tests that exercise the newly added or modified logic.'
      );
      expect(getDefaultExpectedEvidence('security_sensitive', 'review')).toContain(
        'Perform a security review on authentication, cryptography, or permission modifications.'
      );
      expect(getDefaultExpectedEvidence('regression_risk', 'warn')).toContain(
        'Provide regression tests verifying backward compatibility.'
      );
      expect(getDefaultExpectedEvidence('custom_generic_rule', 'review')).toContain(
        "Remediate the policy violation identified by rule 'custom_generic_rule'."
      );
    });
  });
});
