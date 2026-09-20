/**
 * src/types/index.ts
 * Unified domain type exports for GitGuard.
 */

// Git Domain Types
export type {
  ChangeScope,
  FileChangeStatus,
  GitFileStatus,
  ChangedFile,
  GitStatusSummary,
  GitStatus,
  DiffOptions,
  GitAdapter,
  IGitAdapter,
} from './git.js';

// Diff Domain Types
export type {
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffFile,
  DiffSummary,
  DiffContext,
  DiffParser,
} from './diff.js';

// Context Domain Types
export type {
  TaskSource,
  TaskContext,
  SurroundingCodeSpan,
  FileContext,
  InstructionContext,
  TestContext,
  RepositoryMetadata,
  RepositoryContext,
  ContextBudgetOptions,
  PrivacyOptions,
  ContextBuildOptions,
  EvaluationContext,
  ContextBuilder,
} from './context.js';

// Provider & Analysis Domain Types
export type {
  DeterministicCheckId,
  DeterministicStatus,
  DeterministicCheckStatus,
  DeterministicViolation,
  DeterministicResult,
  DeterministicEvidence,
  CommandDefinition,
  DeterministicConfig,
  DeterministicChecker,
  DeterministicRunner,
  SemanticQuestionType,
  SemanticPrimitive,
  SemanticQuestionChoice,
  SemanticQuestionLevel,
  StandardQuestionId,
  SemanticQuestion,
  SemanticDecision,
  SemanticResult,
  DecisionProvider,
  IDecisionProvider,
} from './provider.js';

// Finding Domain Types
export type {
  FindingSeverity,
  FindingStatus,
  FindingSource,
  FindingLifecycleState,
  EvidenceType,
  Evidence,
  Finding,
  FindingFilter,
  VerificationReportMetadata,
  VerificationReport,
  FindingFingerprintInput,
  FindingManager,
  IFindingManager,
} from './finding.js';

// Policy Domain Types
export type {
  GateVerdict,
  GateStatus,
  ThresholdConfig,
  PolicyRule,
  CustomPolicyRule,
  ContextBudgetConfig,
  SystemOneConfig,
  DeterministicCheckConfig,
  DeterministicSecretScanConfig,
  DeterministicPolicyConfig,
  BuiltinRulesConfig,
  PrivacyConfig,
  PolicyConfig,
  RuleMatch,
  PolicyEvaluationResult,
  PolicyEngine,
} from './policy.js';

// Core Engine Domain Types
export type {
  InspectOptions,
  InspectResult,
  CheckOptions,
  CheckResult,
  VerifyOptions,
  GitGuardEngine,
} from './engine.js';

// Error Hierarchy Classes
export {
  GitGuardError,
  NotAGitRepositoryError,
  GitExecutionError,
  ForbiddenGitOperationError,
  InvalidGitRefError,
  ConfigurationError,
  PolicyEvaluationError,
  SecurityViolationError,
  ProviderError,
  BudgetExceededError,
} from './errors.js';
