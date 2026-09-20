/**
 * src/context/index.ts
 * Context module exports for GitGuard.
 */

export { DefaultContextBuilder } from './builder.js';

export {
  PrivacyFilter,
  isSensitiveFile,
  redactSecrets,
  sanitizeEvaluationContext,
  omitSensitiveDiffHunks,
  DEFAULT_SENSITIVE_FILE_PATTERNS,
  REDACTION_TOKEN,
} from './filter.js';

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
} from '../types/context.js';
