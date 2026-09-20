/**
 * src/findings/store.ts
 * Repository-level persistent storage for GitGuard structured findings.
 * Stores findings inside `<repoRoot>/.git/gitguard/findings.json` to survive
 * CLI execution lifecycles without polluting the git working tree.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Finding, FindingFilter } from '../types/finding.js';

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
  private memoryFallback: MemoryFindingStore;

  constructor(repoRoot: string = process.cwd()) {
    this.storePath = path.join(repoRoot, '.git', 'gitguard', 'findings.json');
    this.memoryFallback = new MemoryFindingStore();
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
      await fs.writeFile(this.storePath, serialized, 'utf8');
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
    const map = await this.readAll();
    for (const f of findings) {
      map.set(f.id, f);
    }
    await this.writeAll(map);
  }

  public async upsert(finding: Finding): Promise<void> {
    const map = await this.readAll();
    map.set(finding.id, finding);
    await this.writeAll(map);
  }

  public async resolve(id: string): Promise<void> {
    const map = await this.readAll();
    const item = map.get(id);
    if (item) {
      item.lifecycle = 'resolved';
      item.resolvedAt = new Date().toISOString();
      map.set(id, item);
      await this.writeAll(map);
    }
    await this.memoryFallback.resolve(id);
  }

  public async clear(): Promise<void> {
    const map = new Map<string, Finding>();
    await this.writeAll(map);
    await this.memoryFallback.clear();
  }
}
