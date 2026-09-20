/**
 * tests/unit/context/builder.test.ts
 * Unit and integration tests for DefaultContextBuilder using isolated temporary Git fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { DefaultContextBuilder } from '../../../src/context/builder.js';
import { GitCLIAdapter } from '../../../src/git/adapter.js';
import { REDACTION_TOKEN } from '../../../src/context/filter.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';

describe('DefaultContextBuilder', () => {
  let fixture: GitFixture;
  let adapter: GitCLIAdapter;
  let builder: DefaultContextBuilder;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    adapter = new GitCLIAdapter(fixture.path);
    builder = new DefaultContextBuilder(adapter);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('Basic Context Synthesis', () => {
    it('should build complete EvaluationContext for staged changes', async () => {
      await fixture.writeFile('src/math.ts', 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
      await fixture.stage();
      await fixture.commit('feat: initial math module');

      // Stage an update
      await fixture.writeFile(
        'src/math.ts',
        'export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n'
      );
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        task: 'Add subtraction function to math module',
      });

      // Verify task context
      expect(context.task?.taskPresent).toBe(true);
      expect(context.task?.task).toBe('Add subtraction function to math module');
      expect(context.task?.keywords).toContain('subtraction');
      expect(context.task?.keywords).toContain('math');

      // Verify diff context
      expect(context.diff.files).toHaveLength(1);
      expect(context.diff.files[0].newPath).toBe('src/math.ts');
      expect(context.diff.insertions).toBeGreaterThan(0);

      // Verify repository metadata
      const expectedRoot = await fs.realpath(fixture.repoPath);
      const actualRoot = await fs.realpath(context.repository.rootPath);
      expect(actualRoot.toLowerCase()).toBe(expectedRoot.toLowerCase());
      expect(context.repository.headSha).toHaveLength(40);
      expect(context.evidence).toEqual([]);
      expect(context.createdAt).toBeDefined();
    });

    it('should handle empty task description gracefully', async () => {
      await fixture.writeFile('hello.txt', 'hello\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      expect(context.task?.taskPresent).toBe(false);
      expect(context.task?.task).toBe('');
      expect(context.task?.keywords).toEqual([]);
    });
  });

  describe('Surrounding Lines & Overlapping Span Merging', () => {
    it('should extract surrounding lines and merge overlapping intervals', async () => {
      // Create a 100-line file
      const lines: string[] = [];
      for (let i = 1; i <= 100; i++) {
        lines.push(`// line ${i}`);
      }
      await fixture.writeFile('large.ts', lines.join('\n') + '\n');
      await fixture.stage();
      await fixture.commit('init large file');

      // Modify line 20 and line 30 (with surroundingLines=20, these overlap!)
      lines[19] = '// line 20 MODIFIED';
      lines[29] = '// line 30 MODIFIED';
      await fixture.writeFile('large.ts', lines.join('\n') + '\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        budget: { surroundingLines: 20 },
      });

      const fileCtx = context.files.find((f) => f.path === 'large.ts');
      expect(fileCtx).toBeDefined();

      // Because [1, 40] and [10, 50] overlap, they should merge into a single span!
      expect(fileCtx?.spans).toHaveLength(1);
      const span = fileCtx!.spans[0];
      expect(span.startLine).toBe(1); // Clamped to 1
      expect(span.endLine).toBeGreaterThanOrEqual(50);
      expect(span.code).toContain('line 20 MODIFIED');
      expect(span.code).toContain('line 30 MODIFIED');
    });

    it('should clamp boundary lines near EOF', async () => {
      const lines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'];
      await fixture.writeFile('small.ts', lines.join('\n') + '\n');
      await fixture.stage();
      await fixture.commit('init');

      lines[4] = 'line 5 modified';
      await fixture.writeFile('small.ts', lines.join('\n') + '\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        budget: { surroundingLines: 40 },
      });

      const fileCtx = context.files.find((f) => f.path === 'small.ts');
      expect(fileCtx?.spans).toHaveLength(1);
      const span = fileCtx!.spans[0];
      expect(span.startLine).toBe(1);
      expect(span.endLine).toBe(5); // Clamped to total lines (5)
    });

    it('should generate separate spans for disjoint hunks separated by more than 100 lines', async () => {
      const lines: string[] = [];
      for (let i = 1; i <= 200; i++) {
        lines.push(`// line ${i}`);
      }
      await fixture.writeFile('disjoint.ts', lines.join('\n') + '\n');
      await fixture.stage();
      await fixture.commit('init disjoint file');

      // Modify line 10 and line 180 (separated by 170 lines)
      lines[9] = '// line 10 MODIFIED';
      lines[179] = '// line 180 MODIFIED';
      await fixture.writeFile('disjoint.ts', lines.join('\n') + '\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        budget: { surroundingLines: 20 },
      });

      const fileCtx = context.files.find((f) => f.path === 'disjoint.ts');
      expect(fileCtx).toBeDefined();
      expect(fileCtx?.spans).toHaveLength(2);
      expect(fileCtx?.spans[0].endLine).toBeLessThan(fileCtx!.spans[1].startLine);
      expect(fileCtx?.spans[0].code).toContain('line 10 MODIFIED');
      expect(fileCtx?.spans[1].code).toContain('line 180 MODIFIED');
    });
  });

  describe('Repository Instruction Discovery', () => {
    it('should discover root and monorepo subdirectory instructions', async () => {
      // 1. Root instruction files
      await fixture.writeFile('AGENTS.md', '# Root Agent Rules\nFollow project conventions.');
      await fixture.writeFile('.gitguard.yml', 'version: 1\n');

      // 2. Subdirectory instruction files
      await fixture.writeFile('apps/web/AGENTS.md', '# Web Specific Rules\nUse React 19.');
      await fixture.writeFile('apps/web/src/index.ts', 'export const app = "web";\n');

      await fixture.stage();
      await fixture.commit('init repo with instructions');

      // Modify subproject file
      await fixture.writeFile('apps/web/src/index.ts', 'export const app = "web-v2";\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      const rootInstruction = context.instructions.find((i) => i.sourcePath === 'AGENTS.md');
      expect(rootInstruction).toBeDefined();
      expect(rootInstruction?.scope).toBe('/');
      expect(rootInstruction?.content).toContain('Root Agent Rules');

      const webInstruction = context.instructions.find((i) => i.sourcePath === 'apps/web/AGENTS.md');
      expect(webInstruction).toBeDefined();
      expect(webInstruction?.scope).toBe('apps/web');
      expect(webInstruction?.content).toContain('Web Specific Rules');
    });
  });

  describe('Related Test Discovery', () => {
    it('should find existing related tests in workspace', async () => {
      await fixture.writeFile('src/auth/token.ts', 'export const generateToken = () => "123";\n');
      await fixture.writeFile('tests/unit/auth/token.test.ts', 'import { describe, it } from "vitest";\n// token suite\n');
      await fixture.stage();
      await fixture.commit('feat: auth module');

      // Modify source file only
      await fixture.writeFile('src/auth/token.ts', 'export const generateToken = () => "456";\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      expect(context.relatedTests).toHaveLength(1);
      const testCtx = context.relatedTests[0];
      expect(testCtx.testPath).toBe('tests/unit/auth/token.test.ts');
      expect(testCtx.relatedSourcePath).toBe('src/auth/token.ts');
      expect(testCtx.existsInWorkspace).toBe(true);
      expect(testCtx.modifiedInDiff).toBe(false);
      expect(testCtx.contentSnippet).toContain('token suite');
    });

    it('should flag modifiedInDiff when test was also changed in changeset', async () => {
      await fixture.writeFile('src/user.ts', 'export const user = "alice";\n');
      await fixture.writeFile('src/user.test.ts', 'test user\n');
      await fixture.stage();
      await fixture.commit('init user');

      // Modify both source and test
      await fixture.writeFile('src/user.ts', 'export const user = "bob";\n');
      await fixture.writeFile('src/user.test.ts', 'test user bob\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      const testCtx = context.relatedTests.find((t) => t.testPath === 'src/user.test.ts');
      expect(testCtx).toBeDefined();
      expect(testCtx?.modifiedInDiff).toBe(true);
    });

    it('should discover co-located tests for root-level files without leading slash escape', async () => {
      await fixture.writeFile('index.ts', 'export const greeting = "hello";\n');
      await fixture.writeFile('index.test.ts', 'import { describe, it } from "vitest";\n// root index test\n');
      await fixture.stage();
      await fixture.commit('feat: root index file');

      // Modify root-level index.ts
      await fixture.writeFile('index.ts', 'export const greeting = "world";\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      expect(context.relatedTests.length).toBeGreaterThanOrEqual(1);
      const testCtx = context.relatedTests.find((t) => t.testPath === 'index.test.ts');
      expect(testCtx).toBeDefined();
      expect(testCtx?.testPath).toBe('index.test.ts');
      expect(testCtx?.testPath.startsWith('/')).toBe(false);
      expect(testCtx?.existsInWorkspace).toBe(true);
      expect(testCtx?.contentSnippet).toContain('root index test');
    });
  });

  describe('Budget Management & Privacy Redaction', () => {
    it('should truncate diff exceeding maxDiffChars budget', async () => {
      // Create large diff
      const hugeContent = 'a'.repeat(2000);
      await fixture.writeFile('huge.txt', hugeContent);
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        budget: { maxDiffChars: 300 },
      });

      expect(context.diff.truncated).toBe(true);
      expect(context.diff.raw).toContain('[Diff truncated due to budget limit]');
      expect(context.diff.raw.length).toBeLessThanOrEqual(400);
    });

    it('should automatically redact sensitive tokens in context', async () => {
      await fixture.writeFile(
        'src/client.ts',
        'export const apiKey = "AKIAIOSFODNN7EXAMPLE";\nexport const secret = "sk-1234567890abcdef1234567890abcdef12";\n'
      );
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        task: 'Set up credentials with AKIAIOSFODNN7EXAMPLE',
      });

      // Task redacted
      expect(context.task?.task).toContain(REDACTION_TOKEN);
      expect(context.task?.task).not.toContain('AKIAIOSFODNN7EXAMPLE');

      // Diff redacted
      expect(context.diff.raw).toContain(REDACTION_TOKEN);
      expect(context.diff.raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(context.diff.raw).not.toContain('sk-12345');

      // Code span redacted
      const fileCtx = context.files.find((f) => f.path === 'src/client.ts');
      expect(fileCtx?.spans[0].code).toContain(REDACTION_TOKEN);
      expect(fileCtx?.spans[0].code).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should omit code spans and raw diff hunks for sensitive files (.env)', async () => {
      await fixture.writeFile('.env', 'DATABASE_PASSWORD=superSecret123456\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
      });

      const envFile = context.files.find((f) => f.path === '.env');
      expect(envFile).toBeDefined();
      expect(envFile?.spans).toHaveLength(0);

      // Raw diff should have omitted hunks and no leaked password
      expect(context.diff.raw).toContain('[Diff omitted for sensitive file: .env]');
      expect(context.diff.raw).not.toContain('DATABASE_PASSWORD=superSecret123456');
    });

    it('should strictly enforce maxTotalChars budget and guarantee context character bounds', async () => {
      // Create instruction file
      await fixture.writeFile('AGENTS.md', '# Agent Guide\n' + 'Instruction rule line.\n'.repeat(50));

      // Create related test file
      await fixture.writeFile('src/service.ts', 'export const run = () => true;\n' + 'line;\n'.repeat(40));
      await fixture.writeFile('tests/unit/service.test.ts', 'test suite\n' + 'test code line\n'.repeat(30));
      await fixture.stage();
      await fixture.commit('init service and tests');

      // Modify service.ts with large hunk
      await fixture.writeFile(
        'src/service.ts',
        'export const run = () => false;\n' + 'expanded modified line content 123456789;\n'.repeat(50)
      );
      await fixture.stage();

      const tightMaxTotal = 500;
      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        budget: {
          maxDiffChars: 50000,
          maxTotalChars: tightMaxTotal,
          surroundingLines: 30,
        },
      });

      // Calculate total characters
      let totalChars = 0;
      if (context.task?.task) totalChars += context.task.task.length;
      if (context.diff?.raw) totalChars += context.diff.raw.length;
      for (const f of context.files) {
        for (const s of f.spans) totalChars += s.code.length;
        if (f.content) totalChars += f.content.length;
      }
      for (const inst of context.instructions) totalChars += inst.content.length;
      for (const t of context.relatedTests) {
        if (t.contentSnippet) totalChars += t.contentSnippet.length;
      }

      expect(totalChars).toBeLessThanOrEqual(tightMaxTotal);
      expect(context.diff.truncated).toBe(true);
    });

    it('should trim full file content and test snippets first to respect maxTotalChars', async () => {
      await fixture.writeFile('src/data.ts', 'const data = "' + 'x'.repeat(1000) + '";\n');
      await fixture.stage();

      const context = await builder.buildContext({
        cwd: fixture.path,
        scope: 'staged',
        privacy: { includeFullFiles: true },
        budget: {
          maxDiffChars: 50000,
          maxTotalChars: 300,
        },
      });

      const fileCtx = context.files.find((f) => f.path === 'src/data.ts');
      expect(fileCtx).toBeDefined();
      expect(fileCtx?.content).toBeUndefined(); // Full content dropped
    });
  });
});
