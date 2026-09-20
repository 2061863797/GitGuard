/**
 * tests/e2e/tier1-features/mcp-check-commit.e2e.test.ts
 * Tier 1: Feature Coverage - MCP tool `check_before_commit`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  spawnMcpClient,
  type McpSession,
  setupGitGuardRepo,
  createTempGitRepo,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 1: MCP check_before_commit tool', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-mcp-cmt-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T1-MCP-CMT-01: Safe staged changes allow commit with canCommit: true', async () => {
    await fixture.writeFile('src/clean.ts', 'export const cleanValue = 42;\n');
    await fixture.stage('src/clean.ts');

    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.canCommit).toBe(true);
    expect(data.verdict).toBe('PASS');
  });

  it('T1-MCP-CMT-02: Staged secret blocks commit with canCommit: false and BLOCK status', async () => {
    await fixture.writeFile('src/secret.ts', 'const token = "sk-1234567890abcdef1234567890abcdef12345678";\n');
    await fixture.stage('src/secret.ts');

    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.canCommit).toBe(false);
    expect(data.verdict).toBe('BLOCK');
    expect(data.findings.length).toBeGreaterThan(0);
  });

  it('T1-MCP-CMT-03: Incorporates task context into commit gate check', async () => {
    await fixture.writeFile('src/logger.ts', 'export function log(msg: string) { console.log(msg); }\n');
    await fixture.stage('src/logger.ts');

    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, task: 'Add logger' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.canCommit).toBe(true);
  });

  it('T1-MCP-CMT-04: Returns structured deterministic check status map', async () => {
    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data).toHaveProperty('deterministic');
    expect(typeof data.deterministic).toBe('object');
  });

  it('T1-MCP-CMT-05: Clean repo check allows commit with 0 violations', async () => {
    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.canCommit).toBe(true);
    expect(data.findings).toHaveLength(0);
  });
});
