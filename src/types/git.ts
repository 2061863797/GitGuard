/**
 * Git domain types and read-only adapter contracts for GitGuard.
 * Compatible with R1 requirements and GitGuard architecture specifications.
 */

export {
  NotAGitRepositoryError,
  ForbiddenGitOperationError,
  GitExecutionError,
  InvalidGitRefError,
} from './errors.js';

/**
 * Inspection scope defining the Git changes to evaluate.
 */
export type ChangeScope =
  | 'staged'         // git diff --cached (staged index changes)
  | 'working'        // unstaged changes in working tree (alias for working-tree)
  | 'working-tree'    // git diff (unstaged changes in working tree)
  | 'all'             // staged + unstaged changes
  | 'commit'          // single commit (git show <sha>)
  | 'range'           // commit range (git diff <base>..<head>)
  | 'pull-request';   // merge-base diff against target (git diff <base>...<head>)

/**
 * Status categorization of a changed file within Git.
 */
export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked';

/**
 * Alias for FileChangeStatus ensuring backwards compatibility.
 */
export type GitFileStatus = FileChangeStatus;

/**
 * Information regarding an individual changed file.
 */
export interface ChangedFile {
  /** Relative POSIX path of the file within the repository */
  path: string;
  /** Status of change */
  status: FileChangeStatus;
  /** Original file path before rename/copy, if applicable */
  oldPath?: string;
  /** True if the change is staged in the Git index */
  staged: boolean;
  /** True if the file is binary (e.g. image, binary executable) */
  binary: boolean;
  /** Count of added lines */
  additions: number;
  /** Count of deleted lines */
  deletions: number;
}

/**
 * Summary of current repository status.
 */
export interface GitStatusSummary {
  /** Whether the directory is a valid Git repository */
  isRepo: boolean;
  /** Absolute path to the repository root directory */
  rootPath: string;
  /** Current active branch name (or 'HEAD' if detached) */
  currentBranch: string;
  /** Current commit SHA of HEAD (empty string if unborn branch) */
  headSha: string;
  /** True if working tree and index are clean */
  isClean: boolean;
  /** List of paths staged in the index */
  stagedFiles: string[];
  /** List of modified paths not staged in the index */
  unstagedFiles: string[];
  /** List of untracked paths */
  untrackedFiles: string[];
}

/**
 * Backward compatibility alias for GitStatusSummary.
 */
export type GitStatus = GitStatusSummary;

/**
 * Options for configuring Git diff operations.
 */
export interface DiffOptions {
  /** Change scope to extract */
  scope?: ChangeScope;
  /** Base commit or branch ref (for range and pull-request scopes) */
  baseRef?: string;
  /** Head commit or branch ref (for range and pull-request scopes) */
  headRef?: string;
  /** Specific commit SHA to inspect (for commit scope) */
  commitSha?: string;
  /** Whether to include untracked files in the evaluation */
  includeUntracked?: boolean;
  /** Filter diff to specific subpaths or glob patterns */
  pathFilters?: string[];
  /** Target working directory (defaults to process.cwd()) */
  cwd?: string;
}

/**
 * Read-only Git adapter interface.
 * Strictly forbids mutating commands (add, commit, checkout, push, reset).
 */
export interface GitAdapter {
  /** Check if a given directory is inside a valid Git repository */
  isGitRepository(cwd?: string): Promise<boolean>;
  /** Get the absolute root directory of the Git repository */
  getRepositoryRoot(cwd?: string): Promise<string>;
  /** Get the current status summary of the repository */
  getStatus(cwd?: string): Promise<GitStatusSummary>;
  /** Get the current branch name */
  getCurrentBranch(cwd?: string): Promise<string>;
  /** Get the HEAD commit SHA */
  getHeadSha(cwd?: string): Promise<string>;
  /** Get raw unified diff text for a specified scope */
  getDiff(scope: ChangeScope, options?: DiffOptions): Promise<string>;
  /** Convenience method: get diff for staged changes */
  getStagedDiff(cwd?: string): Promise<string>;
  /** Convenience method: get diff for working tree changes */
  getWorkingTreeDiff(cwd?: string): Promise<string>;
  /** Get list of changed files with additions, deletions, and status */
  getChangedFiles(scope?: ChangeScope, options?: DiffOptions | string): Promise<ChangedFile[]>;
  /**
   * Get content of a file at a specific Git ref or current working tree.
   * Returns null if the file does not exist or was deleted.
   */
  getFileContent(filepath: string, ref?: string, cwd?: string): Promise<string | null>;
}

/**
 * Backward compatibility alias for GitAdapter.
 */
export type IGitAdapter = GitAdapter;
