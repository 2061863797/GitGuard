/**
 * src/core/command-cache.ts
 * Reuses passing test/lint/typecheck results while nothing they could depend on changed:
 * same HEAD, same content of every uncommitted file (including untracked) and same commands.
 * Ignored files (dependencies, .env) are not part of the key.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGitDir } from '../findings/store.js';
import { collectBlobs, type GitExec } from '../enforcement/commit-gate.js';
import type { DeterministicPolicyConfig } from '../types/policy.js';
import type { DeterministicResult } from '../types/provider.js';

const CACHE_FILE = 'command-cache.json';
export const COMMAND_CHECK_IDS = ['test', 'lint', 'typecheck'] as const;

interface CommandCache {
  version: 1;
  key: string;
  results: DeterministicResult[];
}

function cachePath(root: string): string {
  return path.join(resolveGitDir(root), 'gitguard', CACHE_FILE);
}

export async function commandCacheKey(
  root: string,
  deterministic: DeterministicPolicyConfig | undefined,
  exec: GitExec
): Promise<string> {
  let head = '';
  try {
    head = (await exec(['rev-parse', '--verify', '--quiet', 'HEAD'], root)).trim();
  } catch {
    head = '';
  }
  const files = await collectBlobs(exec, root, 'all');
  const commands = COMMAND_CHECK_IDS.map((id) => [id, deterministic?.[id]?.enabled ? deterministic[id]?.run : null]);
  const sortedFiles = Object.keys(files).sort().map((file) => [file, files[file]]);
  return crypto.createHash('sha256').update(JSON.stringify({ head, files: sortedFiles, commands })).digest('hex');
}

/** Cached command results for `key`, or null. */
export function readCommandCache(root: string, key: string): DeterministicResult[] | null {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(root), 'utf8')) as CommandCache;
    return cache.version === 1 && cache.key === key && Array.isArray(cache.results) ? cache.results : null;
  } catch {
    return null;
  }
}

/** Stores the command results when every configured command passed; otherwise clears the cache. */
export function writeCommandCache(root: string, key: string, results: DeterministicResult[]): void {
  const target = cachePath(root);
  const commandResults = results.filter((r) => (COMMAND_CHECK_IDS as readonly string[]).includes(r.id));
  if (commandResults.some((r) => r.status === 'failed')) {
    fs.rmSync(target, { force: true });
    return;
  }
  const trimmed = commandResults.map((r) => ({
    ...r,
    stdout: r.stdout?.slice(-2000),
    stderr: r.stderr?.slice(-2000),
  }));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: 1, key, results: trimmed } satisfies CommandCache), 'utf8');
  fs.renameSync(temp, target);
}
