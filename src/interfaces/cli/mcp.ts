/**
 * src/interfaces/cli/mcp.ts
 * Command handler for `gitguard mcp` (launches stdio MCP server).
 */

import type { GitGuardEngine } from '../../types/engine.js';
import { GitGuardMcpServer, logDiagnostic } from '../mcp/server.js';

export interface McpCliOptions {
  debug?: boolean;
}

export async function mcpCommand(
  options: McpCliOptions = {},
  engine?: GitGuardEngine
): Promise<GitGuardMcpServer> {
  const mcpServer = new GitGuardMcpServer({
    engine,
    debug: options.debug,
  });

  const handleSignal = async () => {
    logDiagnostic('Shutdown signal received, terminating MCP server...');
    await mcpServer.close();
    process.exit(0);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  await mcpServer.start();
  return mcpServer;
}
