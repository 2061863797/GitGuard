/**
 * tests/unit/policy/config.test.ts
 * Unit tests for the .gitguard.yml loader: the minimal schema and its mapping to built-in defaults.
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
    expect(DEFAULT_CONFIG.deterministic?.secret_scan?.enabled).toBe(true);
    for (const id of ['test', 'lint', 'typecheck'] as const) {
      expect(DEFAULT_CONFIG.deterministic?.[id]?.enabled).toBe(false);
      expect(DEFAULT_CONFIG.deterministic?.[id]?.run).toBeUndefined();
    }
    expect(DEFAULT_CONFIG.rules).toEqual([]);
    expect(DEFAULT_CONFIG.context?.max_diff_chars).toBe(50000);
    expect(DEFAULT_CONFIG.privacy?.redact_secrets).toBe(true);
  });

  it('returns the default config if no .gitguard.yml exists in directory', async () => {
    const config = await loadConfig(undefined, tmpDir);
    expect(config).toEqual(DEFAULT_POLICY_CONFIG);
  });

  it('maps the full minimal schema onto the built-in defaults', () => {
    const config = parseConfig(`
version: 1
deterministic:
  test: "pnpm test"
  lint:
    run: "pnpm lint"
    timeout_ms: 90000
rules:
  - id: auth_tests
    rule: "修改鉴权代码必须同时补充测试"
    level: review
    files: ["src/auth/**"]
    exclude: ["**/*.test.ts"]
secret_scan:
  patterns: ["[A-Z0-9]{32}"]
