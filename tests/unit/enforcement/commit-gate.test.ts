import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import {
  evaluateCommitGate,
  hasGitGuardConfig,
  installPreCommitHook,
  readLastCheck,
  HOOK_MARKER,
} from '../../../src/enforcement/commit-gate.js';
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

  it('allows commits in repositories that never had a GitGuard config', async () => {
    await repo.exec(['rm', '-q', '.gitguard.yml']);
    await repo.commit('drop config');
    expect(await hasGitGuardConfig(repo.repoPath)).toBe(false);
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('keeps the gate on when the config is deleted from the working tree but still in HEAD', async () => {
    await repo.deleteFile('.gitguard.yml');
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    expect(await hasGitGuardConfig(repo.repoPath)).toBe(true);
    const decision = await evaluateCommitGate(repo.repoPath);
    expect(decision.allow).toBe(false);
  });

  it('blocks a commit when no check was recorded', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    const decision = await evaluateCommitGate(repo.repoPath);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/none was recorded/);
  });

  it('allows committing what an "all" check covered, including CRLF content and partial commits', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\r\n');
    await repo.writeFile('README.md', '# changed\r\n');
    const result = await engine.check({ cwd: repo.repoPath });
    expect(result.status).toBe('PASS');
    expect(Object.keys(readLastCheck(repo.repoPath)!.files).sort()).toEqual(['README.md', 'src/app.ts']);

    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
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
    expect(blocked.reason).toMatch(/returned BLOCK/);
    expect(blocked.reason).toContain(checked.findings[0].id);

    await repo.writeFile('src/config.ts', 'export const token = process.env.TOKEN;\n');
    const verified = await engine.verify({ cwd: repo.repoPath, findingIds: [checked.findings[0].id] });
    expect(verified.status).toBe('PASS');
    await repo.stage();
    expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
  });

  it('blocks after HEAD moves', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await engine.check({ cwd: repo.repoPath });
    await repo.stage();
    await repo.exec(['commit', '-q', '--no-verify', '-m', 'committed elsewhere']);
    await repo.writeFile('src/app.ts', 'export const a = 1;\n// more\n');
    await repo.stage();
    expect((await evaluateCommitGate(repo.repoPath)).reason).toMatch(/HEAD moved/);
  });

  it('records submodule changes by their checked-out commit instead of failing', async () => {
    const sub = await createTempGitRepo('gitguard-sub-');
    try {
      await sub.writeFile('lib.txt', 'v1\n');
      await sub.stage();
      await sub.commit('v1');
      await repo.exec(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repoPath.split(path.sep).join('/'), 'mod']);
      await repo.exec(['commit', '-q', '--no-verify', '-m', 'add submodule']);
      await repo.exec(['-C', 'mod', 'config', 'user.name', 'GitGuard Test']);
      await repo.exec(['-C', 'mod', 'config', 'user.email', 'test@gitguard.local']);
      await repo.exec(['-C', 'mod', 'commit', '-q', '--allow-empty', '-m', 'bump']);

      const result = await engine.check({ cwd: repo.repoPath });
      expect(result.status).toBe('PASS');
      expect(readLastCheck(repo.repoPath)?.files.mod).toMatch(/^[0-9a-f]{40}$/);
      await repo.exec(['add', 'mod']);
      expect(await evaluateCommitGate(repo.repoPath)).toEqual({ allow: true });
    } finally {
      await sub.cleanup();
    }
  });

  it('does not record commit or range checks', async () => {
    await repo.writeFile('src/app.ts', 'export const a = 1;\n');
    await repo.stage();
    const sha = await repo.commit('second');
    await engine.check({ cwd: repo.repoPath, target: sha });
    expect(readLastCheck(repo.repoPath)).toBeNull();
  });
});

describe('installPreCommitHook', () => {
  let repo: GitFixture;
  const script = path.resolve('dist', 'pre-commit.js');

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('installs, keeps and refreshes its own hook', async () => {
    const first = await installPreCommitHook(repo.repoPath, script);
    expect(first.status).toBe('installed');
    const hookPath = path.join(repo.repoPath, '.git', 'hooks', 'pre-commit');
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain(script.replace(/\\/g, '/'));
    expect((await installPreCommitHook(repo.repoPath, script)).status).toBe('unchanged');
    expect((await installPreCommitHook(repo.repoPath, `${script}.moved`)).status).toBe('updated');
  });

  it('never overwrites a hook it did not install', async () => {
    const hookPath = path.join(repo.repoPath, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, '#!/bin/sh\necho mine\n');
    const result = await installPreCommitHook(repo.repoPath, script);
    expect(result.status).toBe('skipped');
    expect(fs.readFileSync(hookPath, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('does not write into a hooks directory outside .git (core.hooksPath)', async () => {
    await repo.exec(['config', 'core.hooksPath', '.husky']);
    const result = await installPreCommitHook(repo.repoPath, script);
    expect(result.status).toBe('skipped');
    expect(fs.existsSync(path.join(repo.repoPath, '.husky', 'pre-commit'))).toBe(false);
  });
});
