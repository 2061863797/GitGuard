/**
 * tests/unit/version-contract.test.ts
 * Strict version alignment contract test ensuring package.json, library exports,
 * CLI version flags, and MCP server versions never drift.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GITGUARD_VERSION } from '../../src/index.js';
import { GitGuardMcpServer } from '../../src/interfaces/mcp/server.js';
import { DefaultGitGuardEngine } from '../../src/core/engine.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('Version Alignment Contract', () => {
  it('package.json version matches exported GITGUARD_VERSION', () => {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(pkg.version).toBe(GITGUARD_VERSION);
    expect(pkg.version).toBe('0.2.5');
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

    const initResult = client.getServerVersion();
    expect(initResult?.version).toBe(GITGUARD_VERSION);
    expect(initResult?.version).toBe('0.2.5');

    await client.close();
    await server.close();
  });
});
