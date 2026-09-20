/**
 * src/types/finding.ts
 * Finding domain models, evidence structures, and verification reports for GitGuard.
 */

import type { GateVerdict, RuleMatch } from './policy.js';
import type { TaskContext, EvaluationContext } from './context.js';
import type { DiffSummary } from './diff.js';
import type { DeterministicResult, SemanticDecision } from './provider.js';

/**
 * Granular severity assigned to a finding.
 */
export type FindingSeverity = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

/**
 * Operational gate status assigned to an individual finding.
 */
export type FindingStatus = 'warn' | 'review' | 'block';

/**
 * Origin subsystem that detected the finding.
 */
export type FindingSource = 'deterministic' | 'semantic' | 'policy';

/**
 * Lifecycle state of a finding across inspection and re-verification loops.
 */
export type FindingLifecycleState = 'active' | 'resolved' | 'suppressed';

/**
 * Categorical type of concrete evidence supporting a finding.
 */
export type EvidenceType =
  | 'file_change'
  | 'test_result'
  | 'lint_error'
  | 'secret_detected'
  | 'repository_policy'
  | 'behavior_change'
  | 'missing_test'
  | (string & {});

/**
 * Concrete, observable factual artifact validating a finding.
 */
export interface Evidence {
  /** Type of evidence */
  type: EvidenceType;
  /** File path associated with the evidence, if applicable */
  path?: string;
  /** Line range or specific line numbers (e.g., "72-104" or "42") */
  lines?: string;
  /** Executed command (for test/lint results) */
  command?: string;
  /** Execution status or exit outcome */
  status?: string;
  /** Process exit code */
  exitCode?: number;
  /** Rule name or identifier */
  ruleName?: string;
  /** Human-readable evidence description or failure message */
  message?: string;
  /** Code snippet or truncated log excerpt */
  snippet?: string;
  /** Additional structured details */
  details?: Record<string, unknown>;
}

/**
 * Structured Finding entity emitted by the Policy Engine and managed by FindingManager.
 */
export interface Finding {
  /** Unique finding identifier (e.g. "finding_tests_required_7f9c2a" or "finding_01") */
  id: string;
  /** Identifier of the policy rule that produced this finding */
  ruleId: string;
  /** Source subsystem that generated this finding */
  source: FindingSource;
  /** Operational gate status associated with this finding */
  status: FindingStatus;
  /** Severity level */
  severity: FindingSeverity;
  /** Current lifecycle state */
  lifecycle: FindingLifecycleState;
  /** Probability score from semantic decision (0.0 - 1.0), if applicable */
  probability?: number;
  /** File paths affected by this finding */
  affectedFiles: string[];
  /** Human- and agent-readable description of the finding */
  message: string;
  /** Observable evidence proving this finding */
  evidence: Evidence[];
  /** Actionable instructions detailing what evidence is required to resolve this finding */
  expectedEvidence: string[];
  /** Content-addressable SHA256 hash invariant to line number drift */
  fingerprint: string;
  /** ISO timestamp when the finding was initially detected */
  createdAt: string;
  /** ISO timestamp when the finding was resolved, if applicable */
  resolvedAt?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Filter options for querying active or historical findings.
 */
export interface FindingFilter {
  ruleId?: string;
  source?: FindingSource;
  status?: FindingStatus;
  severity?: FindingSeverity;
  lifecycle?: FindingLifecycleState;
  file?: string;
}

/**
 * Execution metadata captured during verification.
 */
export interface VerificationReportMetadata {
  /** Total elapsed time in milliseconds */
  durationMs: number;
  /** ISO timestamp of report generation */
  timestamp: string;
  /** Repository root path */
  gitRoot: string;
  /** HEAD commit SHA at verification time */
  headSha: string;
  /** Whether results were retrieved from evaluation cache */
  cacheHit: boolean;
}

/**
 * Comprehensive Verification Report produced by check() and verify().
 */
export interface VerificationReport {
  /** Overall gate verdict */
  status: GateVerdict;
  /** Concise human-readable verdict summary */
  verdictSummary: string;
  /** Declared task context, if provided */
  task?: TaskContext;
  /** High-level diff statistics */
  diffSummary: DiffSummary;
  /** All active findings */
  findings: Finding[];
  /** IDs of findings resolved in this verification loop */
  resolved: string[];
  /** IDs of findings still active in this verification loop */
  remaining: string[];
  /** Alias for resolved finding IDs (backwards compatibility) */
  resolvedFindings?: string[];
  /** Alias for remaining active finding IDs (backwards compatibility) */
  remainingFindings?: string[];
  /** Raw deterministic check outcomes */
  deterministicResults: DeterministicResult[];
  /** Semantic decisions indexed by question/rule ID */
  semanticDecisions: Record<string, SemanticDecision>;
  /** Execution metadata */
  metadata: VerificationReportMetadata;
}

/**
 * Payload required to compute a content-stable finding fingerprint.
 */
export interface FindingFingerprintInput {
  ruleId: string;
  affectedFiles: string[];
  normalizedDiffHunks: string;
}

/**
 * Finding manager interface contract for finding lifecycle, fingerprinting, and resolution.
 */
export interface FindingManager {
  createFindings(ruleMatches: RuleMatch[], context: EvaluationContext): Finding[];
  computeFingerprint(finding: Omit<Finding, 'id' | 'fingerprint'> | FindingFingerprintInput): string;
  resolveFindings(previousFindings: Finding[], freshFindings: Finding[]): VerificationReport;
  getFindings?(filter?: FindingFilter): Finding[];
  storeFinding?(finding: Finding): void;
  clear?(): void;
}

export type IFindingManager = FindingManager;

