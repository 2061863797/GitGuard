/**
 * src/git/index.ts
 * Git module exports for GitGuard.
 */

export { GitCLIAdapter } from './adapter.js';
export type { GitCLIAdapterOptions } from './adapter.js';

export {
  UnifiedDiffParser,
  unifiedDiffParser,
  parseDiff,
  parseHunkLines,
} from './diff-parser.js';

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
} from '../types/git.js';

export type {
  DiffLineType,
  DiffLine,
  DiffHunk,
  DiffFile,
  DiffSummary,
  DiffContext,
  DiffParser,
} from '../types/diff.js';
