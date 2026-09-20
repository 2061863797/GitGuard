/**
 * src/git/adapter.ts
 * Read-only Git CLI adapter for GitGuard.
 * Strictly enforces read-only access and executes Git operations safely.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  GitAdapter,
  IGitAdapter,
  GitStatusSummary,
  ChangeScope,
  DiffOptions,
  ChangedFile,
} from '../types/git.js';
import {
  NotAGitRepositoryError,
  ForbiddenGitOperationError,
  GitExecutionError,
  InvalidGitRefError,
} from '../types/errors.js';
import { parseDiff } from './diff-parser.js';

const execFileAsync = promisify(execFile);

/** Empty git tree SHA, universal across all Git repositories */
const GIT_EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Allowed read-only subcommands */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'ls-files',
  'rev-parse',
  'check-ref-format',
  'cat-file',
  'symbolic-ref',
  'config',
  'merge-base',
  'version',
]);

/** Strictly forbidden mutating commands */
const FORBIDDEN_GIT_COMMANDS = new Set([
  'add',
  'commit',
  'checkout',
  'reset',
  'clean',
  'push',
  'pull',
  'merge',
  'rebase',
  'tag',
  'branch',
  'cherry-pick',
  'revert',
  'apply',
  'stash',
  'rm',
  'mv',
  'clone',
  'init',
]);

/**
 * Normalizes file system paths to POSIX standard slashes.
 */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Options for configuring GitCLIAdapter.
 */
export interface GitCLIAdapterOptions {
  cwd?: string;
  maxBuffer?: number;
  timeoutMs?: number;
}

/**
 * Read-only Git CLI Adapter implementation conforming to GitAdapter and IGitAdapter.
 */
export class GitCLIAdapter implements GitAdapter, IGitAdapter {
  private defaultCwd?: string;
  private maxBuffer: number;
  private timeoutMs: number;

  constructor(options?: GitCLIAdapterOptions | string) {
    if (typeof options === 'string') {
      this.defaultCwd = options;
      this.maxBuffer = 20 * 1024 * 1024;
      this.timeoutMs = 30000;
    } else {
      this.defaultCwd = options?.cwd;
      this.maxBuffer = options?.maxBuffer ?? 20 * 1024 * 1024;
      this.timeoutMs = options?.timeoutMs ?? 30000;
    }
  }

