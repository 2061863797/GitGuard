/**
 * Diff parsing and AST representation types for GitGuard.
 * Translates raw unified diffs into structured hunks and file models.
 */

import type { FileChangeStatus } from './git.js';

/**
 * Line type classification within a diff hunk.
 */
export type DiffLineType = 'addition' | 'deletion' | 'context';

/**
 * Structured diff line representation with line numbering.
 */
export interface DiffLine {
  /** Line change type: addition (+), deletion (-), or context (' ') */
  type: DiffLineType;
  /** Character content of the line without prefix */
  content: string;
  /** Line number in the original (old) file, if applicable */
  oldLineNumber?: number;
  /** Line number in the updated (new) file, if applicable */
  newLineNumber?: number;
}

/**
 * Unified diff hunk representing a contiguous set of line alterations.
 */
export interface DiffHunk {
  /** Starting line number in the original file */
  oldStart: number;
  /** Total line span in the original file */
  oldLines: number;
  /** Starting line number in the modified file */
  newStart: number;
  /** Total line span in the modified file */
  newLines: number;
  /** Raw hunk header line (e.g., "@@ -10,5 +10,8 @@ function test()") */
  header: string;
  /** Raw diff lines including prefix (+, -, or space) */
  lines: string[];
}

/**
 * Structured change representation for a single file in a diff.
 */
export interface DiffFile {
  /** Path of the file before rename/copy, if applicable */
  oldPath?: string;
  /** Path of the file after changes */
  newPath: string;
  /** File change classification */
  status: FileChangeStatus | 'binary';
  /** True if this is a binary file change (no line-level hunks) */
  binary: boolean;
  /** Parsed diff hunks for text files (empty for binary files) */
  hunks: DiffHunk[];
  /** Total added lines in this file */
  additions: number;
  /** Total deleted lines in this file */
  deletions: number;
}

/**
 * High-level diff statistics summary.
 */
export interface DiffSummary {
  /** Total number of files changed */
  filesChanged: number;
  /** Total line insertions */
  insertions: number;
  /** Total line deletions */
  deletions: number;
  /** Whether diff contains any binary file changes */
  hasBinaryChanges?: boolean;
  /** Whether diff was truncated due to budget limits */
  truncated?: boolean;
}

/**
 * Aggregated context representing the complete parsed diff of a changeset.
 */
export interface DiffContext {
  /** Full raw unified diff text (or truncated text if budget was exceeded) */
  raw: string;
  /** Structured array of parsed file changes */
  files: DiffFile[];
  /** Total line insertions across all changed files */
  insertions: number;
  /** Total line deletions across all changed files */
  deletions: number;
  /** True if the diff text was truncated due to context budget limits */
  truncated: boolean;
  /** Total number of files affected before any truncation */
  totalFiles?: number;
}

/**
 * Parser interface for converting raw unified diff strings into DiffContext AST.
 */
export interface DiffParser {
  /** Parse a raw unified diff string into a typed DiffContext */
  parse(rawDiff: string): DiffContext;
}
