import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { DeterministicMockProvider } from '../../../src/analysis/semantic/mock-provider.js';
import { executeMcpTool } from '../../../src/interfaces/mcp/tools.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

describe('MCP online-only semantic tools', () => {
  let fixture: GitFixture;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    await fixture.writeFile('tracked.txt', 'initial\n');
    await fixture.stage();
    await fixture.commit('initial');
    await fixture.writeFile('tracked.txt', 'changed\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.cleanup();
  });

  it('keeps read-only inspection available without a TypeSafe key', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    const result = await executeMcpTool('inspect_changes', { cwd: fixture.path, scope: 'all' }, new DefaultGitGuardEngine());
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).summary.filesChanged).toBe(1);
  });

  it('requires TypeSafe even when the selected Git scope is clean', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    const result = await executeMcpTool(
      'check_before_commit',
      { cwd: fixture.path, scope: 'staged' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TypeSafe API key is not configured');
  });

  it('returns an error instead of a mock completion verdict when the key is missing', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    const result = await executeMcpTool(
      'check_task_completion',
      { cwd: fixture.path, task: 'Update the tracked file' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TypeSafe API key is not configured');
    expect(result.content[0].text).not.toContain('"status"');
  });

  it('returns an error instead of a mock gate when the online request fails', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'unit-test-only-key');
    vi.stubEnv('JEV_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test service unavailable')));
    const result = await executeMcpTool(
      'check_before_commit',
      { cwd: fixture.path, scope: 'all', task: 'Update the tracked file' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('test service unavailable');
    expect(result.content[0].text).not.toContain('"canCommit"');
  });

  it('rejects empty HTTP 200 answers without reporting a passing gate', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'unit-test-only-key');
    vi.stubEnv('JEV_API_KEY', '');
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      const questions = JSON.parse(String(init.body)).questions as Record<string, unknown>;
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, {}]));
      return { ok: true, status: 200, json: async () => ({ model: 'unit-test', answers }) };
    }));
    const result = await executeMcpTool(
      'check_before_commit',
      { cwd: fixture.path, scope: 'all', task: 'Update the tracked file' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Malformed System One answer');
    expect(result.content[0].text).not.toContain('"canCommit"');
  });

  it('requires a live TypeSafe answer for a clean required-semantic CLI check', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    await fixture.stage();
    await fixture.commit('clean worktree');
    await expect(new DefaultGitGuardEngine().check({
      cwd: fixture.path, scope: 'all', requireSemantic: true,
    })).rejects.toThrow('TypeSafe API key is not configured');
  });

  it('does not resolve stored findings when the online service is unavailable', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('JEV_API_KEY', '');
    const store = new FileFindingStore(fixture.path);
    await store.save([{
      id: 'online-only-finding',
      ruleId: 'task_completed',
      source: 'semantic',
      status: 'review',
      severity: 'ERROR',
      lifecycle: 'active',
      affectedFiles: [],
      message: 'Task still needs verification',
      evidence: [],
      expectedEvidence: [],
      fingerprint: 'online-only-finding',
      createdAt: new Date().toISOString(),
    }]);
    const result = await executeMcpTool(
      'verify_findings',
      { cwd: fixture.path, findingIds: ['online-only-finding'], task: 'Update the tracked file' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('TypeSafe API key is not configured');
    expect((await store.get('online-only-finding'))?.lifecycle).toBe('active');
  });

  it('rejects a repository policy that selects the mock provider', async () => {
    await fixture.writeFile('.gitguard.yml', 'version: 1\nsystem_one:\n  provider: mock\n');
    const result = await executeMcpTool(
      'check_task_completion',
      { cwd: fixture.path, task: 'Update the tracked file' },
      new DefaultGitGuardEngine(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('offline or mock mode is unavailable');
  });

  it('rejects incomplete online decisions instead of inventing a success score', async () => {
    const engine = {
      async check() {
        return {
          status: 'PASS',
          semanticDecisions: {
            task_completed: {
              id: 'task_completed', probability: 0.9, provider: 'typesafe',
              metadata: { requestedProvider: 'typesafe', effectiveProvider: 'typesafe', fallback: false },
            },
          },
        };
      },
    } as unknown as DefaultGitGuardEngine;
    const result = await executeMcpTool('check_task_completion', { task: 'Implement UI' }, engine);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('missing a required task-completion probability');
  });

  it('never invokes an injected local mock provider', async () => {
    const provider = new DeterministicMockProvider();
    const evaluate = vi.spyOn(provider, 'evaluate');
    const result = await executeMcpTool(
      'check_task_completion',
      { cwd: fixture.path, task: 'Update the tracked file' },
      new DefaultGitGuardEngine({ typesafeProvider: provider }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('require the TypeSafe provider');
    expect(evaluate).not.toHaveBeenCalled();
  });
});
