/**
 * src/hook.ts
 * PreToolUse hook shared by the Claude Code and Codex plugins (Bash and PowerShell tools).
 * Commits themselves are gated by the Git pre-commit hook; this only stops an agent from skipping
 * or tampering with that hook in a GitGuard repository (exit code 2 blocks the tool call).
 */

import process from 'node:process';
import { findHookBypass, isGitGuardRepository } from './enforcement/bypass-guard.js';

/** Shell tools that can run git (Codex reports its shell as Bash). */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

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
  if (!SHELL_TOOLS.has(event.tool_name ?? '') || typeof event.tool_input?.command !== 'string') {
    return 0;
  }
  const reason = findHookBypass(event.tool_input.command);
  if (!reason || !isGitGuardRepository(event.cwd || process.cwd())) {
    return 0;
  }
  process.stderr.write(`GitGuard: blocked because ${reason}. Run the GitGuard check tool and commit normally; only the user may skip the check.\n`);
  return 2;
}

main().then((code) => process.exit(code), () => process.exit(0));
