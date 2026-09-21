/**
 * tests/e2e/tier4-scenarios/scenario-c-agent-loop.e2e.test.ts
 * Tier 4 Scenario C: Autonomous Coding Agent Task Completion Loop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  spawnMcpClient,
  type GitFixture,
  type McpSession,
} from '../helpers/e2e-harness.js';

describe('Tier 4 Scenario C: Autonomous Coding Agent Loop', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-scen-c-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T4-SCEN-C1: Agent queries task completion before making edits', async () => {
    const res = await session.client.callTool({
      name: 'check_task_completion',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        task: 'Implement JWT token validation',
      },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data).toHaveProperty('taskCompleted');
    expect(data.status).toBe('BLOCK');
    expect(data.taskCompleted).toBe(0.0);
  });

  it('T4-SCEN-C2: Agent writes implementation and checks commit gate (blocks on secret)', async () => {
    await fixture.writeFile(
      'src/jwt.ts',
      `export class TokenValidator {
  private secret = "AKIAIOSFODNN7EXAMPLE";
  validate(token: string) { return !!token; }
}\n`
    );
    await fixture.stage('src/jwt.ts');

    const res = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.canCommit).toBe(false);
    expect(data.verdict).toBe('BLOCK');
    expect(data.findings.length).toBeGreaterThan(0);
    expect(data.findings[0].id).toContain('finding_deterministic_secret_scan');
  });

  it('T4-SCEN-C3: Agent remediates, verifies resolution, and commits cleanly', async () => {
    // 1. Introduce secret
    await fixture.writeFile(
      'src/calc.ts',
      'const apiKey = "AKIAIOSFODNN7EXAMPLE";\n'
    );
    await fixture.stage('src/calc.ts');

    const checkRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    const checkData = JSON.parse((checkRes.content as any)[0].text);
    expect(checkData.canCommit).toBe(false);
    const findingId = checkData.findings[0].id;

    // 2. Agent removes secret
    await fixture.writeFile(
      'src/calc.ts',
      'export function calculate(a: number, b: number) { return a + b; }\n'
    );
    await fixture.stage('src/calc.ts');

    // 3. Agent calls verify_findings
    const verifyRes = await session.client.callTool({
      name: 'verify_findings',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        findingIds: [findingId],
      },
    });
    const verifyData = JSON.parse((verifyRes.content as any)[0].text);
    expect(verifyData.allResolved).toBe(true);
    expect(verifyData.status).toBe('PASS');

    // 4. Agent calls check_before_commit -> ready to commit
    const finalCheck = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    const finalData = JSON.parse((finalCheck.content as any)[0].text);
    expect(finalData.canCommit).toBe(true);
  });
});
