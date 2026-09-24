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
 * Guarantees that symlinks pointing outside the repository root are strictly blocked,
 * including symlinks in intermediate directories (e.g. `linkdir/passwd` where
 * `linkdir` is a symlink escaping the repo).
 * Returns null if the file does not exist, escapes the repository, or is unreadable.
 */
export async function safeReadRepoFile(
  repoRoot: string,
  relativePath: string,
  options: SafeReadOptions = {}
): Promise<string | null> {
  try {
    // Canonicalize the repo root first so the containment check below is sound
    // on platforms where temp/system directories themselves contain symlinks
    // (e.g. /tmp -> /private/tmp on macOS).
    const normalizedRepo = await fs.realpath(path.resolve(repoRoot));
    const targetPath = path.resolve(normalizedRepo, relativePath);

    // 1. Initial lexical path traversal check (before resolving symlinks)
    if (!targetPath.startsWith(normalizedRepo + path.sep) && targetPath !== normalizedRepo) {
      return null;
    }

    // 2. Resolve ALL symlinks (final component AND intermediate directories) and
    //    enforce that the canonical path remains strictly inside the repository.
    //    NOTE: realpath + read is not atomic; an actor with concurrent write
    //    access to the repo could theoretically swap a symlink between the
    //    check and the read (TOCTOU). This residual risk is accepted: anyone
    //    with write access can already influence the gate more directly.
    const realPath = await fs.realpath(targetPath);
    if (!realPath.startsWith(normalizedRepo + path.sep) && realPath !== normalizedRepo) {
      return null;
    }

    if (options.allowSymlinksWithinRepo === false && realPath !== targetPath) {
      return null;
    }

    // 3. Prevent reading directories
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) {
      return null;
    }

    // 4. File size limits
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024; // 2MB default
    if (stats.size > maxBytes) {
      const fd = await fs.open(realPath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await fd.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await fd.close();
      }
    }

    return await fs.readFile(realPath, 'utf-8');
  } catch {
    return null;
  }
}
