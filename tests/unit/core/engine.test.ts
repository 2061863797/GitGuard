import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DefaultGitGuardEngine, mergeQuestions, MAX_AGENT_QUESTIONS } from '../../../src/core/engine.js';
import { parseConfig } from '../../../src/policy/config.js';
import { ConfigurationError, ProviderError } from '../../../src/types/errors.js';
import type { DecisionProvider, SemanticQuestion } from '../../../src/types/provider.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';

const configWithQuestion = parseConfig(`
version: 1
questions:
  - id: config_question
    question: "Does this change leave debug logging behind?"
    level: warn
`);

describe('DefaultGitGuardEngine check and verify', () => {
  let repository: GitFixture;
  let provider: DecisionProvider;
  let yes: Set<string>;
  let asked: SemanticQuestion[][];
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    repository = await createTempGitRepo();
    await repository.writeFile('README.md', '# fixture\n');
    await repository.stage();
    await repository.commit('initial');
    yes = new Set();
    asked = [];
    const stub = createOnlineSemanticStub();
    provider = {
      name: 'typesafe',
      isAvailable: stub.isAvailable,
      async evaluate(context, questions) {
        asked.push(questions);
        const decisions = await stub.evaluate(context, questions);
        return decisions.map((d) => ({ ...d, probability: yes.has(d.id) ? 0.9 : d.probability }));
      },
    };
    engine = new DefaultGitGuardEngine({ typesafeProvider: provider });
  });

  afterEach(async () => {
    await repository.cleanup();
  });

  it('runs only the secret scan without .gitguard.yml and never calls the provider without questions', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await engine.check({ cwd: repository.path });
    expect(result.status).toBe('PASS');
    expect(result.canCommit).toBe(true);
    expect(Object.fromEntries(result.deterministicResults.map((r) => [r.id, r.status]))).toEqual({
      secret_scan: 'passed', test: 'skipped', lint: 'skipped', typecheck: 'skipped',
    });
    expect(result.metadata.questionsAsked).toBe(0);
    expect(asked).toEqual([]);
  });

  it('does not need TYPESAFE_API_KEY when no questions are asked', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    try {
      const live = new DefaultGitGuardEngine();
      await repository.writeFile('src/app.ts', 'export const value = 1;\n');
      const result = await live.check({ cwd: repository.path });
      expect(result.status).toBe('PASS');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed with a clear error when questions are asked without TYPESAFE_API_KEY', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    try {
      const live = new DefaultGitGuardEngine();
      await repository.writeFile('src/app.ts', 'export const value = 1;\n');
      await expect(live.check({
        cwd: repository.path,
        questions: [{ id: 'missing_tests', question: 'Does this change lack tests?', level: 'review' }],
      })).rejects.toThrow(/TYPESAFE_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('asks agent and config questions together and turns a yes answer into a finding with its level', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    yes.add('missing_validation');
    const result = await engine.check({
      cwd: repository.path,
      config: configWithQuestion,
      task: 'Add value export',
      questions: [{ id: 'missing_validation', question: 'Does this change skip input validation?', level: 'block' }],
    });

    expect(asked).toHaveLength(1);
    expect(asked[0].map((q) => q.id).sort()).toEqual(['config_question', 'missing_validation']);
    expect(asked[0].find((q) => q.id === 'missing_validation')?.prompt).toBe('Does this change skip input validation?');
    expect(result.status).toBe('BLOCK');
    expect(result.canCommit).toBe(false);
    const finding = result.findings.find((f) => f.ruleId === 'missing_validation')!;
    expect(finding.status).toBe('block');
    expect(finding.source).toBe('semantic');
    expect(finding.metadata?.question).toMatchObject({ id: 'missing_validation', source: 'agent', level: 'block' });
    expect(result.findings.some((f) => f.ruleId === 'config_question')).toBe(false);
  });

  it('skips questions whose file filters do not match the changeset', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await engine.check({
      cwd: repository.path,
      questions: [
        { id: 'migration_rollback', question: 'Does this migration lack a rollback?', level: 'review', files: ['migrations/**'] },
        { id: 'app_logic', question: 'Does this change break the app?', level: 'review', files: ['src/**'], exclude: ['**/*.test.ts'] },
      ],
    });
    expect(asked[0].map((q) => q.id)).toEqual(['app_logic']);
    expect(result.metadata.questionsAsked).toBe(1);
  });

  it('asks nothing for a clean changeset', async () => {
    const result = await engine.check({
      cwd: repository.path,
      questions: [{ id: 'anything', question: 'Is anything wrong?', level: 'warn' }],
    });
    expect(result.status).toBe('PASS');
    expect(result.diffSummary.filesChanged).toBe(0);
    expect(asked).toEqual([]);
  });

  it('re-asks the stored agent question during verify and resolves it when the answer becomes no', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    yes.add('debug_output');
    const checked = await engine.check({
      cwd: repository.path,
      questions: [{ id: 'debug_output', question: 'Does this change print debug output?', level: 'review' }],
    });
    const finding = checked.findings.find((f) => f.ruleId === 'debug_output')!;
    expect(checked.status).toBe('REVIEW');

    yes.clear();
    asked = [];
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const verified = await engine.verify({ cwd: repository.path, findingIds: [finding.id] });

    expect(asked[0].map((q) => q.id)).toEqual(['debug_output']);
    expect(verified.status).toBe('PASS');
    expect(verified.resolved).toEqual([finding.id]);
  });

  it('keeps a verified finding open while the answer is still yes', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    yes.add('debug_output');
    const checked = await engine.check({
      cwd: repository.path,
      questions: [{ id: 'debug_output', question: 'Does this change print debug output?', level: 'block' }],
    });
    const finding = checked.findings[0];
    const verified = await engine.verify({ cwd: repository.path, findingIds: [finding.id] });
    expect(verified.status).toBe('BLOCK');
    expect(verified.remaining).toEqual([finding.id]);
  });

  it('raises ProviderError when the provider omits an answer', async () => {
    const partial: DecisionProvider = {
      name: 'typesafe',
      async isAvailable() { return true; },
      async evaluate() { return []; },
    };
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    await expect(new DefaultGitGuardEngine({ typesafeProvider: partial }).check({
      cwd: repository.path,
      questions: [{ id: 'q1', question: 'Is something wrong?', level: 'warn' }],
    })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('mergeQuestions', () => {
  const configQuestions = configWithQuestion.questions!;

  it('tags sources and keeps config questions first', () => {
    const merged = mergeQuestions(configQuestions, [{ id: 'agent_q', question: 'Is it broken?', level: 'warn' }]);
    expect(merged.map((q) => [q.id, q.source])).toEqual([['config_question', 'config'], ['agent_q', 'agent']]);
  });

  it('rejects agent questions that reuse a config id or each other', () => {
    expect(() => mergeQuestions(configQuestions, [{ id: 'config_question', question: 'x?', level: 'warn' }]))
      .toThrow(ConfigurationError);
    expect(() => mergeQuestions([], [
      { id: 'dup', question: 'a?', level: 'warn' },
      { id: 'dup', question: 'b?', level: 'warn' },
    ])).toThrow(/already used/);
  });

  it('rejects malformed agent questions and too many questions', () => {
    expect(() => mergeQuestions([], [{ id: 'Bad-Id', question: 'x?', level: 'warn' }])).toThrow(/id must match/);
    expect(() => mergeQuestions([], [{ id: 'ok', question: 'x?', level: 'fatal' as 'warn' }])).toThrow(/level/);
    const many = Array.from({ length: MAX_AGENT_QUESTIONS + 1 }, (_, i) => ({ id: `q${i}`, question: 'x?', level: 'warn' as const }));
    expect(() => mergeQuestions([], many)).toThrow(/At most/);
  });

  it('adds stored agent questions only when their id is still free', () => {
    const merged = mergeQuestions(configQuestions, [], [
      { id: 'old_agent', question: 'Old?', level: 'review', source: 'agent' },
      { id: 'config_question', question: 'Stale copy?', level: 'block', source: 'agent' },
      { id: 'old_config', question: 'Removed from yml?', level: 'block', source: 'config' },
    ]);
    expect(merged.map((q) => q.id)).toEqual(['config_question', 'old_agent']);
    expect(merged[0].question).toBe('Does this change leave debug logging behind?');
  });
});
