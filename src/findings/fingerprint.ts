/**
 * src/findings/fingerprint.ts
 * Content-addressable SHA256 fingerprint generation for GitGuard findings.
 * Invariant to diff line number drift and formatting differences.
 */

import * as crypto from 'node:crypto';
import type { FindingFingerprintInput } from '../types/finding.js';
import type { DiffFile } from '../types/diff.js';

/**
 * Normalizes diff hunks by stripping line coordinates (@@ -12,4 +12,6 @@ headers),
 * trimming trailing whitespace on lines, and standardizing line breaks.
 * This guarantees that line drifts caused by edits elsewhere do not change the fingerprint.
 */
export function normalizeHunk(hunkText?: string): string {
  if (!hunkText || typeof hunkText !== 'string') {
    return '';
  }

  const lines = hunkText
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('@@'))
    .map((line) => line.trimEnd());

  // Trim leading empty lines
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }

  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Normalizes a list of file paths by converting backslashes to forward slashes,
 * deduplicating entries, and sorting alphabetically.
 */
export function normalizeAffectedFiles(files?: string[]): string[] {
  if (!files || !Array.isArray(files)) {
    return [];
  }

  const normalizedSet = new Set(
    files
      .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      .map((f) => f.replace(/\\/g, '/').trim())
  );

  return Array.from(normalizedSet).sort();
}

/**
 * Extracts raw hunk text from DiffFile structures matching affected file paths.
 */
export function extractHunksForFiles(affectedFiles: string[], diffFiles?: DiffFile[]): string {
  if (!diffFiles || diffFiles.length === 0 || !affectedFiles || affectedFiles.length === 0) {
    return '';
  }

  const normalizedAffected = new Set(normalizeAffectedFiles(affectedFiles));
  const hunkParts: string[] = [];

  // Sort files for deterministic ordering
  const sortedDiffFiles = [...diffFiles].sort((a, b) => (a.newPath || '').localeCompare(b.newPath || ''));

  for (const file of sortedDiffFiles) {
    const newP = (file.newPath || '').replace(/\\/g, '/');
    const oldP = (file.oldPath || '').replace(/\\/g, '/');

    if (normalizedAffected.has(newP) || normalizedAffected.has(oldP)) {
      if (file.hunks && Array.isArray(file.hunks)) {
        for (const hunk of file.hunks) {
          if (hunk.lines && Array.isArray(hunk.lines)) {
            hunkParts.push(hunk.lines.join('\n'));
          }
        }
      }
    }
  }

  return hunkParts.join('\n');
}

/**
 * Computes a stable, content-addressable SHA256 fingerprint for a finding.
 * Format: SHA256(ruleId + ":" + files.sort().join(",") + ":" + normalizedHunk)
 */
export function computeFindingFingerprint(
  ruleIdOrInput: string | FindingFingerprintInput,
  affectedFiles?: string[],
  normalizedDiffHunks?: string
): string {
  let ruleId: string;
  let files: string[];
  let hunks: string;

  if (typeof ruleIdOrInput === 'object' && ruleIdOrInput !== null) {
    ruleId = ruleIdOrInput.ruleId || '';
    files = normalizeAffectedFiles(ruleIdOrInput.affectedFiles);
    hunks = normalizeHunk(ruleIdOrInput.normalizedDiffHunks);
  } else {
    ruleId = ruleIdOrInput || '';
    files = normalizeAffectedFiles(affectedFiles);
    hunks = normalizeHunk(normalizedDiffHunks);
  }

  const sortedFilesStr = files.join(',');
  const rawPayload = `${ruleId}:${sortedFilesStr}:${hunks}`;

  return crypto.createHash('sha256').update(rawPayload, 'utf8').digest('hex');
}
