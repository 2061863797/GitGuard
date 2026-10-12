/**
 * End-to-end: a real MCP stdio subprocess running check → fix → verify on a temporary repository.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempGitRepo, type GitFixture } from '../helpers/git-fixture.js';
import { spawnMcpClient, setupGitGuardRepo, type McpSession } from './helpers/e2e-harness.js';

const secret = ['ghp', '123456789012345678901234567890123456'].join('_');

describe('GitGuard MCP lifecycle (stdio)', () => {
  let repo: GitFixture;
  let session: McpSession | undefined;

  beforeEach(async () => {
    repo = await createTempGitRepo('gitguard-e2e-');
  });

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await repo.cleanup();
  });

  it('advertises exactly check and verify with server instructions', async () => {
    session = await spawnMcpClient();
    const { tools } = await session.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['check', 'verify']);
    const check = tools.find((tool) => tool.name === 'check')!;
    expect(check.inputSchema.required).toContain('cwd');
    expect(Object.keys(check.inputSchema.properties ?? {})).toContain('rules');
    expect(session.client.getInstructions()).toMatch(/judge whether the change violates rules/);
  });

  it('blocks a leaked secret, then resolves it through verify after the fix', async () => {
    await setupGitGuardRepo(repo);
    session = await spawnMcpClient();
    await repo.writeFile('src/config.ts', `export const token = "${secret}";\n`);

    const checked = await session.call('check', { cwd: repo.path });
    expect(checked.isError).toBe(false);
    expect(checked.data.status).toBe('BLOCK');
    expect(checked.data.canCommit).toBe(false);
    expect(checked.text).not.toContain(secret);
    const finding = checked.data.findings.find((f: any) => f.ruleId === 'deterministic.secret_scan');
    expect(finding).toBeDefined();

    await repo.writeFile('src/config.ts', 'export const token = process.env.TOKEN;\n');
    const verified = await session.call('verify', { cwd: repo.path, findingIds: [finding.id] });
    expect(verified.data.status).toBe('PASS');
    expect(verified.data.resolved).toEqual([finding.id]);
  });

  it('checks agent and config rules, records findings, and re-checks them on verify', async () => {
    await setupGitGuardRepo(repo, `rules:
  - id: violated_config_rule
    rule: "业务代码必须通过统一的日志模块输出"
    level: review
    files: ["src/**"]
  - id: docs_only_rule
    rule: "Docs must keep the table of contents in sync"
    level: block
    files: ["docs/**"]
`);
    session = await spawnMcpClient();
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');

    const checked = await session.call('check', {
      cwd: repo.path,
      task: 'Add value export',
      rules: [
        { id: 'violated_agent_rule', rule: 'All external input must be validated', level: 'block' },
        { id: 'clean_agent_rule', rule: 'Code must not print debug output', level: 'warn' },
      ],
    });
    expect(checked.isError).toBe(false);
    expect(checked.data.status).toBe('BLOCK');
    expect(checked.data.metadata.rulesChecked).toBe(3);
    expect(checked.data.ruleResults.map((r: any) => r.id).sort())
      .toEqual(['clean_agent_rule', 'violated_agent_rule', 'violated_config_rule']);
    const byRule = Object.fromEntries(checked.data.findings.map((f: any) => [f.ruleId, f]));
    expect(byRule.violated_agent_rule).toMatchObject({ status: 'block', ruleSource: 'agent', rule: 'All external input must be validated' });
    expect(byRule.violated_config_rule).toMatchObject({ status: 'review', ruleSource: 'config', rule: '业务代码必须通过统一的日志模块输出' });

    const verified = await session.call('verify', { cwd: repo.path, findingIds: [byRule.violated_agent_rule.id] });
    expect(verified.data.ruleResults.map((r: any) => r.id)).toContain('violated_agent_rule');
    expect(verified.data.status).toBe('BLOCK');
    expect(verified.data.remaining).toEqual([byRule.violated_agent_rule.id]);
  });

  it('runs without TYPESAFE_API_KEY when no rules are checked, and fails clearly when they are', async () => {
    await setupGitGuardRepo(repo);
    session = await spawnMcpClient({ withKey: false });
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');

    const plain = await session.call('check', { cwd: repo.path });
    expect(plain.isError).toBe(false);
    expect(plain.data.status).toBe('PASS');

    const withRules = await session.call('check', {
      cwd: repo.path,
      rules: [{ id: 'r1', rule: 'Nothing may be wrong', level: 'warn' }],
    });
    expect(withRules.isError).toBe(true);
    expect(withRules.text).toContain('TYPESAFE_API_KEY');
  });
});
