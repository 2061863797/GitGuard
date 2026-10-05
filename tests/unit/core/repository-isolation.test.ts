import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import { InvalidGitRefError } from '../../../src/types/errors.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { createOnlineSemanticStub } from '../../helpers/online-semantic-stub.js';

const config = {
  version: 1 as const,
  deterministic: {
    test: { enabled: false }, lint: { enabled: false }, typecheck: { enabled: false },
    secret_scan: { enabled: true, block_on_detection: true },
  },
  rules: { tests_required: { enabled: false } },
};
const secret = ['ghp', '123456789012345678901234567890123456'].join('_');

describe('Engine repository isolation and revision ranges', () => {
  let repository: GitFixture;
  let otherRepository: GitFixture | undefined;
  let engine: DefaultGitGuardEngine;
  let evaluate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    repository = await createTempGitRepo();
    const provider = createOnlineSemanticStub();
    evaluate = vi.spyOn(provider, 'evaluate');
    engine = new DefaultGitGuardEngine({ typesafeProvider: provider });
  });

  afterEach(async () => {
    await repository.cleanup();
    await otherRepository?.cleanup();
    otherRepository = undefined;
  });

  async function detectSecret() {
    await repository.writeFile('secret.ts', 'const key = "' + secret + '";\n');
    await repository.stage();
    const result = await engine.check({ cwd: repository.path, scope: 'staged', config, onlineOnly: true, noCache: true });
    const finding = result.findings.find((entry) => entry.ruleId === 'deterministic.secret_scan')!;
    expect(result.status).toBe('BLOCK');
    expect(finding).toBeDefined();
    return finding;
  }

  async function createCleanOtherRepository() {
    otherRepository = await createTempGitRepo();
    await otherRepository.writeFile('README.md', '# Clean repository\n');
    await otherRepository.stage();
    await otherRepository.commit('initial');
    return otherRepository;
  }

  it('blocks a finding from another repository before evaluating and never persists it there', async () => {
    const finding = await detectSecret();
    const other = await createCleanOtherRepository();
    evaluate.mockClear();

    const result = await engine.verify({
      cwd: other.path, findingIds: [finding.id], config, onlineOnly: true, noCache: true,
    });

    expect(result.status).toBe('BLOCK');
    expect(result.targetsResolved).toBe(false);
    expect(result.unknownFindings).toEqual([finding.id]);
    expect(result.resolved).toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await new FileFindingStore(other.path).list()).toEqual([]);
  });

  it('keeps bulk verification confined to active findings in the current repository', async () => {
    await detectSecret();
    const other = await createCleanOtherRepository();
    const result = await engine.verify({ cwd: other.path, config, onlineOnly: true, noCache: true });
    expect(result.status).toBe('PASS');
    expect(result.resolved).toEqual([]);
    expect(result.remaining).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  it('reports partially unknown IDs accurately and leaves known records active without evaluation', async () => {
    const finding = await detectSecret();
    evaluate.mockClear();
    const result = await engine.verify({ cwd: repository.path, findingIds: [finding.id, 'missing'], config, onlineOnly: true, noCache: true });
    expect(result.status).toBe('BLOCK');
    expect(result.verdictSummary).toContain('Some targeted finding ID(s) are unknown');
    expect(result.unknownFindings).toEqual(['missing']);
    expect(result.remaining).toContain(finding.id);
    expect(evaluate).not.toHaveBeenCalled();
    expect((await new FileFindingStore(repository.path).get(finding.id))?.lifecycle).toBe('active');
  });

  it('supports same-repository memory fallback when the disk record is absent', async () => {
    const finding = await detectSecret();
    expect(finding.provenance?.repositoryRoot).toBe(repository.path);
    await fs.unlink(path.join(repository.path, '.git', 'gitguard', 'findings.json'));
    await repository.writeFile('secret.ts', 'const key = "public";\n');
    await repository.stage();

    const result = await engine.verify({
      cwd: repository.path, findingIds: [finding.id], config, onlineOnly: true, noCache: true,
    });
    expect(result.resolved).toContain(finding.id);
    expect(result.status).toBe('PASS');
  });

  it('accepts legacy records from the current repository store without a repositoryRoot', async () => {
    const finding = await detectSecret();
    delete finding.provenance!.repositoryRoot;
    await new FileFindingStore(repository.path).save([finding]);
    await repository.writeFile('secret.ts', 'const key = "public";\n');
    await repository.stage();

    const result = await engine.verify({
      cwd: repository.path, findingIds: [finding.id], config, onlineOnly: true, noCache: true,
    });
    expect(result.resolved).toContain(finding.id);
    expect(result.status).toBe('PASS');
  });

  it('isolates concurrent checks on a shared engine', async () => {
    const other = await createCleanOtherRepository();
    await repository.writeFile('secret.ts', 'const key = "' + secret + '";\n');
    await repository.stage();
    await other.writeFile('safe.ts', 'export const safe = true;\n');

    const [first, second] = await Promise.all([
      engine.check({ cwd: repository.path, scope: 'staged', config, onlineOnly: true, noCache: true }),
      engine.check({ cwd: other.path, scope: 'all', config, onlineOnly: true, noCache: true }),
    ]);
    expect(first.status).toBe('BLOCK');
    expect(first.findings.every((finding) => finding.provenance?.repositoryRoot === repository.path)).toBe(true);
    expect(second.status).toBe('PASS');
    expect(second.findings).toEqual([]);

    const verification = await engine.verify({
      cwd: other.path, findingIds: first.findings.map((finding) => finding.id), config, onlineOnly: true, noCache: true,
    });
    expect(verification.status).toBe('BLOCK');
    expect(verification.unknownFindings).toEqual(first.findings.map((finding) => finding.id));
  });

  it('fails on corrupt finding storage before checks or provider calls and preserves the corrupt file', async () => {
    const storePath = path.join(repository.path, '.git', 'gitguard', 'findings.json');
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const corrupt = '{ invalid json';
    await fs.writeFile(storePath, corrupt);
    await expect(engine.verify({ cwd: repository.path, config, onlineOnly: true, noCache: true }))
      .rejects.toMatchObject({ code: 'FINDING_STORE_CORRUPT' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await fs.readFile(storePath, 'utf8')).toBe(corrupt);
  });

  it('infers a commit scope from target without including later commits', async () => {
    await repository.writeFile('first.txt', 'first\n');
    await repository.stage();
    const first = await repository.commit('first');
    await repository.writeFile('later.txt', 'later\n');
    await repository.stage();
    await repository.commit('later');
    const result = await engine.inspect({ cwd: repository.path, target: first });
    expect(result.changedFiles.map((file) => file.path)).toEqual(['first.txt']);
  });

  it.runIf(process.platform === 'win32')('blocks verification when a read-only store cannot persist resolution', async () => {
    const finding = await detectSecret();
    const storePath = path.join(repository.path, '.git', 'gitguard', 'findings.json');
    await fs.chmod(storePath, 0o444);
    try {
      await repository.writeFile('secret.ts', 'const key = "public";\n');
      await repository.stage();
      const result = await engine.verify({ cwd: repository.path, findingIds: [finding.id], config, onlineOnly: true, noCache: true });
      expect(result.status).toBe('BLOCK');
      expect(result.allResolved).toBe(false);
      expect(result.metadata.persistenceOk).toBe(false);
      expect((await new FileFindingStore(repository.path).get(finding.id))?.lifecycle).toBe('active');
    } finally {
      await fs.chmod(storePath, 0o666);
    }
  });

  it('preserves endpoint and merge-base comparisons on diverged branches, including verify target', async () => {
    await repository.writeFile('base.txt', 'base\n');
    await repository.stage();
    await repository.commit('base');
    await repository.createBranch('feature');
    await repository.writeFile('feature.txt', 'feature\n');
    await repository.stage();
    await repository.commit('feature');
    await repository.checkout('HEAD~1');
    await repository.exec(['checkout', '-b', 'other']);
    await repository.writeFile('other.txt', 'other\n');
    await repository.stage();
    await repository.commit('other');

    const mergeBase = await engine.inspect({ cwd: repository.path, target: 'other...feature' });
    const endpoints = await engine.inspect({ cwd: repository.path, target: 'other..feature' });
    expect(mergeBase.changedFiles.map((file) => file.path)).toEqual(['feature.txt']);
    expect(endpoints.changedFiles.map((file) => file.path).sort()).toEqual(['feature.txt', 'other.txt']);
    const verified = await engine.verify({ cwd: repository.path, target: 'other...feature', config, onlineOnly: true, noCache: true });
    expect(verified.diffSummary.filesChanged).toBe(1);
  });

  it.each(['..', 'main..', '..head', '...', 'main...', '...head', 'main....head', 'a..b..c', 'a...b...c', 'a..b...c'])(
    'rejects an incomplete or ambiguous range %s',
    async (target) => {
      await expect(engine.inspect({ cwd: repository.path, target })).rejects.toThrow(InvalidGitRefError);
    }
  );
});
