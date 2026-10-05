import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { GitGuardMcpServer, logDiagnostic } from '../../../src/interfaces/mcp/server.js';
import { executeMcpTool, GITGUARD_MCP_TOOLS } from '../../../src/interfaces/mcp/tools.js';
import type { GitGuardEngine } from '../../../src/types/engine.js';

function fakeEngine() {
  const result = {
    status: 'PASS', exitCode: 0, verdictSummary: 'Safe changes', findings: [],
    deterministicResults: [], diffSummary: { filesChanged: 1, insertions: 1, deletions: 0 },
    semanticDecisions: Object.fromEntries(['task_completed', 'task_scope_match', 'unrelated_changes'].map((id) => [
      id, { id, probability: id === 'unrelated_changes' ? 0.01 : 0.99, provider: 'typesafe',
        metadata: { requestedProvider: 'typesafe', effectiveProvider: 'typesafe', fallback: false, effectiveModel: 'test-model' } },
    ])),
    metadata: {},
  };
  const methods = {
    inspect: vi.fn().mockResolvedValue({ status: 'PASS', summary: result.diffSummary, changedFiles: [], findings: [], hasDeterministicFailures: false }),
    check: vi.fn().mockResolvedValue(result),
    verify: vi.fn().mockResolvedValue({ ...result, resolved: ['one'], remaining: [], targetsResolved: true, allResolved: true }),
  };
  return { methods, result, engine: methods as unknown as GitGuardEngine };
}

