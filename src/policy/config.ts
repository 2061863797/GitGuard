/**
 * src/policy/config.ts
 * Policy configuration loader, parser, validator, and default constants for GitGuard (.gitguard.yml).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { PolicyConfig } from '../types/policy.js';
import { ConfigurationError } from '../types/errors.js';
import { safeReadRepoFile } from '../context/fs.js';
import { validateCustomSecretPattern } from '../analysis/deterministic/secrets.js';

/**
 * Canonical default GitGuard policy configuration.
 * Used when no .gitguard.yml is present, or as a baseline merged with repository overrides.
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
  questions: [],
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
 * Keys that must never be merged as plain data: assigning them would mutate
 * the prototype chain instead of setting an own property (prototype pollution).
 * Note: `yaml` preserves `__proto__` as an own key (visible via Object.keys),
 * so a malicious `.gitguard.yml` could otherwise smuggle these past validation.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively deep-merges source object properties into a cloned target object.
 * Skips prototype-polluting keys (`__proto__`, `constructor`, `prototype`).
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const result = { ...target } as Record<string, any>;

  for (const key of Object.keys(source)) {
    // Prototype pollution guard: never copy magic keys, even if present as
    // own properties of the parsed YAML object.
    if (UNSAFE_MERGE_KEYS.has(key)) {
      continue;
    }

    const sourceVal = source[key];
    const targetVal = result[key];

    if (sourceVal === undefined) {
      continue;
    }

    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }

  return result as T;
}

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

/**
 * Configuration keys removed in 0.3 with migration hints.
 */
const REMOVED_CONFIG_KEYS: Array<[string, string]> = [
  ['rules', 'Built-in semantic rules no longer exist; express each concern as an entry under questions.'],
  ['custom_rules', 'Move each rule to questions with id, question, level (warn|review|block) and optional files/exclude.'],
  ['gate', 'Verdicts are fixed (BLOCK stops a commit) and semantic caching was removed; delete this section.'],
  ['system_one.provider', 'Only the TypeSafe provider remains and offline/mock mode was removed; delete this field.'],
];

export const QUESTION_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
export const QUESTION_LEVELS = ['warn', 'review', 'block'] as const;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

/**
 * Validates one question entry shared by .gitguard.yml and agent input. Returns error messages.
 */
