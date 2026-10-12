/**
 * src/enforcement/bypass-guard.ts
 * Detects agent shell commands that would skip or tamper with the GitGuard pre-commit hook.
 * Plain text matching on purpose: it also sees through `bash -c "..."`, `eval`, `pwsh -Command`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_FILE_NAMES } from '../policy/config-files.js';

const BYPASS_PATTERNS: Array<[RegExp, string]> = [
  [/--no-verify\b/, '--no-verify skips the GitGuard pre-commit check'],
  [/\bgit\b[^\n]*\bcommit\b[^\n;&|]*\s-[A-Za-z]*n[A-Za-z]*(?=\s|$)/, '`git commit -n` skips the GitGuard pre-commit check'],
  [/hooks_?path/i, 'changing core.hooksPath disables the GitGuard pre-commit hook'],
  [/\.git[\\/]+(hooks|gitguard)\b/i, 'the GitGuard hook and check records under .git/ must not be edited by the agent'],
];

/** Returns why the command bypasses GitGuard, or null when it does not. */
export function findHookBypass(command: string): string | null {
  for (const [pattern, reason] of BYPASS_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

/** True when `dir` is inside a Git working tree whose root has a GitGuard config file. */
export function isGitGuardRepository(dir: string): boolean {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return CONFIG_FILE_NAMES.some((name) => fs.existsSync(path.join(current, name)));
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
