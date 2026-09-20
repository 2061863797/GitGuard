/**
 * src/policy/config.ts
 * Policy configuration loader, parser, validator, and default constants for GitGuard (.gitguard.yml).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { PolicyConfig } from '../types/policy.js';
import { ConfigurationError } from '../types/errors.js';

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
    provider: 'typesafe',
    model: 'jev-latest',
    timeout_ms: 10000,
  },
  deterministic: {
    test: {
      enabled: true,
      run: 'pnpm test',
      block_on_failure: true,
      timeout_ms: 60000,
    },
    lint: {
      enabled: true,
      run: 'pnpm lint',
      block_on_failure: true,
      timeout_ms: 30000,
    },
    typecheck: {
      enabled: true,
      run: 'pnpm tsc --noEmit',
      block_on_failure: true,
      timeout_ms: 45000,
    },
    secret_scan: {
      enabled: true,
      block_on_detection: true,
    },
  },
  rules: {
    task_completed: {
      enabled: true,
      review_below: 0.6,
      block_below: 0.2,
    },
    unrelated_changes: {
      enabled: true,
      warn: 0.55,
      review: 0.75,
      block: 0.95,
    },
    tests_required: {
      enabled: true,
      warn: 0.6,
      review: 0.8,
    },
    security_sensitive: {
      enabled: true,
      warn: 0.5,
      review: 0.65,
      block: 0.9,
    },
    regression_risk: {
      enabled: true,
      warn_on: ['medium'],
      review_on: ['high'],
      block_on: ['critical'],
    },
  },
  custom_rules: [],
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
  gate: {
    block_on: ['BLOCK'],
    cache: {
      enabled: true,
      directory: '.git/gitguard/cache',
    },
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
 * Recursively deep-merges source object properties into a cloned target object.
 */
export function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const result = { ...target } as Record<string, any>;

  for (const key of Object.keys(source)) {
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
 * Validates the raw configuration object structure and thresholds.
 */
export function validateConfig(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Configuration must be a non-null object'] };
  }

  const obj = raw as Record<string, any>;

  if (obj.version !== undefined && typeof obj.version !== 'number' && typeof obj.version !== 'string') {
    errors.push('version must be a number or string');
  }

  if (obj.custom_rules !== undefined) {
    if (!Array.isArray(obj.custom_rules)) {
      errors.push('custom_rules must be an array');
    } else {
      for (let i = 0; i < obj.custom_rules.length; i++) {
        const rule = obj.custom_rules[i];
        if (!rule || typeof rule !== 'object') {
          errors.push(`custom_rules[${i}] must be an object`);
          continue;
        }
        if (!rule.id || typeof rule.id !== 'string') {
          errors.push(`custom_rules[${i}].id must be a non-empty string`);
        }
        if (!rule.question || typeof rule.question !== 'string') {
          errors.push(`custom_rules[${i}].question must be a non-empty string`);
        }
        if (!Array.isArray(rule.files)) {
          errors.push(`custom_rules[${i}].files must be an array of glob strings`);
        }
      }
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
  return deepMerge(clonedDefault, parsed as Record<string, any>);
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
      const content = await fs.promises.readFile(resolvedPath, 'utf-8');
      return parseConfig(content);
    } catch (err: any) {
      if (err instanceof ConfigurationError) {
        throw err;
      }
      throw new ConfigurationError(`Failed to read config at ${resolvedPath}: ${err.message}`);
    }
  }

  // 2. Search default config file names in cwd
  for (const filename of CONFIG_FILE_NAMES) {
    const candidate = path.resolve(cwd, filename);
    if (fs.existsSync(candidate)) {
      try {
        const content = await fs.promises.readFile(candidate, 'utf-8');
        return parseConfig(content);
      } catch (err: any) {
        if (err instanceof ConfigurationError) {
          throw err;
        }
        throw new ConfigurationError(`Failed to read config at ${candidate}: ${err.message}`);
      }
    }
  }

  // 3. Zero-config fallback: return a fresh clone of default configuration
  return JSON.parse(JSON.stringify(DEFAULT_POLICY_CONFIG)) as PolicyConfig;
}
