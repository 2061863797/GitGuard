import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileFindingStore } from '../../../src/findings/store.js';
import { GitGuardError } from '../../../src/types/errors.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

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
});