export function validateQuestion(raw: unknown, label: string): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${label} must be an object`];
  }
  const q = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof q.id !== 'string' || !QUESTION_ID_PATTERN.test(q.id)) {
    errors.push(`${label}.id must match [a-z0-9_] and be at most 64 characters`);
  }
  if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 1000) {
    errors.push(`${label}.question must be a non-empty string of at most 1000 characters`);
  }
  if (!QUESTION_LEVELS.includes(q.level as (typeof QUESTION_LEVELS)[number])) {
    errors.push(`${label}.level must be one of warn, review, block`);
  }
  if (q.files !== undefined && !isStringArray(q.files)) {
    errors.push(`${label}.files must be an array of glob strings`);
  }
  if (q.exclude !== undefined && !isStringArray(q.exclude)) {
    errors.push(`${label}.exclude must be an array of glob strings`);
  }
  for (const key of Object.keys(q)) {
    if (!['id', 'question', 'level', 'files', 'exclude'].includes(key)) {
      errors.push(`${label}.${key} is not a supported question field`);
    }
  }
  return errors;
}

/**
 * Validates the raw configuration object structure.
 */
export function validateConfig(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Configuration must be a non-null object'] };
  }

  if (containsUnsafeKeys(raw)) {
    errors.push(
      'Configuration contains forbidden keys (__proto__/constructor/prototype). Remove them from .gitguard.yml.'
    );
  }

  const obj = raw as Record<string, any>;

  if (obj.version !== undefined && typeof obj.version !== 'number' && typeof obj.version !== 'string') {
    errors.push('version must be a number or string');
  }

  if (obj.system_one && typeof obj.system_one === 'object') {
    if (obj.system_one.apiKey !== undefined) {
      errors.push(
        'Storing apiKey directly in .gitguard.yml is forbidden for credential security. Set the TYPESAFE_API_KEY environment variable instead.'
      );
    }
    if (obj.system_one.baseUrl !== undefined) {
      const rawUrl = String(obj.system_one.baseUrl).trim().replace(/\/+$/, '');
      const isOfficial =
        rawUrl === 'https://api.typesafe.ai' ||
        rawUrl === 'https://api.typesafe.ai/v1' ||
        rawUrl === 'https://api.typesafe.ai/v1/systemone';
      if (!isOfficial) {
        errors.push(
          `Repository configuration (.gitguard.yml) cannot override system_one.baseUrl to custom endpoint ('${rawUrl}') to prevent API key exfiltration. Use the TYPESAFE_BASE_URL environment variable instead.`
        );
      }
    }
  }

  if (obj.privacy !== undefined &&
      (!obj.privacy || typeof obj.privacy !== 'object' || Array.isArray(obj.privacy))) {
    errors.push('privacy must be an object');
  } else {
    if (obj.privacy?.redact_secrets !== undefined && obj.privacy.redact_secrets !== true) {
      errors.push('Repository configuration cannot disable privacy.redact_secrets');
    }
    if (obj.privacy?.include_full_files !== undefined && obj.privacy.include_full_files !== false) {
      errors.push('Repository configuration cannot enable privacy.include_full_files');
    }
  }

  for (const [key, hint] of REMOVED_CONFIG_KEYS) {
    const [section, field] = key.split('.');
    const present = field
      ? obj[section] && typeof obj[section] === 'object' && Object.hasOwn(obj[section], field)
      : Object.hasOwn(obj, section);
    if (present) {
      errors.push(`'${key}' was removed in GitGuard 0.3. ${hint}`);
    }
  }

  if (obj.deterministic?.secret_scan?.patterns !== undefined) {
    if (!Array.isArray(obj.deterministic.secret_scan.patterns)) {
      errors.push('deterministic.secret_scan.patterns must be an array of regex strings');
    } else {
      for (let i = 0; i < obj.deterministic.secret_scan.patterns.length; i++) {
        const pattern = obj.deterministic.secret_scan.patterns[i];
        if (typeof pattern !== 'string' || !pattern.trim()) {
          errors.push(`deterministic.secret_scan.patterns[${i}] must be a non-empty string`);
        } else {
          const reason = validateCustomSecretPattern(pattern);
          if (reason) {
            errors.push(`deterministic.secret_scan.patterns[${i}] is unsafe: ${reason}`);
          }
        }
      }
    }
  }

  if (obj.questions !== undefined) {
    if (!Array.isArray(obj.questions)) {
      errors.push('questions must be an array');
    } else {
      const seen = new Set<string>();
      obj.questions.forEach((question: unknown, i: number) => {
        errors.push(...validateQuestion(question, `questions[${i}]`));
        const id = (question as Record<string, unknown> | null)?.id;
        if (typeof id === 'string') {
          if (seen.has(id)) errors.push(`questions[${i}].id '${id}' is duplicated`);
          seen.add(id);
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parses and validates YAML configuration text, merging it over DEFAULT_POLICY_CONFIG.
 */
export function parseConfig(yamlContent: string): PolicyConfig {
  if (!yamlContent || yamlContent.trim() === '') {
    return JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
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
    return JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
  }

  if (typeof parsed !== 'object') {
    throw new ConfigurationError('Configuration file must contain a valid YAML mapping/object');
  }

  const validation = validateConfig(parsed);
  if (!validation.valid) {
    throw new ConfigurationError(`Invalid configuration schema: ${validation.errors.join('; ')}`);
  }

  // Deep clone default config and merge user config
  const clonedDefault = JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
  const merged = deepMerge(clonedDefault, parsed as Record<string, any>);
  // A configured command implies the check is wanted unless explicitly disabled.
  for (const checkId of ['test', 'lint', 'typecheck'] as const) {
    const userCheck = (parsed as Record<string, any>).deterministic?.[checkId];
    const check = merged.deterministic?.[checkId];
    if (check && userCheck && userCheck.enabled === undefined && typeof check.run === 'string' && check.run.trim()) {
      check.enabled = true;
    }
  }
  merged.questions = (merged.questions ?? []).map((question) => ({ ...question, source: 'config' as const }));
  return merged;
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
