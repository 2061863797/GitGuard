#!/usr/bin/env tsx
/**
 * bin/gitguard.ts
 * Unified CLI entrypoint for GitGuard (TypeScript).
 */

import process from 'node:process';
import { createCliProgram } from '../src/interfaces/cli/program.js';

const program = createCliProgram();
program.parseAsync(process.argv).catch((err: any) => {
  process.stderr.write(`Fatal error: ${err.message || String(err)}\n`);
  process.exit(err.exitCode ?? 1);
});
