/**
 * src/hook.ts
 * PreToolUse hook entrypoint shared by the Claude Code and Codex plugins.
 * Reads the hook event from stdin; for an agent `git commit` in a GitGuard-enabled repository,
 * exits with code 2 (block) unless the last GitGuard check covered the content being committed
 * and was not BLOCK. Anything unexpected lets the command proceed.
 */

import * as path from 'node:path';
import process from 'node:process';
import { findGitCommits } from './enforcement/commit-command.js';
import { evaluateCommitGate } from './enforcement/commit-gate.js';

interface PreToolUseEvent {
  tool_name?: string;
  tool_input?: { command?: unknown };
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  let event: PreToolUseEvent;
  try {
    event = JSON.parse(await readStdin()) as PreToolUseEvent;
  } catch {
    return 0;
  }
  if (event.tool_name !== 'Bash' || typeof event.tool_input?.command !== 'string') {
    return 0;
  }

  const baseDir = event.cwd || process.cwd();
  for (const commit of findGitCommits(event.tool_input.command)) {
    const repoDir = commit.dir ? path.resolve(baseDir, commit.dir) : baseDir;
    try {
      // Staging commands earlier in the same command line have not run yet, so require every change to be checked.
      const coverage = commit.stagesFirst ? 'all' : commit.all ? 'tracked' : 'staged';
      const decision = await evaluateCommitGate(repoDir, { coverage });
      if (!decision.allow) {
        process.stderr.write(`${decision.reason}\n`);
        return 2;
      }
    } catch (err) {
      // Not a repository or git unavailable: do not get in the way of unrelated commands.
      process.stderr.write(`[gitguard-hook] skipped: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return 0;
}

main().then((code) => process.exit(code), () => process.exit(0));
