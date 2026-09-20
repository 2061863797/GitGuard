/**
 * tests/unit/policy/stress.test.ts
 * Empirical Challenger M3-1: Policy Engine & Gate Synthesis Stress Suite.
 *
 * Covers:
 * 1. Gate Verdict Dominance across 1,000 randomized permutations (BLOCK > REVIEW > WARN > PASS)
 * 2. Inverted and Standard Threshold Boundary Exactness (epsilon probes, boundary inclusions)
 * 3. Extreme, Pathological, and Nullish Probability & Score Boundary Handling
 * 4. Complex Mixed Evaluation (Deterministic + Semantic + Custom Rules + Disjoint Sets)
 * 5. Deeply Nested and Pathological Glob Pattern Resilience
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DefaultPolicyEngine,
  synthesizeGateVerdict,
  matchesGlob,
  filterMatchingFiles,
  evaluateNumericalThreshold,
  evaluateScoreThreshold,
  getEffectiveBuiltinRule,
  evaluateSemanticRuleMatch,
  evaluateDeterministicCheck,
  globToRegExp,
  DEFAULT_BUILTIN_RULES,
} from '../../../src/policy/index.js';
import type { PolicyConfig, CustomPolicyRule, RuleMatch, GateVerdict } from '../../../src/types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../../../src/types/provider.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { FindingStatus, FindingSeverity } from '../../../src/types/finding.js';

describe('Empirical Challenger M3-1: Policy Engine Stress Suite', () => {
  // =========================================================================
  // 1. GATE VERDICT DOMINANCE (1,000 Randomized Permutations)
  // =========================================================================
  describe('1. Gate Verdict Dominance & Randomized Permutations', () => {
    it('should strictly enforce BLOCK > REVIEW > WARN > PASS across 1,000 randomized permutations', () => {
      const allStatuses: Array<FindingStatus | GateVerdict | string | { status: string } | { verdict: string }> = [
        'BLOCK',
        'block',
        { status: 'block' },
        { verdict: 'BLOCK' },
        'REVIEW',
        'review',
        { status: 'review' },
        { verdict: 'REVIEW' },
        'WARN',
        'warn',
        { status: 'warn' },
        { verdict: 'WARN' },
        'PASS',
        'pass',
        { status: 'pass' },
        { verdict: 'PASS' },
        { status: 'unknown' },
        'CLEAN',
      ];

      // PRNG seeded for reproducible pseudo-random behavior
      let seed = 42;
      function random(): number {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      }

      function pickRandom<T>(arr: T[]): T {
        return arr[Math.floor(random() * arr.length)];
      }

      for (let i = 0; i < 1000; i++) {
        const length = Math.floor(random() * 20) + 1; // 1 to 20 elements
        const items: any[] = [];
        let expectedVerdict: GateVerdict = 'PASS';

        let hasBlock = false;
        let hasReview = false;
        let hasWarn = false;

        for (let j = 0; j < length; j++) {
          const item = pickRandom(allStatuses);
          items.push(item);

          let str = '';
          if (typeof item === 'string') {
            str = item.toLowerCase();
          } else if (item && typeof item === 'object') {
            if ('status' in item && item.status) {
              str = String(item.status).toLowerCase();
            } else if ('verdict' in item && item.verdict) {
              str = String(item.verdict).toLowerCase();
            }
          }

          if (str === 'block') hasBlock = true;
          else if (str === 'review') hasReview = true;
          else if (str === 'warn') hasWarn = true;
        }

        if (hasBlock) expectedVerdict = 'BLOCK';
        else if (hasReview) expectedVerdict = 'REVIEW';
        else if (hasWarn) expectedVerdict = 'WARN';
        else expectedVerdict = 'PASS';

        const actualVerdict = synthesizeGateVerdict(items);
        expect(actualVerdict).toBe(expectedVerdict);
      }
    });

    it('should correctly handle nullish, empty, or unparseable items in verdict synthesis', () => {
      expect(synthesizeGateVerdict([])).toBe('PASS');
      expect(synthesizeGateVerdict(null as any)).toBe('PASS');
      expect(synthesizeGateVerdict(undefined as any)).toBe('PASS');
      expect(synthesizeGateVerdict([null as any, undefined as any, {} as any])).toBe('PASS');
      expect(synthesizeGateVerdict([null as any, 'WARN', undefined as any])).toBe('WARN');
      expect(synthesizeGateVerdict([{} as any, { status: null } as any, 'BLOCK'])).toBe('BLOCK');
      expect(synthesizeGateVerdict([{ verdict: null } as any, { status: 'review' }])).toBe('REVIEW');
    });

    it('should prioritize status over verdict if both are present on the same item', () => {
      // In object processing, status is checked first:
      // if 'status' in item && item.status => uses item.status
      const mixed = [{ status: 'block', verdict: 'WARN' }];
      expect(synthesizeGateVerdict(mixed as any)).toBe('BLOCK');

      const mixed2 = [{ status: 'warn', verdict: 'BLOCK' }];
      expect(synthesizeGateVerdict(mixed2 as any)).toBe('WARN');
    });

    it('should observe that untrimmed status strings bypass matching and evaluate to PASS', () => {
      // Empirical discovery: synthesizeGateVerdict does not trim input strings,
      // so ' BLOCK ' or '  warn  ' fails strict equality against 'block' / 'warn'
      expect(synthesizeGateVerdict([' BLOCK '])).toBe('PASS');
      expect(synthesizeGateVerdict([' warn '])).toBe('PASS');
    });
  });

  // =========================================================================
  // 2. THRESHOLD BOUNDARY EXACTNESS & EPSILON PROBING
  // =========================================================================
  describe('2. Inverted & Standard Threshold Boundary Exactness', () => {
    describe('Inverted thresholds (review_below: 0.60, block_below: 0.20)', () => {
      const thresholds = { review_below: 0.6, block_below: 0.2 };
      const eps = 1e-7;

      it('should trigger BLOCK strictly below block_below', () => {
        const res = evaluateNumericalThreshold(0.2 - eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('block');
        expect(res.severity).toBe('CRITICAL');
      });

      it('should trigger REVIEW exactly at block_below (0.20 is not < 0.20, but is < 0.60)', () => {
        const res = evaluateNumericalThreshold(0.2, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
        expect(res.severity).toBe('ERROR');
      });

      it('should trigger REVIEW slightly above block_below', () => {
        const res = evaluateNumericalThreshold(0.2 + eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
        expect(res.severity).toBe('ERROR');
      });

      it('should trigger REVIEW slightly below review_below', () => {
        const res = evaluateNumericalThreshold(0.6 - eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
        expect(res.severity).toBe('ERROR');
      });

      it('should PASS cleanly exactly at review_below (0.60 is not < 0.60)', () => {
        const res = evaluateNumericalThreshold(0.6, thresholds);
        expect(res.triggered).toBe(false);
      });

      it('should PASS cleanly slightly above review_below', () => {
        const res = evaluateNumericalThreshold(0.6 + eps, thresholds);
        expect(res.triggered).toBe(false);
      });

      it('should handle floating point representation anomalies around 0.3', () => {
        // 0.1 + 0.2 in JS IEEE 754 is 0.30000000000000004
        const sum = 0.1 + 0.2;
        const res = evaluateNumericalThreshold(sum, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
      });
    });

    describe('Standard thresholds (warn: 0.55, review: 0.75, block: 0.95)', () => {
      const thresholds = { warn: 0.55, review: 0.75, block: 0.95 };
      const eps = 1e-7;

      it('should PASS slightly below warn threshold', () => {
        const res = evaluateNumericalThreshold(0.55 - eps, thresholds);
        expect(res.triggered).toBe(false);
      });

      it('should trigger WARN exactly at warn threshold (0.55 >= 0.55)', () => {
        const res = evaluateNumericalThreshold(0.55, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('warn');
        expect(res.severity).toBe('WARN');
      });

      it('should trigger WARN slightly above warn threshold', () => {
        const res = evaluateNumericalThreshold(0.55 + eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('warn');
        expect(res.severity).toBe('WARN');
      });

      it('should trigger WARN slightly below review threshold', () => {
        const res = evaluateNumericalThreshold(0.75 - eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('warn');
      });

      it('should trigger REVIEW exactly at review threshold (0.75 >= 0.75)', () => {
        const res = evaluateNumericalThreshold(0.75, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
        expect(res.severity).toBe('ERROR');
      });

      it('should trigger REVIEW slightly above review threshold', () => {
        const res = evaluateNumericalThreshold(0.75 + eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
      });

      it('should trigger REVIEW slightly below block threshold', () => {
        const res = evaluateNumericalThreshold(0.95 - eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('review');
      });

      it('should trigger BLOCK exactly at block threshold (0.95 >= 0.95)', () => {
        const res = evaluateNumericalThreshold(0.95, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('block');
        expect(res.severity).toBe('CRITICAL');
      });

      it('should trigger BLOCK slightly above block threshold', () => {
        const res = evaluateNumericalThreshold(0.95 + eps, thresholds);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('block');
      });
    });

    describe('Coincident and degenerate threshold configurations', () => {
      it('should handle coincident thresholds (warn == review == block)', () => {
        const coincident = { warn: 0.7, review: 0.7, block: 0.7 };
        // Priority order in evaluateNumericalThreshold: block > review > warn
        const res = evaluateNumericalThreshold(0.7, coincident);
        expect(res.triggered).toBe(true);
        expect(res.status).toBe('block');
      });

      it('should handle coincident inverted thresholds (block_below == review_below)', () => {
        const coincident = { block_below: 0.5, review_below: 0.5 };
        // At 0.49 -> block
        expect(evaluateNumericalThreshold(0.49, coincident).status).toBe('block');
        // At 0.50 -> neither is < 0.50, so passes
        expect(evaluateNumericalThreshold(0.50, coincident).triggered).toBe(false);
      });

      it('should handle inverted thresholds where block_below > review_below', () => {
        const invertedAnomaly = { block_below: 0.8, review_below: 0.3 };
        // block_below is checked first: if probability < 0.8 => block
        expect(evaluateNumericalThreshold(0.5, invertedAnomaly).status).toBe('block');
        expect(evaluateNumericalThreshold(0.2, invertedAnomaly).status).toBe('block');
        expect(evaluateNumericalThreshold(0.85, invertedAnomaly).triggered).toBe(false);
      });

      it('should return triggered: false when threshold config is empty', () => {
        expect(evaluateNumericalThreshold(0.5, {}).triggered).toBe(false);
        expect(evaluateNumericalThreshold(1.0, {}).triggered).toBe(false);
      });
    });
  });

  // =========================================================================
  // 3. EXTREME, PATHOLOGICAL, AND SPECIAL NUMERICAL VALUES
  // =========================================================================
  describe('3. Extreme & Pathological Values', () => {
    const standardThresholds = { warn: 0.55, review: 0.75, block: 0.95 };
    const invertedThresholds = { review_below: 0.6, block_below: 0.2 };

    it('should handle probability 0.0 correctly', () => {
      // Standard: 0.0 >= 0.55 is false -> clean
      expect(evaluateNumericalThreshold(0.0, standardThresholds).triggered).toBe(false);
      // Inverted: 0.0 < 0.2 -> block
      const invRes = evaluateNumericalThreshold(0.0, invertedThresholds);
      expect(invRes.triggered).toBe(true);
      expect(invRes.status).toBe('block');
    });

    it('should handle probability 1.0 correctly', () => {
      // Standard: 1.0 >= 0.95 -> block
      const stdRes = evaluateNumericalThreshold(1.0, standardThresholds);
      expect(stdRes.triggered).toBe(true);
      expect(stdRes.status).toBe('block');
      // Inverted: 1.0 < 0.6 is false -> clean
      expect(evaluateNumericalThreshold(1.0, invertedThresholds).triggered).toBe(false);
    });

    it('should handle negative probabilities safely', () => {
      // Negative probability: -0.5
      expect(evaluateNumericalThreshold(-0.5, standardThresholds).triggered).toBe(false);
      const invRes = evaluateNumericalThreshold(-0.5, invertedThresholds);
      expect(invRes.triggered).toBe(true);
      expect(invRes.status).toBe('block');
    });

    it('should handle probabilities greater than 1.0 safely', () => {
      expect(evaluateNumericalThreshold(1.5, standardThresholds).status).toBe('block');
      expect(evaluateNumericalThreshold(1.5, invertedThresholds).triggered).toBe(false);
    });

    it('should handle Infinity and -Infinity without throwing', () => {
      const infStd = evaluateNumericalThreshold(Infinity, standardThresholds);
      expect(infStd.triggered).toBe(true);
      expect(infStd.status).toBe('block');

      const negInfInv = evaluateNumericalThreshold(-Infinity, invertedThresholds);
      expect(negInfInv.triggered).toBe(true);
      expect(negInfInv.status).toBe('block');
    });

    it('should safely return untriggered for NaN probability without throwing or returning invalid status', () => {
      // NaN comparisons (NaN < x, NaN >= x) all evaluate to false
      const resStd = evaluateNumericalThreshold(NaN, standardThresholds);
      expect(resStd.triggered).toBe(false);

      const resInv = evaluateNumericalThreshold(NaN, invertedThresholds);
      expect(resInv.triggered).toBe(false);
    });

    it('should evaluate score thresholds with extreme numeric values', () => {
      const scoreThresholds = {
        warn_on: ['medium'],
        review_on: ['high'],
        block_on: ['critical'],
      };

      // 0.95 -> critical -> block
      expect(evaluateScoreThreshold(0.95, scoreThresholds).status).toBe('block');
      // 0.70 -> high -> review
      expect(evaluateScoreThreshold(0.70, scoreThresholds).status).toBe('review');
      // 0.40 -> medium -> warn
      expect(evaluateScoreThreshold(0.40, scoreThresholds).status).toBe('warn');
      // 0.20 -> low -> not triggered
      expect(evaluateScoreThreshold(0.20, scoreThresholds).triggered).toBe(false);
      // 0.05 -> negligible -> not triggered
      expect(evaluateScoreThreshold(0.05, scoreThresholds).triggered).toBe(false);
      // Negative score -> negligible -> not triggered
      expect(evaluateScoreThreshold(-10, scoreThresholds).triggered).toBe(false);
      // NaN score -> falls through to negligible -> not triggered
      expect(evaluateScoreThreshold(NaN, scoreThresholds).triggered).toBe(false);
    });

    it('should evaluate categorical string scores case-insensitively and handle unknown strings', () => {
      const scoreThresholds = {
        warn_on: ['Medium'],
        review_on: ['HIGH'],
        block_on: ['critical'],
      };

      expect(evaluateScoreThreshold('CRITICAL', scoreThresholds).status).toBe('block');
      expect(evaluateScoreThreshold('High', scoreThresholds).status).toBe('review');
      expect(evaluateScoreThreshold('medium', scoreThresholds).status).toBe('warn');
      expect(evaluateScoreThreshold('  CRITICAL  ', scoreThresholds).status).toBe('block');
      expect(evaluateScoreThreshold('completely_unknown', scoreThresholds).triggered).toBe(false);
      expect(evaluateScoreThreshold('', scoreThresholds).triggered).toBe(false);
    });

    it('should observe that null probability throws TypeError on inverted thresholds due to null.toFixed(2)', () => {
      // In JS, null < 0.2 evaluates to true (0 < 0.2), causing message string interpolation to call null.toFixed(2)
      expect(() => {
        evaluateNumericalThreshold(null as any, invertedThresholds);
      }).toThrow(TypeError);

      // On standard thresholds, null >= 0.55 evaluates to false (0 >= 0.55 is false), so it does not throw
      expect(evaluateNumericalThreshold(null as any, standardThresholds).triggered).toBe(false);
    });
  });

  // =========================================================================
  // 4. COMPLEX MIXTURES OF DETERMINISTIC RESULTS AND SEMANTIC DECISIONS
  // =========================================================================
  describe('4. Complex Mixtures of Deterministic & Semantic Results', () => {
    let engine: DefaultPolicyEngine;
    let baseContext: EvaluationContext;
    let defaultPolicy: PolicyConfig;

    beforeEach(() => {
      engine = new DefaultPolicyEngine();
      defaultPolicy = {
        version: 1,
        deterministic: {
          test: { enabled: true, run: 'pnpm test', block_on_failure: true },
          lint: { enabled: true, run: 'pnpm lint', block_on_failure: false }, // review on failure
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

      baseContext = {
        task: { task: 'Add user authentication flow', source: 'cli' },
        diff: {
          raw: 'diff --git a/src/auth.ts b/src/auth.ts\n+export function login() {}\n',
          files: [{ newPath: 'src/auth.ts', status: 'modified', binary: false }],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
        files: [],
        instructions: [],
        relatedTests: [],
        repository: { rootPath: process.cwd(), branch: 'main', headSha: 'abc', isClean: false },
        evidence: [],
      };
    });

    it('Scenario A: All deterministic pass + All semantic pass => Gate PASS', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'test', status: 'passed', exitCode: 0, durationMs: 100 },
        { id: 'lint', status: 'passed', exitCode: 0, durationMs: 50 },
        { id: 'typecheck', status: 'passed', exitCode: 0, durationMs: 200 },
        { id: 'secret_scan', status: 'passed', durationMs: 10, violations: [] },
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.95 },
        { id: 'unrelated_changes', question: 'Unrelated?', probability: 0.1 },
        { id: 'tests_required', question: 'Tests needed?', probability: 0.2 },
        { id: 'security_sensitive', question: 'Security risk?', probability: 0.1 },
        { id: 'regression_risk', question: 'Regression risk?', value: 'low' },
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      expect(result.verdict).toBe('PASS');
      expect(result.findings.length).toBe(0);
      expect(result.violatedRules.length).toBe(0);
      expect(result.passedRules.length).toBeGreaterThan(0);
    });

    it('Scenario B: Deterministic secret scan fails (BLOCK) + Semantic all pass => Gate BLOCK', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'test', status: 'passed', exitCode: 0, durationMs: 100 },
        {
          id: 'secret_scan',
          status: 'failed',
          durationMs: 10,
          violations: [{ file: 'src/auth.ts', line: 1, message: 'Exposed API token', severity: 'block' }],
        },
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.99 },
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      expect(result.verdict).toBe('BLOCK');
      expect(result.violatedRules).toContain('deterministic.secret_scan');
      expect(result.findings.some((f) => f.ruleId === 'deterministic.secret_scan' && f.status === 'block')).toBe(true);
    });

    it('Scenario C: Deterministic lint fails (REVIEW) + Semantic unrelated_changes triggers WARN => Gate REVIEW', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'test', status: 'passed', exitCode: 0, durationMs: 100 },
        { id: 'lint', status: 'failed', exitCode: 1, durationMs: 50, stderr: 'Lint error' }, // block_on_failure: false => review
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.9 },
        { id: 'unrelated_changes', question: 'Unrelated?', probability: 0.60 }, // 0.60 >= warn (0.55) => warn
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      expect(result.verdict).toBe('REVIEW');
      expect(result.violatedRules).toEqual(expect.arrayContaining(['deterministic.lint', 'unrelated_changes']));
    });

    it('Scenario D: Deterministic lint fails (REVIEW) + Semantic task_completed triggers BLOCK => Gate BLOCK', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'lint', status: 'failed', exitCode: 1, durationMs: 50 }, // review
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.15 }, // 0.15 < 0.20 => block
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      expect(result.verdict).toBe('BLOCK');
      expect(result.violatedRules).toEqual(expect.arrayContaining(['deterministic.lint', 'task_completed']));
    });

    it('Scenario E: Only WARN triggers across both deterministic and semantic => Gate WARN', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'test', status: 'passed', exitCode: 0, durationMs: 100 },
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.9 },
        { id: 'unrelated_changes', question: 'Unrelated?', probability: 0.60 }, // warn
        { id: 'regression_risk', question: 'Regression?', value: 'medium' }, // warn_on: ['medium'] => warn
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      expect(result.verdict).toBe('WARN');
      expect(result.findings.every((f) => f.status === 'warn')).toBe(true);
    });

    it('should strictly guarantee passedRules and violatedRules are disjoint', () => {
      const deterministicResults: DeterministicResult[] = [
        { id: 'test', status: 'failed', exitCode: 1, durationMs: 100 },
        { id: 'lint', status: 'passed', exitCode: 0, durationMs: 50 },
      ];

      const semanticDecisions: SemanticDecision[] = [
        { id: 'task_completed', question: 'Task completed?', probability: 0.8 }, // pass
        { id: 'security_sensitive', question: 'Security?', probability: 0.95 }, // block
      ];

      const result = engine.evaluate(deterministicResults, semanticDecisions, defaultPolicy, baseContext);
      const passedSet = new Set(result.passedRules);
      const violatedSet = new Set(result.violatedRules);

      for (const v of violatedSet) {
        expect(passedSet.has(v)).toBe(false);
      }
      for (const p of passedSet) {
        expect(violatedSet.has(p)).toBe(false);
      }
    });

    it('should handle empty task description by bypassing task_completed rule cleanly', () => {
      const emptyTaskContext: EvaluationContext = {
        ...baseContext,
        task: { task: '', source: 'cli' },
      };

      const semanticDecisions: SemanticDecision[] = [
        // Even if low probability was provided, missing task should treat it as satisfied
        { id: 'task_completed', question: 'Task completed?', probability: 0.05 },
      ];

      const result = engine.evaluate([], semanticDecisions, defaultPolicy, emptyTaskContext);
      expect(result.violatedRules).not.toContain('task_completed');
      expect(result.passedRules).toContain('task_completed');
      expect(result.verdict).toBe('PASS');
    });

    it('should cleanly handle empty changeset short-circuit', () => {
      const cleanContext: EvaluationContext = {
        ...baseContext,
        diff: { raw: '', files: [], insertions: 0, deletions: 0, truncated: false },
      };

      const result = engine.evaluate([], [], defaultPolicy, cleanContext);
      expect(result.verdict).toBe('PASS');
      expect(result.ruleMatches).toEqual([]);
      expect(result.findings).toEqual([]);
      expect(result.summary).toContain('Clean changeset');
    });
  });

  // =========================================================================
  // 5. DEEPLY NESTED & PATHOLOGICAL GLOB PATTERNS IN CUSTOM RULES
  // =========================================================================
  describe('5. Glob Pattern Resilience & Custom Policy Rules', () => {
    describe('globToRegExp and matchesGlob', () => {
      it('should match deep directory wildcards across arbitrary nesting depths', () => {
        expect(matchesGlob('a/b/c/d/e/f/g/h/file.ts', 'a/**/file.ts')).toBe(true);
        expect(matchesGlob('a/file.ts', 'a/**/file.ts')).toBe(true);
        expect(matchesGlob('a/b/c/file.ts', 'a/**/b/**/file.ts')).toBe(true);
        expect(matchesGlob('packages/core/src/policy/engine.ts', 'packages/*/src/**/*.ts')).toBe(true);
      });

      it('should match basename fallback for filename-only patterns', () => {
        expect(matchesGlob('src/components/button/index.tsx', '*.tsx')).toBe(true);
        expect(matchesGlob('deeply/nested/dir/app.test.js', '*.test.js')).toBe(true);
        expect(matchesGlob('deeply/nested/dir/app.test.js', '*.test.ts')).toBe(false);
      });

      it('should handle Windows-style backslashes transparently in files and globs', () => {
        expect(matchesGlob('src\\auth\\jwt.ts', 'src/auth/**')).toBe(true);
        expect(matchesGlob('src\\auth\\jwt.ts', 'src\\auth\\**')).toBe(true);
        expect(matchesGlob('packages\\core\\src\\index.ts', 'packages/**/*.ts')).toBe(true);
      });

      it('should handle single character wildcard (?) correctly', () => {
        expect(matchesGlob('src/file1.ts', 'src/file?.ts')).toBe(true);
        expect(matchesGlob('src/fileA.ts', 'src/file?.ts')).toBe(true);
        expect(matchesGlob('src/file12.ts', 'src/file?.ts')).toBe(false);
      });

      it('should escape regex special characters in filenames safely', () => {
        // Files with parentheses, plus signs, brackets, dots
        expect(matchesGlob('src/utils (legacy)/math+extra.ts', 'src/utils (legacy)/*.ts')).toBe(true);
        expect(matchesGlob('src/routes/[id]/page.tsx', 'src/routes/[id]/*.tsx')).toBe(true);
        expect(matchesGlob('config/file.min.js', 'config/*.min.js')).toBe(true);
        expect(matchesGlob('src/special$^|test.ts', 'src/special$^|test.ts')).toBe(true);
      });

      it('should handle empty glob or empty file path without throwing', () => {
        expect(matchesGlob('', '')).toBe(true);
        expect(matchesGlob('src/auth.ts', '')).toBe(false);
        expect(matchesGlob('', 'src/*.ts')).toBe(false);
      });

      it('should observe that leading ./ in glob patterns fails to match stripped relative file paths', () => {
        // matchesGlob strips leading ./ from file path, but globToRegExp escapes leading ./ as ^\.\/,
        // meaning './src/auth/**' will fail to match 'src/auth/token.ts'
        expect(matchesGlob('src/auth/token.ts', './src/auth/**')).toBe(false);
        expect(matchesGlob('./src/auth/token.ts', './src/auth/**')).toBe(false);
        // Correct standard glob syntax without leading ./ matches cleanly
        expect(matchesGlob('./src/auth/token.ts', 'src/auth/**')).toBe(true);
        expect(matchesGlob('src/auth/token.ts', 'src/auth/**')).toBe(true);
      });
    });

    describe('filterMatchingFiles with Includes and Excludes', () => {
      const fileList = [
        'src/auth/token.ts',
        'src/auth/token.test.ts',
        'src/auth/helper.ts',
        'src/payment/bill.ts',
        'src/payment/bill.spec.ts',
        'docs/readme.md',
        'packages/cli/src/main.ts',
      ];

      it('should filter files matching include patterns', () => {
        const result = filterMatchingFiles(fileList, ['src/auth/**']);
        expect(result).toEqual([
          'src/auth/helper.ts',
          'src/auth/token.test.ts',
          'src/auth/token.ts',
        ]);
      });

      it('should exclude files matching exclude patterns with higher priority', () => {
        const result = filterMatchingFiles(
          fileList,
          ['src/auth/**', 'src/payment/**'],
          ['**/*.test.ts', '**/*.spec.ts']
        );
        expect(result).toEqual([
          'src/auth/helper.ts',
          'src/auth/token.ts',
          'src/payment/bill.ts',
        ]);
      });

      it('should deduplicate and normalize paths with backslashes', () => {
        const messyList = [
          'src\\auth\\token.ts',
          'src/auth/token.ts',
          'src\\auth\\token.ts',
        ];
        const result = filterMatchingFiles(messyList, ['src/auth/**']);
        expect(result).toEqual(['src/auth/token.ts']);
      });

      it('should preserve relative dot-slash segments verbatim in normalizeAffectedFiles without POSIX canonicalization', () => {
        const listWithDots = ['src/auth/./token.ts', 'src/auth/token.ts'];
        const result = filterMatchingFiles(listWithDots, ['src/auth/**']);
        // Note: normalizeAffectedFiles only converts backslashes and trims, preserving ./ segments
        expect(result).toContain('src/auth/./token.ts');
        expect(result).toContain('src/auth/token.ts');
      });

      it('should return empty array when includeGlobs is empty or undefined', () => {
        expect(filterMatchingFiles(fileList, [])).toEqual([]);
        expect(filterMatchingFiles(fileList, undefined as any)).toEqual([]);
      });
    });

    describe('CustomPolicyRule evaluation through DefaultPolicyEngine', () => {
      let engine: DefaultPolicyEngine;

      beforeEach(() => {
        engine = new DefaultPolicyEngine();
      });

      it('should trigger custom rule when changed files match glob and decision exceeds threshold', () => {
        const customRule: CustomPolicyRule = {
          id: 'crypto_review_required',
          files: ['src/crypto/**', 'src/security/**'],
          exclude: ['**/*.test.ts'],
          question: 'Does this change modify cryptographic primitives without audited review?',
          review: 0.60,
          block: 0.90,
        };

        const policy: PolicyConfig = {
          version: 1,
          custom_rules: [customRule],
        };

        const context: EvaluationContext = {
          diff: {
            raw: 'diff --git a/src/crypto/aes.ts b/src/crypto/aes.ts\n+const cipher = createCipher();\n',
            files: [
              { newPath: 'src/crypto/aes.ts', status: 'modified', binary: false },
              { newPath: 'src/crypto/aes.test.ts', status: 'modified', binary: false },
            ],
            insertions: 1,
            deletions: 0,
            truncated: false,
          },
          files: [],
          instructions: [],
          relatedTests: [],
          repository: { rootPath: process.cwd(), branch: 'main', headSha: 'abc', isClean: false },
          evidence: [],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'crypto_review_required',
            question: customRule.question,
            probability: 0.92, // >= 0.90 => block
            rationale: 'Modifies AES encryption key derivation',
          },
        ];

        const result = engine.evaluate([], decisions, policy, context);
        expect(result.verdict).toBe('BLOCK');
        expect(result.violatedRules).toContain('crypto_review_required');
        expect(result.findings.length).toBe(1);
        // Excluded test file should not be in affectedFiles
        expect(result.findings[0].affectedFiles).toEqual(['src/crypto/aes.ts']);
      });

      it('should skip custom rule when changed files only match excluded patterns', () => {
        const customRule: CustomPolicyRule = {
          id: 'crypto_review_required',
          files: ['src/crypto/**'],
          exclude: ['**/*.test.ts'],
          question: 'Cryptographic modification?',
          review: 0.60,
          block: 0.90,
        };

        const policy: PolicyConfig = {
          version: 1,
          custom_rules: [customRule],
        };

        // Changeset contains ONLY test file matching exclude
        const context: EvaluationContext = {
          diff: {
            raw: 'diff --git a/src/crypto/aes.test.ts b/src/crypto/aes.test.ts\n+it("works", () => {})\n',
            files: [{ newPath: 'src/crypto/aes.test.ts', status: 'modified', binary: false }],
            insertions: 1,
            deletions: 0,
            truncated: false,
          },
          files: [],
          instructions: [],
          relatedTests: [],
          repository: { rootPath: process.cwd(), branch: 'main', headSha: 'abc', isClean: false },
          evidence: [],
        };

        const decisions: SemanticDecision[] = [
          {
            id: 'crypto_review_required',
            question: customRule.question,
            probability: 0.99,
          },
        ];

        const result = engine.evaluate([], decisions, policy, context);
        // Custom rule not applicable, should pass
        expect(result.verdict).toBe('PASS');
        expect(result.violatedRules.length).toBe(0);
      });

      it('should match custom rule decision by question if id does not match decision id', () => {
        const customRule: CustomPolicyRule = {
          id: 'custom_rule_id_123',
          files: ['src/**'],
          question: 'Does this change affect public API stability?',
          review: 0.70,
        };

        const policy: PolicyConfig = {
          version: 1,
          custom_rules: [customRule],
        };

        const context: EvaluationContext = {
          diff: {
            raw: 'diff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n',
            files: [{ newPath: 'src/api.ts', status: 'modified', binary: false }],
            insertions: 1,
            deletions: 0,
            truncated: false,
          },
          files: [],
          instructions: [],
          relatedTests: [],
          repository: { rootPath: process.cwd(), branch: 'main', headSha: 'abc', isClean: false },
          evidence: [],
        };

        // When decision.id equals the question string, decisionMap.get(customRule.question) finds it
        const decisionsWithQuestionAsId: SemanticDecision[] = [
          {
            id: 'Does this change affect public API stability?',
            question: 'Does this change affect public API stability?',
            probability: 0.85,
          },
        ];

        const result = engine.evaluate([], decisionsWithQuestionAsId, policy, context);
        expect(result.verdict).toBe('REVIEW');
        expect(result.violatedRules).toContain('custom_rule_id_123');

        // Documenting empirical discovery: if decision.id is an arbitrary hash not matching rule.id or question,
        // it is not matched because decisionMap indexes strictly by decision.id
        const unmappedDecisions: SemanticDecision[] = [
          {
            id: 'unmapped_hash_456',
            question: 'Does this change affect public API stability?',
            probability: 0.85,
          },
        ];
        const unmappedResult = engine.evaluate([], unmappedDecisions, policy, context);
        expect(unmappedResult.verdict).toBe('PASS');
      });

      it('should respect enabled: false on custom rules', () => {
        const customRule: CustomPolicyRule = {
          id: 'disabled_rule',
          enabled: false,
          files: ['src/**'],
          question: 'Is something wrong?',
          block: 0.1,
        };

        const policy: PolicyConfig = {
          version: 1,
          custom_rules: [customRule],
        };

        const context: EvaluationContext = {
          diff: {
            raw: 'diff --git a/src/api.ts b/src/api.ts\n+export function api() {}\n',
            files: [{ newPath: 'src/api.ts', status: 'modified', binary: false }],
            insertions: 1,
            deletions: 0,
            truncated: false,
          },
          files: [],
          instructions: [],
          relatedTests: [],
          repository: { rootPath: process.cwd(), branch: 'main', headSha: 'abc', isClean: false },
          evidence: [],
        };

        const decisions: SemanticDecision[] = [
          { id: 'disabled_rule', question: 'Is something wrong?', probability: 0.99 },
        ];

        const result = engine.evaluate([], decisions, policy, context);
        expect(result.verdict).toBe('PASS');
        expect(result.violatedRules).not.toContain('disabled_rule');
      });
    });
  });
});