  /**
   * Safely executes a read-only git command using Node child_process.execFile.
   * Throws ForbiddenGitOperationError if a mutating command is requested.
   */
  public async executeGit(
    args: string[],
    cwd?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();

    // Find the primary git subcommand (skipping leading flags like -C, etc.)
    let subcommand = '';
    for (const arg of args) {
      if (!arg.startsWith('-')) {
        subcommand = arg;
        break;
      }
    }

    if (FORBIDDEN_GIT_COMMANDS.has(subcommand)) {
      throw new ForbiddenGitOperationError(subcommand || args[0]);
    }

    if (subcommand && !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new ForbiddenGitOperationError(subcommand);
    }

    try {
      const result = await execFileAsync('git', args, {
        cwd: targetCwd,
        maxBuffer: this.maxBuffer,
        timeout: this.timeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          LC_ALL: 'C',
        },
      });

      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        exitCode: 0,
      };
    } catch (err: unknown) {
      const execErr = err as {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };

      const stderrStr = execErr.stderr ? execErr.stderr.toString() : '';
      const stdoutStr = execErr.stdout ? execErr.stdout.toString() : '';
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;

      // Special handling for git diff --no-index: exit code 1 indicates diffs were found (success)
      if (args.includes('--no-index') && exitCode === 1) {
        return {
          stdout: stdoutStr,
          stderr: stderrStr,
          exitCode: 1,
        };
      }

      // Check if current directory is not a Git repository
      if (
        stderrStr.includes('not a git repository') ||
        stderrStr.includes('Not a git repository') ||
        (execErr.message && execErr.message.includes('not a git repository'))
      ) {
        throw new NotAGitRepositoryError(targetCwd);
      }

      // Check for invalid revision / ref
      if (
        stderrStr.includes('unknown revision') ||
        stderrStr.includes('bad revision') ||
        stderrStr.includes('fatal: Not a valid object name') ||
        stderrStr.includes('fatal: ambiguous argument')
      ) {
        // Find which ref argument caused it
        const refArg = args.find(
          (a) => !a.startsWith('-') && a !== subcommand && a !== '--'
        );
        if (refArg) {
          throw new InvalidGitRefError(refArg);
        }
      }

      throw new GitExecutionError(`git ${args.join(' ')}`, stderrStr || execErr.message || '', exitCode);
    }
  }

  /**
   * Checks whether the specified directory is inside a valid Git repository.
   */
  public async isGitRepository(cwd?: string): Promise<boolean> {
    try {
      const res = await this.executeGit(['rev-parse', '--is-inside-work-tree'], cwd);
      return res.stdout.trim() === 'true';
    } catch (err) {
      if (err instanceof NotAGitRepositoryError) {
        return false;
      }
      return false;
    }
  }

  /**
   * Gets the absolute path of the Git repository root.
   */
  public async getRepositoryRoot(cwd?: string): Promise<string> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    try {
      const res = await this.executeGit(['rev-parse', '--show-toplevel'], targetCwd);
      const rootPath = path.resolve(res.stdout.trim());
      return toPosixPath(rootPath);
    } catch (err) {
      if (err instanceof NotAGitRepositoryError) {
        throw err;
      }
      throw new NotAGitRepositoryError(targetCwd);
    }
  }

  /**
   * Gets the current active branch name or 'HEAD' if detached.
   */
  public async getCurrentBranch(cwd?: string): Promise<string> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);

    try {
      // First try symbolic-ref to see if we are on a named branch
      const res = await this.executeGit(['symbolic-ref', '--short', '-q', 'HEAD'], targetCwd);
      const branch = res.stdout.trim();
      if (branch) return branch;
    } catch {
      // Detached HEAD or unborn branch
    }

    try {
      const res = await this.executeGit(['rev-parse', '--abbrev-ref', 'HEAD'], targetCwd);
      const branch = res.stdout.trim();
      if (branch) return branch;
    } catch {
      // Unborn repo
    }

    // Default fallback
    return 'HEAD';
  }

  /**
   * Gets the HEAD commit SHA, or an empty string for an unborn repository.
   */
  public async getHeadSha(cwd?: string): Promise<string> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);

    try {
      const res = await this.executeGit(['rev-parse', 'HEAD'], targetCwd);
      return res.stdout.trim();
    } catch {
      // Unborn repository (0 commits)
      return '';
    }
  }

  /**
   * Returns a complete status summary of the repository.
   */
  public async getStatus(cwd?: string): Promise<GitStatusSummary> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    const rootPath = await this.getRepositoryRoot(targetCwd);
    const currentBranch = await this.getCurrentBranch(targetCwd);
    const headSha = await this.getHeadSha(targetCwd);

    const res = await this.executeGit(['status', '--porcelain=v1', '-uall'], targetCwd);
    const lines = res.stdout.split(/\r?\n/);

    const stagedFiles: string[] = [];
    const unstagedFiles: string[] = [];
    const untrackedFiles: string[] = [];

    for (const rawLine of lines) {
      if (!rawLine || rawLine.length < 3) continue;

      const x = rawLine[0];
      const y = rawLine[1];
      let filePath = rawLine.substring(3).trim();

      // Handle quoted paths
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.substring(1, filePath.length - 1);
      }

      // Handle renames formatted as "old -> new"
      if (filePath.includes(' -> ')) {
        const parts = filePath.split(' -> ');
        filePath = parts[1].replace(/^"|"$/g, '');
      }

      filePath = toPosixPath(filePath);

      if (x === '?' && y === '?') {
        untrackedFiles.push(filePath);
      } else {
        if (x !== ' ' && x !== '?' && x !== '!') {
          stagedFiles.push(filePath);
        }
        if (y !== ' ' && y !== '?' && y !== '!') {
          unstagedFiles.push(filePath);
        }
      }
    }

    const isClean = stagedFiles.length === 0 && unstagedFiles.length === 0 && untrackedFiles.length === 0;

    return {
      isRepo: true,
      rootPath,
      currentBranch,
      headSha,
      isClean,
      stagedFiles,
      unstagedFiles,
      untrackedFiles,
    };
  }

  /**
   * Extracts raw unified diff text for the given scope and options.
   */
  public async getDiff(scope: ChangeScope, options?: DiffOptions): Promise<string> {
    const targetCwd = options?.cwd || this.defaultCwd || process.cwd();
    await this.ensureRepo(targetCwd);

    const headSha = await this.getHeadSha(targetCwd);
    const args: string[] = ['diff', '--no-color'];

    let diffText = '';

    switch (scope) {
      case 'staged': {
        if (!headSha) {
          // Unborn repository: diff cached files against empty tree
          args.push('--cached', GIT_EMPTY_TREE_SHA);
        } else {
          args.push('--cached');
        }
        break;
      }
      case 'working':
      case 'working-tree': {
        // Unstaged diff against index
        break;
      }
      case 'all': {
        if (!headSha) {
          // If unborn, get staged diff against empty tree + working tree diff
          const staged = await this.getDiff('staged', options);
          const working = await this.getDiff('working-tree', options);
          return [staged, working].filter(Boolean).join('\n');
        }
        // Diff working tree + staged against HEAD
        args.push('HEAD');
        break;
      }
      case 'commit': {
        const sha = options?.commitSha;
        if (!sha) {
          throw new InvalidGitRefError('commitSha is required for commit scope');
        }
        // git show --no-color --format= <sha> safely outputs patch even for root commit
        const showArgs = ['show', '--no-color', '--format=', sha];
        if (options?.pathFilters && options.pathFilters.length > 0) {
          showArgs.push('--', ...options.pathFilters);
        }
        const showRes = await this.executeGit(showArgs, targetCwd);
        return showRes.stdout;
      }
      case 'range': {
        let range = '';
        if (options?.baseRef && options.baseRef.includes('..')) {
          range = options.baseRef;
        } else if (options?.baseRef && options?.headRef) {
          range = `${options.baseRef}..${options.headRef}`;
        } else {
          throw new InvalidGitRefError('baseRef and headRef are required for range scope');
        }
        args.push(range);
        break;
      }
      case 'pull-request': {
        const base = options?.baseRef || 'main';
        const head = options?.headRef || 'HEAD';
        args.push(`${base}...${head}`);
        break;
      }
      default:
        throw new GitExecutionError(`git diff`, `Unknown change scope: ${scope}`);
    }

    if (options?.pathFilters && options.pathFilters.length > 0) {
      args.push('--', ...options.pathFilters);
    }

    try {
      const res = await this.executeGit(args, targetCwd);
      diffText = res.stdout;
    } catch (err) {
      if (err instanceof InvalidGitRefError) throw err;
      if (err instanceof NotAGitRepositoryError) throw err;
      throw err;
    }

    // Include untracked files if requested
    if (options?.includeUntracked) {
      const status = await this.getStatus(targetCwd);
      for (const untracked of status.untrackedFiles) {
        if (
          options.pathFilters &&
          options.pathFilters.length > 0 &&
          !options.pathFilters.some((f) => untracked.startsWith(f) || untracked === f)
        ) {
          continue;
        }

        try {
          const noIndexRes = await this.executeGit(
            ['diff', '--no-color', '--no-index', '--', '/dev/null', untracked],
            targetCwd
          );
          if (noIndexRes.stdout) {
            diffText = diffText ? `${diffText}\n${noIndexRes.stdout}` : noIndexRes.stdout;
          }
        } catch {
          // Silently skip if cannot read untracked file
        }
      }
    }

    return diffText;
  }

  /**
   * Convenience method to get staged unified diff.
   */
  public async getStagedDiff(cwd?: string): Promise<string> {
    return this.getDiff('staged', { cwd });
  }

  /**
   * Convenience method to get working tree unified diff.
   */
  public async getWorkingTreeDiff(cwd?: string): Promise<string> {
    return this.getDiff('working-tree', { cwd });
  }

  /**
   * Returns list of changed files with additions, deletions, and status.
   */
  public async getChangedFiles(
    scope?: ChangeScope,
    options?: DiffOptions | string
  ): Promise<ChangedFile[]> {
    let diffOptions: DiffOptions = {};
    let resolvedScope: ChangeScope = scope ?? 'staged';

    if (typeof options === 'string') {
      diffOptions = { cwd: options, scope: resolvedScope };
    } else if (options) {
      diffOptions = { ...options };
      if (options.scope && !scope) {
        resolvedScope = options.scope;
      }
    }

    const rawDiff = await this.getDiff(resolvedScope, diffOptions);
    const parsed = parseDiff(rawDiff);

    const changedFiles: ChangedFile[] = parsed.files.map((file) => {
      const isStaged = resolvedScope === 'staged' || resolvedScope === 'commit';
      return {
        path: toPosixPath(file.newPath),
        status: file.status === 'binary' ? 'modified' : file.status,
        oldPath: file.oldPath ? toPosixPath(file.oldPath) : undefined,
        staged: isStaged,
        binary: file.binary,
        additions: file.additions,
        deletions: file.deletions,
      };
    });

    return changedFiles;
  }

  /**
   * Gets file content at a specific Git ref or from current working tree.
   * Returns null if file does not exist or was deleted.
   */
  public async getFileContent(
    filepath: string,
    ref?: string,
    cwd?: string
  ): Promise<string | null> {
    const targetCwd = cwd || this.defaultCwd || process.cwd();
    const root = await this.getRepositoryRoot(targetCwd);
    const relativePath = toPosixPath(path.relative(root, path.resolve(root, filepath)));

    if (ref) {
      try {
        const res = await this.executeGit(['show', `${ref}:${relativePath}`], targetCwd);
        return res.stdout;
      } catch {
        return null;
      }
    } else {
      const fullPath = path.resolve(root, relativePath);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        return content;
      } catch {
        return null;
      }
    }
  }

  /**
   * Convenience alias: get content of a file at a specific Git ref.
   */
  public async getFileContentAtRef(
    filePath: string,
    ref: string,
    cwd?: string
  ): Promise<string | null> {
    return this.getFileContent(filePath, ref, cwd);
  }

  /**
   * Convenience alias: get content of a file in the working tree.
   */
  public async getWorkingFileContent(
    filePath: string,
    cwd?: string
  ): Promise<string | null> {
    return this.getFileContent(filePath, undefined, cwd);
  }

  /**
   * Internal helper ensuring that target directory is a Git repository.
   */
  private async ensureRepo(cwd: string): Promise<void> {
    const isRepo = await this.isGitRepository(cwd);
    if (!isRepo) {
      throw new NotAGitRepositoryError(cwd);
    }
  }
}
