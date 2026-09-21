/**
 * src/findings/store.ts
 * Repository-level persistent storage for GitGuard structured findings.
 * Stores findings inside `<repoRoot>/.git/gitguard/findings.json` to survive
 * CLI execution lifecycles without polluting the git working tree.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import type { Finding, FindingFilter } from '../types/finding.js';

/**
 * Finds nearest ancestor directory containing a .git directory or file.
 */
export function findNearestGitRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (fsSync.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

/**
 * Resolves the actual git storage directory, supporting worktrees and submodules where .git is a pointer file.
 */
export function resolveGitDir(repoRoot: string): string {
  const gitPath = path.join(repoRoot, '.git');
  try {
    const stat = fsSync.statSync(gitPath);
    if (stat.isDirectory()) {
      return gitPath;
    }
    if (stat.isFile()) {
      const content = fsSync.readFileSync(gitPath, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const rawTarget = match[1].trim();
        return path.isAbsolute(rawTarget)
          ? rawTarget
          : path.resolve(repoRoot, rawTarget);
      }
    }
  } catch {
    // ignore
  }
  return gitPath;
}

/**
 * Finding persistence interface.
 */
export interface FindingStore {
  get(id: string): Promise<Finding | undefined>;
  list(filter?: FindingFilter): Promise<Finding[]>;
  save(findings: Finding[]): Promise<void>;
  upsert(finding: Finding): Promise<void>;
  resolve(id: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * In-memory finding store implementation for isolated unit tests.
 */
export class MemoryFindingStore implements FindingStore {
  private store: Map<string, Finding> = new Map();

  constructor(initialFindings?: Finding[]) {
    if (initialFindings) {
      for (const f of initialFindings) {
        this.store.set(f.id, f);
      }
    }
  }

  public async get(id: string): Promise<Finding | undefined> {
    return this.store.get(id);
  }

  public async list(filter?: FindingFilter): Promise<Finding[]> {
    let items = Array.from(this.store.values());
    if (!filter) return items;

    if (filter.lifecycle) {
      items = items.filter((f) => f.lifecycle === filter.lifecycle);
    }
    if (filter.source) {
      items = items.filter((f) => f.source === filter.source);
    }
    if (filter.status) {
      items = items.filter((f) => f.status.toLowerCase() === filter.status?.toLowerCase());
    }
    if (filter.severity) {
      items = items.filter((f) => f.severity.toLowerCase() === filter.severity?.toLowerCase());
    }
    if (filter.ruleId) {
      items = items.filter((f) => f.ruleId === filter.ruleId);
    }
    if (filter.file) {
      items = items.filter((f) => f.affectedFiles?.includes(filter.file!));
    }
    return items;
  }

  public async save(findings: Finding[]): Promise<void> {
    for (const f of findings) {
      this.store.set(f.id, f);
    }
  }

  public async upsert(finding: Finding): Promise<void> {
    this.store.set(finding.id, finding);
  }

  public async resolve(id: string): Promise<void> {
    const item = this.store.get(id);
    if (item) {
      item.lifecycle = 'resolved';
      item.resolvedAt = new Date().toISOString();
      this.store.set(id, item);
    }
  }

  public async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * File-based persistent finding store writing to .git/gitguard/findings.json.
 */
export class FileFindingStore implements FindingStore {
  private storePath: string;
  private lockPath: string;
  private memoryFallback: MemoryFindingStore;
  private mutexQueue: Promise<void> = Promise.resolve();

  constructor(repoRoot: string = process.cwd()) {
    const resolvedRoot = findNearestGitRoot(repoRoot);
    const gitDir = resolveGitDir(resolvedRoot);
    const gitguardDir = path.join(gitDir, 'gitguard');
    this.storePath = path.join(gitguardDir, 'findings.json');
    this.lockPath = path.join(gitguardDir, 'findings.lock');
    this.memoryFallback = new MemoryFindingStore();
  }

  /**
   * Acquires cross-process atomic file lock using O_CREAT | O_EXCL ('wx').
   * Recovers automatically from stale locks (> 10s).
   */
  private async acquireFileLock(timeoutMs = 10000): Promise<(() => Promise<void>) | null> {
    const start = Date.now();
    const dir = path.dirname(this.lockPath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      return null;
    }

    while (Date.now() - start < timeoutMs) {
      try {
        const handle = await fs.open(this.lockPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, time: Date.now() }), 'utf8');
        } finally {
          await handle.close();
        }
        return async () => {
          try {
            await fs.unlink(this.lockPath);
          } catch {
            // ignore
          }
        };
      } catch (err: any) {
        if (err?.code === 'EEXIST') {
          try {
            const stat = await fs.stat(this.lockPath);
            if (Date.now() - stat.mtimeMs > 10000) {
              await fs.unlink(this.lockPath).catch(() => {});
            }
          } catch {
            // lock file may have been unlinked in between
          }
          const jitter = Math.floor(Math.random() * 50) + 50;
          await new Promise((r) => setTimeout(r, jitter));
        } else {
          return null;
        }
      }
    }
    return null;
  }

  private async withLock<T>(op: () => Promise<T>): Promise<T> {
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => { release = resolve; });
    const prevLock = this.mutexQueue;
    this.mutexQueue = prevLock.then(() => nextLock);
    await prevLock;
    let releaseFileLock: (() => Promise<void>) | null = null;
    try {
      releaseFileLock = await this.acquireFileLock();
      return await op();
    } finally {
      if (releaseFileLock) {
        await releaseFileLock();
      }
      release!();
    }
  }

  /**
   * Reads raw findings from the JSON file.
   */
  private async readAll(): Promise<Map<string, Finding>> {
    try {
      const content = await fs.readFile(this.storePath, 'utf8');
      const data = JSON.parse(content) as Finding[];
      const map = new Map<string, Finding>();
      if (Array.isArray(data)) {
        for (const item of data) {
          map.set(item.id, item);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Atomically writes all findings to the JSON file.
   */
  private async writeAll(map: Map<string, Finding>): Promise<void> {
    try {
      const dir = path.dirname(this.storePath);
      await fs.mkdir(dir, { recursive: true });
      const serialized = JSON.stringify(Array.from(map.values()), null, 2);
      const tmpPath = `${this.storePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, serialized, 'utf8');
      try {
        await fs.rename(tmpPath, this.storePath);
      } catch {
        // Fallback for filesystem locking or cross-device rename
        await fs.writeFile(this.storePath, serialized, 'utf8');
        await fs.unlink(tmpPath).catch(() => {});
      }
    } catch {
      // If .git is unwritable (e.g. read-only env or unborn sandbox), keep in memory fallback
      for (const f of map.values()) {
        await this.memoryFallback.upsert(f);
      }
    }
  }

  public async get(id: string): Promise<Finding | undefined> {
    const map = await this.readAll();
    return map.get(id) ?? this.memoryFallback.get(id);
  }

  public async list(filter?: FindingFilter): Promise<Finding[]> {
    const map = await this.readAll();
    let items = Array.from(map.values());
    if (items.length === 0) {
      items = await this.memoryFallback.list(filter);
    }

    if (!filter) return items;

    if (filter.lifecycle) {
      items = items.filter((f) => f.lifecycle === filter.lifecycle);
    }
    if (filter.source) {
      items = items.filter((f) => f.source === filter.source);
    }
    if (filter.status) {
      items = items.filter((f) => f.status.toLowerCase() === filter.status?.toLowerCase());
    }
    if (filter.severity) {
      items = items.filter((f) => f.severity.toLowerCase() === filter.severity?.toLowerCase());
    }
    if (filter.ruleId) {
      items = items.filter((f) => f.ruleId === filter.ruleId);
    }
    if (filter.file) {
      items = items.filter((f) => f.affectedFiles?.includes(filter.file!));
    }
    return items;
  }

  public async save(findings: Finding[]): Promise<void> {
    return this.withLock(async () => {
      const map = await this.readAll();
      for (const f of findings) {
        map.set(f.id, f);
      }
      await this.writeAll(map);
    });
  }

  public async upsert(finding: Finding): Promise<void> {
    return this.withLock(async () => {
      const map = await this.readAll();
      map.set(finding.id, finding);
      await this.writeAll(map);
    });
  }

  public async resolve(id: string): Promise<void> {
    return this.withLock(async () => {
      const map = await this.readAll();
      const item = map.get(id);
      if (item) {
        item.lifecycle = 'resolved';
        item.resolvedAt = new Date().toISOString();
        map.set(id, item);
        await this.writeAll(map);
      }
      await this.memoryFallback.resolve(id);
    });
  }

  public async clear(): Promise<void> {
    return this.withLock(async () => {
      const map = new Map<string, Finding>();
      await this.writeAll(map);
      await this.memoryFallback.clear();
    });
  }
}
