/**
 * src/git/diff-parser.ts
 * Unified diff parser translating raw Git diff text into structured AST models.
 */

import type {
  DiffContext,
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffParser,
} from '../types/diff.js';
import type { FileChangeStatus } from '../types/git.js';

/**
 * Strips Git diff path prefixes (e.g. 'a/' or 'b/') and outer quotes.
 */
function stripPrefix(pathStr: string): string {
  let cleaned = pathStr.trim();
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.substring(1, cleaned.length - 1);
  }
  if (cleaned.startsWith('a/') || cleaned.startsWith('b/')) {
    return cleaned.substring(2);
  }
  return cleaned;
}

/**
 * Unescapes Git octal characters and escaped quotes in paths.
 */
function unescapeGitPath(pathStr: string): string {
  const unescaped = pathStr
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  try {
    return Buffer.from(unescaped, 'binary').toString('utf-8');
  } catch {
    return unescaped;
  }
}

/**
 * Parses file paths from a `diff --git a/... b/...` header line.
 */
function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.substring(prefix.length).trim();

  // Case 1: Quoted paths
  if (rest.startsWith('"')) {
    const secondQuoteIndex = rest.indexOf('"', 1);
    if (secondQuoteIndex !== -1) {
      const firstQuoted = rest.substring(1, secondQuoteIndex);
      const remaining = rest.substring(secondQuoteIndex + 1).trim();
      let secondPath = remaining;
      if (secondPath.startsWith('"') && secondPath.endsWith('"')) {
        secondPath = secondPath.substring(1, secondPath.length - 1);
      }
      return {
        oldPath: unescapeGitPath(stripPrefix(firstQuoted)),
        newPath: unescapeGitPath(stripPrefix(secondPath)),
      };
    }
  }

  // Case 2: Standard space separated with " b/" delimiter
  const splitIdx = rest.lastIndexOf(' b/');
  if (splitIdx !== -1) {
    const p1 = rest.substring(0, splitIdx);
    const p2 = rest.substring(splitIdx + 1);
    return {
      oldPath: unescapeGitPath(stripPrefix(p1)),
      newPath: unescapeGitPath(stripPrefix(p2)),
    };
  }

  // Case 3: Simple whitespace split fallback
  const parts = rest.split(/\s+/);
  if (parts.length >= 2) {
    return {
      oldPath: unescapeGitPath(stripPrefix(parts[0])),
      newPath: unescapeGitPath(stripPrefix(parts[parts.length - 1])),
    };
  }

  return null;
}

/**
 * Converts a DiffHunk's raw lines into structured DiffLine instances with line numbers.
 */
export function parseHunkLines(hunk: DiffHunk): DiffLine[] {
  const lines: DiffLine[] = [];
  let currentOld = hunk.oldStart;
  let currentNew = hunk.newStart;

  for (const line of hunk.lines) {
    if (line.startsWith('+')) {
      lines.push({
        type: 'addition',
        content: line.substring(1),
        newLineNumber: currentNew++,
      });
    } else if (line.startsWith('-')) {
      lines.push({
        type: 'deletion',
        content: line.substring(1),
        oldLineNumber: currentOld++,
      });
    } else if (line.startsWith(' ')) {
      lines.push({
        type: 'context',
        content: line.substring(1),
        oldLineNumber: currentOld++,
        newLineNumber: currentNew++,
      });
    } else if (line.startsWith('\\')) {
      // e.g. \ No newline at end of file
      lines.push({
        type: 'context',
        content: line.substring(1),
      });
    }
  }

  return lines;
}

/**
 * Unified diff parser implementing the DiffParser interface.
 */
export class UnifiedDiffParser implements DiffParser {
  /**
   * Parse a raw unified diff string into a structured DiffContext AST.
   */
  public parse(rawDiff: string): DiffContext {
    if (!rawDiff || typeof rawDiff !== 'string' || rawDiff.trim() === '') {
      return {
        raw: rawDiff || '',
        files: [],
        insertions: 0,
        deletions: 0,
        truncated: false,
        totalFiles: 0,
      };
    }

    const lines = rawDiff.split(/\r?\n/);
    const files: DiffFile[] = [];

    let currentFile: DiffFile | null = null;
    let currentHunk: DiffHunk | null = null;

    const hunkHeaderRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // New file change detected
      if (line.startsWith('diff --git ')) {
        if (currentHunk && currentFile) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }
        if (currentFile) {
          if (currentFile.oldPath === currentFile.newPath) {
            currentFile.oldPath = undefined;
          }
          files.push(currentFile);
        }

        const parsedPaths = parseDiffGitPaths(line);
        const oldPath = parsedPaths?.oldPath;
        const newPath = parsedPaths?.newPath || '';

        currentFile = {
          oldPath: oldPath !== newPath ? oldPath : undefined,
          newPath,
          status: 'modified',
          binary: false,
          hunks: [],
          additions: 0,
          deletions: 0,
        };
        continue;
      }

