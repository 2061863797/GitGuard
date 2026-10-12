/**
 * src/main.ts
 * Stdio entrypoint for the GitGuard MCP server (bundled into the plugins).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { DefaultGitGuardEngine } from './core/engine.js';
import { GitGuardMcpServer, logDiagnostic } from './interfaces/mcp/server.js';
import { GITGUARD_VERSION } from './version.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${GITGUARD_VERSION}\n`);
  process.exit(0);
}

// The pre-commit script ships next to this file: gitguard-pre-commit.mjs in the plugin bundle,
// pre-commit.js in a tsc build.
const here = path.dirname(fileURLToPath(import.meta.url));
const preCommitScript = ['gitguard-pre-commit.mjs', 'pre-commit.js']
  .map((name) => path.join(here, name))
  .find((candidate) => fs.existsSync(candidate));

const server = new GitGuardMcpServer({
  engine: new DefaultGitGuardEngine({ preCommitScript }),
  debug: process.argv.includes('--debug'),
});

const shutdown = async () => {
  logDiagnostic('Shutdown signal received, terminating MCP server...');
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.start().catch((err: unknown) => {
  logDiagnostic('Fatal error: %s', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
