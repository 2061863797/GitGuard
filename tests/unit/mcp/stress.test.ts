/**
 * tests/unit/mcp/stress.test.ts
 * Empirical Stress Testing Suite for GitGuard Model Context Protocol (MCP) Server.
 * Authored by Challenger M4-2 for Milestone M4 adversarial review.
 *
 * Probes:
 * 1. Tool registration and schema compliance (all 4 tools, complete JSON Schemas).
 * 2. Stdio hygiene (zero non-JSON-RPC stdout output, stderr exclusive logging, real child process).
 * 3. Tool execution resilience (empty arguments, invalid parameters, non-existent repos, malformed payloads).
 * 4. Concurrency & lifecycle (concurrent requests over single transport, graceful shutdown, stdin EOF).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GitGuardMcpServer, logDiagnostic } from '../../../src/interfaces/mcp/server.js';
import { GITGUARD_MCP_TOOLS, executeMcpTool } from '../../../src/interfaces/mcp/tools.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { FileFindingStore } from '../../../src/findings/store.js';

describe('Empirical Challenger M4-2: MCP Server Stress Suite', () => {
  let fixture: GitFixture;
  let engine: DefaultGitGuardEngine;
  let mcpServer: GitGuardMcpServer;
  let client: Client;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    await fixture.writeFile('src/sample.ts', 'export const value = 42;\n');
    await fixture.stage();
    await fixture.commit('feat: initial commit for mcp stress');

    engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
    mcpServer = new GitGuardMcpServer({ engine });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.start(serverTransport);

    client = new Client(
      { name: 'mcp-stress-client', version: '2.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await mcpServer.close();
    } catch {
      // ignore
    }
    await fixture.cleanup();
  });

  // =========================================================================
  // 1. TOOL REGISTRATION & SCHEMA STRICTNESS STRESS
  // =========================================================================
  describe('1. Tool Registration & Schema Strictness Stress', () => {
    it('should register exactly the 4 required GitGuard tools with correct names', async () => {
      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toHaveLength(4);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'inspect_changes',
          'check_task_completion',
          'check_before_commit',
          'verify_findings',
        ])
      );
    });

    it('should expose complete, valid JSON schemas matching all interface requirements', () => {
      const toolMap = new Map(GITGUARD_MCP_TOOLS.map((t) => [t.name, t]));

      // 1. inspect_changes
      const inspectTool = toolMap.get('inspect_changes');
      expect(inspectTool).toBeDefined();
      expect(inspectTool!.description.length).toBeGreaterThan(20);
      expect(inspectTool!.inputSchema.type).toBe('object');
      const inspectProps = inspectTool!.inputSchema.properties as Record<string, any>;
      expect(inspectProps.scope.type).toBe('string');
      expect(inspectProps.scope.enum).toEqual([
        'staged',
        'working',
        'all',
        'commit',
        'range',
      ]);
      expect(inspectProps.target.type).toBe('string');
      expect(inspectProps.task.type).toBe('string');
      expect(inspectProps.cwd.type).toBe('string');

      // 2. check_task_completion
      const taskTool = toolMap.get('check_task_completion');
      expect(taskTool).toBeDefined();
      expect(taskTool!.inputSchema.type).toBe('object');
      expect(taskTool!.inputSchema.required).toEqual(['task']);
      const taskProps = taskTool!.inputSchema.properties as Record<string, any>;
      expect(taskProps.task.type).toBe('string');
      expect(taskProps.scope.type).toBe('string');
      expect(taskProps.scope.enum).toEqual([
        'staged',
        'working',
        'all',
        'commit',
        'range',
      ]);
      expect(taskProps.repoPath.type).toBe('string');
      expect(taskProps.cwd.type).toBe('string');

      // 3. check_before_commit
      const commitTool = toolMap.get('check_before_commit');
      expect(commitTool).toBeDefined();
      expect(commitTool!.inputSchema.type).toBe('object');
      const commitProps = commitTool!.inputSchema.properties as Record<string, any>;
      expect(commitProps.scope.type).toBe('string');
      expect(commitProps.scope.enum).toEqual(['staged', 'working', 'all']);
      expect(commitProps.task.type).toBe('string');
      expect(commitProps.repoPath.type).toBe('string');
      expect(commitProps.cwd.type).toBe('string');

      // 4. verify_findings
      const verifyTool = toolMap.get('verify_findings');
      expect(verifyTool).toBeDefined();
      expect(verifyTool!.inputSchema.type).toBe('object');
      expect(verifyTool!.inputSchema.required).toEqual(['findingIds']);
      const verifyProps = verifyTool!.inputSchema.properties as Record<string, any>;
      expect(verifyProps.findingIds.type).toBe('array');
      expect(verifyProps.findingIds.items.type).toBe('string');
      expect(verifyProps.task.type).toBe('string');
      expect(verifyProps.cwd.type).toBe('string');
    });

    it('should maintain schema immutability across repeated discovery queries', async () => {
      const initial = await client.listTools();
      const initialJson = JSON.stringify(initial.tools);

      // Query 10 times in sequence
      for (let i = 0; i < 10; i++) {
        const query = await client.listTools();
        expect(JSON.stringify(query.tools)).toBe(initialJson);
      }
    });
  });

  // =========================================================================
  // 2. STDIO PROTOCOL HYGIENE & REAL SUBPROCESS FRAMING STRESS
  // =========================================================================
  describe('2. Stdio Protocol Hygiene & Real Subprocess Framing Stress', () => {
    it(
      'should produce ZERO non-JSON-RPC stdout output across full handshake and tool call over real stdio',
      async () => {
        const entrypoint = path.resolve(process.cwd(), 'bin/gitguard.js');
        const proc = spawn(process.execPath, [entrypoint, 'mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
        proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

        const send = (msg: Record<string, any>) => {
          proc.stdin.write(JSON.stringify(msg) + '\n');
        };

        // 1. initialize request
        send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'stress-stdio-tester', version: '1.0' },
          },
        });

        // 2. notifications/initialized
        send({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        });

        // 3. tools/list
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

        // 4. tools/call inspect_changes
        send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'inspect_changes',
            arguments: { cwd: fixture.path, scope: 'all' },
          },
        });

        // Wait for responses
        await new Promise((resolve) => setTimeout(resolve, 1500));

        proc.stdin.end();
        await new Promise((resolve) => proc.on('exit', resolve));

        const fullStdout = stdoutChunks.join('');
        const lines = fullStdout
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        expect(lines.length).toBeGreaterThanOrEqual(3);

        // Verify EVERY line is strictly valid JSON-RPC 2.0
        for (const line of lines) {
          let parsed: any;
          expect(() => {
            parsed = JSON.parse(line);
          }).not.toThrow();

          expect(parsed.jsonrpc).toBe('2.0');
          expect(typeof parsed.id === 'number' || typeof parsed.id === 'string').toBe(true);
        }

        // Verify responses match requests
        const id1 = lines.map((l) => JSON.parse(l)).find((o) => o.id === 1);
        expect(id1?.result?.serverInfo?.name).toBe('gitguard');

        const id2 = lines.map((l) => JSON.parse(l)).find((o) => o.id === 2);
        expect(id2?.result?.tools).toHaveLength(4);

        const id3 = lines.map((l) => JSON.parse(l)).find((o) => o.id === 3);
        expect(id3?.result?.content).toBeDefined();
        const inspectData = JSON.parse(id3.result.content[0].text);
        expect(inspectData.status).toBe('PASS');
      },
      15000
    );

    it(
      'should route diagnostic logging strictly to stderr when --debug is enabled',
      async () => {
        const entrypoint = path.resolve(process.cwd(), 'bin/gitguard.js');
        const proc = spawn(process.execPath, [entrypoint, 'mcp', '--debug'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));
        proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

        // Send initialize
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 10,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'debug-tester', version: '1.0' },
            },
          }) + '\n'
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));
        proc.stdin.end();
        await new Promise((resolve) => proc.on('exit', resolve));

        const stdoutText = stdoutChunks.join('');
        const stderrText = stderrChunks.join('');

        // Stdout MUST NOT contain any diagnostic logger prefixes
        expect(stdoutText).not.toContain('[gitguard-mcp');
        // Stderr MUST contain diagnostic logs
        expect(stderrText).toContain('[gitguard-mcp');
        expect(stderrText).toContain('Starting GitGuard MCP server');
      },
      10000
    );

    it('should never leak diagnostic messages into stdout under heavy logDiagnostic load', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const testPayloads = [
        'Simple info message',
        '',
        'Special chars: \r\n\t\x00\x1b[31mRed\x1b[0m',
        { complex: { nested: [1, 2, 3], key: 'value' } },
        new Error('Synthetic error for logging test'),
        42,
        null,
        undefined,
      ];

      for (const payload of testPayloads) {
        logDiagnostic('Diagnostic stress payload:', payload);
      }

      // stdout MUST have received 0 calls
      expect(stdoutSpy).not.toHaveBeenCalled();
      // stderr MUST have received calls for every payload
      expect(stderrSpy).toHaveBeenCalledTimes(testPayloads.length);

      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  // =========================================================================
  // 3. ADVERSARIAL TOOL EXECUTION & ERROR RESILIENCE STRESS
  // =========================================================================
  describe('3. Adversarial Tool Execution & Error Resilience Stress', () => {
    describe('Parameter Validation & Missing Arguments', () => {
      it('should fail check_task_completion when task argument is missing, null, or empty', async () => {
        const testArgs = [
          {},
          { task: '' },
          { task: null },
          { task: undefined },
          { task: 12345 },
          { task: ['not-a-string'] },
        ];

        for (const args of testArgs) {
          const res = (await client.callTool({
            name: 'check_task_completion',
            arguments: args as any,
          })) as any;

          expect(res.isError).toBe(true);
          expect(res.content[0].text).toContain("Missing required parameter 'task'");
        }
      });

      it('should fail verify_findings when findingIds is missing, null, or empty array', async () => {
        const testArgs = [
          {},
          { findingIds: [] },
          { findingIds: null },
          { findingIds: undefined },
          { findings: [] },
        ];

        for (const args of testArgs) {
          const res = (await client.callTool({
            name: 'verify_findings',
            arguments: args as any,
          })) as any;

          expect(res.isError).toBe(true);
          expect(res.content[0].text).toContain(
            "Missing or empty required parameter 'findingIds'"
          );
        }
      });

      it('should support string comma-separated findingIds coercion and findings alias in verify_findings', async () => {
        const store = new FileFindingStore(fixture.path);
        await store.save([
          {
            id: 'GG-TEST-001',
            ruleId: 'secret_scan',
            source: 'deterministic',
            status: 'block',
            severity: 'CRITICAL',
            lifecycle: 'active',
            affectedFiles: [],
            message: 'Test 1',
            evidence: [],
            expectedEvidence: [],
            fingerprint: 'fp_1',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'GG-TEST-002',
            ruleId: 'secret_scan',
            source: 'deterministic',
            status: 'block',
            severity: 'CRITICAL',
            lifecycle: 'active',
            affectedFiles: [],
            message: 'Test 2',
            evidence: [],
            expectedEvidence: [],
            fingerprint: 'fp_2',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'GG-ALIAS-001',
            ruleId: 'secret_scan',
            source: 'deterministic',
            status: 'block',
            severity: 'CRITICAL',
            lifecycle: 'active',
            affectedFiles: [],
            message: 'Alias 1',
            evidence: [],
            expectedEvidence: [],
            fingerprint: 'fp_alias',
            createdAt: new Date().toISOString(),
          },
        ]);

        // String coercion: "GG-001, GG-002"
        const res1 = (await client.callTool({
          name: 'verify_findings',
          arguments: {
            findingIds: 'GG-TEST-001, GG-TEST-002',
            cwd: fixture.path,
          },
        })) as any;

        expect(res1.isError).toBeFalsy();
        const parsed1 = JSON.parse(res1.content[0].text);
        expect(parsed1.status).toBe('PASS');
        expect(parsed1.resolved).toContain('GG-TEST-001');
        expect(parsed1.resolved).toContain('GG-TEST-002');

        // Alias: findings instead of findingIds
        const res2 = (await client.callTool({
          name: 'verify_findings',
          arguments: {
            findings: ['GG-ALIAS-001'],
            cwd: fixture.path,
          },
        })) as any;

        expect(res2.isError).toBeFalsy();
        const parsed2 = JSON.parse(res2.content[0].text);
        expect(parsed2.status).toBe('PASS');
        expect(parsed2.resolved).toContain('GG-ALIAS-001');
      });

      it('should handle inspect_changes and check_before_commit with empty arguments gracefully', async () => {
        // inspect_changes with empty arguments defaults to scope: 'all'
        const inspectRes = (await client.callTool({
          name: 'inspect_changes',
          arguments: { cwd: fixture.path },
        })) as any;

        expect(inspectRes.isError).toBeFalsy();
        const inspectParsed = JSON.parse(inspectRes.content[0].text);
        expect(inspectParsed.status).toBe('PASS');

        // check_before_commit with empty arguments defaults to scope: 'staged'
        const commitRes = (await client.callTool({
          name: 'check_before_commit',
          arguments: { cwd: fixture.path },
        })) as any;

        expect(commitRes.isError).toBeFalsy();
        const commitParsed = JSON.parse(commitRes.content[0].text);
        expect(commitParsed.status).toBe('PASS');
        expect(commitParsed.canCommit).toBe(true);
      });
    });

    describe('Filesystem & Git Boundary Conditions', () => {
      it('should return error without crashing server when non-existent repo cwd is provided', async () => {
        const badPath = path.resolve(os.tmpdir(), 'gitguard_mcp_non_existent_dir_99999');

        const inspectRes = (await client.callTool({
          name: 'inspect_changes',
          arguments: { cwd: badPath },
        })) as any;

        expect(inspectRes.isError).toBe(true);
        expect(inspectRes.content[0].text).toContain('Tool execution failed (inspect_changes)');

        const commitRes = (await client.callTool({
          name: 'check_before_commit',
          arguments: { cwd: badPath },
        })) as any;

        expect(commitRes.isError).toBe(true);
        expect(commitRes.content[0].text).toContain('Tool execution failed (check_before_commit)');

        const taskRes = (await client.callTool({
          name: 'check_task_completion',
          arguments: { task: 'Verify non-existent repo', cwd: badPath },
        })) as any;

        expect(taskRes.isError).toBe(true);
        expect(taskRes.content[0].text).toContain('Tool execution failed (check_task_completion)');

        const verifyRes = (await client.callTool({
          name: 'verify_findings',
          arguments: { findingIds: ['F-1'], cwd: badPath },
        })) as any;

        expect(verifyRes.isError).toBe(true);
        expect(verifyRes.content[0].text).toContain('Tool execution failed (verify_findings)');
      });

      it('should return error without crashing when executed against a non-git directory', async () => {
        const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-nongit-'));
        try {
          const res = (await client.callTool({
            name: 'inspect_changes',
            arguments: { cwd: nonGitDir },
          })) as any;

          expect(res.isError).toBe(true);
          expect(res.content[0].text).toContain('Tool execution failed (inspect_changes)');
        } finally {
          await fs.rm(nonGitDir, { recursive: true, force: true });
        }
      });

      it('should handle unborn repository with zero commits safely', async () => {
        const unbornFixture = await createTempGitRepo();
        try {
          // No commits made yet
          const res = (await client.callTool({
            name: 'inspect_changes',
            arguments: { cwd: unbornFixture.path },
          })) as any;

          expect(res.isError).toBeFalsy();
          const parsed = JSON.parse(res.content[0].text);
          expect(parsed.status).toBe('PASS');
          expect(parsed.files).toHaveLength(0);
        } finally {
          await unbornFixture.cleanup();
        }
      });
    });

    describe('Unknown Tools & Malformed JSON-RPC Requests', () => {
      it('should return isError: true when calling an unknown tool name', async () => {
        const direct = await executeMcpTool('unregistered_tool', {}, engine);
        expect(direct.isError).toBe(true);
        expect(direct.content[0].text).toContain('Unknown tool name: "unregistered_tool"');
      });

      it(
        'should survive malformed JSON payload over raw stdio and continue serving valid requests',
        async () => {
          const entrypoint = path.resolve(process.cwd(), 'bin/gitguard.js');
          const proc = spawn(process.execPath, [entrypoint, 'mcp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });

          const stdoutChunks: string[] = [];
          proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));

          // Send malformed garbage line
          proc.stdin.write('MALFORMED_GARBAGE_LINE_NOT_JSON\n');

          // Send valid initialize
          proc.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 99,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'resilience-test', version: '1.0' },
              },
            }) + '\n'
          );

          await new Promise((resolve) => setTimeout(resolve, 1000));
          proc.stdin.end();
          await new Promise((resolve) => proc.on('exit', resolve));

          const responses = stdoutChunks
            .join('')
            .trim()
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l));

          const initResp = responses.find((r) => r.id === 99);
          expect(initResp).toBeDefined();
          expect(initResp.result?.serverInfo?.name).toBe('gitguard');
        },
        10000
      );

      it(
        'should return standard JSON-RPC Method Not Found (-32601) for unregistered methods',
        async () => {
          const entrypoint = path.resolve(process.cwd(), 'bin/gitguard.js');
          const proc = spawn(process.execPath, [entrypoint, 'mcp'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });

          const stdoutChunks: string[] = [];
          proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk.toString()));

          // Initialize first
          proc.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'test', version: '1.0' },
              },
            }) + '\n'
          );

          // Call invalid method
          proc.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 555,
              method: 'invalid/nonexistent/method',
              params: {},
            }) + '\n'
          );

          await new Promise((resolve) => setTimeout(resolve, 1000));
          proc.stdin.end();
          await new Promise((resolve) => proc.on('exit', resolve));

          const responses = stdoutChunks
            .join('')
            .trim()
            .split('\n')
            .filter((l) => l.length > 0)
            .map((l) => JSON.parse(l));

          const errResp = responses.find((r) => r.id === 555);
          expect(errResp).toBeDefined();
          expect(errResp.error?.code).toBe(-32601);
          expect(errResp.error?.message).toContain('Method not found');
        },
        10000
      );
    });
  });

  // =========================================================================
  // 4. CONCURRENCY & LIFECYCLE STRESS
  // =========================================================================
  describe('4. Concurrency & Lifecycle Stress', () => {
    it('should handle high-concurrency tool requests simultaneously without crosstalk or deadlock', async () => {
      await fixture.writeFile(
        '.gitguard.yml',
        [
          'version: 1',
          'deterministic:',
          '  test:',
          '    enabled: false',
          '  lint:',
          '    enabled: false',
          '  typecheck:',
          '    enabled: false',
        ].join('\n')
      );
      await fixture.writeFile(
        'src/sample.ts',
        'export const value = 42; // Concurrent verification task #0 #1 #2 #3 #4\n'
      );
      const store = new FileFindingStore(fixture.path);
      await store.save(
        Array.from({ length: 5 }).map((_, i) => ({
          id: `FINDING-CONCUR-${i}`,
          ruleId: 'secret_scan',
          source: 'deterministic',
          status: 'block' as const,
          severity: 'CRITICAL' as const,
          lifecycle: 'active' as const,
          affectedFiles: ['src/sample.ts'],
          message: `Concurrent finding ${i}`,
          evidence: [],
          expectedEvidence: [],
          fingerprint: `fp_concur_${i}`,
          createdAt: new Date().toISOString(),
        }))
      );

      // Fire 20 concurrent requests across all 4 tool types
      const tasks = [
        // 5 inspect_changes
        ...Array.from({ length: 5 }).map((_, i) =>
          client.callTool({
            name: 'inspect_changes',
            arguments: { cwd: fixture.path, scope: 'all' },
          })
        ),
        // 5 check_task_completion
        ...Array.from({ length: 5 }).map((_, i) =>
          client.callTool({
            name: 'check_task_completion',
            arguments: {
              task: `Concurrent verification task #${i}`,
              cwd: fixture.path,
            },
          })
        ),
        // 5 check_before_commit
        ...Array.from({ length: 5 }).map((_, i) =>
          client.callTool({
            name: 'check_before_commit',
            arguments: { cwd: fixture.path, scope: 'all' },
          })
        ),
        // 5 verify_findings
        ...Array.from({ length: 5 }).map((_, i) =>
          client.callTool({
            name: 'verify_findings',
            arguments: {
              findingIds: [`FINDING-CONCUR-${i}`],
              cwd: fixture.path,
            },
          })
        ),
      ];

      const results = (await Promise.all(tasks)) as any[];
      expect(results).toHaveLength(20);

      // Verify each result succeeded and produced valid JSON content
      for (let i = 0; i < 20; i++) {
        const res = results[i];
        expect(res.isError).toBeFalsy();
        expect(res.content).toHaveLength(1);
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.status).toBe('PASS');

        if (i >= 15) {
          // verify_findings
          const expectedId = `FINDING-CONCUR-${i - 15}`;
          expect(parsed.resolved).toContain(expectedId);
        }
      }
    });

    it('should handle repeated server start and close cycles cleanly without resource leaks', async () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        const testEngine = new DefaultGitGuardEngine();
        const testServer = new GitGuardMcpServer({ engine: testEngine });
        const [cTrans, sTrans] = InMemoryTransport.createLinkedPair();

        await testServer.start(sTrans);
        const testClient = new Client(
          { name: `cycle-client-${cycle}`, version: '1.0' },
          { capabilities: {} }
        );
        await testClient.connect(cTrans);

        const list = await testClient.listTools();
        expect(list.tools).toHaveLength(4);

        await testClient.close();
        await testServer.close();
      }
    });

    it(
      'should exit gracefully with code 0 when stdin EOF is encountered on subprocess',
      async () => {
        const entrypoint = path.resolve(process.cwd(), 'bin/gitguard.js');
        const proc = spawn(process.execPath, [entrypoint, 'mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let exitCode: number | null = null;
        proc.on('exit', (code) => {
          exitCode = code;
        });

        // Close stdin immediately to signal EOF
        proc.stdin.end();

        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(exitCode).toBe(0);
      },
      10000
    );
  });
});
