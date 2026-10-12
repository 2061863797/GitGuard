/**
 * src/pre-commit.ts
 * Git pre-commit hook entrypoint installed by GitGuard into `.git/hooks/pre-commit`.
 * Git runs it for every commit form (aliases, nested shells, `commit -a`, `commit <paths>`),
 * with GIT_INDEX_FILE pointing at exactly what will be committed. Exit 1 rejects the commit.
 * Unexpected errors also reject it (fail closed); people can skip once with `git commit --no-verify`.
 */

import process from 'node:process';
import { evaluateCommitGate } from './enforcement/commit-gate.js';

async function main(): Promise<number> {
  try {
    const decision = await evaluateCommitGate(process.cwd());
    if (decision.allow) return 0;
    process.stderr.write(`${decision.reason}\n(To commit anyway as a person, use git commit --no-verify.)\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `GitGuard: the pre-commit check could not run: ${err instanceof Error ? err.message : String(err)}\n` +
      '(Fix the problem, or commit with --no-verify to skip GitGuard once.)\n'
    );
    return 1;
  }
}

main().then((code) => process.exit(code));
