/**
 * src/enforcement/commit-gate.ts
 * Commit gate: every check records which file contents it covered; a Git pre-commit hook then
 * allows a commit only when the content being committed was checked and the last check was not
 * BLOCK. Enforcement applies only to repositories with a GitGuard config file (in the working
 * tree or in HEAD, so deleting the file does not switch the gate off).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitCLIAdapter } from '../git/adapter.js';
import { resolveGitDir } from '../findings/store.js';
import { CONFIG_FILE_NAMES } from '../policy/config-files.js';
import type { GateVerdict } from '../types/policy.js';

/** Runs a read-only git command in `cwd` and returns stdout. */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

/** Which file contents a check covered or a commit will contain. */
export type CoverageMode = 'staged' | 'all' | 'working';

const ZERO_SHA = '0'.repeat(40);
const RECORD_FILE = 'last-check.json';
/** Marker that identifies a pre-commit hook installed (and safe to update) by GitGuard. */
export const HOOK_MARKER = '# Installed by GitGuard';

/**
 * Last check written under `.git/gitguard/`; `files` maps each covered path to its blob id
 * (all zeros for a deletion, the checked-out commit for a submodule).
 */
export interface LastCheckRecord {
  version: 1;
  status: GateVerdict;
  headSha: string;
  checkedAt: string;
  blockingFindings: string[];
  files: Record<string, string>;
}

export interface CommitGateDecision {
  allow: boolean;
  reason?: string;
}

export function defaultGitExec(): GitExec {
  const adapter = new GitCLIAdapter();
  return async (args, cwd) => (await adapter.executeGit(args, cwd)).stdout;
}

function splitZ(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

async function headSha(exec: GitExec, root: string): Promise<string> {
  try {
    return (await exec(['rev-parse', '--verify', '--quiet', 'HEAD'], root)).trim();
  } catch {
    return '';
  }
}

/** Blob ids of staged entries, as `git commit` would record them (gitlinks report the submodule commit). */
async function stagedBlobs(exec: GitExec, root: string, head: string): Promise<Record<string, string>> {
  const args = ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames'];
  if (!head) args.push('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const fields = splitZ(await exec(args, root));
  const files: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    // ":<old mode> <new mode> <old sha> <new sha> <status>" followed by the path
    const meta = fields[i].split(' ');
    files[fields[i + 1]] = meta[3] ?? ZERO_SHA;
  }
  return files;
}

/**
 * Blob ids of working-tree files after clean filters (so CRLF checkouts compare equal to the index).
 * Directories are submodules: their id is the commit checked out inside them, as Git stages it.
 */
async function workingBlobs(exec: GitExec, root: string, paths: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const regular: string[] = [];
  for (const p of new Set(paths)) {
    const full = path.join(root, p);
    if (!fs.existsSync(full)) {
      files[p] = ZERO_SHA;
    } else if (fs.statSync(full).isDirectory()) {
      files[p] = (await headSha(exec, full)) || ZERO_SHA;
    } else {
      regular.push(p);
    }
  }
  for (let i = 0; i < regular.length; i += 100) {
    const batch = regular.slice(i, i + 100);
    const shas = (await exec(['hash-object', '--', ...batch], root)).split(/\r?\n/).filter(Boolean);
    batch.forEach((p, index) => { files[p] = shas[index] ?? ZERO_SHA; });
  }
  return files;
}

/**
 * Collects blob ids for the given coverage:
 * staged = index; all = staged + unstaged + untracked; working = unstaged + untracked.
 */
export async function collectBlobs(exec: GitExec, root: string, mode: CoverageMode): Promise<Record<string, string>> {
  const head = await headSha(exec, root);
  if (mode === 'staged') return stagedBlobs(exec, root, head);

  const paths: string[] = [];
  if (mode === 'working') {
    paths.push(...splitZ(await exec(['diff', '--name-only', '-z', '--no-renames'], root)));
  } else if (head) {
    paths.push(...splitZ(await exec(['diff', 'HEAD', '--name-only', '-z', '--no-renames'], root)));
  } else {
    paths.push(...Object.keys(await stagedBlobs(exec, root, head)));
    paths.push(...splitZ(await exec(['diff', '--name-only', '-z', '--no-renames'], root)));
  }
  paths.push(...splitZ(await exec(['ls-files', '--others', '--exclude-standard', '-z'], root)));
  return workingBlobs(exec, root, paths);
}

function recordPath(root: string): string {
  return path.join(resolveGitDir(root), 'gitguard', RECORD_FILE);
}

/**
 * True when the repository opted into GitGuard: a config file exists in the working tree or in HEAD.
 */
export async function hasGitGuardConfig(root: string, exec: GitExec = defaultGitExec()): Promise<boolean> {
  if (CONFIG_FILE_NAMES.some((name) => fs.existsSync(path.join(root, name)))) {
    return true;
  }
  for (const name of CONFIG_FILE_NAMES) {
    try {
      await exec(['cat-file', '-e', `HEAD:${name}`], root);
      return true;
    } catch {
      // not in HEAD
    }
  }
  return false;
}

/**
 * Records what a check covered. Scopes that do not describe uncommitted work (commit, range) are not recorded.
 */
export async function recordLastCheck(
  root: string,
  scope: string,
  status: GateVerdict,
  blockingFindings: string[],
  exec: GitExec = defaultGitExec()
): Promise<boolean> {
  const mode: CoverageMode | undefined =
    scope === 'staged' ? 'staged' : scope === 'all' ? 'all' : scope === 'working' || scope === 'working-tree' ? 'working' : undefined;
  if (!mode) return false;
  const record: LastCheckRecord = {
    version: 1,
    status,
    headSha: await headSha(exec, root),
    checkedAt: new Date().toISOString(),
    blockingFindings,
    files: await collectBlobs(exec, root, mode),
  };
  const target = recordPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(temp, target);
  return true;
}

export function readLastCheck(root: string): LastCheckRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath(root), 'utf8')) as LastCheckRecord;
    return parsed && parsed.version === 1 && parsed.files ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Decides whether the staged content in `repoDir` may be committed. Run from the pre-commit hook,
 * where Git points GIT_INDEX_FILE at exactly what the commit will contain (including `git commit -a`
 * and `git commit <paths>`).
 */
