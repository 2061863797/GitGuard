/**
 * tests/e2e/tier3-pairwise/mcp-lifecycle.e2e.test.ts
 * Tier 3: MCP Verification Lifecycle & Autonomous Remediation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  spawnMcpClient,
  type GitFixture,
  type McpSession,
} from '../helpers/e2e-harness.js';

describe('Tier 3: MCP Verification Lifecycle', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-mcp-lc-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T3-MCP-LC-01: Full autonomous remediation cycle over stdio', async () => {
    // 1. Stage a secret
    await fixture.writeFile('src/service.ts', 'const token = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/service.ts');

    // 2. check_before_commit blocks
    const checkRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(checkRes.isError).toBeFalsy();
    const checkData = JSON.parse((checkRes.content as any)[0].text);
    expect(checkData.canCommit).toBe(false);
    expect(checkData.verdict).toBe('BLOCK');
    expect(checkData.findings.length).toBeGreaterThan(0);
    const secretFinding = checkData.findings[0];
    const findingId = secretFinding.id;

    // 3. inspect_changes to review diff
    const inspectRes = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(inspectRes.isError).toBeFalsy();
    const inspectData = JSON.parse((inspectRes.content as any)[0].text);
    expect(inspectData.summary.filesChanged).toBe(1);

    // 4. Remediate secret
    await fixture.writeFile('src/service.ts', 'export const endpoint = "https://example.com";\n');
    await fixture.stage('src/service.ts');

    // 5. verify_findings resolves the finding
    const verifyRes = await session.client.callTool({
      name: 'verify_findings',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        findingIds: [findingId],
      },
    });
    expect(verifyRes.isError).toBeFalsy();
    const verifyData = JSON.parse((verifyRes.content as any)[0].text);
    expect(verifyData.allResolved).toBe(true);
    expect(verifyData.status).toBe('PASS');

    // 6. check_before_commit passes cleanly
    const finalCheck = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(finalCheck.isError).toBeFalsy();
    const finalData = JSON.parse((finalCheck.content as any)[0].text);
    expect(finalData.canCommit).toBe(true);
    expect(finalData.verdict).toBe('PASS');
  });

  it('T3-MCP-LC-02: Incremental task completion verification over MCP', async () => {
    // 1. Initial state: minimal unrelated change
    await fixture.writeFile('src/dummy.ts', '// minimal change\n');
    await fixture.stage('src/dummy.ts');

    const res1 = await session.client.callTool({
      name: 'check_task_completion',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        task: 'Implement database connection pool with health check',
      },
    });
    expect(res1.isError).toBeFalsy();
    const data1 = JSON.parse((res1.content as any)[0].text);
    expect(data1.taskCompleted).toBeDefined();

    // 2. Agent writes implementation matching the task
    await fixture.writeFile(
      'src/db.ts',
      `export class DatabaseConnectionPool {
  async connect() { return true; }
  async healthCheck() { return { status: 'healthy', active: 5 }; }
}\n`
    );
    await fixture.stage('src/db.ts');

    const res2 = await session.client.callTool({
      name: 'check_task_completion',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        task: 'Implement database connection pool with health check',
      },
    });
    expect(res2.isError).toBeFalsy();
    const data2 = JSON.parse((res2.content as any)[0].text);
    expect(data2.taskCompleted).toBeDefined();
    expect(data2.taskCompleted).toBeGreaterThanOrEqual(data1.taskCompleted);
  });

  it('T3-MCP-LC-03: Double verification idempotency', async () => {
    await fixture.writeFile('src/code.ts', 'export const x = 1;\n');
    await fixture.stage('src/code.ts');

    const res1 = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, scope: 'staged', findingIds: ['dummy_id'] },
    });
    expect(res1.isError).toBeFalsy();
    const data1 = JSON.parse((res1.content as any)[0].text);
    expect(data1.allResolved).toBe(true);

    const res2 = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, scope: 'staged', findingIds: ['dummy_id'] },
    });
    expect(res2.isError).toBeFalsy();
    const data2 = JSON.parse((res2.content as any)[0].text);
    expect(data2.allResolved).toBe(true);
  });

  it('T3-MCP-LC-04: Partial fix detection over MCP', async () => {
    const customConfig = `
version: 1
deterministic:
  test: { enabled: false }
  lint: { enabled: false }
  typecheck: { enabled: false }
  secret_scan:
    enabled: true
    block_on_detection: true
rules:
  security_sensitive: { enabled: false }
  tests_required: { enabled: false }
custom_rules:
  - id: forbid_eval
    description: "Forbid eval"
    files: ["src/**"]
    question: "Does this change introduce dangerous eval usage?"
    primitive: noul
    block: 0.1
`;
    await fixture.writeFile('.gitguard.yml', customConfig);
    await fixture.writeFile('src/aws.ts', 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.writeFile('src/eval.ts', 'eval("danger();");\n');
    await fixture.stage();

    // 1. check_before_commit returns 2 findings
    const checkRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(checkRes.isError).toBeFalsy();
    const checkData = JSON.parse((checkRes.content as any)[0].text);
    expect(checkData.findings.length).toBeGreaterThanOrEqual(2);
    const findingIds = checkData.findings.map((f: any) => f.id);

    // 2. Remove ONLY the secret in aws.ts
    await fixture.writeFile('src/aws.ts', 'const k = "cleanKey";\n');
    await fixture.stage('src/aws.ts');

    // 3. verify_findings reports partial fix
    const verifyRes = await session.client.callTool({
      name: 'verify_findings',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        findingIds,
      },
    });
    expect(verifyRes.isError).toBeFalsy();
    const verifyData = JSON.parse((verifyRes.content as any)[0].text);
    expect(verifyData.allResolved).toBe(false);
    expect(verifyData.resolved.length).toBeGreaterThan(0);
    expect(verifyData.remaining.length).toBeGreaterThan(0);
  });
});
