import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import YAML from 'yaml';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { GitCLIAdapter } from '../../../src/git/adapter.js';
import { executeMcpTool } from '../../../src/interfaces/mcp/tools.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import type { Finding } from '../../../src/types/finding.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

describe('MCP audit regressions with real Git and simulated TypeSafe responses', () => {
  let fixture: GitFixture;
  let bodies: string[];
  let taskProbability: number;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    bodies = [];
    taskProbability = 0.99;
    await fixture.writeFile('.gitguard.yml', YAML.stringify({
      version: 1,
      deterministic: {
        test: { enabled: false }, lint: { enabled: false }, typecheck: { enabled: false },
        secret_scan: { enabled: true, block_on_detection: true },
      },
      rules: { tests_required: { enabled: false } },
    }));
    await fixture.stage();
    await fixture.commit('initial configuration');
    vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-test-key');
    vi.stubEnv('JEV_API_KEY', '');
    vi.stubGlobal('fetch', (async (_url, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const { questions } = JSON.parse(body) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> };
        const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
          question.type === 'noul'
            ? { type: 'noul', noul: id === 'task_completed' ? taskProbability : ['task_scope_match', 'tests_present'].includes(id) ? 0.99 : 0.01,
                rationale: `Simulated ${id} at ${taskProbability}` }
            : question.type === 'score' ? { type: 'score', score: 0 }
            : { type: 'choice', choice: Object.keys(question.criteria || {})[0] },
        ]));
        return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 });
      }) as typeof fetch);
    engine = new DefaultGitGuardEngine();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fixture.cleanup();
  });

  it('includes an untracked Unicode credential file in inspection and blocks the commit gate', async () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    await fixture.writeFile('中文-secret.txt', secret + '\n');
    const inspected = await executeMcpTool('inspect_changes', { cwd: fixture.path, scope: 'all' }, engine);
    expect(inspected.isError).toBeFalsy();
    expect(inspected.structuredContent?.files).toEqual([expect.objectContaining({ path: '中文-secret.txt' })]);
    const result = await executeMcpTool('check_before_commit', { cwd: fixture.path, scope: 'all' }, engine);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'BLOCK', canCommit: false, diffSummary: { filesChanged: 1 } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(secret);
  });

  it.each([
    ['GitHub fine-grained', 'github_pat_' + 'A'.repeat(82), 'github_pat_' + 'A'.repeat(82)],
    ['Stripe', 'sk_live_' + 'B'.repeat(24), 'sk_live_' + 'B'.repeat(24)],
    ['AWS secret', 'aws_secret_access_key="' + 'C'.repeat(40) + '"', 'C'.repeat(40)],
  ])('blocks a locally detected %s while sending a redacted online request', async (_format, input, secret) => {
    await fixture.writeFile('app.ts', input + '\n');
    await fixture.stage();
    const local = await engine.inspect({ cwd: fixture.path, scope: 'staged', checkDeterministic: true });
    expect(local.status).toBe('BLOCK');
    expect(bodies).toHaveLength(0);
    const result = await executeMcpTool('check_before_commit', { cwd: fixture.path }, engine);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: 'BLOCK', canCommit: false });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain(secret);
    expect(bodies[0]).toContain('<REDACTED_SECRET>');
    expect(result.content[0].text).not.toContain(secret);
  });

  it.each([[0.15, 'BLOCK'], [0.2, 'REVIEW'], [0.3, 'REVIEW']])(
    'keeps the targeted global task finding unresolved on clean re-verification at %s',
    async (probability, status) => {
      taskProbability = 0.1;
      const task = 'Implement the declared feature';
      const initial = await executeMcpTool('check_task_completion', { cwd: fixture.path, task }, engine);
      expect(initial.isError).toBeFalsy();
      expect(initial.structuredContent?.status).toBe('BLOCK');
      const previous = ((initial.structuredContent?.findings || []) as Finding[]).find((finding) => finding.ruleId === 'task_completed')!;
      expect(previous.affectedFiles).toEqual([]);
      taskProbability = probability as number;
      const verified = await executeMcpTool('verify_findings', { cwd: fixture.path, task, findingIds: [previous.id] }, engine);
      expect(verified.isError).toBeFalsy();
      // Verification blocks unresolved targets even when the fresh rule severity improves to review.
      expect(verified.structuredContent).toMatchObject({ status: 'BLOCK', targetsResolved: false, allResolved: false,
        resolved: [], remaining: [previous.id], newFindings: [] });
      const stored = await new FileFindingStore(fixture.path).get(previous.id);
      expect(stored).toMatchObject({ lifecycle: 'active', probability, status: String(status).toLowerCase() });
      expect(bodies).toHaveLength(2);
      taskProbability = 0.99;
      const resolved = await executeMcpTool('verify_findings', { cwd: fixture.path, task, findingIds: [previous.id] }, engine);
      expect(resolved.structuredContent).toMatchObject({ status: 'PASS', targetsResolved: true, allResolved: true,
        resolved: [previous.id], remaining: [], newFindings: [] });
    }
  );

  it('does not execute a configured fsmonitor helper during MCP inspection', async () => {
    await fixture.writeFile('.git/fsmonitor-helper.sh', '#!/bin/sh\nprintf ran > .git/fsmonitor-ran\nprintf "token\\0"\n');
    await fs.chmod(path.join(fixture.path, '.git', 'fsmonitor-helper.sh'), 0o755);
    await fixture.exec(['config', 'core.fsmonitor', '.git/fsmonitor-helper.sh']);
    await fixture.exec(['config', 'core.fsmonitorHookVersion', '2']);
    const inspected = await executeMcpTool('inspect_changes', { cwd: fixture.path }, engine);
    expect(inspected.isError).toBeFalsy();
    await expect(fs.access(path.join(fixture.path, '.git', 'fsmonitor-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(bodies).toHaveLength(0);
  });

  it('returns an MCP execution error when untracked diff output exceeds the buffer', async () => {
    await fixture.writeFile('large.txt', 'large content\n'.repeat(400));
    const limited = new DefaultGitGuardEngine({ gitAdapter: new GitCLIAdapter({ cwd: fixture.path, maxBuffer: 1024 }) });
    const result = await executeMcpTool('inspect_changes', { cwd: fixture.path, scope: 'all' }, limited);
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({ code: 'TOOL_EXECUTION_FAILED' });
    expect(result.content[0].text).toContain('maxBuffer');
    expect(result.structuredContent).not.toHaveProperty('status');
  });
});
