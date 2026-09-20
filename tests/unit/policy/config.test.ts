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

  it('should export identical DEFAULT_POLICY_CONFIG and DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG).toEqual(DEFAULT_POLICY_CONFIG);
    expect(DEFAULT_CONFIG.version).toBe(1);
    expect(DEFAULT_CONFIG.deterministic?.test?.enabled).toBe(true);
    expect(DEFAULT_CONFIG.rules?.task_completed?.enabled).toBe(true);
    expect(DEFAULT_CONFIG.context?.max_diff_chars).toBe(50000);
  });

  it('should return default config if no .gitguard.yml exists in directory', async () => {
    const config = await loadConfig(undefined, tmpDir);
    expect(config.version).toBe(1);
    expect(config.context?.max_diff_chars).toBe(50000);
    expect(config.deterministic?.test?.run).toBe('pnpm test');
  });

  it('should parse and merge a valid YAML configuration', () => {
    const yaml = `
version: 1
context:
  max_diff_chars: 20000
rules:
  task_completed:
    review_below: 0.75
custom_rules:
  - id: custom_auth_test
    question: "Is auth modified without tests?"
    files:
      - "src/auth/**"
`;
    const config = parseConfig(yaml);
    expect(config.context?.max_diff_chars).toBe(20000);
    expect(config.context?.max_total_chars).toBe(100000); // Preserved from default
    expect(config.rules?.task_completed?.review_below).toBe(0.75);
    expect(config.custom_rules).toHaveLength(1);
    expect(config.custom_rules![0].id).toBe('custom_auth_test');
  });

  it('should throw ConfigurationError on malformed YAML', () => {
    const invalidYaml = 'version: [unclosed bracket';
    expect(() => parseConfig(invalidYaml)).toThrow(ConfigurationError);
  });

  it('should throw ConfigurationError if YAML is not an object', () => {
    expect(() => parseConfig('hello world')).toThrow(ConfigurationError);
    expect(() => parseConfig('12345')).toThrow(ConfigurationError);
  });

  it('should load config from explicit file path', async () => {
    const customConfigPath = path.join(tmpDir, 'custom.yml');
    await fs.writeFile(
      customConfigPath,
      `
version: 2
rules:
  tests_required:
    warn: 0.90
`,
      'utf-8'
    );

    const config = await loadConfig(customConfigPath, tmpDir);
    expect(config.version).toBe(2);
    expect(config.rules?.tests_required?.warn).toBe(0.9);
    // Preserved defaults
    expect(config.deterministic?.lint?.enabled).toBe(true);
  });

  it('should throw ConfigurationError if explicit config path does not exist', async () => {
    const nonExistent = path.join(tmpDir, 'missing.yml');
    await expect(loadConfig(nonExistent, tmpDir)).rejects.toThrow(
      ConfigurationError
    );
  });

  it('should discover .gitguard.yml automatically in directory', async () => {
    const configFile = path.join(tmpDir, '.gitguard.yml');
    await fs.writeFile(
      configFile,
      `
version: 1
system_one:
  provider: mock
`,
      'utf-8'
    );

    const config = await loadConfig(undefined, tmpDir);
    expect(config.system_one?.provider).toBe('mock');
  });

  it('should validate custom rules schema correctly', () => {
    const valid = validateConfig({
      version: 1,
      custom_rules: [
        {
          id: 'rule_1',
          question: 'Are there issues?',
          files: ['src/**'],
        },
      ],
    });
    expect(valid.valid).toBe(true);
    expect(valid.errors).toHaveLength(0);

    const invalid = validateConfig({
      version: 1,
      custom_rules: [
        {
          id: '',
          question: '',
          files: 'not-an-array',
        },
      ],
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it('should deepMerge nested objects without mutating source or target', () => {
    const target = { a: 1, b: { c: 2, d: 3 } };
    const source = { b: { c: 99 }, e: 5 };
    const merged = deepMerge(target, source);

    expect(merged).toEqual({ a: 1, b: { c: 99, d: 3 }, e: 5 });
    expect(target.b.c).toBe(2); // Immutability of original target
  });
});
