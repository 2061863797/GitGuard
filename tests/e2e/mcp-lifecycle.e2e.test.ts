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
    expect(session.client.getInstructions()).toMatch(/"yes" means a problem exists/);
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

  it('asks agent and config questions, records findings, and re-asks them on verify', async () => {
    await setupGitGuardRepo(repo, `questions:
  - id: problem_config_rule
    question: "Does this change violate the config rule?"
    level: review
    files: ["src/**"]
  - id: docs_only_rule
    question: "Does this change break the docs?"
    level: block
    files: ["docs/**"]
`);
    session = await spawnMcpClient();
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');

    const checked = await session.call('check', {
      cwd: repo.path,
      task: 'Add value export',
      questions: [
        { id: 'problem_agent_rule', question: 'Does this change skip validation?', level: 'block' },
        { id: 'clean_agent_rule', question: 'Does this change leave debug output?', level: 'warn' },
      ],
    });
    expect(checked.isError).toBe(false);
    expect(checked.data.status).toBe('BLOCK');
    expect(checked.data.metadata.questionsAsked).toBe(3);
    expect(checked.data.answers.map((a: any) => a.id).sort()).toEqual(['clean_agent_rule', 'problem_agent_rule', 'problem_config_rule']);
    const byRule = Object.fromEntries(checked.data.findings.map((f: any) => [f.ruleId, f]));
    expect(byRule.problem_agent_rule).toMatchObject({ status: 'block', questionSource: 'agent', question: 'Does this change skip validation?' });
    expect(byRule.problem_config_rule).toMatchObject({ status: 'review', questionSource: 'config' });

    const verified = await session.call('verify', { cwd: repo.path, findingIds: [byRule.problem_agent_rule.id] });
    expect(verified.data.answers.map((a: any) => a.id)).toContain('problem_agent_rule');
    expect(verified.data.status).toBe('BLOCK');
    expect(verified.data.remaining).toEqual([byRule.problem_agent_rule.id]);
  });

  it('runs without TYPESAFE_API_KEY when no questions are asked, and fails clearly when they are', async () => {
    await setupGitGuardRepo(repo);
    session = await spawnMcpClient({ withKey: false });
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');

    const plain = await session.call('check', { cwd: repo.path });
    expect(plain.isError).toBe(false);
    expect(plain.data.status).toBe('PASS');

    const withQuestions = await session.call('check', {
      cwd: repo.path,
      questions: [{ id: 'q1', question: 'Is anything wrong?', level: 'warn' }],
    });
    expect(withQuestions.isError).toBe(true);
    expect(withQuestions.text).toContain('TYPESAFE_API_KEY');
  });

  it('rejects an old-format .gitguard.yml with a migration hint', async () => {
    await repo.writeFile('.gitguard.yml', 'version: 1\ncustom_rules:\n  - id: x\n    question: "q"\n    files: ["src/**"]\n');
    await repo.writeFile('src/app.ts', 'export const value = 1;\n');
    session = await spawnMcpClient();
    const result = await session.call('check', { cwd: repo.path });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("'custom_rules' was removed");
  });
});
