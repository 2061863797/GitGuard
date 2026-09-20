/**
 * src/cache/semantic-cache.ts
 * Diff-hash based semantic evaluation cache for GitGuard.
 * Stores semantic decisions inside `.git/gitguard/cache/` to accelerate
 * repeat checks when diff and task intent remain unchanged.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SemanticDecision } from '../types/provider.js';

export interface SemanticCacheEntry {
  cacheKey: string;
  createdAt: string;
  provider: string;
  model: string;
  decisions: SemanticDecision[];
}

export class SemanticCache {
  private cacheDir: string;
  private enabled: boolean;

  constructor(repoRoot: string = process.cwd(), enabled = true) {
    this.cacheDir = path.join(repoRoot, '.git', 'gitguard', 'cache');
    this.enabled = enabled;
  }

  /**
   * Generates a stable SHA-256 cache key based on diff, task, model, and questions.
   */
  public computeKey(
    rawDiff: string,
    task: string,
    model: string,
    questionIds: string[]
  ): string {
    const sortedQuestions = [...questionIds].sort().join(',');
    const content = `diff:${rawDiff}|task:${task}|model:${model}|questions:${sortedQuestions}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Retrieves cached decisions if available and valid.
   */
  public async get(key: string): Promise<SemanticDecision[] | null> {
    if (!this.enabled) return null;

    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      const data = await fs.readFile(filePath, 'utf8');
      const entry = JSON.parse(data) as SemanticCacheEntry;
      if (entry && Array.isArray(entry.decisions)) {
        return entry.decisions;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Writes semantic decisions to the cache.
   */
  public async set(
    key: string,
    provider: string,
    model: string,
    decisions: SemanticDecision[]
  ): Promise<void> {
    if (!this.enabled) return;

    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      const entry: SemanticCacheEntry = {
        cacheKey: key,
        createdAt: new Date().toISOString(),
        provider,
        model,
        decisions,
      };
      const filePath = path.join(this.cacheDir, `${key}.json`);
      await fs.writeFile(filePath, JSON.stringify(entry, null, 2), 'utf8');
    } catch {
      // Ignore cache write errors in unprivileged environments
    }
  }

  /**
   * Clears all cached semantic evaluations.
   */
  public async clear(): Promise<void> {
    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}
