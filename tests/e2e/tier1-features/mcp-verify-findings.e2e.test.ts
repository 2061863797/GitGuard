/**
 * tests/e2e/tier1-features/mcp-verify-findings.e2e.test.ts
 * Tier 1: Feature Coverage - MCP tool `verify_findings`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  spawnMcpClient,
  type McpSession,
  setupGitGuardRepo,
  createTempGitRepo,
  type GitFixture,
} from '../helpers/e2e-harness.js';
import { FileFindingStore } from '../../../src/findings/store.js';

describe('Tier 1: MCP verify_findings tool', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-mcp-vrf-');
    await setupGitGuardRepo(fixture);
    const store = new FileFindingStore(fixture.repoPath);
    await store.save([
      {
        id: 'GG-001',
        ruleId: 'secret_scan',
        source: 'deterministic',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        affectedFiles: [],
        message: 'Mock finding 001',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp_001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'GG-002',
        ruleId: 'secret_scan',
        source: 'deterministic',
        status: 'block',
        severity: 'CRITICAL',
        lifecycle: 'active',
        affectedFiles: [],
        message: 'Mock finding 002',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp_002',
        createdAt: new Date().toISOString(),
      },
    ]);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T1-MCP-VRF-01: Clean repo confirms allResolved: true for targeted finding', async () => {
    const res = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, findingIds: ['GG-001'] },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.allResolved).toBe(true);
    expect(data.status).toBe('PASS');
    expect(data.resolved).toContain('GG-001');
  });

  it('T1-MCP-VRF-02: Unresolved active secret returns allResolved: false and lists in remaining', async () => {
    await fixture.writeFile('src/auth.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/auth.ts');

    const checkRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    const checkData = JSON.parse((checkRes.content as any)[0].text);
    expect(checkData.findings.length).toBeGreaterThan(0);
    const findingId = checkData.findings[0].id;

    const res = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, findingIds: [findingId] },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.allResolved).toBe(false);
    expect(data.remaining).toContain(findingId);
  });

  it('T1-MCP-VRF-03: Empty findingIds array returns tool error', async () => {
    const res = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, findingIds: [] },
    });

    expect(res.isError).toBe(true);
    const text = (res.content as any)[0].text;
    expect(text).toContain("Missing or empty required parameter 'findingIds'");
  });

  it('T1-MCP-VRF-04: Accepts comma-separated string via findings alias', async () => {
    const res = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, findings: 'GG-001,GG-002' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.allResolved).toBe(true);
    expect(data.resolved).toContain('GG-001');
    expect(data.resolved).toContain('GG-002');
  });

  it('T1-MCP-VRF-05: Incorporates task context into verification report', async () => {
    const res = await session.client.callTool({
      name: 'verify_findings',
      arguments: { cwd: fixture.repoPath, findingIds: ['GG-001'], task: 'Fix issue' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.allResolved).toBe(true);
    expect(data.status).toBe('PASS');
  });
});
