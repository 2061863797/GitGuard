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
import { findNearestGitRoot, resolveGitDir } from '../findings/store.js';

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
    const resolvedRoot = findNearestGitRoot(repoRoot);
    const gitDir = resolveGitDir(resolvedRoot);
    this.cacheDir = path.join(gitDir, 'gitguard', 'cache');
    this.enabled = enabled;
  }

  /**
   * Generates a stable SHA-256 cache key based on diff, task, model, questions, and extra context.
   */
  public computeKey(
    rawDiff: string,
    task: string,
    model: string,
    questionIds: string[],
    extraContext?: {
      instructionsFingerprint?: string;
      contextFingerprint?: string;
      questionsFingerprint?: string;
    }
  ): string {
    const sortedQuestions = [...questionIds].sort().join(',');
    const extra = extraContext
      ? `|extra:${extraContext.instructionsFingerprint || ''}:${extraContext.contextFingerprint || ''}:${extraContext.questionsFingerprint || ''}`
      : '';
    const content = `diff:${rawDiff}|task:${task}|model:${model}|questions:${sortedQuestions}${extra}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Retrieves cached decisions if available, valid, and not expired.
   */
  public async get(key: string, maxTtlMs?: number): Promise<SemanticDecision[] | null> {
    if (!this.enabled) return null;

    try {
      const filePath = path.join(this.cacheDir, `${key}.json`);
      const data = await fs.readFile(filePath, 'utf8');
      const entry = JSON.parse(data) as SemanticCacheEntry;
      if (!entry || !Array.isArray(entry.decisions)) {
        return null;
      }

      // If model is a dynamic 'latest' alias, enforce TTL (default 24h)
      const isDynamicModel = entry.model?.includes('latest') ?? false;
      const effectiveTtlMs = maxTtlMs ?? (isDynamicModel ? 24 * 60 * 60 * 1000 : Infinity);

      if (effectiveTtlMs < Infinity && entry.createdAt) {
        const ageMs = Date.now() - new Date(entry.createdAt).getTime();
        if (ageMs > effectiveTtlMs) {
          return null; // Expired entry
        }
      }

      return entry.decisions;
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
