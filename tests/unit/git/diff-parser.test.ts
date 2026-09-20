/**
 * tests/unit/git/diff-parser.test.ts
 * Unit tests for UnifiedDiffParser and hunk AST generation.
 */

import { describe, it, expect } from 'vitest';
import {
  UnifiedDiffParser,
  parseDiff,
  parseHunkLines,
} from '../../../src/git/diff-parser.js';

describe('UnifiedDiffParser', () => {
  const parser = new UnifiedDiffParser();

  it('should handle empty or whitespace diffs cleanly', () => {
    const emptyResult = parser.parse('');
    expect(emptyResult.files).toEqual([]);
    expect(emptyResult.insertions).toBe(0);
    expect(emptyResult.deletions).toBe(0);
    expect(emptyResult.truncated).toBe(false);

    const whitespaceResult = parseDiff('   \n\n  \t ');
    expect(whitespaceResult.files).toEqual([]);
  });

  it('should parse a standard single file modification diff', () => {
    const rawDiff = `diff --git a/src/index.ts b/src/index.ts
index 1234567..89abcde 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -10,4 +10,5 @@ function test() {
   const a = 1;
-  const b = 2;
+  const b = 3;
+  const c = 4;
   return a + b;
 }`;

    const result = parser.parse(rawDiff);
    expect(result.files).toHaveLength(1);
    expect(result.insertions).toBe(2);
    expect(result.deletions).toBe(1);

    const file = result.files[0];
    expect(file.newPath).toBe('src/index.ts');
    expect(file.oldPath).toBeUndefined();
    expect(file.status).toBe('modified');
    expect(file.binary).toBe(false);
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    expect(hunk.oldStart).toBe(10);
    expect(hunk.oldLines).toBe(4);
    expect(hunk.newStart).toBe(10);
    expect(hunk.newLines).toBe(5);

    // Verify structured hunk lines
    const diffLines = parseHunkLines(hunk);
    expect(diffLines).toHaveLength(6);
    expect(diffLines[0]).toEqual({
      type: 'context',
      content: '  const a = 1;',
      oldLineNumber: 10,
      newLineNumber: 10,
    });
    expect(diffLines[1]).toEqual({
      type: 'deletion',
      content: '  const b = 2;',
      oldLineNumber: 11,
      newLineNumber: undefined,
    });
    expect(diffLines[2]).toEqual({
      type: 'addition',
      content: '  const b = 3;',
      oldLineNumber: undefined,
      newLineNumber: 11,
    });
    expect(diffLines[3]).toEqual({
      type: 'addition',
      content: '  const c = 4;',
      oldLineNumber: undefined,
      newLineNumber: 12,
    });
  });

  it('should parse an added new file diff', () => {
    const rawDiff = `diff --git a/new-file.ts b/new-file.ts
new file mode 100644
index 0000000..abcdef1
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,3 @@
+export const HELLO = 'world';
+export const FOO = 123;
+export default HELLO;`;

    const result = parser.parse(rawDiff);
    expect(result.files).toHaveLength(1);
    expect(result.insertions).toBe(3);
    expect(result.deletions).toBe(0);

    const file = result.files[0];
    expect(file.newPath).toBe('new-file.ts');
    expect(file.status).toBe('added');
    expect(file.binary).toBe(false);
    expect(file.additions).toBe(3);
    expect(file.deletions).toBe(0);
  });

  it('should parse a deleted file diff', () => {
    const rawDiff = `diff --git a/obsolete.ts b/obsolete.ts
deleted file mode 100644
index abcdef1..0000000
--- a/obsolete.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const oldCode = true;
-export default oldCode;`;

    const result = parser.parse(rawDiff);
    expect(result.files).toHaveLength(1);
    expect(result.insertions).toBe(0);
    expect(result.deletions).toBe(2);

    const file = result.files[0];
    expect(file.newPath).toBe('obsolete.ts');
    expect(file.status).toBe('deleted');
    expect(file.binary).toBe(false);
  });

  it('should parse renamed file with and without modifications', () => {
    const pureRenameDiff = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts`;

    const result1 = parser.parse(pureRenameDiff);
    expect(result1.files).toHaveLength(1);
    const file1 = result1.files[0];
    expect(file1.status).toBe('renamed');
    expect(file1.oldPath).toBe('src/old-name.ts');
    expect(file1.newPath).toBe('src/new-name.ts');
    expect(file1.additions).toBe(0);
    expect(file1.deletions).toBe(0);

    const renameWithModDiff = `diff --git a/old.ts b/new.ts
similarity index 85%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1,3 +1,4 @@
 line 1
-line 2
+modified line 2
+extra line 3
 line 4`;

    const result2 = parser.parse(renameWithModDiff);
    expect(result2.files).toHaveLength(1);
    const file2 = result2.files[0];
    expect(file2.status).toBe('renamed');
    expect(file2.oldPath).toBe('old.ts');
    expect(file2.newPath).toBe('new.ts');
    expect(file2.additions).toBe(2);
    expect(file2.deletions).toBe(1);
  });

  it('should identify binary file modifications without corrupting hunks', () => {
    const binaryDiff = `diff --git a/assets/logo.png b/assets/logo.png
new file mode 100644
index 0000000..abcdef1
Binary files /dev/null and b/assets/logo.png differ
diff --git a/assets/icon.ico b/assets/icon.ico
index 1234567..89abcde 100644
Binary files a/assets/icon.ico and b/assets/icon.ico differ`;

    const result = parser.parse(binaryDiff);
    expect(result.files).toHaveLength(2);

    const file1 = result.files[0];
    expect(file1.newPath).toBe('assets/logo.png');
    expect(file1.binary).toBe(true);
    expect(file1.hunks).toHaveLength(0);

    const file2 = result.files[1];
    expect(file2.newPath).toBe('assets/icon.ico');
    expect(file2.binary).toBe(true);
    expect(file2.hunks).toHaveLength(0);
  });

  it('should handle quoted paths with spaces', () => {
    const quotedDiff = `diff --git "a/path with spaces/file a.ts" "b/path with spaces/file a.ts"
index 1234567..89abcde 100644
--- "a/path with spaces/file a.ts"
+++ "b/path with spaces/file a.ts"
@@ -1,2 +1,2 @@
-old line
+new line`;

    const result = parser.parse(quotedDiff);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].newPath).toBe('path with spaces/file a.ts');
    expect(result.files[0].additions).toBe(1);
    expect(result.files[0].deletions).toBe(1);
  });

  it('should aggregate statistics accurately across multiple files and hunks', () => {
    const multiDiff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 ctx 1
+add 1
 ctx 2
@@ -10,2 +11,3 @@
 ctx 3
+add 2
 ctx 4
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -5,3 +5,2 @@
-del 1
-del 2
 ctx 5`;

    const result = parser.parse(multiDiff);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(0);

    expect(result.files[1].hunks).toHaveLength(1);
    expect(result.files[1].additions).toBe(0);
    expect(result.files[1].deletions).toBe(2);

    expect(result.insertions).toBe(2);
    expect(result.deletions).toBe(2);
  });
});
