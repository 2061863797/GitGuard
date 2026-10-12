/**
 * src/types/engine.ts
 * Unified core engine contracts and option/result types for GitGuard.
 */

import type { ChangeScope } from './git.js';
import type { TaskContext } from './context.js';
import type { Finding, FindingFilter, VerificationReport } from './finding.js';
import type { PolicyConfig, RuleSpec } from './policy.js';

/**
 * Agent-supplied rule; `source` is assigned by the engine.
 */
export type AgentRule = Omit<RuleSpec, 'source'>;

/**
 * Options for GitGuardEngine.check().
 */
export interface CheckOptions {
  /** Repository root or working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Git change scope to analyze (staged, working-tree, all, commit, range, pull-request) */
  scope?: ChangeScope;
  /** Target commit hash or diff range (e.g., "HEAD~1..HEAD") */
  target?: string;
  /** Declared task description or structured task context */
  task?: string | TaskContext;
  /** Rules supplied by the calling agent for this check */
  rules?: AgentRule[];
  /** Explicit path to .gitguard.yml configuration file */
  configPath?: string;
  /** Programmatic policy configuration override */
  config?: PolicyConfig;
}

/**
 * Complete check result returned by GitGuardEngine.check().
 */
export interface CheckResult extends VerificationReport {
  /** False when the verdict is BLOCK */
  canCommit: boolean;
}

/**
 * Options for GitGuardEngine.verify().
 */
export interface VerifyOptions {
  /** Specific finding IDs to re-evaluate for resolution */
  findingIds?: string[];
  /** Declared task description or structured task context */
  task?: string | TaskContext;
  /** Git change scope */
  scope?: ChangeScope;
  /** Commit or complete base..head / base...head range to recheck. */
  target?: string;
  /** Repository root or working directory */
  cwd?: string;
  /** Explicit path to .gitguard.yml configuration file */
  configPath?: string;
  /** Programmatic policy configuration override */
  config?: PolicyConfig;
}

/**
 * Central GitGuard Verification Engine interface.
 * The MCP server delegates to this contract.
 */
export interface GitGuardEngine {
  /**
   * Executes the gate: deterministic checks plus agent and config rules.
   */
  check(options: CheckOptions): Promise<CheckResult>;

  /**
   * Re-evaluates previously identified findings to determine if fresh changes have resolved them.
   */
  verify(options: VerifyOptions): Promise<VerificationReport>;

  /**
   * Retrieves active or filtered findings from the finding manager.
   */
  getFindings?(filter?: FindingFilter): Promise<Finding[]>;
}
