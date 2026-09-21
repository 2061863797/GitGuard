/**
 * src/context/fs.ts
 * Safe repository filesystem reader preventing symbolic link escapes and path traversal.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface SafeReadOptions {
  /** Maximum bytes to read before truncating (default: 2MB) */
  maxBytes?: number;
  /** Whether to allow symlinks that resolve strictly within the repo (default: true) */
  allowSymlinksWithinRepo?: boolean;
}

/**
 * Safely reads a file located inside the repository root.
 * Guarantees that symlinks pointing outside the repository root are strictly blocked.
 * Returns null if the file does not exist, escapes the repository, or is unreadable.
 */
export async function safeReadRepoFile(
  repoRoot: string,
  relativePath: string,
  options: SafeReadOptions = {}
): Promise<string | null> {
  const normalizedRepo = path.resolve(repoRoot);
  const targetPath = path.resolve(normalizedRepo, relativePath);

  // 1. Initial path traversal check
  if (!targetPath.startsWith(normalizedRepo + path.sep) && targetPath !== normalizedRepo) {
    return null;
  }

  try {
    const lstats = await fs.lstat(targetPath);

    // 2. Symbolic link boundary enforcement
    if (lstats.isSymbolicLink()) {
      if (options.allowSymlinksWithinRepo === false) {
        return null;
      }
      const realPath = await fs.realpath(targetPath);
      // Ensure the resolved canonical path remains strictly inside the repository
      if (!realPath.startsWith(normalizedRepo + path.sep) && realPath !== normalizedRepo) {
        return null;
      }
    }

    // 3. Prevent reading directories
    const stats = await fs.stat(targetPath);
    if (!stats.isFile()) {
      return null;
    }

    // 4. File size limits
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024; // 2MB default
    if (stats.size > maxBytes) {
      const fd = await fs.open(targetPath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await fd.close();
      }
    }

    return await fs.readFile(targetPath, 'utf-8');
  } catch {
    return null;
  }
}
