import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DefaultGitGuardEngine, mergeRules, MAX_AGENT_RULES } from '../../../src/core/engine.js';
import { parseConfig } from '../../../src/policy/config.js';
import { ConfigurationError, ProviderError } from '../../../src/types/errors.js';
import type { DecisionProvider, SemanticQuestion } from '../../../src/types/provider.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';

const configWithRule = parseConfig(`
version: 1
rules:
  - id: config_rule
    rule: "不得遗留调试日志"
    level: warn
`);

describe('DefaultGitGuardEngine check and verify', () => {
  let repository: GitFixture;
  let provider: DecisionProvider;
  let violated: Set<string>;
  let asked: SemanticQuestion[][];
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    repository = await createTempGitRepo();
    await repository.writeFile('README.md', '# fixture\n');
    await repository.stage();
    await repository.commit('initial');
    violated = new Set();
    asked = [];
    const stub = createOnlineSemanticStub();
    provider = {
      name: 'typesafe',
      isAvailable: stub.isAvailable,
      async evaluate(context, questions) {
        asked.push(questions);
        const decisions = await stub.evaluate(context, questions);
        return decisions.map((d) => ({ ...d, probability: violated.has(d.id) ? 0.9 : d.probability }));
      },
    };
    engine = new DefaultGitGuardEngine({ typesafeProvider: provider });
  });

  afterEach(async () => {
    await repository.cleanup();
  });

  it('runs only the secret scan without .gitguard.yml and never calls the provider without rules', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await engine.check({ cwd: repository.path });
    expect(result.status).toBe('PASS');
    expect(result.canCommit).toBe(true);
    expect(Object.fromEntries(result.deterministicResults.map((r) => [r.id, r.status]))).toEqual({
      secret_scan: 'passed', test: 'skipped', lint: 'skipped', typecheck: 'skipped',
    });
    expect(result.metadata.rulesChecked).toBe(0);
    expect(asked).toEqual([]);
  });

  it('does not need TYPESAFE_API_KEY when no rules are checked', async () => {
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

  it('fails closed with a clear error when rules are checked without TYPESAFE_API_KEY', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    try {
      const live = new DefaultGitGuardEngine();
      await repository.writeFile('src/app.ts', 'export const value = 1;\n');
      await expect(live.check({
        cwd: repository.path,
        rules: [{ id: 'needs_tests', rule: 'Behaviour changes must come with tests', level: 'review' }],
      })).rejects.toThrow(/TYPESAFE_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('checks agent and config rules together and turns a violation into a finding with its level', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    violated.add('validate_input');
    const result = await engine.check({
      cwd: repository.path,
      config: configWithRule,
      task: 'Add value export',
      rules: [{ id: 'validate_input', rule: 'All external input must be validated', level: 'block' }],
    });

    expect(asked).toHaveLength(1);
    expect(asked[0].map((q) => q.id).sort()).toEqual(['config_rule', 'validate_input']);
    const prompt = asked[0].find((q) => q.id === 'validate_input')!.prompt;
    expect(prompt).toContain('violate');
    expect(prompt).toContain('Rule: All external input must be validated');
    expect(asked[0].find((q) => q.id === 'config_rule')!.prompt).toContain('Rule: 不得遗留调试日志');
    expect(result.status).toBe('BLOCK');
    expect(result.canCommit).toBe(false);
    const finding = result.findings.find((f) => f.ruleId === 'validate_input')!;
    expect(finding.status).toBe('block');
    expect(finding.source).toBe('semantic');
    expect(finding.message).toContain('All external input must be validated');
    expect(finding.metadata?.rule).toMatchObject({ id: 'validate_input', source: 'agent', level: 'block' });
    expect(result.findings.some((f) => f.ruleId === 'config_rule')).toBe(false);
  });

  it('skips rules whose file filters do not match the changeset', async () => {
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await engine.check({
      cwd: repository.path,
      rules: [
        { id: 'migration_rollback', rule: 'Migrations must have a rollback', level: 'review', files: ['migrations/**'] },
        { id: 'app_logic', rule: 'App code must not break existing behaviour', level: 'review', files: ['src/**'], exclude: ['**/*.test.ts'] },
      ],
    });
    expect(asked[0].map((q) => q.id)).toEqual(['app_logic']);
    expect(result.metadata.rulesChecked).toBe(1);
  });

  it('checks nothing for a clean changeset', async () => {
    const result = await engine.check({
      cwd: repository.path,
      rules: [{ id: 'anything', rule: 'Nothing may be wrong', level: 'warn' }],
    });
    expect(result.status).toBe('PASS');
    expect(result.diffSummary.filesChanged).toBe(0);
    expect(asked).toEqual([]);
  });

  it('re-checks the stored agent rule during verify and resolves it once it is no longer violated', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    violated.add('no_debug_output');
    const checked = await engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug_output', rule: 'Code must not print debug output', level: 'review' }],
    });
    const finding = checked.findings.find((f) => f.ruleId === 'no_debug_output')!;
    expect(checked.status).toBe('REVIEW');

    violated.clear();
    asked = [];
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    const verified = await engine.verify({ cwd: repository.path, findingIds: [finding.id] });

    expect(asked[0].map((q) => q.id)).toEqual(['no_debug_output']);
    expect(verified.status).toBe('PASS');
    expect(verified.resolved).toEqual([finding.id]);
  });

  it('keeps a verified finding open while the rule is still violated', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    violated.add('no_debug_output');
    const checked = await engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug_output', rule: 'Code must not print debug output', level: 'block' }],
    });
    const finding = checked.findings[0];
    const verified = await engine.verify({ cwd: repository.path, findingIds: [finding.id] });
    expect(verified.status).toBe('BLOCK');
    expect(verified.remaining).toEqual([finding.id]);
  });

  it('raises ProviderError when the provider omits a judgment', async () => {
    const partial: DecisionProvider = {
      name: 'typesafe',
      async isAvailable() { return true; },
      async evaluate() { return []; },
    };
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    await expect(new DefaultGitGuardEngine({ typesafeProvider: partial }).check({
      cwd: repository.path,
      rules: [{ id: 'r1', rule: 'Nothing may be wrong', level: 'warn' }],
    })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('mergeRules', () => {
  const configRules = configWithRule.rules!;

  it('tags sources and keeps config rules first', () => {
    const merged = mergeRules(configRules, [{ id: 'agent_r', rule: 'Must not break', level: 'warn' }]);
    expect(merged.map((r) => [r.id, r.source])).toEqual([['config_rule', 'config'], ['agent_r', 'agent']]);
  });

  it('rejects agent rules that reuse a config id or each other', () => {
    expect(() => mergeRules(configRules, [{ id: 'config_rule', rule: 'x', level: 'warn' }]))
      .toThrow(ConfigurationError);
    expect(() => mergeRules([], [
      { id: 'dup', rule: 'a', level: 'warn' },
      { id: 'dup', rule: 'b', level: 'warn' },
    ])).toThrow(/already used/);
  });

  it('rejects malformed agent rules and too many rules', () => {
    expect(() => mergeRules([], [{ id: 'Bad-Id', rule: 'x', level: 'warn' }])).toThrow(/id must match/);
    expect(() => mergeRules([], [{ id: 'ok', rule: 'x', level: 'fatal' as 'warn' }])).toThrow(/level/);
    expect(() => mergeRules([], [{ id: 'ok', question: 'x?', level: 'warn' } as never])).toThrow(/rule must be a non-empty string/);
    const many = Array.from({ length: MAX_AGENT_RULES + 1 }, (_, i) => ({ id: `r${i}`, rule: 'x', level: 'warn' as const }));
    expect(() => mergeRules([], many)).toThrow(/At most/);
  });

  it('adds stored agent rules only when their id is still free', () => {
    const merged = mergeRules(configRules, [], [
      { id: 'old_agent', rule: 'Old rule', level: 'review', source: 'agent' },
      { id: 'config_rule', rule: 'Stale copy', level: 'block', source: 'agent' },
      { id: 'old_config', rule: 'Removed from yml', level: 'block', source: 'config' },
    ]);
    expect(merged.map((r) => r.id)).toEqual(['config_rule', 'old_agent']);
    expect(merged[0].rule).toBe('不得遗留调试日志');
  });
});