`);
    expect(config.deterministic?.test).toEqual({ enabled: true, run: 'pnpm test', block_on_failure: true });
    expect(config.deterministic?.lint).toEqual({ enabled: true, run: 'pnpm lint', block_on_failure: true, timeout_ms: 90000 });
    expect(config.deterministic?.typecheck?.enabled).toBe(false);
    expect(config.deterministic?.secret_scan).toEqual({ enabled: true, block_on_detection: true, patterns: ['[A-Z0-9]{32}'] });
    expect(config.rules).toEqual([{
      id: 'auth_tests',
      rule: '修改鉴权代码必须同时补充测试',
      level: 'review',
      files: ['src/auth/**'],
      exclude: ['**/*.test.ts'],
      source: 'config',
    }]);
    expect(config.context).toEqual(DEFAULT_POLICY_CONFIG.context);
    expect(config.privacy).toEqual(DEFAULT_POLICY_CONFIG.privacy);
    expect(config.system_one).toEqual(DEFAULT_POLICY_CONFIG.system_one);
  });

  it.each([
    ['context', 'context:\n  max_diff_chars: 1\n'],
    ['privacy', 'privacy:\n  redact_secrets: false\n'],
    ['system_one', 'system_one:\n  baseUrl: http://127.0.0.1:8080\n'],
    ['gate', 'gate:\n  block_on: [BLOCK]\n'],
    ['custom_rules', 'custom_rules: []\n'],
    ['typo', 'rule:\n  - id: x\n'],
  ])('rejects the unsupported top-level key %s', (key, body) => {
    expect(() => parseConfig('version: 1\n' + body)).toThrow(/is not supported \(allowed: version, deterministic, rules, secret_scan\)/);
  });

  it.each([
    ['unknown check', 'deterministic:\n  build: "make"\n', /deterministic\.build is not supported/],
    ['enabled flag', 'deterministic:\n  test:\n    run: "x"\n    enabled: false\n', /deterministic\.test\.enabled is not supported/],
    ['missing run', 'deterministic:\n  test:\n    timeout_ms: 1000\n', /deterministic\.test\.run must be a single-line command/],
    ['multi-line command', 'deterministic:\n  test: "a\\nb"\n', /single-line command/],
    ['bad timeout', 'deterministic:\n  test:\n    run: "x"\n    timeout_ms: -5\n', /timeout_ms must be a positive integer/],
    ['old secret_scan location', 'deterministic:\n  secret_scan:\n    patterns: ["x{3}"]\n', /deterministic\.secret_scan is not supported/],
    ['secret_scan extra key', 'secret_scan:\n  enabled: false\n', /secret_scan\.enabled is not supported/],
  ])('rejects %s', (_label, body, error) => {
    expect(() => parseConfig('version: 1\n' + body)).toThrow(error);
  });

  it('only accepts version 1', () => {
    expect(() => parseConfig('version: 2\n')).toThrow(/version must be 1/);
  });

  it('requires rules to be a list', () => {
    expect(() => parseConfig('version: 1\nrules:\n  no_float: "x"\n')).toThrow(/rules must be a list/);
  });

  it('rejects invalid or duplicated rules', () => {
    const result = validateConfig({
      version: 1,
      rules: [
        { id: 'Bad Id', rule: '', level: 'fatal', files: 'src/**' },
        { id: 'dup', rule: 'a', level: 'warn' },
        { id: 'dup', rule: 'b', level: 'warn', extra: true },
      ],
    });
    expect(result.valid).toBe(false);
    const errors = result.errors.join('\n');
    expect(errors).toMatch(/rules\[0\]\.id must match/);
    expect(errors).toMatch(/rules\[0\]\.rule must be/);
    expect(errors).toMatch(/rules\[0\]\.level/);
    expect(errors).toMatch(/rules\[0\]\.files/);
    expect(errors).toMatch(/'dup' is duplicated/);
    expect(errors).toMatch(/rules\[2\]\.extra is not a supported rule field/);
  });

  it('validateRule accepts a minimal valid rule', () => {
    expect(validateRule({ id: 'ok_1', rule: 'Public APIs must stay backward compatible', level: 'block' }, 'r')).toEqual([]);
  });

  it('throws ConfigurationError on malformed YAML, non-mapping YAML and prototype keys', () => {
    expect(() => parseConfig('version: [unclosed bracket')).toThrow(ConfigurationError);
    expect(() => parseConfig('hello world')).toThrow(ConfigurationError);
    expect(() => parseConfig('- a\n- b\n')).toThrow(ConfigurationError);
    expect(() => parseConfig('version: 1\nrules:\n  - __proto__: {}\n')).toThrow(/forbidden keys/);
  });

  it('treats an empty file as the defaults', () => {
    expect(parseConfig('')).toEqual(DEFAULT_POLICY_CONFIG);
    expect(parseConfig('# only a comment\n')).toEqual(DEFAULT_POLICY_CONFIG);
  });

  it('loads config from an explicit file path and discovers .gitguard.yml', async () => {
    const customConfigPath = path.join(tmpDir, 'custom.yml');
    await fs.writeFile(customConfigPath, 'deterministic:\n  test: "npm test"\n', 'utf-8');
    expect((await loadConfig(customConfigPath, tmpDir)).deterministic?.test?.run).toBe('npm test');

    await fs.writeFile(path.join(tmpDir, '.gitguard.yml'), 'deterministic:\n  lint: "npm run lint"\n', 'utf-8');
    expect((await loadConfig(undefined, tmpDir)).deterministic?.lint?.run).toBe('npm run lint');
  });

  it('throws ConfigurationError if explicit config path does not exist', async () => {
    await expect(loadConfig(path.join(tmpDir, 'missing.yml'), tmpDir)).rejects.toThrow(ConfigurationError);
  });

  it('rejects unbounded custom secret patterns but accepts bounded patterns', () => {
    expect(() => parseConfig('secret_scan:\n  patterns: ["^(a+)+$"]\n')).toThrow(/secret_scan\.patterns\[0\] is unsafe/);
    expect(parseConfig('secret_scan:\n  patterns: ["[A-Z0-9]{32}"]\n').deterministic?.secret_scan?.patterns)
      .toEqual(['[A-Z0-9]{32}']);
  });
});