      if (!currentFile) {
        continue;
      }

      // Detect file status and metadata before hunks
      if (line.startsWith('new file mode ')) {
        currentFile.status = 'added';
        continue;
      }

      if (line.startsWith('deleted file mode ')) {
        currentFile.status = 'deleted';
        continue;
      }

      if (line.startsWith('similarity index ')) {
        currentFile.status = 'renamed';
        continue;
      }

      if (line.startsWith('rename from ')) {
        currentFile.status = 'renamed';
        currentFile.oldPath = unescapeGitPath(stripPrefix(line.substring('rename from '.length)));
        continue;
      }

      if (line.startsWith('rename to ')) {
        currentFile.status = 'renamed';
        currentFile.newPath = unescapeGitPath(stripPrefix(line.substring('rename to '.length)));
        continue;
      }

      if (line.startsWith('copy from ')) {
        currentFile.status = 'copied';
        currentFile.oldPath = unescapeGitPath(stripPrefix(line.substring('copy from '.length)));
        continue;
      }

      if (line.startsWith('copy to ')) {
        currentFile.status = 'copied';
        currentFile.newPath = unescapeGitPath(stripPrefix(line.substring('copy to '.length)));
        continue;
      }

      // Binary file detection
      if (
        line.startsWith('Binary files ') ||
        line.includes('differ') ||
        line.startsWith('GIT binary patch')
      ) {
        currentFile.binary = true;
        if (currentFile.status === 'modified') {
          currentFile.status = 'binary';
        }
        continue;
      }

      // Parse +++ and --- paths if they provide more accurate information
      if (line.startsWith('--- ')) {
        const rawOld = line.substring(4).trim();
        if (rawOld === '/dev/null') {
          currentFile.status = 'added';
        } else {
          const stripped = stripPrefix(rawOld);
          if (stripped && !currentFile.oldPath) {
            currentFile.oldPath = unescapeGitPath(stripped);
          }
        }
        continue;
      }

      if (line.startsWith('+++ ')) {
        const rawNew = line.substring(4).trim();
        if (rawNew === '/dev/null') {
          currentFile.status = 'deleted';
        } else {
          const stripped = stripPrefix(rawNew);
          if (stripped) {
            currentFile.newPath = unescapeGitPath(stripped);
          }
        }
        continue;
      }

      // Hunk header match
      const hunkMatch = line.match(hunkHeaderRegex);
      if (hunkMatch) {
        if (currentHunk) {
          currentFile.hunks.push(currentHunk);
          currentHunk = null;
        }

        try {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldLines = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
          const newStart = parseInt(hunkMatch[3], 10);
          const newLines = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

          currentHunk = {
            oldStart,
            oldLines,
            newStart,
            newLines,
            header: line,
            lines: [],
          };
        } catch {
          // Gracefully skip corrupted hunk header
          currentHunk = null;
        }
        continue;
      }

      // Hunk line content
      if (currentHunk) {
        if (line.startsWith('+')) {
          currentFile.additions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith('-')) {
          currentFile.deletions++;
          currentHunk.lines.push(line);
        } else if (line.startsWith(' ') || line.startsWith('\\')) {
          currentHunk.lines.push(line);
        }
      }
    }

    if (currentHunk && currentFile) {
      currentFile.hunks.push(currentHunk);
    }
    if (currentFile) {
      if (currentFile.oldPath === currentFile.newPath) {
        currentFile.oldPath = undefined;
      }
      files.push(currentFile);
    }

    let insertions = 0;
    let deletions = 0;
    for (const f of files) {
      insertions += f.additions;
      deletions += f.deletions;
    }

    return {
      raw: rawDiff,
      files,
      insertions,
      deletions,
      truncated: false,
      totalFiles: files.length,
    };
  }
}

/**
 * Convenience singleton instance for unified diff parsing.
 */
export const unifiedDiffParser = new UnifiedDiffParser();

/**
 * Convenience helper function to parse raw diff text.
 */
export function parseDiff(rawDiff: string): DiffContext {
  return unifiedDiffParser.parse(rawDiff);
}
