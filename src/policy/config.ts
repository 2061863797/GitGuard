/**
 * src/policy/config.ts
 * Policy configuration loader, parser, validator, and default constants for GitGuard (.gitguard.yml).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { PolicyConfig, RuleSpec } from '../types/policy.js';
import { ConfigurationError } from '../types/errors.js';
import { safeReadRepoFile } from '../context/fs.js';
import { validateCustomSecretPattern } from '../analysis/deterministic/secrets.js';

/**
 * Built-in GitGuard configuration. `.gitguard.yml` can only add project commands, rules and
 * extra secret patterns; context budgets, model settings and privacy filtering are fixed here.
 */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  version: 1,
  context: {
    max_diff_chars: 50000,
    max_total_chars: 100000,
    surrounding_lines: 40,
    related_tests: {
      max_files: 5,
    },
    instructions: {
      max_chars: 15000,
    },
  },
  system_one: {
    model: 'jev-latest',
    timeout_ms: 10000,
  },
  // Project commands run only when a repository configures them explicitly.
  deterministic: {
    test: { enabled: false },
    lint: { enabled: false },
    typecheck: { enabled: false },
    secret_scan: {
      enabled: true,
      block_on_detection: true,
    },
  },
  rules: [],
  privacy: {
    redact_secrets: true,
    include_full_files: false,
    exclude_paths: [
      '.env*',
      '*.pem',
      '*.key',
      'credentials.json',
      'secrets.*',
      'id_rsa*',
    ],
  },
};

/**
 * Exported alias for DEFAULT_POLICY_CONFIG.
 */
export const DEFAULT_CONFIG = DEFAULT_POLICY_CONFIG;

/**
 * Standard configuration file names searched in repository roots.
 */
export const CONFIG_FILE_NAMES = [
  '.gitguard.yml',
  '.gitguard.yaml',
  'gitguard.yml',
  'gitguard.yaml',
];

/**
 * Keys rejected anywhere in the file: `yaml` preserves `__proto__` as an own key,
 * so a malicious `.gitguard.yml` could otherwise smuggle prototype-polluting data through.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively detects prototype-polluting keys anywhere in a parsed config
 * object. Uses Object.keys/values (never dot access) so a `__proto__` own
 * key planted by YAML parsing is reliably observed.
 */
function containsUnsafeKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsUnsafeKeys);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => UNSAFE_MERGE_KEYS.has(k))) {
    return true;
  }
  return keys.some((k) => containsUnsafeKeys(obj[k]));
}

export const RULE_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
export const RULE_LEVELS = ['warn', 'review', 'block'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

/**
 * Validates one rule entry shared by .gitguard.yml and agent input. Returns error messages.
 */
export function validateRule(raw: unknown, label: string): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${label} must be an object`];
  }
  const q = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof q.id !== 'string' || !RULE_ID_PATTERN.test(q.id)) {
    errors.push(`${label}.id must match [a-z0-9_] and be at most 64 characters`);
  }
  if (typeof q.rule !== 'string' || !q.rule.trim() || q.rule.length > 1000) {
    errors.push(`${label}.rule must be a non-empty string of at most 1000 characters`);
  }
  if (!RULE_LEVELS.includes(q.level as (typeof RULE_LEVELS)[number])) {
    errors.push(`${label}.level must be one of warn, review, block`);
  }
  if (q.files !== undefined && !isStringArray(q.files)) {
    errors.push(`${label}.files must be an array of glob strings`);
  }
  if (q.exclude !== undefined && !isStringArray(q.exclude)) {
    errors.push(`${label}.exclude must be an array of glob strings`);
  }
  for (const key of Object.keys(q)) {
    if (!['id', 'rule', 'level', 'files', 'exclude'].includes(key)) {
      errors.push(`${label}.${key} is not a supported rule field`);
    }
  }
  return errors;
}

/**
 * Top-level keys accepted in .gitguard.yml. Everything else uses built-in defaults.
 */
const TOP_LEVEL_KEYS = ['version', 'deterministic', 'rules', 'secret_scan'];
const COMMAND_CHECKS = ['test', 'lint', 'typecheck'] as const;
const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;

function unknownKeys(obj: Record<string, unknown>, allowed: string[], label: string): string[] {
  return Object.keys(obj)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${label}${key} is not supported (allowed: ${allowed.join(', ')})`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateCommand(raw: unknown, label: string): string[] {
  const isCommandText = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value);
  if (typeof raw === 'string') {
    return isCommandText(raw) ? [] : [`${label} must be a single-line command`];
  }
  if (!isPlainObject(raw)) {
    return [`${label} must be a command string or an object with run and optional timeout_ms`];
  }
  const errors = unknownKeys(raw, ['run', 'timeout_ms'], `${label}.`);
  if (!isCommandText(raw.run)) {
    errors.push(`${label}.run must be a single-line command`);
  }
  if (raw.timeout_ms !== undefined &&
      (!Number.isInteger(raw.timeout_ms) || (raw.timeout_ms as number) <= 0 || (raw.timeout_ms as number) > MAX_COMMAND_TIMEOUT_MS)) {
    errors.push(`${label}.timeout_ms must be a positive integer of milliseconds (at most ${MAX_COMMAND_TIMEOUT_MS})`);
  }
  return errors;
}

