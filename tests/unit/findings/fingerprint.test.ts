import { describe, it, expect } from 'vitest';
import {
  normalizeHunk,
  normalizeAffectedFiles,
  extractHunksForFiles,
  computeFindingFingerprint,
} from '../../../src/findings/fingerprint.js';
import type { DiffFile } from '../../../src/types/diff.js';
import type { FindingFingerprintInput } from '../../../src/types/finding.js';

describe('Finding Fingerprint System', () => {
  describe('normalizeHunk', () => {
    it('should strip diff coordinate headers (@@ ... @@)', () => {
      const hunk = `@@ -10,5 +10,6 @@ function authenticate()
 const user = getUser();
+const token = generateToken(user);
 return token;`;

      const normalized = normalizeHunk(hunk);
      expect(normalized).not.toContain('@@');
      expect(normalized).toContain('const user = getUser();');
      expect(normalized).toContain('+const token = generateToken(user);');
      expect(normalized).toContain('return token;');
    });

    it('should trim trailing whitespace on lines and overall leading/trailing blanks', () => {
      const hunk = `
@@ -1,3 +1,3 @@   
  line1    
+ line2 \t  
  line3   
`;
      const normalized = normalizeHunk(hunk);
      const lines = normalized.split('\n');
      for (const line of lines) {
        expect(line).toBe(line.trimEnd());
      }
      expect(normalized.startsWith('line1')).toBe(false); // leading space preserved
      expect(lines[0]).toBe('  line1');
      expect(lines[1]).toBe('+ line2');
      expect(lines[2]).toBe('  line3');
    });

    it('should handle Windows CRLF line endings identically to Unix LF', () => {
      const unixHunk = '@@ -1,2 +1,2 @@\n-oldLine\n+newLine';
      const windowsHunk = '@@ -1,2 +1,2 @@\r\n-oldLine\r\n+newLine';

      expect(normalizeHunk(unixHunk)).toBe(normalizeHunk(windowsHunk));
    });

    it('should return empty string on undefined, null, or empty string', () => {
      expect(normalizeHunk('')).toBe('');
      expect(normalizeHunk(undefined as any)).toBe('');
      expect(normalizeHunk(null as any)).toBe('');
      expect(normalizeHunk(123 as any)).toBe('');
    });

    it('should strip multiple @@ headers within unified hunks', () => {
      const multiHunk = `@@ -10,3 +10,4 @@
+addedLine1
@@ -50,3 +51,4 @@
+addedLine2`;

      const normalized = normalizeHunk(multiHunk);
      expect(normalized).toBe('+addedLine1\n+addedLine2');
    });
  });

  describe('normalizeAffectedFiles', () => {
    it('should convert Windows backslashes to forward slashes', () => {
      const files = ['src\\auth\\token.ts', 'src\\utils\\crypto.ts'];
      const normalized = normalizeAffectedFiles(files);
      expect(normalized).toEqual(['src/auth/token.ts', 'src/utils/crypto.ts']);
    });

    it('should deduplicate and sort file paths alphabetically', () => {
      const files = ['b.ts', 'a.ts', 'b.ts', 'c.ts', 'a.ts'];
      const normalized = normalizeAffectedFiles(files);
      expect(normalized).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });

    it('should filter out empty strings and whitespace-only entries', () => {
      const files = ['a.ts', '', '  ', 'b.ts'];
      const normalized = normalizeAffectedFiles(files);
      expect(normalized).toEqual(['a.ts', 'b.ts']);
    });

    it('should handle non-array or empty inputs cleanly', () => {
      expect(normalizeAffectedFiles([])).toEqual([]);
      expect(normalizeAffectedFiles(undefined)).toEqual([]);
      expect(normalizeAffectedFiles(null as any)).toEqual([]);
    });
  });

  describe('extractHunksForFiles', () => {
    const diffFiles: DiffFile[] = [
      {
        newPath: 'src/auth/jwt.ts',
        status: 'modified',
        binary: false,
        additions: 2,
        deletions: 1,
        hunks: [
          {
            oldStart: 10,
            oldLines: 3,
            newStart: 10,
            newLines: 4,
            header: '@@ -10,3 +10,4 @@',
            lines: ['-oldCode', '+newCode1', '+newCode2'],
          },
        ],
      },
      {
        newPath: 'src/billing/payment.ts',
        status: 'modified',
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            oldStart: 5,
            oldLines: 2,
            newStart: 5,
            newLines: 3,
            header: '@@ -5,2 +5,3 @@',
            lines: [' constant', '+addedFee'],
          },
        ],
      },
    ];

    it('should extract hunks for matching affected files', () => {
      const hunks = extractHunksForFiles(['src/auth/jwt.ts'], diffFiles);
      expect(hunks).toContain('-oldCode');
      expect(hunks).toContain('+newCode1');
      expect(hunks).not.toContain('+addedFee');
    });

    it('should extract hunks matching oldPath on renamed files', () => {
      const renamedFiles: DiffFile[] = [
        {
          oldPath: 'old/auth.ts',
          newPath: 'new/auth.ts',
          status: 'renamed',
          binary: false,
          additions: 1,
          deletions: 0,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 2,
              header: '@@ -1,1 +1,2 @@',
              lines: ['-old', '+new'],
            },
          ],
        },
      ];

      const hunks = extractHunksForFiles(['old/auth.ts'], renamedFiles);
      expect(hunks).toContain('+new');
    });

    it('should return empty string when no files match or inputs are empty', () => {
      expect(extractHunksForFiles(['nonexistent.ts'], diffFiles)).toBe('');
      expect(extractHunksForFiles([], diffFiles)).toBe('');
      expect(extractHunksForFiles(['src/auth/jwt.ts'], [])).toBe('');
      expect(extractHunksForFiles(['src/auth/jwt.ts'], undefined)).toBe('');
    });
  });

  describe('computeFindingFingerprint', () => {
    it('should produce a valid 64-character SHA256 hexadecimal string', () => {
      const fp = computeFindingFingerprint('tests_required', ['src/index.ts'], '+console.log("hello");');
      expect(fp).toHaveLength(64);
      expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should remain invariant across line number coordinate drift', () => {
      const hunkAtLine10 = `@@ -10,4 +10,5 @@
 const x = 1;
+const y = 2;
 return x;`;

      const hunkAtLine250 = `@@ -250,4 +250,5 @@
 const x = 1;
+const y = 2;
 return x;`;

      const fp1 = computeFindingFingerprint('rule_a', ['src/service.ts'], hunkAtLine10);
      const fp2 = computeFindingFingerprint('rule_a', ['src/service.ts'], hunkAtLine250);

      expect(fp1).toBe(fp2);
    });

    it('should remain invariant across file path ordering', () => {
      const fp1 = computeFindingFingerprint('rule_a', ['b.ts', 'a.ts'], 'diff');
      const fp2 = computeFindingFingerprint('rule_a', ['a.ts', 'b.ts'], 'diff');

      expect(fp1).toBe(fp2);
    });

    it('should remain invariant across Windows and POSIX path separators', () => {
      const fpWindows = computeFindingFingerprint('rule_a', ['src\\auth\\token.ts'], 'diff');
      const fpPosix = computeFindingFingerprint('rule_a', ['src/auth/token.ts'], 'diff');

      expect(fpWindows).toBe(fpPosix);
    });

    it('should remain invariant across trailing whitespace on diff lines', () => {
      const hunkNormal = ' const x = 1;\n+const y = 2;';
      const hunkWithTrailingSpaces = ' const x = 1;   \n+const y = 2; \t ';

      const fp1 = computeFindingFingerprint('rule_a', ['src/x.ts'], hunkNormal);
      const fp2 = computeFindingFingerprint('rule_a', ['src/x.ts'], hunkWithTrailingSpaces);

      expect(fp1).toBe(fp2);
    });

    it('should be sensitive to ruleId changes', () => {
      const fp1 = computeFindingFingerprint('rule_one', ['src/a.ts'], 'diff');
      const fp2 = computeFindingFingerprint('rule_two', ['src/a.ts'], 'diff');

      expect(fp1).not.toBe(fp2);
    });

    it('should be sensitive to hunk content changes', () => {
      const fp1 = computeFindingFingerprint('rule_a', ['src/a.ts'], '+const x = 1;');
      const fp2 = computeFindingFingerprint('rule_a', ['src/a.ts'], '+const x = 2;');

      expect(fp1).not.toBe(fp2);
    });

    it('should be sensitive to affected files changes', () => {
      const fp1 = computeFindingFingerprint('rule_a', ['src/a.ts'], 'diff');
      const fp2 = computeFindingFingerprint('rule_a', ['src/a.ts', 'src/b.ts'], 'diff');

      expect(fp1).not.toBe(fp2);
    });

    it('should accept FindingFingerprintInput object directly', () => {
      const input: FindingFingerprintInput = {
        ruleId: 'custom_rule',
        affectedFiles: ['src/main.ts'],
        normalizedDiffHunks: '+let count = 0;',
      };

      const fp = computeFindingFingerprint(input);
      const expected = computeFindingFingerprint('custom_rule', ['src/main.ts'], '+let count = 0;');

      expect(fp).toBe(expected);
    });

    it('should handle empty files and empty diff hunk gracefully', () => {
      const fp = computeFindingFingerprint('rule_empty', [], '');
      expect(fp).toHaveLength(64);
    });
  });
});
