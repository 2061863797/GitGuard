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
 * Threshold boundaries for numerical probabilities and categorical scores.
 */
export interface ThresholdConfig {
  /** Probability threshold at or above which a WARN is triggered */
  warn?: number;
  /** Probability threshold at or above which a REVIEW is triggered */
  review?: number;
  /** Probability threshold at or above which a BLOCK is triggered */
  block?: number;
  /** Categorical score levels triggering WARN (e.g. ["medium"]) */
  warn_on?: string[];
  /** Categorical score levels triggering REVIEW (e.g. ["high"]) */
  review_on?: string[];
  /** Categorical score levels triggering BLOCK (e.g. ["critical"]) */
  block_on?: string[];
  /** Inverted threshold: trigger REVIEW if probability is BELOW this value (e.g., task_completed < 0.60) */
  review_below?: number;
  /** Inverted threshold: trigger BLOCK if probability is BELOW this value (e.g., task_completed < 0.20) */
  block_below?: number;
}

/**
 * Representation of a generic policy rule.
 */
export interface PolicyRule {
  /** Unique rule identifier */
  id: string;
  /** Whether the rule is actively evaluated */
  enabled: boolean;
  /** Optional human description */
  description?: string;
  /** Target file glob patterns */
  files?: string[];
  /** Excluded file glob patterns */
  exclude?: string[];
  /** Evaluation thresholds */
  thresholds?: ThresholdConfig;
  /** Natural language question for semantic evaluation */
  question?: string;
  /** Primitive evaluation type */
  primitive?: 'noul' | 'boolean' | 'choice' | 'score';
  /** Choices for categorical evaluation */
  candidates?: string[];
  /** Ordered levels for score evaluation */
  scoreLevels?: string[];
}

/**
 * User-defined custom semantic policy rule declared in .gitguard.yml.
 */
export interface CustomPolicyRule {
  /** Unique rule identifier (e.g., "auth_requires_tests") */
  id: string;
  /** Human description of the intent */
  description?: string;
  /** Target file glob patterns (e.g., ["src/auth/**"]) */
  files: string[];
  /** Excluded file glob patterns (e.g., ["**\/*.test.ts"]) */
  exclude?: string[];
  /** Natural language question asked to the Semantic Decision Layer */
  question: string;
  /** System One primitive type (defaults to 'noul') */
  primitive?: 'noul' | 'boolean' | 'choice' | 'score';
  /** Candidate options if primitive is 'choice' */
  candidates?: string[];
  /** Score levels if primitive is 'score' */
  scoreLevels?: string[];
  /** Probability threshold for WARN */
  warn?: number;
  /** Probability threshold for REVIEW */
  review?: number;
  /** Probability threshold for BLOCK */
  block?: number;
  /** Categorical values triggering WARN */
  warn_on?: string[];
  /** Categorical values triggering REVIEW */
  review_on?: string[];
  /** Categorical values triggering BLOCK */
  block_on?: string[];
  /** Inverted threshold for REVIEW */
  review_below?: number;
  /** Inverted threshold for BLOCK */
  block_below?: number;
  /** Whether the rule is enabled (default: true) */
  enabled?: boolean;
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
 * Semantic provider integration settings in .gitguard.yml.
 */
export interface SystemOneConfig {
  /** Provider implementation: 'typesafe' (live API) | 'mock' (offline deterministic) */
  provider?: 'typesafe' | 'mock' | string;
  /** Model name or endpoint identifier (default: 'jev') */
  model?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout_ms?: number;
  /** Optional API Key (defaults to TYPESAFE_API_KEY environment variable) */
  apiKey?: string;
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
 * Built-in standard semantic rules configuration.
 */
export interface BuiltinRulesConfig {
  /** Task completion evaluator (inverted thresholds: review_below, block_below) */
  task_completed?: {
    enabled?: boolean;
    review_below?: number;
    block_below?: number;
  };
  /** Unrelated changes evaluator */
  unrelated_changes?: {
    enabled?: boolean;
    warn?: number;
    review?: number;
    block?: number;
  };
  /** Test requirements evaluator */
  tests_required?: {
    enabled?: boolean;
    warn?: number;
    review?: number;
    block?: number;
  };
  /** Security sensitive changes evaluator */
  security_sensitive?: {
    enabled?: boolean;
    warn?: number;
    review?: number;
    block?: number;
  };
  /** Regression risk evaluator */
  regression_risk?: {
    enabled?: boolean;
    warn_on?: string[];
    review_on?: string[];
    block_on?: string[];
  };
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
  /** Standard built-in rule thresholds */
  rules?: BuiltinRulesConfig;
  /** Custom repository semantic rules */
  custom_rules?: CustomPolicyRule[];
  /** Privacy and data exclusion configuration */
  privacy?: PrivacyConfig;
  /** Gate execution policy */
  gate?: {
    block_on?: GateVerdict[];
    cache?: {
      enabled?: boolean;
      directory?: string;
    };
  };
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
  /** Categorical score value, if applicable */
  score?: string | number;
  /** Affected files */
  affectedFiles: string[];
  /** Supporting evidence */
  evidence: Evidence[];
  /** Actionable resolution instructions */
  expectedEvidence: string[];
  /** Originating policy rule definition */
  rule?: PolicyRule | CustomPolicyRule;
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
   * Evaluates deterministic results and semantic decisions against policy rules to produce the final verdict.
   */
  evaluate(
    deterministicResults: DeterministicResult[],
    semanticDecisions: SemanticDecision[],
    policy: PolicyConfig,
    context: EvaluationContext
  ): PolicyEvaluationResult;
}