/**
 * Validates the raw .gitguard.yml object. Only version, deterministic (test/lint/typecheck),
 * rules and secret_scan.patterns are accepted; unknown keys are errors so typos are not ignored.
 */
export function validateConfig(raw: unknown): { valid: boolean; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['Configuration must be a YAML mapping'] };
  }
  const errors: string[] = [];
  if (containsUnsafeKeys(raw)) {
    errors.push('Configuration contains forbidden keys (__proto__/constructor/prototype). Remove them from .gitguard.yml.');
  }
  errors.push(...unknownKeys(raw, TOP_LEVEL_KEYS, ''));

  if (raw.version !== undefined && raw.version !== 1 && raw.version !== '1') {
    errors.push('version must be 1');
  }

  if (raw.deterministic !== undefined) {
    if (!isPlainObject(raw.deterministic)) {
      errors.push('deterministic must be a mapping of test, lint and typecheck commands');
    } else {
      errors.push(...unknownKeys(raw.deterministic, [...COMMAND_CHECKS], 'deterministic.'));
      for (const checkId of COMMAND_CHECKS) {
        if (raw.deterministic[checkId] !== undefined) {
          errors.push(...validateCommand(raw.deterministic[checkId], `deterministic.${checkId}`));
        }
      }
    }
  }

  if (raw.secret_scan !== undefined) {
    if (!isPlainObject(raw.secret_scan)) {
      errors.push('secret_scan must be a mapping with patterns');
    } else {
      errors.push(...unknownKeys(raw.secret_scan, ['patterns'], 'secret_scan.'));
      const patterns = raw.secret_scan.patterns;
      if (patterns !== undefined) {
        if (!Array.isArray(patterns)) {
          errors.push('secret_scan.patterns must be a list of regex strings');
        } else {
          patterns.forEach((pattern: unknown, i: number) => {
            if (typeof pattern !== 'string' || !pattern.trim()) {
              errors.push(`secret_scan.patterns[${i}] must be a non-empty string`);
            } else {
              const reason = validateCustomSecretPattern(pattern);
              if (reason) errors.push(`secret_scan.patterns[${i}] is unsafe: ${reason}`);
            }
          });
        }
      }
    }
  }

  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) {
      errors.push('rules must be a list of rules (id, rule, level)');
    } else {
      const seen = new Set<string>();
      raw.rules.forEach((rule: unknown, i: number) => {
        errors.push(...validateRule(rule, `rules[${i}]`));
        const id = (rule as Record<string, unknown> | null)?.id;
        if (typeof id === 'string') {
          if (seen.has(id)) errors.push(`rules[${i}].id '${id}' is duplicated`);
          seen.add(id);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function defaults(): PolicyConfig {
  return JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
}

/**
 * Parses and validates .gitguard.yml text into the internal policy configuration.
 */
export function parseConfig(yamlContent: string): PolicyConfig {
  if (!yamlContent || yamlContent.trim() === '') {
    return defaults();
  }

  // Strip leading UTF-8 Byte Order Mark (BOM) if present
  const sanitizedContent =
    yamlContent.charCodeAt(0) === 0xfeff ? yamlContent.slice(1) : yamlContent;

  let parsed: unknown;
  try {
    parsed = YAML.parse(sanitizedContent);
  } catch (err: any) {
    throw new ConfigurationError(`YAML parse error: ${err.message || String(err)}`);
  }

  if (parsed === null || parsed === undefined) {
    return defaults();
  }

  const validation = validateConfig(parsed);
  if (!validation.valid) {
    throw new ConfigurationError(`Invalid .gitguard.yml: ${validation.errors.join('; ')}`);
  }

  const raw = parsed as Record<string, any>;
  const config = defaults();
  for (const checkId of COMMAND_CHECKS) {
    const command = raw.deterministic?.[checkId];
    if (command === undefined) continue;
    const run = typeof command === 'string' ? command : command.run;
    config.deterministic![checkId] = {
      enabled: true,
      run: run.trim(),
      block_on_failure: true,
      ...(typeof command === 'object' && command.timeout_ms !== undefined ? { timeout_ms: command.timeout_ms } : {}),
    };
  }
  if (raw.secret_scan?.patterns) {
    config.deterministic!.secret_scan!.patterns = raw.secret_scan.patterns;
  }
  config.rules = (raw.rules ?? []).map((rule: RuleSpec) => ({ ...rule, source: 'config' as const }));
  return config;
}

/**
 * Loads and validates .gitguard.yml configuration.
 * Searches explicit configPath or standard repository config filenames.
 * Falls back safely to DEFAULT_POLICY_CONFIG if no configuration file is found.
 */
export async function loadConfig(
  configPath?: string,
  cwd: string = process.cwd()
): Promise<PolicyConfig> {
  // 1. Explicit path specified
  if (configPath) {
    const resolvedPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(cwd, configPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new ConfigurationError(`Specified config file does not exist: ${resolvedPath}`);
    }

    try {
      const lstats = await fs.promises.lstat(resolvedPath);
      if (lstats.isSymbolicLink()) {
        const realPath = await fs.promises.realpath(resolvedPath);
        const normalizedRoot = path.resolve(cwd);
        if (!realPath.startsWith(normalizedRoot + path.sep) && realPath !== normalizedRoot) {
          throw new ConfigurationError(`Config file is a symbolic link pointing outside repository: ${resolvedPath}`);
        }
      }
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      return parseConfig(content);
    } catch (err: any) {
      if (err instanceof ConfigurationError) {
        throw err;
      }
      throw new ConfigurationError(`Failed to read config at ${resolvedPath}: ${err.message}`);
    }
  }

  // 2. Search default config file names in cwd and recursively up to repository root
  let currentDir = path.resolve(cwd);
  while (true) {
    for (const filename of CONFIG_FILE_NAMES) {
      const candidate = path.join(currentDir, filename);
      if (fs.existsSync(candidate)) {
        try {
          const stats = await fs.promises.stat(candidate);
          if (stats.isDirectory()) {
            throw new ConfigurationError(`Failed to read config at ${candidate}: EISDIR, illegal operation on a directory, read`);
          }
          const content = await safeReadRepoFile(currentDir, filename);
          if (content !== null) {
            return parseConfig(content);
          }
          throw new ConfigurationError(`Failed to read config at ${candidate}: Unreadable or escaping symbolic link`);
        } catch (err: any) {
          if (err instanceof ConfigurationError) {
            throw err;
          }
          throw new ConfigurationError(`Failed to read config at ${candidate}: ${err.message}`);
        }
      }
    }

    // Stop searching upwards if current directory contains a .git folder or pointer file
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      break;
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  // 3. Zero-config fallback: return a fresh clone of default configuration
  return JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
}