describe('MCP input and output contracts', () => {
  it.each([
    ['inspect_changes', { scope: 'typo' }],
    ['inspect_changes', { cwd: 123 }],
    ['inspect_changes', { unexpected: true }],
    ['inspect_changes', []],
    ['inspect_changes', { scope: 'commit' }],
    ['inspect_changes', { scope: 'staged', target: 'HEAD' }],
    ['inspect_changes', { target: '--output=bad' }],
    ['inspect_changes', { target: 'HEAD main' }],
    ['inspect_changes', { target: 'main..' }],
    ['inspect_changes', { target: 'main....HEAD' }],
    ['inspect_changes', { target: 'a...b...c' }],
    ['check_task_completion', { task: '   ' }],
    ['check_task_completion', { task: 'Fix bug', onlineOnly: false }],
    ['verify_findings', { findingIds: [123] }],
    ['verify_findings', { findingIds: [' '] }],
    ['verify_findings', { findingIds: ['one'], findings: ['two'] }],
    ['check_before_commit', { scope: 'range', target: 'main..HEAD' }],
  ])('rejects invalid input for %s before reaching the engine: %j', async (name, args) => {
    const { engine, methods } = fakeEngine();
    const response = await executeMcpTool(name as string, args, engine);
    expect(response.isError).toBe(true);
    expect(response.structuredContent?.error).toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(methods.inspect).not.toHaveBeenCalled();
    expect(methods.check).not.toHaveBeenCalled();
    expect(methods.verify).not.toHaveBeenCalled();
  });

  it('rejects conflicting repository aliases but accepts equivalent paths for all tools', async () => {
    for (const name of GITGUARD_MCP_TOOLS.map((tool) => tool.name)) {
      const { engine, methods } = fakeEngine();
      const args = { task: 'Fix feature', ...(name === 'verify_findings' ? { findingIds: ['one'] } : {}) };
      const invalid = await executeMcpTool(name, { ...args, cwd: './repo-a', repoPath: './repo-b' }, engine);
      expect(invalid.isError).toBe(true);
      expect(Object.values(methods).every((method) => method.mock.calls.length === 0)).toBe(true);

      const valid = await executeMcpTool(name, { ...args, cwd: './repo-a', repoPath: path.resolve('./repo-a') }, engine);
      expect(valid.isError).toBeFalsy();
      expect(Object.values(methods).flatMap((method) => method.mock.calls)[0][0].cwd).toBe(path.resolve('./repo-a'));
    }
  });

  it('forwards target and inferred scope to inspection, task check and finding verification', async () => {
    for (const name of ['inspect_changes', 'check_task_completion', 'verify_findings']) {
      const { engine, methods } = fakeEngine();
      const response = await executeMcpTool(name, { task: 'Fix feature', target: 'main...HEAD',
        ...(name === 'verify_findings' ? { findingIds: ['one'] } : {}) }, engine);
      expect(response.isError).toBeFalsy();
      const options = Object.values(methods).flatMap((method) => method.mock.calls)[0][0];
      expect(options).toMatchObject({ target: 'main...HEAD', scope: 'range' });
      if (name !== 'inspect_changes') expect(options).toMatchObject({ onlineOnly: true, noCache: true });
    }
  });

  it('keeps legacy finding aliases and comma strings while advertising nonempty arrays', async () => {
    const { engine, methods } = fakeEngine();
    for (const args of [{ findingIds: 'one, two,one' }, { findings: ['one', 'two'] }]) {
      expect((await executeMcpTool('verify_findings', args, engine)).isError).toBeFalsy();
      expect(methods.verify).toHaveBeenLastCalledWith(expect.objectContaining({ findingIds: ['one', 'two'] }));
    }
    const tool = GITGUARD_MCP_TOOLS.find((entry) => entry.name === 'verify_findings')!;
    expect(tool.inputSchema.properties?.findingIds).toMatchObject({ type: 'array', minItems: 1 });
  });

  it('uses structuredContent with identical, redacted JSON text and keeps BLOCK a successful evaluation', async () => {
    const { engine, methods, result } = fakeEngine();
    const token = ['ghp', '123456789012345678901234567890123456'].join('_');
    methods.check.mockResolvedValue({ ...result, status: 'BLOCK', exitCode: 1,
      findings: [{ message: 'api_key=opaque_secret_12345', evidence: [{ content: token }] }] });
    const response = await executeMcpTool('check_before_commit', {}, engine);
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({ status: 'BLOCK', canCommit: false });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
    expect(response.content[0].text).not.toContain(token);
    expect(response.content[0].text).not.toContain('opaque_secret_12345');
    expect(methods.check).toHaveBeenCalledWith(expect.objectContaining({ scope: 'staged', onlineOnly: true, noCache: true }));
  });

  it('returns a stable error without exposing known credentials from exceptions', async () => {
    const { engine, methods } = fakeEngine();
    const token = ['ghp', '123456789012345678901234567890123456'].join('_');
    methods.inspect.mockRejectedValue(new Error('Provider error: ' + token));
    const response = await executeMcpTool('inspect_changes', {}, engine);
    expect(response.isError).toBe(true);
    expect(response.structuredContent?.error).toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
    expect(response.content[0].text).not.toContain(token);
  });

  it('describes side effects and repository aliases accurately during discovery', () => {
    for (const tool of GITGUARD_MCP_TOOLS) {
      expect(tool.inputSchema.properties).toHaveProperty('repoPath');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.annotations?.readOnlyHint).toBe(tool.name === 'inspect_changes');
      expect(tool.annotations?.openWorldHint).toBe(tool.name !== 'inspect_changes');
    }
    for (const name of ['inspect_changes', 'check_task_completion', 'verify_findings']) {
      expect(GITGUARD_MCP_TOOLS.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty('target');
    }
  });

  it('formats diagnostic placeholders on stderr and redacts known credentials', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write');
    try {
      logDiagnostic('Tool %s registered %d handlers, api_key=%s', 'inspect_changes', 4, 'opaque_secret_12345');
      expect(stderr.mock.calls[0][0]).toContain('Tool inspect_changes registered 4 handlers');
      expect(stderr.mock.calls[0][0]).not.toContain('opaque_secret_12345');
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it('reports unknown tools as a protocol error over MCP', async () => {
    const { engine } = fakeEngine();
    const server = new GitGuardMcpServer({ engine });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.start(serverTransport);
      await client.connect(clientTransport);
      await expect(client.callTool({ name: 'nonexistent', arguments: {} })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await server.close();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('delegates transport shutdown to the SDK without a second direct close', async () => {
    const { engine } = fakeEngine();
    const server = new GitGuardMcpServer({ engine });
    const transport = { start: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), send: vi.fn() };
    await server.start(transport);
    await server.close();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });
});
