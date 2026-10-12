/**
 * tests/unit/policy/config.test.ts
 * Unit tests for GitGuard policy config loader, parser, validator, and defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadConfig,
  parseConfig,
  validateConfig,
  validateRule,
  DEFAULT_POLICY_CONFIG,
  DEFAULT_CONFIG,
  deepMerge,
} from '../../../src/policy/config.js';
import { ConfigurationError } from '../../../src/types/errors.js';

describe('Policy Configuration Loader & Validator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-config-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('defaults to secret scanning only, with no project commands and no rules', () => {
    expect(DEFAULT_CONFIG).toEqual(DEFAULT_POLICY_CONFIG);
    expect(DEFAULT_CONFIG.version).toBe(1);
    expect(DEFAULT_CONFIG.deterministic?.secret_scan?.enabled).toBe(true);
    for (const id of ['test', 'lint', 'typecheck'] as const) {
      expect(DEFAULT_CONFIG.deterministic?.[id]?.enabled).toBe(false);
      expect(DEFAULT_CONFIG.deterministic?.[id]?.run).toBeUndefined();
    }
    expect(DEFAULT_CONFIG.rules).toEqual([]);
    expect(DEFAULT_CONFIG.context?.max_diff_chars).toBe(50000);
  });

  it('returns the default config if no .gitguard.yml exists in directory', async () => {
    const config = await loadConfig(undefined, tmpDir);
    expect(config.version).toBe(1);
    expect(config.deterministic?.test?.enabled).toBe(false);
  });

  it('parses rules, tags them as config rules and keeps defaults', () => {
    const config = parseConfig(`
version: 1
context:
  max_diff_chars: 20000
rules:
  - id: auth_without_tests
    rule: "修改鉴权代码必须同时补充测试"
    level: review
    files: ["src/auth/**"]
    exclude: ["**/*.test.ts"]
`);
    expect(config.context?.max_diff_chars).toBe(20000);
    expect(config.context?.max_total_chars).toBe(100000);
    expect(config.rules).toEqual([{
      id: 'auth_without_tests',
      rule: '修改鉴权代码必须同时补充测试',
      level: 'review',
      files: ['src/auth/**'],
      exclude: ['**/*.test.ts'],
      source: 'config',
    }]);
  });

  it('enables a project command when only run is configured, unless explicitly disabled', () => {
    const config = parseConfig(`
version: 1
deterministic:
  test:
    run: "pnpm test"
  lint:
    run: "pnpm lint"
    enabled: false
`);
    expect(config.deterministic?.test).toMatchObject({ enabled: true, run: 'pnpm test' });
    expect(config.deterministic?.lint).toMatchObject({ enabled: false, run: 'pnpm lint' });
    expect(config.deterministic?.typecheck?.enabled).toBe(false);
  });

  it('requires rules to be a list', () => {
    expect(() => parseConfig('version: 1\nrules:\n  no_float: "x"\n')).toThrow(/rules must be a list/);
  });

  it('rejects invalid or duplicated rules', () => {
    const result = validateConfig({
      version: 1,
      rules: [
        { id: 'Bad Id', rule: '', level: 'fatal', files: 'src/**' },
        { id: 'dup', rule: 'a?', level: 'warn' },
        { id: 'dup', rule: 'b?', level: 'warn', extra: true },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/rules\[0\]\.id must match/);
    expect(result.errors.join('\n')).toMatch(/rules\[0\]\.rule must be/);
    expect(result.errors.join('\n')).toMatch(/rules\[0\]\.level/);
    expect(result.errors.join('\n')).toMatch(/rules\[0\]\.files/);
    expect(result.errors.join('\n')).toMatch(/'dup' is duplicated/);
    expect(result.errors.join('\n')).toMatch(/rules\[2\]\.extra is not a supported rule field/);
    expect(validateConfig({ version: 1, rules: [{ id: 'q', question: 'Is it bad?', level: 'warn' }] }).errors.join('\n'))
      .toMatch(/rules\[0\]\.question is not a supported rule field/);
  });

  it('validateRule accepts a minimal valid rule', () => {
    expect(validateRule({ id: 'ok_1', rule: 'Public APIs must stay backward compatible', level: 'block' }, 'r')).toEqual([]);
  });

  it('throws ConfigurationError on malformed YAML or non-object YAML', () => {
    expect(() => parseConfig('version: [unclosed bracket')).toThrow(ConfigurationError);
    expect(() => parseConfig('hello world')).toThrow(ConfigurationError);
    expect(() => parseConfig('12345')).toThrow(ConfigurationError);
  });

  it('loads config from an explicit file path', async () => {
    const customConfigPath = path.join(tmpDir, 'custom.yml');
    await fs.writeFile(customConfigPath, 'version: 2\ncontext:\n  surrounding_lines: 10\n', 'utf-8');
    const config = await loadConfig(customConfigPath, tmpDir);
    expect(config.version).toBe(2);
    expect(config.context?.surrounding_lines).toBe(10);
    expect(config.deterministic?.secret_scan?.enabled).toBe(true);
  });

  it('throws ConfigurationError if explicit config path does not exist', async () => {
    await expect(loadConfig(path.join(tmpDir, 'missing.yml'), tmpDir)).rejects.toThrow(ConfigurationError);
  });

  it('discovers .gitguard.yml automatically in directory', async () => {
    await fs.writeFile(path.join(tmpDir, '.gitguard.yml'), 'version: 1\nsystem_one:\n  model: jev-custom\n', 'utf-8');
    const config = await loadConfig(undefined, tmpDir);
    expect(config.system_one?.model).toBe('jev-custom');
  });

  it('rejects unsafe repository provider and privacy overrides', () => {
    expect(() => parseConfig('version: 1\nsystem_one:\n  baseUrl: http://127.0.0.1:8080\n'))
      .toThrow(/TYPESAFE_BASE_URL/);
    expect(() => parseConfig('version: 1\nsystem_one:\n  apiKey: secret\n'))
      .toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nprivacy:\n  redact_secrets: false\n'))
      .toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nprivacy:\n  include_full_files: true\n'))
      .toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nprivacy:\n  redact_secrets: 0\n'))
      .toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nprivacy:\n  include_full_files: "true"\n'))
      .toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nprivacy: []\n'))
      .toThrow(ConfigurationError);
    expect(parseConfig('version: 1\nsystem_one:\n  baseUrl: https://api.typesafe.ai/v1\n').system_one?.baseUrl)
      .toBe('https://api.typesafe.ai/v1');
  });

  it('rejects unbounded custom secret patterns but accepts bounded patterns', () => {
    expect(() => parseConfig('version: 1\ndeterministic:\n  secret_scan:\n    patterns: ["^(a+)+$"]\n'))
      .toThrow(ConfigurationError);
    const config = parseConfig(
      'version: 1\ndeterministic:\n  secret_scan:\n    patterns: ["[A-Z0-9]{32}"]\n'
    );
    expect(config.deterministic?.secret_scan?.patterns).toEqual(['[A-Z0-9]{32}']);
  });

  it('deepMerges nested objects without mutating source or target', () => {
    const target = { a: 1, b: { c: 2, d: 3 } };
    const source = { b: { c: 99 }, e: 5 };
    const merged = deepMerge(target, source);

    expect(merged).toEqual({ a: 1, b: { c: 99, d: 3 }, e: 5 });
    expect(target.b.c).toBe(2);
  });
});
