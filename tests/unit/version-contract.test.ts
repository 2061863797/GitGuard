/**
 * tests/unit/version-contract.test.ts
 * Strict version alignment contract: package.json, library export, MCP server
 * version and both plugin manifests never drift.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GITGUARD_VERSION } from '../../src/index.js';
import { GitGuardMcpServer } from '../../src/interfaces/mcp/server.js';
import { DefaultGitGuardEngine } from '../../src/core/engine.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

const readJson = (relativePath: string) =>
  JSON.parse(fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8'));

describe('Version Alignment Contract', () => {
  it('package.json and both plugin manifests match GITGUARD_VERSION', () => {
    expect(GITGUARD_VERSION).toBe('0.3.0');
    expect(readJson('package.json').version).toBe(GITGUARD_VERSION);
    expect(readJson('plugins/gitguard/.claude-plugin/plugin.json').version).toBe(GITGUARD_VERSION);
    expect(readJson('plugins/gitguard/.codex-plugin/plugin.json').version).toBe(GITGUARD_VERSION);
  });

  it('plugin manifests point at the bundled server and shared skill', () => {
    const claude = readJson('plugins/gitguard/.claude-plugin/plugin.json');
    expect(claude.mcpServers.gitguard.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/server/gitguard-mcp.mjs']);
    const codex = readJson('plugins/gitguard/.codex-plugin/plugin.json');
    expect(codex.skills).toBe('./skills/');
    const codexMcp = readJson(path.join('plugins/gitguard', codex.mcpServers));
    expect(codexMcp.mcpServers.gitguard).toMatchObject({ command: 'node', args: ['gitguard-mcp.mjs'], cwd: 'server', tool_timeout_sec: 900 });
    expect(claude.mcpServers.gitguard.timeout).toBe(900000);
    expect(fs.existsSync(path.resolve('plugins/gitguard/server/gitguard-mcp.mjs'))).toBe(true);
    expect(fs.existsSync(path.resolve('plugins/gitguard/skills/gitguard/SKILL.md'))).toBe(true);
  });

  it('both plugins register the commit hook from the shared hooks file', () => {
    const codex = readJson('plugins/gitguard/.codex-plugin/plugin.json');
    expect(codex.hooks).toBe('./hooks/hooks.json');
    const hooks = readJson('plugins/gitguard/hooks/hooks.json');
    const [group] = hooks.hooks.PreToolUse;
    expect(group.matcher).toBe('Bash|PowerShell');
    expect(group.hooks[0].command).toContain("'server','gitguard-hook.mjs'");
    expect(group.hooks[0].command).toContain('process.env.PLUGIN_ROOT||process.env.CLAUDE_PLUGIN_ROOT');
    expect(fs.existsSync(path.resolve('plugins/gitguard/server/gitguard-hook.mjs'))).toBe(true);
  });

  it('MCP server initialization reports version strictly matching GITGUARD_VERSION', async () => {
    const engine = new DefaultGitGuardEngine();
    const server = new GitGuardMcpServer({ engine });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.start(serverTransport);
    const client = new Client(
      { name: 'test-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.version).toBe(GITGUARD_VERSION);

    await client.close();
    await server.close();
  });
});
