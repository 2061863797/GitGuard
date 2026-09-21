#!/usr/bin/env node
/**
 * bin/gitguard.js
 * Unified CLI entrypoint for GitGuard (Node.js executable).
 */

import process from 'node:process';
import { createCliProgram } from '../dist/interfaces/cli/program.js';

const program = createCliProgram();
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Fatal error: ${err.message || String(err)}\n`);
  process.exit(err.exitCode ?? 1);
});
