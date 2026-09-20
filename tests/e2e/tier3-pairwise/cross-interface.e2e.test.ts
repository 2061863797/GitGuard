/**
 * tests/e2e/tier3-pairwise/cross-interface.e2e.test.ts
 * Tier 3: Cross-Interface Interoperability (CLI <-> MCP Stdio).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTempGitRepo,
  setupGitGuardRepo,
  spawnMcpClient,
  runCli,
  type GitFixture,
  type McpSession,
} from '../helpers/e2e-harness.js';

describe('Tier 3: Cross-Interface Interoperability', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cross-if-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T3-CRS-01: CLI detects finding -> MCP resolves finding', async () => {
    // 1. Introduce secret and stage
    await fixture.writeFile('src/key.ts', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/key.ts');

    // 2. CLI check detects finding
    const cliRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(cliRes.exitCode).toBe(1);
    const cliJson = cliRes.json();
    expect(cliJson.findings.length).toBeGreaterThan(0);
    const findingId = cliJson.findings[0].id;

    // 3. Fix code
    await fixture.writeFile('src/key.ts', 'export const key = "clean_value";\n');
    await fixture.stage('src/key.ts');

    // 4. MCP verify_findings resolves the CLI finding
    const mcpRes = await session.client.callTool({
      name: 'verify_findings',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'staged',
        findingIds: [findingId],
      },
    });
    expect(mcpRes.isError).toBeFalsy();
    const mcpData = JSON.parse((mcpRes.content as any)[0].text);
    expect(mcpData.allResolved).toBe(true);
    expect(mcpData.status).toBe('PASS');
    expect(mcpData.resolved).toContain(findingId);
  });

  it('T3-CRS-02: MCP detects blocker -> CLI verifies fix', async () => {
    // 1. Stage secret
    await fixture.writeFile('src/token.ts', 'const secret = "AKIAIOSFODNN7EXAMPLE";\n');
    await fixture.stage('src/token.ts');

    // 2. MCP check detects blocker
    const mcpRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(mcpRes.isError).toBeFalsy();
    const mcpData = JSON.parse((mcpRes.content as any)[0].text);
    expect(mcpData.canCommit).toBe(false);
    expect(mcpData.findings.length).toBeGreaterThan(0);
    const findingId = mcpData.findings[0].id;

    // 3. Fix code
    await fixture.writeFile('src/token.ts', 'export const token = "safe_token";\n');
    await fixture.stage('src/token.ts');

    // 4. CLI verify confirms resolution
    const cliRes = await runCli(
      ['verify', '--findings', findingId, '--scope', 'staged', '--offline', '--json'],
      { cwd: fixture.repoPath }
    );
    expect(cliRes.exitCode).toBe(0);
    const cliJson = cliRes.json();
    expect(cliJson.status).toBe('PASS');
    expect(cliJson.resolved).toContain(findingId);
  });

  it('T3-CRS-03: CLI inspect matches MCP inspect parity', async () => {
    await fixture.writeFile('src/mod1.ts', 'line1\nline2\nline3\n');
    await fixture.writeFile('src/mod2.ts', 'abc\ndef\n');
    await fixture.stage();

    // 1. CLI inspect
    const cliRes = await runCli(['inspect', '--scope', 'staged', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(cliRes.exitCode).toBe(0);
    const cliData = cliRes.json();

    // 2. MCP inspect
    const mcpRes = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(mcpRes.isError).toBeFalsy();
    const mcpData = JSON.parse((mcpRes.content as any)[0].text);

    // Parity checks
    expect(cliData.summary.filesChanged).toBe(mcpData.summary.filesChanged);
    expect(cliData.summary.insertions).toBe(mcpData.summary.insertions);
    expect(cliData.summary.deletions).toBe(mcpData.summary.deletions);
  });

  it('T3-CRS-04: Concurrent CLI check while MCP server runs', async () => {
    await fixture.writeFile('src/data.ts', 'export const items = [1, 2, 3];\n');
    await fixture.stage('src/data.ts');

    // Run CLI check while MCP server session is actively alive
    const cliRes = await runCli(['check', '--staged', '--offline', '--json'], {
      cwd: fixture.repoPath,
    });
    expect(cliRes.exitCode).toBe(0);

    // Run MCP check immediately after
    const mcpRes = await session.client.callTool({
      name: 'check_before_commit',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });
    expect(mcpRes.isError).toBeFalsy();
    const mcpData = JSON.parse((mcpRes.content as any)[0].text);
    expect(mcpData.canCommit).toBe(true);
  });
});
