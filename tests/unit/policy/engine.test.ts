import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultPolicyEngine,
  synthesizeGateVerdict,
  matchesGlob,
  filterMatchingFiles,
  evaluateNumericalThreshold,
  evaluateScoreThreshold,
  DEFAULT_BUILTIN_RULES,
  getEffectiveBuiltinRule,
  evaluateSemanticRuleMatch,
} from '../../../src/policy/index.js';
import type { PolicyConfig, CustomPolicyRule } from '../../../src/types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../../../src/types/provider.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import { DefaultFindingManager } from '../../../src/findings/manager.js';

describe('Policy Engine & Rule Evaluators', () => {
  describe('synthesizeGateVerdict', () => {
    it('should return PASS on empty array or undefined', () => {
      expect(synthesizeGateVerdict([])).toBe('PASS');
      expect(synthesizeGateVerdict(undefined as any)).toBe('PASS');
    });

    it('should return PASS when all items are pass/clean', () => {
      expect(synthesizeGateVerdict(['PASS', 'pass'])).toBe('PASS');
    });

    it('should return WARN when worst item is warn', () => {
      expect(synthesizeGateVerdict(['PASS', 'WARN', 'pass'])).toBe('WARN');
    });

    it('should return REVIEW when review is present, dominating WARN and PASS', () => {
      expect(synthesizeGateVerdict(['PASS', 'WARN', 'REVIEW'])).toBe('REVIEW');
    });

    it('should return BLOCK when block is present, dominating REVIEW, WARN, and PASS', () => {
      expect(synthesizeGateVerdict(['PASS', 'WARN', 'REVIEW', 'BLOCK'])).toBe('BLOCK');
      expect(synthesizeGateVerdict(['BLOCK', 'WARN'])).toBe('BLOCK');
    });

    it('should extract status from objects with status or verdict properties', () => {
      const items = [
        { status: 'warn' },
        { status: 'review' },
        { verdict: 'PASS' },
      ];
      expect(synthesizeGateVerdict(items as any)).toBe('REVIEW');
    });
  });

  describe('Glob Matching Utilities', () => {
    it('matchesGlob should match simple patterns, wildcards, and directory stars', () => {
      expect(matchesGlob('src/auth/jwt.ts', 'src/auth/**')).toBe(true);
      expect(matchesGlob('src/auth/jwt.ts', '**/*.ts')).toBe(true);
      expect(matchesGlob('src/auth/jwt.ts', '*.ts')).toBe(true); // basename fallback
      expect(matchesGlob('src/auth/jwt.ts', 'src/payment/**')).toBe(false);
      expect(matchesGlob('src/auth/jwt.test.ts', '**/*.test.ts')).toBe(true);
    });

    it('filterMatchingFiles should apply include and exclude glob patterns', () => {
      const files = [
        'src/auth/token.ts',
        'src/auth/token.test.ts',
        'src/payment/bill.ts',
        'docs/readme.md',
      ];

      const matched = filterMatchingFiles(files, ['src/auth/**'], ['**/*.test.ts']);
      expect(matched).toEqual(['src/auth/token.ts']);
    });

    it('filterMatchingFiles should return empty array when includes is empty', () => {
      expect(filterMatchingFiles(['src/auth.ts'], [])).toEqual([]);
    });
  });

  describe('Threshold Evaluators', () => {
    describe('evaluateNumericalThreshold', () => {
      it('should handle inverted thresholds (review_below, block_below)', () => {
        const thresholds = { review_below: 0.6, block_below: 0.2 };

        // 1. Below block_below -> block
        const resBlock = evaluateNumericalThreshold(0.15, thresholds);
        expect(resBlock.triggered).toBe(true);
        expect(resBlock.status).toBe('block');
        expect(resBlock.severity).toBe('CRITICAL');

        // 2. Between block_below and review_below -> review
        const resReview = evaluateNumericalThreshold(0.45, thresholds);
        expect(resReview.triggered).toBe(true);
        expect(resReview.status).toBe('review');
        expect(resReview.severity).toBe('ERROR');

        // 3. At or above review_below -> clean (not triggered)
        const resPass = evaluateNumericalThreshold(0.6, thresholds);
        expect(resPass.triggered).toBe(false);

        const resHighPass = evaluateNumericalThreshold(0.95, thresholds);
        expect(resHighPass.triggered).toBe(false);
      });

      it('should handle standard thresholds (warn, review, block)', () => {
        const thresholds = { warn: 0.55, review: 0.75, block: 0.95 };

        // 1. Above block -> block
        const resBlock = evaluateNumericalThreshold(0.96, thresholds);
        expect(resBlock.triggered).toBe(true);
        expect(resBlock.status).toBe('block');
        expect(resBlock.severity).toBe('CRITICAL');

        // 2. Between review and block -> review
        const resReview = evaluateNumericalThreshold(0.8, thresholds);
        expect(resReview.triggered).toBe(true);
        expect(resReview.status).toBe('review');
        expect(resReview.severity).toBe('ERROR');

        // 3. Between warn and review -> warn
        const resWarn = evaluateNumericalThreshold(0.6, thresholds);
        expect(resWarn.triggered).toBe(true);
        expect(resWarn.status).toBe('warn');
        expect(resWarn.severity).toBe('WARN');

        // 4. Below warn -> not triggered
        const resClean = evaluateNumericalThreshold(0.4, thresholds);
        expect(resClean.triggered).toBe(false);
      });
    });

    describe('evaluateScoreThreshold', () => {
      it('should match categorical string scores against score level lists', () => {
        const thresholds = {
          warn_on: ['medium'],
          review_on: ['high'],
          block_on: ['critical'],
        };

        expect(evaluateScoreThreshold('critical', thresholds).status).toBe('block');
        expect(evaluateScoreThreshold('high', thresholds).status).toBe('review');
        expect(evaluateScoreThreshold('medium', thresholds).status).toBe('warn');
        expect(evaluateScoreThreshold('low', thresholds).triggered).toBe(false);
        expect(evaluateScoreThreshold('negligible', thresholds).triggered).toBe(false);
      });

      it('should map numeric scores to score levels when categorical lists are provided', () => {
        const thresholds = {
          warn_on: ['medium'],
          review_on: ['high'],
          block_on: ['critical'],
        };

        expect(evaluateScoreThreshold(0.95, thresholds).status).toBe('block');
        expect(evaluateScoreThreshold(0.8, thresholds).status).toBe('review');
        expect(evaluateScoreThreshold(0.5, thresholds).status).toBe('warn');
        expect(evaluateScoreThreshold(0.1, thresholds).triggered).toBe(false);
      });
    });
  });

  describe('DefaultPolicyEngine', () => {
    let engine: DefaultPolicyEngine;
    let mockContext: EvaluationContext;
    let mockPolicy: PolicyConfig;

    beforeEach(() => {
      engine = new DefaultPolicyEngine();
      mockPolicy = {
        version: 1,
        deterministic: {
          test: { enabled: true, run: 'pnpm test', block_on_failure: true },
          lint: { enabled: true, run: 'pnpm lint', block_on_failure: true },
          typecheck: { enabled: true, run: 'pnpm tsc --noEmit', block_on_failure: true },
          secret_scan: { enabled: true, block_on_detection: true },
        },
        rules: {
          task_completed: { enabled: true, review_below: 0.6, block_below: 0.2 },
          unrelated_changes: { enabled: true, warn: 0.55, review: 0.75, block: 0.95 },
          tests_required: { enabled: true, warn: 0.6, review: 0.8 },
          security_sensitive: { enabled: true, review: 0.65, block: 0.9 },
          regression_risk: {
            enabled: true,
            warn_on: ['medium'],
            review_on: ['high'],
            block_on: ['critical'],
          },
        },
      };

      mockContext = {
        task: {
          task: 'Implement authentication token refresh logic',
          source: 'cli',
        },
        diff: {
          raw: 'diff --git a/src/auth/token.ts b/src/auth/token.ts\n+const token = "abc";\n',
          files: [
            {
              newPath: 'src/auth/token.ts',
              status: 'modified',
              binary: false,
              additions: 1,
              deletions: 0,
              hunks: [],
            },
          ],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
        files: [],
        instructions: [],
        relatedTests: [],
        repository: {
          root: '/mock/repo',
          branch: 'main',
          headSha: '1234567890abcdef',
          isClean: false,
        },
      };
    });

    it('should short-circuit and return PASS when changeset is completely empty', () => {
      const emptyContext: EvaluationContext = {
        ...mockContext,
        diff: {
          raw: '',
          files: [],
          insertions: 0,
          deletions: 0,
          truncated: false,
        },
      };

      const result = engine.evaluate([], [], mockPolicy, emptyContext);

      expect(result.verdict).toBe('PASS');
      expect(result.summary).toContain('Clean changeset');
      expect(result.ruleMatches).toHaveLength(0);
      expect(result.findings).toHaveLength(0);
      expect(result.passedRules).toHaveLength(0);
      expect(result.violatedRules).toHaveLength(0);
    });

    describe('Deterministic Evaluations', () => {
      it('should record passed deterministic checks in passedRules', () => {
        const deterministicResults: DeterministicResult[] = [
          {
            id: 'test',
            status: 'passed',
            exitCode: 0,
            durationMs: 1200,
          },
          {
            id: 'lint',
            status: 'passed',
            exitCode: 0,
            durationMs: 800,
          },
        ];

        const result = engine.evaluate(deterministicResults, [], mockPolicy, mockContext);

        expect(result.verdict).toBe('PASS');
        expect(result.passedRules).toContain('deterministic.test');
        expect(result.passedRules).toContain('deterministic.lint');
        expect(result.violatedRules).toHaveLength(0);
      });

      it('should emit BLOCK violation when test check fails and block_on_failure is true', () => {
        const deterministicResults: DeterministicResult[] = [
          {
            id: 'test',
            status: 'failed',
            exitCode: 1,
            durationMs: 1500,
            stderr: 'FAIL tests/auth.test.ts: Token expired',
          },
        ];

        const result = engine.evaluate(deterministicResults, [], mockPolicy, mockContext);

        expect(result.verdict).toBe('BLOCK');
        expect(result.violatedRules).toContain('deterministic.test');
        expect(result.passedRules).not.toContain('deterministic.test');
        expect(result.ruleMatches[0].status).toBe('block');
        expect(result.ruleMatches[0].severity).toBe('CRITICAL');
        expect(result.findings[0].id).toMatch(/^finding_deterministic_test_/);
      });

      it('should emit REVIEW violation when test check fails and block_on_failure is false', () => {
        const advisoryPolicy: PolicyConfig = {
          ...mockPolicy,
          deterministic: {
            test: { enabled: true, run: 'pnpm test', block_on_failure: false },
          },
        };

        const deterministicResults: DeterministicResult[] = [
          {
            id: 'test',
            status: 'failed',
            exitCode: 1,
            durationMs: 1500,
            stderr: '1 test failed',
          },
        ];

        const result = engine.evaluate(deterministicResults, [], advisoryPolicy, mockContext);

        expect(result.verdict).toBe('REVIEW');
        expect(result.ruleMatches[0].status).toBe('review');
        expect(result.ruleMatches[0].severity).toBe('ERROR');
      });

      it('should emit BLOCK violation when secret scanner detects credentials', () => {
        const deterministicResults: DeterministicResult[] = [
          {
            id: 'secret_scan',
            status: 'failed',
            durationMs: 100,
            violations: [
              {
                file: 'src/auth.ts',
                line: 12,
                rule: 'aws_access_key',
                message: 'AWS Access Key detected',
                severity: 'block',
              },
            ],
          },
        ];

        const result = engine.evaluate(deterministicResults, [], mockPolicy, mockContext);

        expect(result.verdict).toBe('BLOCK');
        expect(result.violatedRules).toContain('deterministic.secret_scan');
        expect(result.ruleMatches[0].severity).toBe('CRITICAL');
        expect(result.ruleMatches[0].evidence[0].type).toBe('secret_detected');
        expect(result.ruleMatches[0].evidence[0].path).toBe('src/auth.ts');
      });

      it('should skip disabled deterministic checks', () => {
        const disabledPolicy: PolicyConfig = {
          ...mockPolicy,
          deterministic: {
            test: { enabled: false, run: 'pnpm test' },
          },
        };

        const deterministicResults: DeterministicResult[] = [
          {
            id: 'test',
            status: 'failed',
            exitCode: 1,
            durationMs: 100,
          },
        ];

        const result = engine.evaluate(deterministicResults, [], disabledPolicy, mockContext);

        expect(result.verdict).toBe('PASS');
        expect(result.violatedRules).not.toContain('deterministic.test');
      });
    });

    describe('Standard Semantic Rule Evaluations', () => {
      it('should evaluate task_completed with inverted thresholds (review_below / block_below)', () => {
        // Case 1: prob = 0.15 (< block_below 0.20) -> BLOCK
        const decisionsBlock: SemanticDecision[] = [
          {
            id: 'task_completed',
            probability: 0.15,
            provider: 'mock',
            rationale: 'Major requirements unfulfilled',
          },
        ];
        const resBlock = engine.evaluate([], decisionsBlock, mockPolicy, mockContext);
        expect(resBlock.verdict).toBe('BLOCK');
        expect(resBlock.violatedRules).toContain('task_completed');

        // Case 2: prob = 0.45 (< review_below 0.60) -> REVIEW
        const decisionsReview: SemanticDecision[] = [
          {
            id: 'task_completed',
            probability: 0.45,
            provider: 'mock',
            rationale: 'Partial requirements fulfilled',
          },
        ];
        const resReview = engine.evaluate([], decisionsReview, mockPolicy, mockContext);
        expect(resReview.verdict).toBe('REVIEW');
        expect(resReview.violatedRules).toContain('task_completed');

        // Case 3: prob = 0.90 (>= 0.60) -> PASS
        const decisionsPass: SemanticDecision[] = [
          {
            id: 'task_completed',
            probability: 0.9,
            provider: 'mock',
            rationale: 'Task fully completed',
          },
        ];
        const resPass = engine.evaluate([], decisionsPass, mockPolicy, mockContext);
        expect(resPass.verdict).toBe('PASS');
        expect(resPass.passedRules).toContain('task_completed');
      });

      it('should treat task_completed as passed when context.task is absent or empty', () => {
        const noTaskContext: EvaluationContext = {
          ...mockContext,
          task: undefined,
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'task_completed',
            probability: 0.1, // low prob, but no task was declared
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, mockPolicy, noTaskContext);

        expect(result.verdict).toBe('PASS');
        expect(result.passedRules).toContain('task_completed');
        expect(result.violatedRules).not.toContain('task_completed');
      });

      it('should evaluate unrelated_changes with standard thresholds', () => {
        const decisions: SemanticDecision[] = [
          {
            id: 'unrelated_changes',
            probability: 0.8, // >= 0.75 review threshold
            provider: 'mock',
            rationale: 'Unrelated payment changes found in auth task',
          },
        ];

        const result = engine.evaluate([], decisions, mockPolicy, mockContext);

        expect(result.verdict).toBe('REVIEW');
        expect(result.violatedRules).toContain('unrelated_changes');
      });

      it('should evaluate tests_required and security_sensitive (including security_sensitive_change alias)', () => {
        const decisions: SemanticDecision[] = [
          {
            id: 'tests_required',
            probability: 0.85, // >= 0.80 review threshold
            provider: 'mock',
          },
          {
            id: 'security_sensitive_change', // question alias for security_sensitive rule
            probability: 0.95, // >= 0.90 block threshold
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, mockPolicy, mockContext);

        // Security block dominates tests_required review
        expect(result.verdict).toBe('BLOCK');
        expect(result.violatedRules).toContain('security_sensitive');
        expect(result.violatedRules).toContain('tests_required');
      });

      it('should evaluate regression_risk categorical score thresholds', () => {
        const decisions: SemanticDecision[] = [
          {
            id: 'regression_risk',
            value: 'critical',
            score: 1.0,
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, mockPolicy, mockContext);

        expect(result.verdict).toBe('BLOCK');
        expect(result.violatedRules).toContain('regression_risk');
      });
    });

    describe('Custom Repository Policy Rules', () => {
      it('should evaluate custom rule when changed files match glob pattern', () => {
        const customRule: CustomPolicyRule = {
          id: 'auth_requires_tests',
          description: 'Modifications to auth require test coverage',
          files: ['src/auth/**'],
          exclude: ['**/*.test.ts'],
          question: 'Does this change modify authentication without regression tests?',
          review: 0.7,
        };

        const customPolicy: PolicyConfig = {
          ...mockPolicy,
          custom_rules: [customRule],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'auth_requires_tests',
            probability: 0.82,
            provider: 'mock',
            rationale: 'Auth modified without tests',
          },
        ];

        const result = engine.evaluate([], decisions, customPolicy, mockContext);

        expect(result.verdict).toBe('REVIEW');
        expect(result.violatedRules).toContain('auth_requires_tests');
        expect(result.ruleMatches[0].ruleId).toBe('auth_requires_tests');
        expect(result.ruleMatches[0].affectedFiles).toEqual(['src/auth/token.ts']);
      });

      it('should skip custom rule when changed files do NOT match glob pattern', () => {
        const customRule: CustomPolicyRule = {
          id: 'billing_protection',
          description: 'Billing changes require review',
          files: ['src/billing/**'],
          question: 'Billing altered?',
          block: 0.8,
        };

        const customPolicy: PolicyConfig = {
          ...mockPolicy,
          custom_rules: [customRule],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'billing_protection',
            probability: 0.99,
            provider: 'mock',
          },
        ];

        // mockContext only modifies src/auth.ts
        const result = engine.evaluate([], decisions, customPolicy, mockContext);

        expect(result.verdict).toBe('PASS');
        expect(result.violatedRules).not.toContain('billing_protection');
      });

      it('should skip disabled custom rules', () => {
        const customRule: CustomPolicyRule = {
          id: 'disabled_rule',
          enabled: false,
          files: ['src/**'],
          question: 'Question?',
          block: 0.5,
        };

        const customPolicy: PolicyConfig = {
          ...mockPolicy,
          custom_rules: [customRule],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'disabled_rule',
            probability: 0.95,
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, customPolicy, mockContext);

        expect(result.verdict).toBe('PASS');
        expect(result.violatedRules).not.toContain('disabled_rule');
      });
    });

    describe('Worst-Case Hierarchy Integration', () => {
      it('should synthesize worst-case verdict when multiple layers produce signals', () => {
        // Deterministic passes, semantic tests_required is WARN, unrelated_changes is REVIEW, security is BLOCK
        const deterministicResults: DeterministicResult[] = [
          { id: 'test', status: 'passed', exitCode: 0, durationMs: 500 },
          { id: 'lint', status: 'passed', exitCode: 0, durationMs: 300 },
        ];

        const decisions: SemanticDecision[] = [
          { id: 'tests_required', probability: 0.65, provider: 'mock' }, // WARN (>= 0.60)
          { id: 'unrelated_changes', probability: 0.78, provider: 'mock' }, // REVIEW (>= 0.75)
          { id: 'security_sensitive', probability: 0.92, provider: 'mock' }, // BLOCK (>= 0.90)
        ];

        const result = engine.evaluate(deterministicResults, decisions, mockPolicy, mockContext);

        expect(result.verdict).toBe('BLOCK');
        expect(result.findings).toHaveLength(3);
        expect(result.passedRules).toContain('deterministic.test');
        expect(result.passedRules).toContain('deterministic.lint');
        expect(result.violatedRules).toEqual(['unrelated_changes', 'tests_required', 'security_sensitive']);
      });

      it('should allow injecting custom FindingManager in constructor', () => {
        const customFindingManager = new DefaultFindingManager();
        const customEngine = new DefaultPolicyEngine(customFindingManager);

        const result = customEngine.evaluate(
          [
            {
              id: 'test',
              status: 'failed',
              exitCode: 1,
              durationMs: 100,
            },
          ],
          [],
          mockPolicy,
          mockContext
        );

        expect(result.findings).toHaveLength(1);
        expect(customFindingManager.getFindings()).toHaveLength(1);
      });

      it('engine.synthesizeVerdict delegates directly to synthesizeGateVerdict', () => {
        expect(engine.synthesizeVerdict(['WARN', 'PASS'])).toBe('WARN');
        expect(engine.synthesizeVerdict(['BLOCK', 'REVIEW'])).toBe('BLOCK');
      });

      it('should skip built-in rule when disabled via policy config', () => {
        const disabledPolicy: PolicyConfig = {
          ...mockPolicy,
          rules: {
            tests_required: { enabled: false },
          },
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'tests_required',
            probability: 0.99,
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, disabledPolicy, mockContext);
        expect(result.violatedRules).not.toContain('tests_required');
      });

      it('should record custom rule as passed when decision does not violate thresholds', () => {
        const customRule: CustomPolicyRule = {
          id: 'auth_requires_tests',
          files: ['src/auth/**'],
          question: 'Auth tests?',
          review: 0.8,
        };

        const customPolicy: PolicyConfig = {
          ...mockPolicy,
          custom_rules: [customRule],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'auth_requires_tests',
            probability: 0.2, // well below review 0.80
            provider: 'mock',
          },
        ];

        const result = engine.evaluate([], decisions, customPolicy, mockContext);
        expect(result.verdict).toBe('PASS');
        expect(result.passedRules).toContain('auth_requires_tests');
      });
    });

    describe('Helper Edge Cases', () => {
      it('getEffectiveBuiltinRule returns null for nonexistent rule or disabled rule', () => {
        expect(getEffectiveBuiltinRule('nonexistent_rule', mockPolicy)).toBeNull();
        expect(
          getEffectiveBuiltinRule('tests_required', {
            version: 1,
            rules: { tests_required: { enabled: false } },
          })
        ).toBeNull();
      });

      it('evaluateSemanticRuleMatch returns null when rule is disabled', () => {
        const rule = {
          id: 'disabled_rule',
          enabled: false,
        };
        const decision: SemanticDecision = {
          id: 'disabled_rule',
          probability: 0.99,
          provider: 'mock',
        };
        expect(evaluateSemanticRuleMatch(decision, rule as any, mockContext)).toBeNull();
      });

      it('evaluateScoreThreshold returns triggered false on invalid input type', () => {
        expect(evaluateScoreThreshold(null as any, {})).toEqual({ triggered: false });
      });
    });
  });
});
