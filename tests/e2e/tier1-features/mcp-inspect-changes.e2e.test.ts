/**
 * tests/e2e/tier1-features/mcp-inspect-changes.e2e.test.ts
 * Tier 1: Feature Coverage - MCP tool `inspect_changes`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  spawnMcpClient,
  type McpSession,
  setupGitGuardRepo,
  createTempGitRepo,
  type GitFixture,
} from '../helpers/e2e-harness.js';

describe('Tier 1: MCP inspect_changes tool', () => {
  let fixture: GitFixture;
  let session: McpSession;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-mcp-insp-');
    await setupGitGuardRepo(fixture);
    session = await spawnMcpClient(fixture.repoPath);
  });

  afterEach(async () => {
    await session.close();
    await fixture.cleanup();
  });

  it('T1-MCP-INSP-01: Clean repo returns status PASS and 0 changed files', async () => {
    const res = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath, scope: 'all' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.status).toBe('PASS');
    expect(data.summary.filesChanged).toBe(0);
  });

  it('T1-MCP-INSP-02: Staged file detected with insertions in staged scope', async () => {
    await fixture.writeFile('src/service.ts', 'export class UserService {}\n');
    await fixture.stage('src/service.ts');

    const res = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath, scope: 'staged' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.summary.filesChanged).toBe(1);
    expect(data.files[0].path).toBe('src/service.ts');
    expect(data.files[0].insertions).toBeGreaterThan(0);
  });

  it('T1-MCP-INSP-03: Working tree file modification isolated in working scope', async () => {
    await fixture.writeFile('notes.txt', 'Initial notes.\n');
    await fixture.stage('notes.txt');
    await fixture.commit('chore: add notes');

    await fixture.writeFile('notes.txt', 'Updated notes.\n');

    const res = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath, scope: 'working' },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.summary.filesChanged).toBe(1);
    expect(data.files[0].path).toBe('notes.txt');
  });

  it('T1-MCP-INSP-04: Commit range inspected accurately', async () => {
    await fixture.writeFile('file1.txt', 'first\n');
    await fixture.stage('file1.txt');
    await fixture.commit('feat: commit 1');

    await fixture.writeFile('file2.txt', 'second\n');
    await fixture.stage('file2.txt');
    await fixture.commit('feat: commit 2');

    const res = await session.client.callTool({
      name: 'inspect_changes',
      arguments: {
        cwd: fixture.repoPath,
        scope: 'range',
        target: 'HEAD~1..HEAD',
      },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.summary.filesChanged).toBe(1);
    expect(data.files[0].path).toBe('file2.txt');
  });

  it('T1-MCP-INSP-05: Handles default parameters gracefully', async () => {
    const res = await session.client.callTool({
      name: 'inspect_changes',
      arguments: { cwd: fixture.repoPath },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse((res.content as any)[0].text);
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('summary');
  });
});
