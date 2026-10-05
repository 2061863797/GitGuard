import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileFindingStore } from '../../../src/findings/store.js';
import { GitGuardError } from '../../../src/types/errors.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import type { Finding } from '../../../src/types/finding.js';

vi.mock('node:fs/promises', { spy: true });

describe('FileFindingStore corruption handling', () => {
  let fixture: GitFixture;
  let store: FileFindingStore;
  let storePath: string;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    store = new FileFindingStore(fixture.repoPath);
    storePath = path.join(fixture.repoPath, '.git', 'gitguard', 'findings.json');
    await fs.mkdir(path.dirname(storePath), { recursive: true });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it.each(['{invalid json', '{"findings":[]}'])(
    'preserves invalid persisted findings on attempted save: %s',
    async (corruptContent) => {
      await fs.writeFile(storePath, corruptContent, 'utf8');
      await expect(store.save([])).rejects.toThrow(GitGuardError);
      expect(await fs.readFile(storePath, 'utf8')).toBe(corruptContent);
      await expect(store.list()).rejects.toThrow(GitGuardError);
    }
  );

  it('reports failed atomic replacement, preserves existing records and removes its temporary file', async () => {
    await fs.writeFile(storePath, '[]', 'utf8');
    const finding: Finding = {
      id: 'test-write-failure', ruleId: 'test', source: 'deterministic', status: 'warn',
      severity: 'LOW', lifecycle: 'active', affectedFiles: [], message: 'Synthetic finding',
      evidence: [], expectedEvidence: [], fingerprint: 'test', createdAt: new Date().toISOString(),
    };
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('Synthetic write denial'), { code: 'EPERM' }));
    await expect(store.save([finding])).rejects.toMatchObject({ code: 'FINDING_STORE_WRITE_ERROR' });
    expect(await fs.readFile(storePath, 'utf8')).toBe('[]');
    expect((await fs.readdir(path.dirname(storePath))).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['EACCES', 'EROFS', 'EPERM'])('refuses unlocked writes after lock acquisition fails with %s', async (code) => {
    await fs.writeFile(storePath, '[]', 'utf8');
    vi.mocked(fs.open).mockRejectedValueOnce(Object.assign(new Error('Synthetic lock denial'), { code }));
    await expect(store.save([])).rejects.toMatchObject({ code: 'FINDING_STORE_LOCK_ERROR' });
    expect(await fs.readFile(storePath, 'utf8')).toBe('[]');
  });
});
