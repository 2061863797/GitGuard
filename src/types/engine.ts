/**
 * src/types/engine.ts
 * Unified core engine contracts and option/result types for GitGuard.
 */

import type { ChangeScope, ChangedFile } from './git.js';
import type { DiffSummary } from './diff.js';
import type { TaskContext } from './context.js';
import type { Finding, FindingFilter, VerificationReport } from './finding.js';
import type { GateVerdict, PolicyConfig } from './policy.js';

/**
 * Options for GitGuardEngine.inspect().
 */
export interface InspectOptions {
  /** Git change scope to analyze (staged, working-tree, all, commit, range, pull-request) */
  scope?: ChangeScope;
  /** Target commit hash, branch name, or diff range (e.g., "HEAD~1..HEAD") */
  target?: string;
  /** Repository root or working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Declared task description or structured task context */
  task?: string | TaskContext;
  /** Whether to execute preliminary deterministic checks (test, lint, secrets) */
  checkDeterministic?: boolean;
  /** Explicit path to .gitguard.yml configuration file */
  configPath?: string;
  /** Programmatic policy configuration override */
  config?: PolicyConfig;
}

/**
 * Structured inspection result returned by GitGuardEngine.inspect().
 */
export interface InspectResult {
  /** Overall gate status for the inspected scope */
  status: GateVerdict;
  /** Diff summary statistics */
  summary: DiffSummary;
  /** List of individual changed files */
  changedFiles: ChangedFile[];
  /** Active findings identified during inspection */
  findings: Finding[];
  /** Whether deterministic checks failed during inspection */
  hasDeterministicFailures: boolean;
  /** Alias for findings (backwards compatibility) */
  preliminaryFindings?: Finding[];
}

/**
 * Options for GitGuardEngine.check().
 */
export interface CheckOptions extends InspectOptions {
  /** Treat WARN and REVIEW as strict blockers */
  strict?: boolean;
  /** Cause WARN verdict to yield a non-zero exit code */
  failOnWarn?: boolean;
  /** Force offline deterministic mock semantic provider */
  offline?: boolean;
  /** Disallow mock fallback; exit with code 2 if TypeSafe Jev is unavailable */
  requireSemantic?: boolean;
  /** Require a fresh TypeSafe response and reject local simulation (MCP). */
  onlineOnly?: boolean;
  /** Bypass evaluation cache in .git/gitguard/cache/ */
  noCache?: boolean;
  /** Restrict evaluation to specific finding IDs */
  findingIds?: string[];
  /** Evaluate only task completion semantics (task_completed, task_scope_match, unrelated_changes) */
  taskOnly?: boolean;
  /** Running in verification mode: clean changesets do not artificially fail task_completed */
  verifyMode?: boolean;
  /** Explicitly allow custom provider endpoints beyond official TypeSafe domain */
  allowCustomProvider?: boolean;
}

/**
 * Complete check result returned by GitGuardEngine.check().
 * Identical to VerificationReport with an optional process exit code.
 */
export interface CheckResult extends VerificationReport {
  /** Suggested process exit code (0 for pass/warn, 1 for block/review) */
  exitCode?: number;
}

/**
 * Options for GitGuardEngine.verify().
 */
export interface VerifyOptions {
  /** Specific finding IDs to re-evaluate for resolution */
  findingIds?: string[];
  /** Only verify resolution of targeted findings without considering newly introduced violations */
  targetOnly?: boolean;
  /** Treat WARN and REVIEW as strict blockers */
  strict?: boolean;
  /** Declared task description or structured task context */
  task?: string | TaskContext;
  /** Git change scope */
  scope?: ChangeScope;
  /** Repository root or working directory */
  cwd?: string;
  /** Explicit path to .gitguard.yml configuration file */
  configPath?: string;
  /** Programmatic policy configuration override */
  config?: PolicyConfig;
  /** Force offline deterministic mock semantic provider */
  offline?: boolean;
  /** Require a fresh TypeSafe response and reject local simulation (MCP). */
  onlineOnly?: boolean;
  /** Bypass evaluation cache */
  noCache?: boolean;
  /** Explicitly allow custom provider endpoints beyond official TypeSafe domain */
  allowCustomProvider?: boolean;
}

/**
 * Central GitGuard Verification Engine interface.
 * All external entry points (CLI, MCP stdio server, CI pipelines) strictly delegate to this contract.
 */
export interface GitGuardEngine {
  /**
   * Rapidly inspects repository changes without executing full semantic evaluation suites.
   */
  inspect(options: InspectOptions): Promise<InspectResult>;

  /**
   * Executes the full verification gate (deterministic + semantic + policy evaluation).
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
