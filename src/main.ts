/**
 * src/main.ts
 * Stdio entrypoint for the GitGuard MCP server (bundled into the plugins).
 */

import process from 'node:process';
import { GitGuardMcpServer, logDiagnostic } from './interfaces/mcp/server.js';
import { GITGUARD_VERSION } from './version.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${GITGUARD_VERSION}\n`);
  process.exit(0);
}

const server = new GitGuardMcpServer({ debug: process.argv.includes('--debug') });

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
