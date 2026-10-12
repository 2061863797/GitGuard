/**
 * src/types/policy.ts
 * Policy engine configuration, rules, verdicts, and evaluation result models for GitGuard.
 */

import type { Finding, FindingSeverity, FindingStatus, FindingSource, Evidence } from './finding.js';
import type { EvaluationContext } from './context.js';
import type { DeterministicResult, SemanticDecision } from './provider.js';

/**
 * Definitive gate verdict produced by GitGuard.
 * Ordered by severity: PASS < WARN < REVIEW < BLOCK.
 */
export type GateVerdict = 'PASS' | 'WARN' | 'REVIEW' | 'BLOCK';

/**
 * GateStatus alias for GateVerdict ensuring seamless cross-module interoperability.
 */
export type GateStatus = GateVerdict;

/**
 * Finding level assigned when a change violates a rule.
 */
export type RuleLevel = 'warn' | 'review' | 'block';

/**
 * Where a rule came from.
 */
export type RuleSource = 'agent' | 'config';

/**
 * A rule the change must follow, written as a plain statement (e.g. "Money must not use floating point").
 * System One judges whether the change violates it. Agent and `.gitguard.yml` rules share this shape.
 */
export interface RuleSpec {
  /** Stable identifier ([a-z0-9_]); unique across agent and config rules in one check */
  id: string;
  /** The rule itself, stated as what the code must (not) do */
  rule: string;
  /** Finding level when System One judges the change violates the rule with probability >= 0.5 */
  level: RuleLevel;
  /** Optional include globs; the rule is skipped when no changed file matches */
  files?: string[];
  /** Optional exclude globs */
  exclude?: string[];
  /** Origin of the rule */
  source: RuleSource;
}

/**
 * Context budget configuration limits in .gitguard.yml.
 */
export interface ContextBudgetConfig {
  /** Maximum raw diff characters allowed before truncation (default: 50000) */
  max_diff_chars?: number;
  /** Maximum overall context characters allowed (default: 100000) */
  max_total_chars?: number;
  /** Number of surrounding source lines included around diff hunks (default: 40) */
  surrounding_lines?: number;
  /** Related test discovery limits */
  related_tests?: {
    max_files?: number;
  };
  /** Instructions budget limits */
  instructions?: {
    max_chars?: number;
  };
}

/**
 * TypeSafe System One settings in .gitguard.yml.
 */
export interface SystemOneConfig {
  /** Model name (default: 'jev-latest') */
  model?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout_ms?: number;
  /** Optional API Key (always rejected in repository files; use TYPESAFE_API_KEY) */
  apiKey?: string;
  /** Optional base API URL (only the official TypeSafe endpoint is accepted) */
  baseUrl?: string;
}

/**
 * Deterministic command execution configuration for a single tool.
 */
export interface DeterministicCheckConfig {
  /** Whether the check is enabled */
  enabled: boolean;
  /** Shell command to execute (e.g., "pnpm test", "pnpm lint", "pnpm tsc --noEmit") */
  run?: string;
  /** Whether non-zero exit code triggers an immediate BLOCK verdict (default: true) */
  block_on_failure?: boolean;
  /** Command timeout in milliseconds */
  timeout_ms?: number;
}

/**
 * Secret scanning configuration.
 */
export interface DeterministicSecretScanConfig {
  /** Whether secret scanning is enabled */
  enabled: boolean;
  /** Whether secret detection immediately triggers a BLOCK verdict (default: true) */
  block_on_detection?: boolean;
  /** Additional custom regex patterns for detecting secrets */
  patterns?: string[];
}

/**
 * Grouped deterministic checks configuration.
 */
export interface DeterministicPolicyConfig {
  /** Test runner check */
  test?: DeterministicCheckConfig;
  /** Linter check */
  lint?: DeterministicCheckConfig;
  /** Typecheck compiler check */
  typecheck?: DeterministicCheckConfig;
  /** Diff secret scanner */
  secret_scan?: DeterministicSecretScanConfig;
}

/**
 * Privacy and secret redaction settings.
 */
export interface PrivacyConfig {
  /** Whether to redact detected credentials with <REDACTED_SECRET> (default: true) */
  redact_secrets?: boolean;
  /** Whether to disallow full file contents in semantic context (default: false) */
  include_full_files?: boolean;
  /** File path patterns completely excluded from context */
  exclude_paths?: string[];
}

/**
 * Complete .gitguard.yml schema specification.
 */
export interface PolicyConfig {
  /** Configuration format version (typically 1) */
  version: number | string;
  /** Context extraction limits */
  context?: ContextBudgetConfig;
  /** Semantic decision provider configuration */
  system_one?: SystemOneConfig;
  /** Deterministic command configurations */
  deterministic?: DeterministicPolicyConfig;
  /** User-written rules checked on every run */
  rules?: RuleSpec[];
  /** Privacy and data exclusion configuration */
  privacy?: PrivacyConfig;
}

/**
 * Triggered rule match resulting from policy evaluation.
 */
export interface RuleMatch {
  /** Rule identifier */
  ruleId: string;
  /** Layer that triggered the match */
  source: FindingSource;
  /** Assigned operational status */
  status: FindingStatus;
  /** Assigned severity */
  severity: FindingSeverity;
  /** Explanation message */
  message: string;
  /** Numerical probability value, if applicable */
  probability?: number;
  /** Affected files */
  affectedFiles: string[];
  /** Supporting evidence */
  evidence: Evidence[];
  /** Actionable resolution instructions */
  expectedEvidence: string[];
  /** Originating rule for semantic matches */
  rule?: RuleSpec;
}

/**
 * Output of PolicyEngine.evaluate().
 */
export interface PolicyEvaluationResult {
  /** Overall synthesized gate verdict */
  verdict: GateVerdict;
  /** Human-readable verdict summary */
  summary: string;
  /** All rule matches evaluated against thresholds */
  ruleMatches: RuleMatch[];
  /** Generated structured findings */
  findings: Finding[];
  /** IDs of rules that evaluated cleanly without triggering violations */
  passedRules: string[];
  /** IDs of rules that triggered violations */
  violatedRules: string[];
}

/**
 * Contract for the Policy Engine component.
 */
export interface PolicyEngine {
  /**
   * Evaluates deterministic results and System One's judgments of the checked rules to produce the final verdict.
   */
  evaluate(
    deterministicResults: DeterministicResult[],
    semanticDecisions: SemanticDecision[],
    rules: RuleSpec[],
    policy: PolicyConfig,
    context: EvaluationContext
  ): PolicyEvaluationResult;
}
