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
  /** Optional custom regex patterns (e.g. for secret_scan) */
  patterns?: string[];
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
 * Yes/no semantic question sent to System One / Jev (noul primitive).
 */
export interface SemanticQuestion {
  /** Identifier matching the originating QuestionSpec.id */
  id: string;
  /** Clear, single-intent, testable prompt string; "yes" means a problem exists */
  prompt: string;
}

/**
 * Provider execution metadata tracking model versions and latency.
 */
export interface ProviderMetadata {
  /** Provider that executed the evaluation (e.g., 'typesafe') */
  provider: string;
  /** Name of the requested model (e.g., 'jev-latest') */
  requestedModel?: string;
  /** Name/version of the effective model resolved by the API */
  effectiveModel?: string;
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
  /** Probability (0.0 to 1.0) that the answer is "yes" */
  probability: number;
  /** Decision confidence metric (0.0 to 1.0) */
  confidence?: number;
  /** Name of provider producing this decision */
  provider: string;
  /** Short explanation or rationale, if returned by the provider */
  rationale?: string;
  /** Metadata on provider execution */
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
 * Decouples GitGuard Core from the TypeSafe service so tests can inject stubs.
 */
export interface DecisionProvider {
  /** Unique provider identifier name (e.g., 'typesafe') */
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
