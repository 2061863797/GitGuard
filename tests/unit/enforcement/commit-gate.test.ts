import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { evaluateCommitGate, readLastCheck } from '../../../src/enforcement/commit-gate.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';

const secret = ['ghp', '123456789012345678901234567890123456'].join('_');

describe('commit gate', () => {
  let repo: GitFixture;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    await repo.writeFile('README.md', '# fixture\r\n');
    await repo.writeFile('.gitguard.yml', 'version: 1\n');
    await repo.stage();
    await repo.commit('initial');
    engine = new DefaultGitGuardEngine({ typesafeProvider: createOnlineSemanticStub() });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('allows commits in repositories without a GitGuard config', async () => {
    await repo.exec(['rm', '-q', '--cached', '.gitguard.yml']);
    await repo.deleteFile('.gitguard.yml');
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('blocks a commit when no check was recorded', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    const decision = await evaluateCommitGate(repo.repoPath);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/none was recorded/);
  });

  it('allows staging and committing exactly what an "all" check covered, including CRLF content', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\r\n');
    await repo.writeFile('README.md', '# changed\r\n');
    const result = await engine.check({ cwd: repo.repoPath });
    expect(result.status).toBe('PASS');
    expect(Object.keys(readLastCheck(repo.repoPath)!.files).sort()).toEqual(['README.md', 'src/app.ts']);

    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
    // A partial commit of checked content is also fine.
    await repo.exec(['reset', '-q', 'README.md']);
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('blocks content that changed after the check', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repo.repoPath });
    await repo.writeFile('src/app.ts', 'export const a = 2;\n');
    await repo.stage();
    const decision = await evaluateCommitGate(repo.repoPath);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('src/app.ts');
  });

  it('blocks when the last check returned BLOCK, and allows after a passing verify', async () => {
    await repo.writeFile('src/config.ts', `export const token = "${secret}";\n`);
    const checked = await engine.check({ cwd: repo.repoPath });
    expect(checked.status).toBe('BLOCK');
    await repo.stage();
    const blocked = await evaluateCommitGate(repo.repoPath);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toMatch(/returned BLOCK/);
    expect(blocked.reason).toContain(checked.findings[0].id);

    await repo.writeFile('src/config.ts', 'export const token = process.env.TOKEN;\n');
    const verified = await engine.verify({ cwd: repo.repoPath, findingIds: [checked.findings[0].id] });
    expect(verified.status).toBe('PASS');
    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('allows REVIEW and WARN results', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    const result = await engine.check({
      cwd: repo.repoPath,
      rules: [{ id: 'violated_style', rule: 'Exports must be documented', level: 'review' }],
    });
    expect(result.status).toBe('REVIEW');
    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('blocks after HEAD moves', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repo.repoPath });
    await repo.stage();
    await repo.commit('committed elsewhere');
    await repo.writeFile('src/app.ts', 'export const a = 1;\n// more\n');
    await repo.stage();
    expect((await evaluateCommitGate(repo.repoPath)).reason).toMatch(/HEAD moved/);
  });

  it('checks unstaged tracked changes for commit -a', async () => {
    await repo.writeFile('README.md', '# checked\n');
    await engine.check({ cwd: repo.repoPath, scope: 'staged' });
    expect((await evaluateCommitGate(repo.repoPath, { coverage: 'tracked' })).allow).toBe(false);

    await engine.check({ cwd: repo.repoPath });
    expect(await evaluateCommitGate(repo.repoPath, { coverage: 'tracked' })).toEqual({ allow: true });
  });

  it('requires every change to be checked when the command stages files first', async () => {
    await repo.writeFile('src/checked.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repo.repoPath });
    expect(await evaluateCommitGate(repo.repoPath, { coverage: 'all' })).toEqual({ allow: true });
    await repo.writeFile('src/unchecked.ts', 'export const b = 2;\n');
    const decision = await evaluateCommitGate(repo.repoPath, { coverage: 'all' });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('src/unchecked.ts');
  });

  it('does not record commit or range checks', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    const sha = await repo.commit('second');
    await engine.check({ cwd: repo.repoPath, target: sha });
    expect(readLastCheck(repo.repoPath)).toBeNull();
  });
});
