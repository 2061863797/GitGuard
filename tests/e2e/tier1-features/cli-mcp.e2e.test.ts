/**
 * tests/e2e/tier1-features/cli-mcp.e2e.test.ts
 * Tier 1: Feature Coverage - CLI `mcp` server subcommand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { runCli, BIN_PATH, createTempGitRepo, type GitFixture } from '../helpers/e2e-harness.js';

describe('Tier 1: CLI mcp subcommand', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-cli-mcp-');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('T1-CLI-MCP-01: Displays help text and exits with code 0', async () => {
    const outcome = await runCli(['mcp', '--help'], { cwd: fixture.repoPath });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('Launch the Model Context Protocol (MCP) server over stdio');
  });

  it('T1-CLI-MCP-02: Spawns MCP server subprocess and replies to initialize handshake', async () => {
    const proc = spawn(process.execPath, [BIN_PATH, 'mcp'], {
      cwd: fixture.repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    proc.stdout.on('data', (d) => stdoutChunks.push(d.toString()));

    const initMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-tester', version: '1.0' },
      },
    };

    proc.stdin.write(JSON.stringify(initMsg) + '\n');

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 800));

    proc.stdin.end();
    await new Promise((resolve) => proc.on('exit', resolve));

    const combined = stdoutChunks.join('');
    expect(combined).toContain('"jsonrpc":"2.0"');
    expect(combined).toContain('"id":1');
    const parsed = JSON.parse(combined.trim().split('\n')[0]);
    expect(parsed.result).toHaveProperty('serverInfo');
    expect(parsed.result.serverInfo.name).toBe('gitguard');
  });

  it('T1-CLI-MCP-03: Routes diagnostic logging strictly to stderr under --debug', async () => {
    const proc = spawn(process.execPath, [BIN_PATH, 'mcp', '--debug'], {
      cwd: fixture.repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    proc.stdout.on('data', (d) => stdoutChunks.push(d.toString()));
    proc.stderr.on('data', (d) => stderrChunks.push(d.toString()));

    const initMsg = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-debug-tester', version: '1.0' },
      },
    };

    proc.stdin.write(JSON.stringify(initMsg) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 800));

    proc.stdin.end();
    await new Promise((resolve) => proc.on('exit', resolve));

    const fullStdout = stdoutChunks.join('');
    const fullStderr = stderrChunks.join('');

    // Every non-empty line on stdout MUST be valid JSON-RPC
    const lines = fullStdout.trim().split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Diagnostic log should appear on stderr
    expect(fullStderr).toContain('[gitguard-mcp');
  });
});
