/**
 * src/interfaces/mcp/server.ts
 * GitGuard Model Context Protocol (MCP) Server.
 * Implements standard MCP JSON-RPC 2.0 over stdio with strict stdio hygiene.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { GitGuardEngine } from '../../types/engine.js';
import { DefaultGitGuardEngine } from '../../core/engine.js';
import { GITGUARD_MCP_TOOLS, executeMcpTool } from './tools.js';

/**
 * Diagnostic logger for the MCP server that strictly directs output to stderr
 * to prevent frame corruption of the stdio JSON-RPC protocol.
 */
export function logDiagnostic(message: string, ...args: any[]): void {
  const timestamp = new Date().toISOString();
  const formatted = `[gitguard-mcp ${timestamp}] ${message}`;
  if (args.length > 0) {
    process.stderr.write(`${formatted} ${JSON.stringify(args)}\n`);
  } else {
    process.stderr.write(`${formatted}\n`);
  }
}

export interface McpServerOptions {
  engine?: GitGuardEngine;
  name?: string;
  version?: string;
  debug?: boolean;
}

/**
 * GitGuard MCP Server implementation wrapping standard MCP SDK Server.
 */
export class GitGuardMcpServer {
  public readonly server: Server;
  public readonly engine: GitGuardEngine;
  private readonly debug: boolean;
  private transport?: Transport;

  constructor(options?: McpServerOptions) {
    this.engine = options?.engine ?? new DefaultGitGuardEngine();
    this.debug = options?.debug ?? false;

    this.server = new Server(
      {
        name: options?.name ?? 'gitguard',
        version: options?.version ?? '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.registerHandlers();
  }

  /**
   * Registers MCP request handlers for tool discovery and execution.
   */
  private registerHandlers(): void {
    // 1. tools/list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (this.debug) {
        logDiagnostic('Listing tools: %d tools registered', GITGUARD_MCP_TOOLS.length);
      }
      return {
        tools: GITGUARD_MCP_TOOLS,
      };
    });

    // 2. tools/call handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (this.debug) {
        logDiagnostic('Calling tool: %s', name);
      }

      const result = await executeMcpTool(name, args, this.engine);
      return result;
    });
  }

  /**
   * Starts the MCP server on the provided transport or defaults to StdioServerTransport.
   */
  public async start(transport?: Transport): Promise<void> {
    this.transport = transport ?? new StdioServerTransport();
    if (this.debug) {
      logDiagnostic('Starting GitGuard MCP server over transport...');
    }
    await this.server.connect(this.transport);
    if (this.debug) {
      logDiagnostic('GitGuard MCP server connected and listening.');
    }
  }

  /**
   * Closes the MCP server connection cleanly.
   */
  public async close(): Promise<void> {
    try {
      await this.server.close();
      if (this.transport && 'close' in this.transport) {
        await (this.transport as any).close();
      }
      if (this.debug) {
        logDiagnostic('GitGuard MCP server closed.');
      }
    } catch (err: any) {
      logDiagnostic('Error while closing server: %s', err.message || String(err));
    }
  }

  /**
   * Returns the underlying SDK Server instance.
   */
  public getServer(): Server {
    return this.server;
  }
}
