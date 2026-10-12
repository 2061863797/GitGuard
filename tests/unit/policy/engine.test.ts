/**
 * tests/unit/policy/engine.test.ts
 * DefaultPolicyEngine: deterministic results plus yes/no question answers.
 */

import { describe, it, expect } from 'vitest';
import { DefaultPolicyEngine } from '../../../src/policy/engine.js';
import { evaluateQuestion, questionAppliesTo, QUESTION_YES_THRESHOLD } from '../../../src/policy/rules.js';
import { DEFAULT_POLICY_CONFIG } from '../../../src/policy/config.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { QuestionSpec } from '../../../src/types/policy.js';
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

const question = (id: string, level: QuestionSpec['level'], extra: Partial<QuestionSpec> = {}): QuestionSpec => ({
  id, question: `Is ${id} a problem?`, level, source: 'agent', ...extra,
});
const answer = (id: string, probability: number): SemanticDecision => ({ id, probability, provider: 'typesafe' });
const passedSecretScan: DeterministicResult = { id: 'secret_scan', status: 'passed', durationMs: 0, violations: [] };

describe('evaluateQuestion', () => {
  it('triggers the question level at or above the 0.5 threshold', () => {
    expect(QUESTION_YES_THRESHOLD).toBe(0.5);
    expect(evaluateQuestion(answer('q', 0.49), question('q', 'block'), ['a.ts'])).toBeNull();
    const match = evaluateQuestion(answer('q', 0.5), question('q', 'block'), ['a.ts'])!;
    expect(match).toMatchObject({ ruleId: 'q', source: 'semantic', status: 'block', severity: 'CRITICAL', affectedFiles: ['a.ts'] });
    expect(match.question?.id).toBe('q');
  });

  it.each([['warn', 'WARN'], ['review', 'ERROR'], ['block', 'CRITICAL']] as const)(
    'maps level %s to severity %s', (level, severity) => {
      expect(evaluateQuestion(answer('q', 0.9), question('q', level), [])?.severity).toBe(severity);
    }
  );

  it('includes the rationale in the message when present', () => {
    const match = evaluateQuestion({ ...answer('q', 0.8), rationale: 'floats used for cents' }, question('q', 'warn'), [])!;
    expect(match.message).toContain('floats used for cents');
  });
});

describe('questionAppliesTo', () => {
  it('applies to all changed files without a filter, minus excludes', () => {
    expect(questionAppliesTo(question('q', 'warn'), ['src/a.ts', 'src/a.test.ts'])).toEqual(['src/a.test.ts', 'src/a.ts']);
    expect(questionAppliesTo(question('q', 'warn', { exclude: ['**/*.test.ts'] }), ['src/a.ts', 'src/a.test.ts'])).toEqual(['src/a.ts']);
    expect(questionAppliesTo(question('q', 'warn', { exclude: ['**/*.ts'] }), ['src/a.ts'])).toBeNull();
  });

  it('returns null when the file filter matches nothing', () => {
    expect(questionAppliesTo(question('q', 'warn', { files: ['migrations/**'] }), ['src/a.ts'])).toBeNull();
    expect(questionAppliesTo(question('q', 'warn', { files: ['src/**'] }), ['src/a.ts', 'docs/b.md'])).toEqual(['src/a.ts']);
  });
});

describe('DefaultPolicyEngine', () => {
  const engine = new DefaultPolicyEngine();

  it('passes when every question is answered no', () => {
    const result = engine.evaluate([passedSecretScan], [answer('a', 0.1), answer('b', 0.2)],
      [question('a', 'block'), question('b', 'review')], DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('PASS');
    expect(result.findings).toEqual([]);
    expect(result.passedRules).toEqual(expect.arrayContaining(['deterministic.secret_scan', 'a', 'b']));
  });

  it('uses the worst level among yes answers and creates findings', () => {
    const result = engine.evaluate([passedSecretScan], [answer('a', 0.9), answer('b', 0.7), answer('c', 0.1)],
      [question('a', 'warn'), question('b', 'review'), question('c', 'block')], DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('REVIEW');
    expect(result.violatedRules.sort()).toEqual(['a', 'b']);
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['a', 'b']);
    expect(result.findings[0].metadata?.question).toBeDefined();
  });

  it('blocks on a failed deterministic check regardless of answers', () => {
    const failedTest: DeterministicResult = { id: 'test', status: 'failed', exitCode: 1, durationMs: 5, summary: 'tests failed' };
    const config = { ...DEFAULT_POLICY_CONFIG, deterministic: { ...DEFAULT_POLICY_CONFIG.deterministic, test: { enabled: true, run: 'pnpm test' } } };
    const result = engine.evaluate([passedSecretScan, failedTest], [], [], config, context(['src/x.ts']));
    expect(result.verdict).toBe('BLOCK');
    expect(result.violatedRules).toEqual(['deterministic.test']);
  });

  it('ignores questions that were not answered or do not apply to the changed files', () => {
    const result = engine.evaluate([passedSecretScan], [answer('scoped', 0.99)],
      [question('scoped', 'block', { files: ['migrations/**'] }), question('unanswered', 'block')],
      DEFAULT_POLICY_CONFIG, context(['src/x.ts']));
    expect(result.verdict).toBe('PASS');
  });
});
