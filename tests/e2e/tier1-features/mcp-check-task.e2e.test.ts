/**
 * tests/e2e/tier1-features/mcp-check-task.e2e.test.ts
 * Tier 1: Feature Coverage - MCP tool `check_task_completion`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  spawnMcpClient,
  type McpSession,
  setupGitGuardRepo,
  createTempGitRepo,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 1: MCP check_task_completion tool', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-mcp-tsk-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T1-MCP-TSK-01: Modified file matching declared task evaluates high completion', async () => {
    await fixture.writeFile('src/feature.ts', 'export function featureLogic() { return true; }\n');
    await fixture.stage('src/feature.ts');

    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: { cwd: fixture.repoPath, task: 'Implement feature logic' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.verdict).toBe('PASS');
    expect(data.taskCompleted).toBeGreaterThanOrEqual(0.6);
  });

  it('T1-MCP-TSK-02: Missing required task parameter returns error payload', async () => {
    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: { cwd: fixture.repoPath },
    });

    expect(res.isError).toBe(true);
    const text = (res.content as any)[0].text;
    expect(text).toContain("Missing required parameter 'task'");
  });

  it('T1-MCP-TSK-03: Clean repo returns BLOCK with 0.0 task completion probability when task is specified', async () => {
    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: { cwd: fixture.repoPath, task: 'Verify baseline' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.verdict).toBe('BLOCK');
    expect(data.taskCompleted).toBe(0.0);
  });

  it('T1-MCP-TSK-04: Accepts repoPath parameter interchangeably with cwd', async () => {
    await fixture.writeFile('src/repoPath.ts', 'export const repoPath = true;\n');
    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: { repoPath: fixture.repoPath, task: 'Test repoPath alias' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.verdict).toBe('PASS');
  });

  it('T1-MCP-TSK-05: Scope staged evaluates only staged changes against task intent', async () => {
    await fixture.writeFile('src/staged.ts', 'export const stagedVal = 100;\n');
    await fixture.stage('src/staged.ts');

    await fixture.writeFile('src/unstaged.ts', 'export const unstagedVal = 200;\n');

    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: { cwd: fixture.repoPath, task: 'Add staged value', scope: 'staged' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.verdict).toBe('PASS');
  });
});