export async function evaluateCommitGate(repoDir: string, exec: GitExec = defaultGitExec()): Promise<CommitGateDecision> {
  const root = (await exec(['rev-parse', '--show-toplevel'], repoDir)).trim();
  if (!(await hasGitGuardConfig(root, exec))) {
    return { allow: true };
  }

  const rerun = 'Run the GitGuard check tool (scope "all" or "staged") on this repository, fix any BLOCK findings, then commit.';
  const record = readLastCheck(root);
  if (!record) {
    return { allow: false, reason: `GitGuard: this repository requires a check before committing, and none was recorded. ${rerun}` };
  }
  if (record.headSha !== (await headSha(exec, root))) {
    return { allow: false, reason: `GitGuard: HEAD moved since the last check. ${rerun}` };
  }

  const committing = await collectBlobs(exec, root, 'staged');
  const unchecked = Object.entries(committing)
    .filter(([file, sha]) => record.files[file] !== sha)
    .map(([file]) => file);
  if (unchecked.length > 0) {
    const listed = unchecked.slice(0, 5).join(', ') + (unchecked.length > 5 ? `, … (${unchecked.length} files)` : '');
    return { allow: false, reason: `GitGuard: these changes were not covered by the last check or changed after it: ${listed}. ${rerun}` };
  }

  if (record.status === 'BLOCK') {
    const findings = record.blockingFindings.length > 0 ? ` Blocking findings: ${record.blockingFindings.join(', ')}.` : '';
    return {
      allow: false,
      reason: `GitGuard: the last check returned BLOCK.${findings} Fix them and run the GitGuard verify tool with these IDs before committing.`,
    };
  }
  return { allow: true };
}

export type HookInstallResult =
  | { status: 'installed' | 'updated' | 'unchanged'; path: string }
  | { status: 'skipped'; reason: string };

/**
 * Installs (or refreshes) the pre-commit hook that runs `scriptPath`. Never overwrites a hook that
 * GitGuard did not install, and does not write into a hooks directory outside the Git directory
 * (e.g. a tracked `.husky/` set through core.hooksPath).
 */
export async function installPreCommitHook(
  root: string,
  scriptPath: string,
  exec: GitExec = defaultGitExec()
): Promise<HookInstallResult> {
  const gitDir = path.resolve(root, (await exec(['rev-parse', '--git-common-dir'], root)).trim());
  const hooksDir = path.resolve(root, (await exec(['rev-parse', '--git-path', 'hooks'], root)).trim());
  if (path.relative(gitDir, hooksDir).startsWith('..') || path.isAbsolute(path.relative(gitDir, hooksDir))) {
    return { status: 'skipped', reason: `core.hooksPath points outside the Git directory (${hooksDir}); add "node ${scriptPath.replace(/\\/g, '/')}" to your pre-commit hook manually.` };
  }

  const hookPath = path.join(hooksDir, 'pre-commit');
  const script = scriptPath.replace(/\\/g, '/');
  const content = [
    '#!/bin/sh',
    `${HOOK_MARKER}. Delete this file to uninstall; people can skip it once with git commit --no-verify.`,
    `script="${script}"`,
    'if [ ! -f "$script" ]; then',
    '  echo "GitGuard: hook script not found ($script). Run the GitGuard check tool to reinstall it, or commit with --no-verify." >&2',
    '  exit 1',
    'fi',
    'exec node "$script" "$@"',
    '',
  ].join('\n');

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(hookPath, 'utf8');
  } catch {
    existing = null;
  }
  if (existing !== null && !existing.includes(HOOK_MARKER)) {
    return { status: 'skipped', reason: `a pre-commit hook not installed by GitGuard already exists (${hookPath}); add "node ${script}" to it manually.` };
  }
  if (existing === content) {
    return { status: 'unchanged', path: hookPath };
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, content, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  return { status: existing === null ? 'installed' : 'updated', path: hookPath };
}
