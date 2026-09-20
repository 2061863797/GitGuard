/**
 * Analysis provider types for GitGuard.
 * Covers both Deterministic Checkers and System One Semantic Decision Providers.
 */

import type { EvaluationContext } from './context.js';

/**
 * Standard identifier for deterministic checker categories.
 */
export type DeterministicCheckId = 'test' | 'lint' | 'typecheck' | 'secret_scan' | (string & {});

/**
 * Status verdict of a deterministic check execution.
 */
export type DeterministicStatus = 'passed' | 'failed' | 'skipped';

/**
 * Alias for DeterministicStatus.
 */
export type DeterministicCheckStatus = DeterministicStatus;

/**
 * Structured violation reported by a deterministic tool.
 */
export interface DeterministicViolation {
  /** File path where violation occurred */
  file?: string;
  /** Line number of violation */
  line?: number;
  /** Rule name or identifier */
  rule?: string;
  /** Descriptive violation message */
  message: string;
  /** Severity rating of violation */
  severity: 'warn' | 'block';
}

/**
 * Structured result produced by a deterministic status checker.
 */
export interface DeterministicResult {
  /** Unique check ID ('test', 'lint', 'typecheck', 'secret_scan') */
  id: DeterministicCheckId;
  /** Final execution status */
  status: DeterministicStatus;
  /** Subprocess exit code (0 indicates success) */
  exitCode?: number;
  /** Total execution duration in milliseconds */
  durationMs: number;
  /** Captured standard output */
  stdout?: string;
  /** Captured standard error */
  stderr?: string;
  /** Short summary of results */
  summary?: string;
  /** Detailed violation list if check failed */
  violations?: DeterministicViolation[];
}

/**
 * Backward compatibility alias for DeterministicResult.
 */
export type DeterministicEvidence = DeterministicResult;

/**
 * Subprocess command definition for deterministic runners.
 */
export interface CommandDefinition {
  /** Shell executable command string (e.g., "pnpm test") */
  run: string;
  /** Maximum execution duration in ms before SIGTERM (default: 60,000) */
  timeoutMs?: number;
  /** Working directory for command execution */
  cwd?: string;
}

/**
 * Enablement and customization settings for a single deterministic check.
 */
export interface DeterministicCheckConfig {
  /** Whether this check is activated */
  enabled: boolean;
  /** Optional custom command override */
  command?: string;
  /** Optional execution timeout override */
  timeoutMs?: number;
}

/**
 * Aggregated configuration for deterministic runners loaded from .gitguard.yml.
 */
export interface DeterministicConfig {
  /** Declared whitelisted command strings */
  commands?: {
    test?: CommandDefinition;
    lint?: CommandDefinition;
    typecheck?: CommandDefinition;
    [key: string]: CommandDefinition | undefined;
  };
  /** Per-check enablement toggles */
  checks?: {
    test?: DeterministicCheckConfig;
    lint?: DeterministicCheckConfig;
    typecheck?: DeterministicCheckConfig;
    secret_scan?: DeterministicCheckConfig;
    [key: string]: DeterministicCheckConfig | undefined;
  };
}

/**
 * Supported System One question primitive formats.
 */
export type SemanticQuestionType = 'boolean' | 'choice' | 'score';

/**
 * Alias for SemanticQuestionType.
 */
export type SemanticPrimitive = SemanticQuestionType;

/**
 * Choice alternative for categorical semantic questions.
 */
export interface SemanticQuestionChoice {
  /** Unique value token (e.g. 'feature', 'bug_fix') */
  value: string;
  /** Description of what this category means */
  description?: string;
}

/**
 * Score level descriptor for ranked semantic questions.
 */
export interface SemanticQuestionLevel {
  /** Level name (e.g. 'negligible', 'low', 'medium', 'high', 'critical') */
  name: string;
  /** Detailed definition of this level */
  description: string;
  /** Normalized score value (0.0 to 1.0) */
  score?: number;
}

/**
 * Predefined canonical semantic question IDs supported by GitGuard.
 */
