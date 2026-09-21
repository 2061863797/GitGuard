/**
 * tests/unit/mcp/server.test.ts
 * Unit tests for GitGuard MCP stdio server, tool discovery, and execution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GitGuardMcpServer, logDiagnostic } from '../../../src/interfaces/mcp/server.js';
import { GITGUARD_MCP_TOOLS, executeMcpTool } from '../../../src/interfaces/mcp/tools.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { FileFindingStore } from '../../../src/findings/store.js';

describe('GitGuard MCP Server & Tools', () => {
  let fixture: GitFixture;
  let engine: DefaultGitGuardEngine;
  let mcpServer: GitGuardMcpServer;
  let client: Client;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    await fixture.writeFile('src/app.ts', 'export const x = 1;\n');
    await fixture.stage();
    await fixture.commit('initial commit');

    engine = new DefaultGitGuardEngine();
    mcpServer = new GitGuardMcpServer({ engine });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.start(serverTransport);

    client = new Client(
      { name: 'test-mcp-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    await fixture.cleanup();
  });

  describe('Tool Registration (tools/list)', () => {
    it('should register exactly the 4 required GitGuard tools', async () => {
      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain('inspect_changes');
      expect(toolNames).toContain('check_task_completion');
      expect(toolNames).toContain('check_before_commit');
      expect(toolNames).toContain('verify_findings');
      expect(response.tools).toHaveLength(4);
    });

    it('should expose valid JSON schemas for all 4 tools', () => {
      for (const tool of GITGUARD_MCP_TOOLS) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }

      const taskTool = GITGUARD_MCP_TOOLS.find((t) => t.name === 'check_task_completion');
      expect(taskTool?.inputSchema.required).toContain('task');

      const verifyTool = GITGUARD_MCP_TOOLS.find((t) => t.name === 'verify_findings');
      expect(verifyTool?.inputSchema.required).toContain('findingIds');
    });
  });

  describe('Tool Execution (tools/call)', () => {
    it('should execute inspect_changes successfully over MCP', async () => {
      const response = (await client.callTool({
        name: 'inspect_changes',
        arguments: {
          cwd: fixture.path,
          scope: 'all',
        },
      })) as any;

      expect(response.isError).toBeFalsy();
      expect(response.content).toHaveLength(1);
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe('PASS');
      expect(parsed.summary.filesChanged).toBe(0);
    });

    it('should execute check_task_completion tool successfully over MCP', async () => {
      await fixture.writeFile('src/feature.ts', 'export const ready = true;\n');
      const response = (await client.callTool({
        name: 'check_task_completion',
        arguments: {
          task: 'Implement ready feature flag',
          cwd: fixture.path,
        },
      })) as any;

      expect(response.isError).toBeFalsy();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe('PASS');
      expect(parsed.verdict).toBe('PASS');
      expect(typeof parsed.taskCompleted).toBe('number');
    });

    it('should fail check_task_completion if task parameter is missing', async () => {
      const response = (await client.callTool({
        name: 'check_task_completion',
        arguments: {
          cwd: fixture.path,
        },
      })) as any;

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("Missing required parameter 'task'");
    });

    it('should execute check_before_commit tool and return canCommit', async () => {
      const response = (await client.callTool({
        name: 'check_before_commit',
        arguments: {
          cwd: fixture.path,
          scope: 'all',
        },
      })) as any;

      expect(response.isError).toBeFalsy();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe('PASS');
      expect(parsed.canCommit).toBe(true);
      expect(parsed.deterministic).toBeDefined();
    });

    it('should execute verify_findings tool successfully', async () => {
      const store = new FileFindingStore(fixture.path);
      await store.save([
        {
          id: 'GG-PREV-001',
          ruleId: 'secret_scan',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          lifecycle: 'active',
          affectedFiles: [],
          message: 'Previous finding resolved',
          evidence: [],
          expectedEvidence: [],
          fingerprint: 'fp_prev_001',
          createdAt: new Date().toISOString(),
        },
      ]);

      const response = (await client.callTool({
        name: 'verify_findings',
        arguments: {
          findingIds: ['GG-PREV-001'],
          cwd: fixture.path,
        },
      })) as any;

      expect(response.isError).toBeFalsy();
      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.status).toBe('PASS');
      expect(parsed.allResolved).toBe(true);
      expect(parsed.resolved).toContain('GG-PREV-001');
    });

    it('should fail verify_findings if findingIds is missing or empty', async () => {
      const response = (await client.callTool({
        name: 'verify_findings',
        arguments: {
          findingIds: [],
          cwd: fixture.path,
        },
      })) as any;

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("Missing or empty required parameter 'findingIds'");
    });

    it('should return error on unknown tool call', async () => {
      const directResult = await executeMcpTool('unknown_tool', {}, engine);
      expect(directResult.isError).toBe(true);
      expect(directResult.content[0].text).toContain('Unknown tool name');
    });
  });

  describe('Stdio Hygiene', () => {
    it('should direct diagnostics exclusively to stderr, never stdout', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      logDiagnostic('Test diagnostic message');

      expect(stderrSpy).toHaveBeenCalled();
      expect(stdoutSpy).not.toHaveBeenCalled();

      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    });
  });
});
