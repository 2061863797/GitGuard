/**
 * tests/unit/policy/engine.test.ts
 * DefaultPolicyEngine: deterministic results plus System One's judgments of rules.
 */

import { describe, it, expect } from 'vitest';
import { DefaultPolicyEngine } from '../../../src/policy/engine.js';
import { evaluateRule, ruleAppliesTo, rulePrompt, VIOLATION_THRESHOLD } from '../../../src/policy/rules.js';
import { DEFAULT_POLICY_CONFIG } from '../../../src/policy/config.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { RuleSpec } from '../../../src/types/policy.js';
import type { DeterministicResult, SemanticDecision } from '../../../src/types/provider.js';

function context(paths: string[]): EvaluationContext {
  return {
    diff: {
      raw: paths.map((p) => `diff --git a/${p} b/${p}\n+change\n`).join(''),
      files: paths.map((p) => ({
        oldPath: p, newPath: p, status: 'modified', binary: false, additions: 1, deletions: 0,
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: '@@ -1,0 +1,1 @@', lines: [{ type: 'add', content: 'change' }] }],
      })),
      insertions: paths.length,
      deletions: 0,
    },
    files: [],
    instructions: [],
    relatedTests: [],
    repository: { rootPath: '/repo', headSha: 'abc', branch: 'main' },
    evidence: [],
  } as unknown as EvaluationContext;
}

const makeRule = (id: string, level: RuleSpec['level'], extra: Partial<RuleSpec> = {}): RuleSpec => ({
  id, rule: `Rule ${id} must hold`, level, source: 'agent', ...extra,
});
const judgment = (id: string, probability: number): SemanticDecision => ({ id, probability, provider: 'typesafe' });
const passedSecretScan: DeterministicResult = { id: 'secret_scan', status: 'passed', durationMs: 0, violations: [] };

describe('rulePrompt', () => {
  it('asks whether the change violates the rule and embeds the rule text verbatim', () => {
    const prompt = rulePrompt(makeRule('r', 'block', { rule: '金额计算不能使用浮点数' }));
    expect(prompt).toMatch(/^Does this code change violate the following rule\?/);
    expect(prompt).toContain('Rule: 金额计算不能使用浮点数');
  });
});

describe('evaluateRule', () => {
  it('triggers the rule level at or above the 0.5 violation threshold', () => {
    expect(VIOLATION_THRESHOLD).toBe(0.5);
    expect(evaluateRule(judgment('r', 0.49), makeRule('r', 'block'), ['a.ts'])).toBeNull();
    const match = evaluateRule(judgment('r', 0.5), makeRule('r', 'block'), ['a.ts'])!;
    expect(match).toMatchObject({ ruleId: 'r', source: 'semantic', status: 'block', severity: 'CRITICAL', affectedFiles: ['a.ts'] });
    expect(match.rule?.id).toBe('r');
    expect(match.message).toContain('Violates rule "Rule r must hold"');
  });

  it.each([['warn', 'WARN'], ['review', 'ERROR'], ['block', 'CRITICAL']] as const)(
    'maps level %s to severity %s', (level, severity) => {
      expect(evaluateRule(judgment('r', 0.9), makeRule('r', level), [])?.severity).toBe(severity);
    }
  );

  it('includes the rationale in the message when present', () => {
    const match = evaluateRule({ ...judgment('r', 0.8), rationale: 'floats used for cents' }, makeRule('r', 'warn'), [])!;
    expect(match.message).toContain('floats used for cents');
  });
});

describe('ruleAppliesTo', () => {
  it('applies to all changed files without a filter, minus excludes', () => {
    expect(ruleAppliesTo(makeRule('r', 'warn'), ['src/a.ts', 'src/a.test.ts'])).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(ruleAppliesTo(makeRule('r', 'warn', { exclude: ['**/*.test.ts'] }), ['src/a.ts', 'src/a.test.ts'])).toEqual(['src/a.ts']);
    expect(ruleAppliesTo(makeRule('r', 'warn', { exclude: ['**/*.ts'] }), ['src/a.ts'])).toBeNull();
  });

  it('returns null when the file filter matches nothing', () => {
    expect(ruleAppliesTo(makeRule('r', 'warn', { files: ['migrations/**'] }), ['src/a.ts'])).toBeNull();
    expect(ruleAppliesTo(makeRule('r', 'warn', { files: ['src/**'] }), ['src/a.ts', 'docs/b.md'])).toEqual(['src/a.ts']);
  });
});

describe('DefaultPolicyEngine', () => {
  const engine = new DefaultPolicyEngine();

  it('passes when no rule is violated', () => {
    const result = engine.evaluate([passedSecretScan], [judgment('a', 0.1), judgment('b', 0.2)],
      [makeRule('a', 'block'), makeRule('b', 'review')], DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('PASS');
    expect(result.findings).toEqual([]);
    expect(result.passedRules).toEqual(expect.arrayContaining(['deterministic.secret_scan', 'a', 'b']));
  });

  it('uses the worst level among violated rules and creates findings', () => {
    const result = engine.evaluate([passedSecretScan], [judgment('a', 0.9), judgment('b', 0.7), judgment('c', 0.1)],
      [makeRule('a', 'warn'), makeRule('b', 'review'), makeRule('c', 'block')], DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('REVIEW');
    expect(result.violatedRules.sort()).toEqual(['a', 'b']);
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['a', 'b']);
    expect(result.findings[0].metadata?.rule).toBeDefined();
  });

  it('blocks on a failed deterministic check regardless of rule judgments', () => {
    const failedTest: DeterministicResult = { id: 'test', status: 'failed', exitCode: 1, durationMs: 5, summary: 'tests failed' };
    const config = { ...DEFAULT_POLICY_CONFIG, deterministic: { ...DEFAULT_POLICY_CONFIG.deterministic, test: { enabled: true, run: 'pnpm test' } } };
    const result = engine.evaluate([passedSecretScan, failedTest], [], [], config, context(['src/x.ts']));
    expect(result.verdict).toBe('BLOCK');
    expect(result.violatedRules).toEqual(['deterministic.test']);
  });

  it('ignores rules that were not judged or do not apply to the changed files', () => {
    const result = engine.evaluate([passedSecretScan], [judgment('scoped', 0.99)],
      [makeRule('scoped', 'block', { files: ['migrations/**'] }), makeRule('unjudged', 'block')],
      DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('PASS');
  });
});