export type StandardQuestionId =
  | 'task_completed'
  | 'task_scope_match'
  | 'unrelated_changes'
  | 'tests_required'
  | 'tests_present'
  | 'behavior_change'
  | 'security_sensitive_change'
  | 'breaking_change'
  | 'debug_leftovers'
  | 'regression_risk'
  | 'change_type';

/**
 * Semantic evaluation question formulated for System One / Jev.
 */
export interface SemanticQuestion {
  /** Identifier matching standard question ID or custom rule ID */
  id: StandardQuestionId | string;
  /** Primitive format: 'boolean' (probability), 'choice' (enum), 'score' (rank) */
  type: SemanticQuestionType;
  /** Clear, single-intent, testable prompt string */
  prompt: string;
  /** Candidate options (for type: 'choice') */
  choices?: string[] | SemanticQuestionChoice[];
  /** Level benchmarks (for type: 'score') */
  levels?: SemanticQuestionLevel[];
}

/**
 * Provider execution metadata tracking model versions, fallback states, and latency.
 */
export interface ProviderMetadata {
  /** Configured provider name (e.g., 'typesafe') */
  requestedProvider: string;
  /** Actual provider that executed the evaluation (e.g., 'typesafe' or 'mock') */
  effectiveProvider: string;
  /** Name of the requested model (e.g., 'jev-latest') */
  requestedModel?: string;
  /** Name/version of the effective model resolved by the API */
  effectiveModel?: string;
  /** Whether a fallback occurred during evaluation */
  fallback: boolean;
  /** Diagnostic reason if fallback occurred */
  fallbackReason?: string;
  /** Total evaluation round-trip latency in milliseconds */
  latencyMs?: number;
  /** Number of evaluated questions */
  questionsCount?: number;
}

/**
 * Structured semantic decision returned by a DecisionProvider.
 */
export interface SemanticDecision {
  /** Identifier matching the corresponding SemanticQuestion.id */
  id: string;
  /** Probability value (0.0 to 1.0) for boolean/noul questions */
  probability?: number;
  /** Selected categorical value for choice questions */
  value?: string;
  /** Normalized score value (0.0 to 1.0) for score questions */
  score?: number;
  /** Raw unnormalized score returned directly by provider */
  rawScore?: number;
  /** Categorical level probabilities if returned for score questions */
  probabilities?: Record<string, number>;
  /** Decision confidence metric (0.0 to 1.0) */
  confidence?: number;
  /** Name of provider producing this decision ('typesafe' | 'mock' | 'heuristic') */
  provider: string;
  /** Short explanation or rationale, if returned by the provider */
  rationale?: string;
  /** Metadata on provider execution and fallback observability */
  metadata?: ProviderMetadata;
}

/**
 * Aggregated report of a semantic evaluation run.
 */
export interface SemanticRunReport {
  decisions: SemanticDecision[];
  metadata: ProviderMetadata;
}

/**
 * Backward compatibility alias for SemanticDecision.
 */
export type SemanticResult = SemanticDecision;

/**
 * Abstract decision provider interface for semantic evaluations.
 * Decouples GitGuard Core from specific model services (TypeSafe, Mock, Local).
 */
export interface DecisionProvider {
  /** Unique provider identifier name (e.g., 'typesafe', 'mock') */
  readonly name: string;
  /** Verify whether this provider is available (credentials present, online) */
  isAvailable(): Promise<boolean>;
  /**
   * Evaluate a batch of semantic questions against an EvaluationContext.
   */
  evaluate(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticDecision[]>;
  /**
   * Evaluate a batch of semantic questions and return explicit execution metadata.
   */
  evaluateWithReport?(
    context: EvaluationContext,
    questions: SemanticQuestion[]
  ): Promise<SemanticRunReport>;
}

/**
 * Backward compatibility alias for DecisionProvider.
 */
export type IDecisionProvider = DecisionProvider;

/**
 * Deterministic status checker runner interface.
 */
export interface DeterministicChecker {
  /**
   * Run enabled deterministic checks (tests, lint, tsc, secrets) against context.
   */
  run(
    context: EvaluationContext,
    config: DeterministicConfig
  ): Promise<DeterministicResult[]>;
}

/**
 * Backward compatibility alias for DeterministicChecker.
 */
export type DeterministicRunner = DeterministicChecker;
