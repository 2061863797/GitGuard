/**
 * Context synthesizer and evaluation context types for GitGuard.
 * Implements Minimal Relevant Context pattern for deterministic and semantic verification.
 */

import type { ChangeScope, DiffOptions, FileChangeStatus } from './git.js';
import type { DiffContext } from './diff.js';
import type { DeterministicResult } from './provider.js';

/**
 * Origin source of a task intent description.
 */
export type TaskSource = 'cli' | 'mcp' | 'prompt' | 'commit_message' | 'instruction' | (string & {});

/**
 * Natural language task intent context.
 */
export interface TaskContext {
  /** Raw task description string from CLI (--task) or MCP */
  task: string;
  /** True if a valid non-empty task description was provided */
  taskPresent: boolean;
  /** Extracted key terms used for heuristic and semantic matching */
  keywords: string[];
  /** Origin source of task context */
  source?: TaskSource;
}

/**
 * Continuous code span surrounding modified hunks for contextual reasoning.
 */
export interface SurroundingCodeSpan {
  /** 1-indexed starting line number of the span */
  startLine: number;
  /** 1-indexed ending line number of the span */
  endLine: number;
  /** Verbatim source code lines within the span */
  code: string;
}

/**
 * Contextual code information for a changed source file.
 */
export interface FileContext {
  /** Path of the file */
  path: string;
  /** Change status */
  status: FileChangeStatus | 'binary';
  /** True if binary file */
  binary: boolean;
  /** Surrounding code spans merged to prevent duplicate line coverage */
  spans: SurroundingCodeSpan[];
  /** Full file content if explicitly configured */
  content?: string;
}

/**
 * In-repository guidance or rule document discovered in the workspace.
 */
export interface InstructionContext {
  /** Path to instruction file (e.g. 'AGENTS.md', 'CLAUDE.md', '.gitguard.yml') */
  sourcePath: string;
  /** Applicable directory scope (e.g. '/' or 'apps/web') */
  scope: string;
  /** Full or budgeted text content of the instructions */
  content: string;
}

/**
 * Automated test file related to changed source files.
 */
export interface TestContext {
  /** Path to test file (e.g., 'src/auth/token.test.ts') */
  testPath: string;
  /** Path to related source file that this test covers */
  relatedSourcePath: string;
  /** Whether the test file exists on disk in the workspace */
  existsInWorkspace: boolean;
  /** Whether this test file was modified in the current diff */
  modifiedInDiff: boolean;
  /** Optional code snippet or test suite signature */
  contentSnippet?: string;
}

/**
 * Basic metadata about the repository environment.
 */
export interface RepositoryMetadata {
  /** Absolute path to the repository root directory */
  rootPath: string;
  /** Current active branch */
  branch: string;
  /** Current HEAD commit SHA */
  headSha: string;
  /** Whether repository is in a clean state */
  isClean: boolean;
  /** Detected package manager ('pnpm' | 'npm' | 'yarn') */
  packageManager?: string;
}

/**
 * Backward compatibility alias for RepositoryMetadata.
 */
export type RepositoryContext = RepositoryMetadata;

/**
 * Context character and token budget constraints (programmatic options).
 */
export interface ContextBudgetOptions {
  /** Maximum characters for raw unified diff (default: 50,000) */
  maxDiffChars?: number;
  /** Maximum characters for total aggregated context (default: 100,000) */
  maxTotalChars?: number;
  /** Number of surrounding context lines around hunks (default: 40) */
  surroundingLines?: number;
  /** Maximum number of related test files to include (default: 5) */
  maxRelatedTestFiles?: number;
  /** Maximum characters for repository instruction files (default: 15,000) */
  maxInstructionChars?: number;
}

/**
 * Privacy and secret redaction configuration.
 */
export interface PrivacyOptions {
  /** Whether to redact recognized secrets before external calls (default: true) */
  redactSecrets?: boolean;
  /** Whether full files may ever be included in context (default: false) */
  includeFullFiles?: boolean;
  /** File glob patterns to completely exclude from context (e.g. .env, *.pem) */
  excludePatterns?: string[];
}

/**
 * Options for constructing the EvaluationContext.
 */
export interface ContextBuildOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Change scope to inspect (default: 'staged') */
  scope?: ChangeScope;
  /** Explicit Git diff options */
  diffOptions?: DiffOptions;
  /** User or agent task intent */
  task?: string;
  /** Budget overrides */
  budget?: ContextBudgetOptions;
  /** Privacy filtering options */
  privacy?: PrivacyOptions;
  /** Explicit path to .gitguard.yml configuration */
  policyConfigPath?: string;
}

/**
 * Complete evaluation context supplied to Deterministic Checkers,
 * Semantic Providers, and Policy Engine.
 */
export interface EvaluationContext {
  /** Task description context (if provided) */
  task?: TaskContext;
  /** Parsed diff context */
  diff: DiffContext;
  /** Contextual code spans for modified files */
  files: FileContext[];
  /** Discovered repository instructions (AGENTS.md, etc.) */
  instructions: InstructionContext[];
  /** Discovered related tests */
  relatedTests: TestContext[];
  /** Repository environment metadata */
  repository: RepositoryContext;
  /**
   * Deterministic verification evidence (test results, lint, tsc, secrets).
   * Populated before or after deterministic execution phase.
   */
  evidence: DeterministicResult[];
  /** ISO timestamp of context creation */
  createdAt?: string;
}

/**
 * Dual context bundle containing both the raw (unsanitized) context for local
 * deterministic checks and the sanitized context for external semantic evaluators.
 */
export interface DualEvaluationContext {
  /** Unsanitized repository context with unmodified diffs and raw credentials */
  rawContext: EvaluationContext;
  /** Sanitized evaluation context with redacted credentials and sensitive diffs omitted */
  semanticContext: EvaluationContext;
}

/**
 * Builder interface for assembling EvaluationContext.
 */
export interface ContextBuilder {
  /** Construct an EvaluationContext based on repository state and options */
  buildContext(options: ContextBuildOptions): Promise<EvaluationContext>;
  /** Construct dual contexts: raw for local tools, sanitized for external models */
  buildDualContext?(options: ContextBuildOptions): Promise<DualEvaluationContext>;
}
