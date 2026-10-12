import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('agent rules that are still violated', () => {
  let repository: GitFixture;
  let violated: Set<string>;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    repository = await createTempGitRepo();
    await repository.writeFile('README.md', '# fixture\n');
    await repository.stage();
    await repository.commit('initial');
    violated = new Set();
    const stub = createOnlineSemanticStub();
    engine = new DefaultGitGuardEngine({
      typesafeProvider: {
        name: 'typesafe',
        isAvailable: stub.isAvailable,
        async evaluate(context, questions) {
          const decisions = await stub.evaluate(context, questions);
          return decisions.map((d) => ({ ...d, probability: violated.has(d.id) ? 0.9 : 0.1 }));
        },
      },
    });
  });

  afterEach(async () => {
    await repository.cleanup();
  });

  it('are re-checked when the next check leaves them out, so the BLOCK stays', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    violated.add('no_debug');
    const first = await engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug', rule: 'Code must not print debug output', level: 'block' }],
    });
    expect(first.status).toBe('BLOCK');

    const again = await engine.check({ cwd: repository.path });
    expect(again.status).toBe('BLOCK');
    expect(again.metadata.rulesChecked).toBe(1);

    violated.clear();
    await repository.writeFile('src/app.ts', 'export const value = 1;\n');
    expect((await engine.check({ cwd: repository.path })).status).toBe('PASS');
  });

  it('cannot be reworded or downgraded by the agent while still active', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    violated.add('no_debug');
    await engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug', rule: 'Code must not print debug output', level: 'block' }],
    });
    await expect(engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug', rule: 'Anything goes', level: 'block' }],
    })).rejects.toThrow(/still violated/);
    await expect(engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug', rule: 'Code must not print debug output', level: 'warn' }],
    })).rejects.toThrow(/still violated/);
  });

  it('stop being re-checked once HEAD moves', async () => {
    await repository.writeFile('src/app.ts', 'console.log("debug");\n');
    violated.add('no_debug');
    await engine.check({
      cwd: repository.path,
      rules: [{ id: 'no_debug', rule: 'Code must not print debug output', level: 'block' }],
    });
    await repository.stage();
    await repository.exec(['commit', '-q', '--no-verify', '-m', 'committed by a person']);
    await repository.writeFile('src/other.ts', 'export const other = 1;\n');
    const next = await engine.check({ cwd: repository.path });
    expect(next.metadata.rulesChecked).toBe(0);
  });
});

describe('project command cache', () => {
  let repository: GitFixture;
  let counterDir: string;

  beforeEach(async () => {
    repository = await createTempGitRepo();
    await repository.writeFile('README.md', '# fixture\n');
    await repository.stage();
    await repository.commit('initial');
    counterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitguard-counter-'));
  });

  afterEach(async () => {
    await repository.cleanup();
    fs.rmSync(counterDir, { recursive: true, force: true });
  });

  function counterConfig(exitCode = 0) {
    const script = path.join(counterDir, 'count.cjs');
    fs.writeFileSync(script, `const fs = require('fs'); fs.appendFileSync(${JSON.stringify(path.join(counterDir, 'runs.txt'))}, 'x'); process.exit(${exitCode});\n`);
    return parseConfig(`deterministic:\n  test: "node ${script.split(path.sep).join('/')}"\n`);
  }
  const runs = () => (fs.existsSync(path.join(counterDir, 'runs.txt')) ? fs.readFileSync(path.join(counterDir, 'runs.txt'), 'utf8').length : 0);

  it('reuses a passing result until the content changes', async () => {
    const engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
    const config = counterConfig(0);
    await repository.writeFile('src/app.ts', 'export const a = 1;\n');

    const first = await engine.check({ cwd: repository.path, config });
    expect(first.deterministicResults.find((r) => r.id === 'test')?.status).toBe('passed');
    const second = await engine.check({ cwd: repository.path, config });
    expect(second.deterministicResults.find((r) => r.id === 'test')?.summary).toMatch(/cached/);
    expect(runs()).toBe(1);

    await repository.writeFile('src/app.ts', 'export const a = 2;\n');
    await engine.check({ cwd: repository.path, config });
    expect(runs()).toBe(2);
  });

  it('never caches a failing result', async () => {
    const engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
    const config = counterConfig(1);
    await repository.writeFile('src/app.ts', 'export const a = 1;\n');
    expect((await engine.check({ cwd: repository.path, config })).status).toBe('BLOCK');
    expect((await engine.check({ cwd: repository.path, config })).status).toBe('BLOCK');
    expect(runs()).toBe(2);
  });

  it('still scans for secrets when command results come from the cache', async () => {
    const engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
    const config = counterConfig(0);
    await repository.writeFile('src/app.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repository.path, config });
    const result = await engine.check({ cwd: repository.path, config, scope: 'staged' });
    expect(result.deterministicResults.map((r) => r.id).sort()).toEqual(['secret_scan', 'test']);
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
