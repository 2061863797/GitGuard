/**
 * MCP tool contracts: schemas, argument validation, result shape and redaction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { GITGUARD_MCP_TOOLS, GITGUARD_SERVER_INSTRUCTIONS, executeMcpTool } from '../../../src/interfaces/mcp/tools.js';
import { GitGuardMcpServer } from '../../../src/interfaces/mcp/server.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import type { GitGuardEngine } from '../../../src/types/engine.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';

const absoluteCwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';

describe('MCP tool definitions', () => {
  it('exposes exactly check and verify, both requiring cwd', () => {
    expect(GITGUARD_MCP_TOOLS.map((tool) => tool.name)).toEqual(['check', 'verify']);
    for (const tool of GITGUARD_MCP_TOOLS) {
      expect(tool.inputSchema.required).toContain('cwd');
    }
    const check = GITGUARD_MCP_TOOLS[0].inputSchema as any;
    expect(check.properties.questions.maxItems).toBe(10);
    expect(check.properties.questions.items.required).toEqual(['id', 'question', 'level']);
    expect(check.properties.questions.items.properties.level.enum).toEqual(['warn', 'review', 'block']);
  });

  it('sends server instructions to clients', async () => {
    const server = new GitGuardMcpServer({ engine: new DefaultGitGuardEngine() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.start(serverTransport);
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    expect(client.getInstructions()).toBe(GITGUARD_SERVER_INSTRUCTIONS);
    expect(GITGUARD_SERVER_INSTRUCTIONS).toMatch(/Never delete or weaken questions/);
    await client.close();
    await server.close();
  });
});

describe('executeMcpTool argument validation', () => {
  const engine: GitGuardEngine = {
    check: vi.fn(),
    verify: vi.fn(),
  };

  it.each([
    ['missing cwd', 'check', {}],
    ['relative cwd', 'check', { cwd: 'repo' }],
    ['unknown property', 'check', { cwd: absoluteCwd, offline: true }],
    ['bad question level', 'check', { cwd: absoluteCwd, questions: [{ id: 'q', question: 'x?', level: 'fatal' }] }],
    ['bad question id', 'check', { cwd: absoluteCwd, questions: [{ id: 'Q-1', question: 'x?', level: 'warn' }] }],
    ['extra question field', 'check', { cwd: absoluteCwd, questions: [{ id: 'q', question: 'x?', level: 'warn', source: 'config' }] }],
    ['too many questions', 'check', { cwd: absoluteCwd, questions: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, question: 'x?', level: 'warn' })) }],
    ['commit scope without target', 'check', { cwd: absoluteCwd, scope: 'commit' }],
    ['option-like target', 'check', { cwd: absoluteCwd, target: '--output=x' }],
    ['empty findingIds', 'verify', { cwd: absoluteCwd, findingIds: [] }],
  ])('rejects %s before reaching the engine', async (_label, name, args) => {
    const result = await executeMcpTool(name, args, engine);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe('INVALID_ARGUMENTS');
    expect(engine.check).not.toHaveBeenCalled();
    expect(engine.verify).not.toHaveBeenCalled();
  });

  it('rejects unknown and removed tool names', async () => {
    for (const name of ['inspect_changes', 'check_before_commit', 'nope']) {
      const result = await executeMcpTool(name, { cwd: absoluteCwd }, engine);
      expect((result.structuredContent as any).error.code).toBe('UNKNOWN_TOOL');
    }
  });
});

describe('executeMcpTool on a real repository', () => {
  let repo: GitFixture;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    await repo.writeFile('README.md', '# fixture\n');
    await repo.stage();
    await repo.commit('initial');
    engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('returns verdict, answers and findings carrying the question text', async () => {
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await executeMcpTool('check', {
      cwd: repo.repoPath,
      task: 'Add value',
      questions: [
        { id: 'problem_validation', question: 'Does this change skip validation?', level: 'review' },
        { id: 'fine_logging', question: 'Does this change leave debug output?', level: 'warn' },
      ],
    }, engine);
    const data = result.structuredContent as any;
    expect(result.isError).toBeUndefined();
    expect(data.status).toBe('REVIEW');
    expect(data.canCommit).toBe(true);
    expect(data.answers.map((a: any) => a.id).sort()).toEqual(['fine_logging', 'problem_validation']);
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({
      ruleId: 'problem_validation', status: 'review', question: 'Does this change skip validation?', questionSource: 'agent',
    });
  });

  it('redacts secrets from tool output', async () => {
    const secret = ['ghp', '123456789012345678901234567890123456'].join('_');
    await repo.writeFile('src/leak.ts', `export const t = "${secret}";\n`);
    const result = await executeMcpTool('check', { cwd: repo.repoPath }, engine);
    expect((result.structuredContent as any).status).toBe('BLOCK');
    expect(result.content[0].text).not.toContain(secret);
  });

  it('returns BLOCK for unknown finding ids without running checks', async () => {
    const result = await executeMcpTool('verify', { cwd: repo.repoPath, findingIds: ['finding_missing'] }, engine);
    const data = result.structuredContent as any;
    expect(data.status).toBe('BLOCK');
    expect(data.unknownFindings).toEqual(['finding_missing']);
  });

  it('reports engine errors such as duplicate question ids as tool errors', async () => {
    await repo.writeFile('.gitguard.yml', 'version: 1\nquestions:\n  - id: taken\n    question: "Is it bad?"\n    level: warn\n');
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');
    const result = await executeMcpTool('check', {
      cwd: repo.repoPath, questions: [{ id: 'taken', question: 'Again?', level: 'warn' }],
    }, engine);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Question id 'taken' is already used");
  });
});
