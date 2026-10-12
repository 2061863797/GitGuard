/**
 * src/enforcement/commit-gate.ts
 * Commit gate: every check records which file contents it covered; a pre-commit hook then
 * allows an agent's `git commit` only when the content being committed was checked and the
 * last check was not BLOCK. Enforcement applies only to repositories with a GitGuard config file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitCLIAdapter } from '../git/adapter.js';
import { resolveGitDir } from '../findings/store.js';
import { CONFIG_FILE_NAMES } from '../policy/config.js';
import type { GateVerdict } from '../types/policy.js';

/** Runs a read-only git command in `cwd` and returns stdout. */
export type GitExec = (args: string[], cwd: string) => Promise<string>;

/** Which file contents a check covered or a commit will contain. */
export type CoverageMode = 'staged' | 'all' | 'working' | 'tracked';

const ZERO_SHA = '0'.repeat(40);
const RECORD_FILE = 'last-check.json';

/**
 * Last check written under `.git/gitguard/`; `files` maps each covered path to its blob id
 * (all zeros for a deletion).
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

/** Blob ids of staged entries, as `git commit` would record them. */
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

/** Blob ids of working-tree files after clean filters (so CRLF checkouts compare equal to the index). */
async function workingBlobs(exec: GitExec, root: string, paths: string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const existing: string[] = [];
  for (const p of new Set(paths)) {
    if (fs.existsSync(path.join(root, p))) existing.push(p);
    else files[p] = ZERO_SHA;
  }
  for (let i = 0; i < existing.length; i += 100) {
    const batch = existing.slice(i, i + 100);
    const shas = (await exec(['hash-object', '--', ...batch], root)).split(/\r?\n/).filter(Boolean);
    batch.forEach((p, index) => { files[p] = shas[index] ?? ZERO_SHA; });
  }
  return files;
}

/**
 * Collects blob ids for the given coverage:
 * staged = index; all = staged + unstaged + untracked; working = unstaged + untracked;
 * tracked = staged + unstaged tracked files (what `git commit -a` commits).
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
  if (mode !== 'tracked') {
    paths.push(...splitZ(await exec(['ls-files', '--others', '--exclude-standard', '-z'], root)));
  }
  return workingBlobs(exec, root, paths);
}

function recordPath(root: string): string {
  return path.join(resolveGitDir(root), 'gitguard', RECORD_FILE);
}

export function hasGitGuardConfig(root: string): boolean {
  return CONFIG_FILE_NAMES.some((name) => fs.existsSync(path.join(root, name)));
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
 * Decides whether an agent may commit in `repoDir`. `coverage` is what the commit may contain:
 * staged (plain commit), tracked (`git commit -a`) or all (the command stages files first).
 */
export async function evaluateCommitGate(
  repoDir: string,
  options: { coverage?: 'staged' | 'tracked' | 'all' } = {},
  exec: GitExec = defaultGitExec()
): Promise<CommitGateDecision> {
  const root = (await exec(['rev-parse', '--show-toplevel'], repoDir)).trim();
  if (!hasGitGuardConfig(root)) {
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

  const committing = await collectBlobs(exec, root, options.coverage ?? 'staged');
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
