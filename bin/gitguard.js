#!/usr/bin/env node
/**
 * bin/gitguard.js
 * Unified CLI entrypoint for GitGuard (Node.js executable).
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createCliProgram } from '../dist/interfaces/cli/program.js';

export { createCliProgram };

// Auto-run if executed directly as entrypoint script
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('gitguard.js') ||
    process.argv[1].endsWith('gitguard.ts') ||
    (import.meta.url && fileURLToPath(import.meta.url) === process.argv[1]));

if (isMain) {
  const program = createCliProgram();
  program.parseAsync(process.argv).catch((err) => {
    process.stderr.write(`Fatal error: ${err.message || String(err)}\n`);
    process.exit(err.exitCode ?? 1);
  });
}
