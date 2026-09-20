/**
 * src/context/builder.ts
 * Evaluation context synthesizer for GitGuard.
 * Implements the Minimal Relevant Context pattern with surrounding lines,
 * repository instruction discovery, related test discovery, and budget management.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type {
  ContextBuilder,
  ContextBuildOptions,
  EvaluationContext,
  FileContext,
  InstructionContext,
  RepositoryMetadata,
  SurroundingCodeSpan,
  TaskContext,
  TestContext,
} from '../types/context.js';
import type { GitAdapter, DiffOptions } from '../types/git.js';
import type { DiffContext } from '../types/diff.js';
import { GitCLIAdapter } from '../git/adapter.js';
import { parseDiff } from '../git/diff-parser.js';
import { isSensitiveFile, sanitizeEvaluationContext } from './filter.js';

/** Default budget limits */
const DEFAULT_BUDGET = {
  maxDiffChars: 50000,
  maxTotalChars: 100000,
  surroundingLines: 40,
  maxRelatedTestFiles: 5,
  maxInstructionChars: 15000,
};

/** Common English stop words filtered from task keywords */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off',
  'over', 'under', 'again', 'further', 'once', 'here', 'there', 'all', 'any', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
  'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don',
  'should', 'now', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
]);

/** Standard repository instruction candidate files */
const ROOT_INSTRUCTION_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.gitguard.yml',
];

/**
 * Normalizes file system paths to POSIX standard slashes.
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Checks if a file exists on disk.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Default implementation of ContextBuilder.
 */
export class DefaultContextBuilder implements ContextBuilder {
  private git: GitAdapter;

  constructor(gitAdapter?: GitAdapter) {
    this.git = gitAdapter || new GitCLIAdapter();
  }

  /**
   * Synthesize complete EvaluationContext for the given repository and options.
   */
  public async buildContext(options: ContextBuildOptions = {}): Promise<EvaluationContext> {
    const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    const scope = options.scope || 'staged';
    const budget = {
      maxDiffChars: options.budget?.maxDiffChars ?? DEFAULT_BUDGET.maxDiffChars,
      maxTotalChars: options.budget?.maxTotalChars ?? DEFAULT_BUDGET.maxTotalChars,
      surroundingLines: options.budget?.surroundingLines ?? DEFAULT_BUDGET.surroundingLines,
      maxRelatedTestFiles: options.budget?.maxRelatedTestFiles ?? DEFAULT_BUDGET.maxRelatedTestFiles,
      maxInstructionChars: options.budget?.maxInstructionChars ?? DEFAULT_BUDGET.maxInstructionChars,
    };

    // 1. Repository metadata
    const repoMetadata = await this.extractRepositoryMetadata(cwd);

    // 2. Diff extraction and AST parsing
    const diffOptions: DiffOptions = {
      ...options.diffOptions,
      cwd: repoMetadata.rootPath,
      scope,
    };
    const rawDiff = await this.git.getDiff(scope, diffOptions);
    let diffContext: DiffContext = parseDiff(rawDiff);

    // Apply budget constraint to diff
    if (diffContext.raw.length > budget.maxDiffChars) {
      diffContext = {
        ...diffContext,
        raw: diffContext.raw.substring(0, budget.maxDiffChars) + '\n[Diff truncated due to budget limit]',
        truncated: true,
      };
    }

    // 3. Task Context
    const taskContext = this.parseTaskContext(options.task);

    // 4. Surrounding lines code context
    const fileContexts = await this.extractSurroundingCode(
      diffContext,
      repoMetadata.rootPath,
      budget.surroundingLines,
      options
    );

    // 5. Instruction files discovery
    const instructionContexts = await this.discoverInstructions(
      repoMetadata.rootPath,
      diffContext,
      budget.maxInstructionChars,
      options.policyConfigPath
    );

    // 6. Related tests discovery
    const testContexts = await this.discoverRelatedTests(
      diffContext,
      repoMetadata.rootPath,
      budget.maxRelatedTestFiles
    );

    // Assemble initial context
    let evaluationContext: EvaluationContext = {
      task: taskContext,
      diff: diffContext,
      files: fileContexts,
      instructions: instructionContexts,
      relatedTests: testContexts,
      repository: repoMetadata,
      evidence: [],
      createdAt: new Date().toISOString(),
    };

    // 7. Context budget management: ensure total context conforms to maxTotalChars
    evaluationContext = this.enforceTotalBudget(evaluationContext, budget.maxTotalChars);

    // 8. Privacy & secret redaction
    if (options.privacy?.redactSecrets !== false) {
      evaluationContext = sanitizeEvaluationContext(evaluationContext, options.privacy);
    }

    return evaluationContext;
  }

  /**
   * Extracts repository metadata and package manager detection.
   */
  private async extractRepositoryMetadata(cwd: string): Promise<RepositoryMetadata> {
    const rootPath = await this.git.getRepositoryRoot(cwd);
    const status = await this.git.getStatus(rootPath);

    let packageManager: string | undefined;
    if (await fileExists(path.join(rootPath, 'pnpm-lock.yaml'))) {
      packageManager = 'pnpm';
    } else if (await fileExists(path.join(rootPath, 'package-lock.json'))) {
      packageManager = 'npm';
    } else if (await fileExists(path.join(rootPath, 'yarn.lock'))) {
      packageManager = 'yarn';
    } else if (await fileExists(path.join(rootPath, 'bun.lockb'))) {
      packageManager = 'bun';
    }

    return {
      rootPath: toPosix(rootPath),
      branch: status.currentBranch,
      headSha: status.headSha,
      isClean: status.isClean,
      packageManager,
    };
  }

  /**
   * Parses natural language task description and extracts keywords.
   */
  private parseTaskContext(taskStr?: string): TaskContext {
    if (!taskStr || typeof taskStr !== 'string' || taskStr.trim() === '') {
      return {
        task: '',
        taskPresent: false,
        keywords: [],
      };
    }

    const trimmed = taskStr.trim();
    const tokens = trimmed
      .toLowerCase()
      .split(/[^a-zA-Z0-9_\-]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    const uniqueKeywords = Array.from(new Set(tokens));

    return {
      task: trimmed,
      taskPresent: true,
      keywords: uniqueKeywords,
      source: 'cli',
    };
  }

  /**
   * Extracts surrounding lines of code for changed hunks and merges overlapping intervals.
   */
  private async extractSurroundingCode(
    diff: DiffContext,
    rootPath: string,
    surroundingLines: number,
    options: ContextBuildOptions
  ): Promise<FileContext[]> {
    const fileContexts: FileContext[] = [];

    for (const diffFile of diff.files) {
      const filePath = diffFile.newPath;

      // Handle binary files
      if (diffFile.binary) {
        fileContexts.push({
          path: toPosix(filePath),
          status: diffFile.status,
          binary: true,
          spans: [],
        });
        continue;
      }

      // Handle deleted files
      if (diffFile.status === 'deleted') {
        fileContexts.push({
          path: toPosix(filePath),
          status: 'deleted',
          binary: false,
          spans: [],
        });
        continue;
      }

      // Handle sensitive files: omit code spans to protect credentials
      const isFileSensitive =
        isSensitiveFile(filePath, options.privacy?.excludePatterns) ||
        (diffFile.oldPath ? isSensitiveFile(diffFile.oldPath, options.privacy?.excludePatterns) : false);
      if (isFileSensitive) {
        fileContexts.push({
          path: toPosix(filePath),
          status: diffFile.status,
          binary: false,
          spans: [],
        });
        continue;
      }

      // Read current file content
      const content = await this.git.getFileContent(filePath, undefined, rootPath);
      if (content === null) {
        fileContexts.push({
          path: toPosix(filePath),
          status: diffFile.status,
          binary: false,
          spans: [],
        });
        continue;
      }

      const fileLines = content.split(/\r?\n/);
      if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
        fileLines.pop();
      }
      const totalLines = fileLines.length;

      // Calculate intervals around each hunk
      const intervals: Array<{ start: number; end: number }> = [];

      for (const hunk of diffFile.hunks) {
        const hunkStart = Math.max(1, hunk.newStart);
        const hunkSpan = Math.max(1, hunk.newLines);
        const start = Math.max(1, hunkStart - surroundingLines);
        const end = Math.min(totalLines, hunkStart + hunkSpan + surroundingLines);
        intervals.push({ start, end });
      }

      // If no hunks parsed (e.g. empty or untracked), take whole file if within budget (skip pure renames)
      if (intervals.length === 0 && totalLines > 0 && diffFile.status !== 'renamed') {
        intervals.push({ start: 1, end: Math.min(totalLines, surroundingLines * 2) });
      }

      // Sort and merge overlapping/adjacent intervals
      intervals.sort((a, b) => a.start - b.start);
      const merged: Array<{ start: number; end: number }> = [];

      for (const interval of intervals) {
        if (merged.length === 0) {
          merged.push({ ...interval });
        } else {
          const last = merged[merged.length - 1];
          if (interval.start <= last.end + 1) {
            last.end = Math.max(last.end, interval.end);
          } else {
            merged.push({ ...interval });
          }
        }
      }

      // Create code spans
      const spans: SurroundingCodeSpan[] = merged.map((m) => ({
        startLine: m.start,
        endLine: m.end,
        code: fileLines.slice(m.start - 1, m.end).join('\n'),
      }));

      fileContexts.push({
        path: toPosix(filePath),
        status: diffFile.status,
        binary: false,
        spans,
        content: options.privacy?.includeFullFiles ? content : undefined,
      });
    }

    return fileContexts;
  }

  /**
   * Discovers repository instruction files (AGENTS.md, CLAUDE.md, etc.) across the repository.
   */
  private async discoverInstructions(
    rootPath: string,
    diff: DiffContext,
    maxChars: number,
    policyConfigPath?: string
  ): Promise<InstructionContext[]> {
    const instructions: InstructionContext[] = [];
    let currentChars = 0;

    const seenPaths = new Set<string>();

    // Helper to load and record instruction file
    const tryAddInstruction = async (relPath: string, scope: string) => {
      const normalizedPath = toPosix(relPath);
      if (seenPaths.has(normalizedPath)) return;

      const fullPath = path.resolve(rootPath, relPath);
      if (await fileExists(fullPath)) {
        try {
          const text = await fs.readFile(fullPath, 'utf-8');
          seenPaths.add(normalizedPath);
          const remainingChars = maxChars - currentChars;
          if (remainingChars <= 0) return;

          const content = text.length > remainingChars ? text.substring(0, remainingChars) : text;
          currentChars += content.length;

          instructions.push({
            sourcePath: normalizedPath,
            scope,
            content,
          });
        } catch {
          // Ignore read errors
        }
      }
    };

    // 1. Explicit policy config if specified
    if (policyConfigPath) {
      await tryAddInstruction(policyConfigPath, '/');
    }

    // 2. Root instruction files
    for (const file of ROOT_INSTRUCTION_FILES) {
      await tryAddInstruction(file, '/');
    }

    // 3. Subdirectory instruction files for changed directories (Monorepo support)
    const affectedDirs = new Set<string>();
    for (const f of diff.files) {
      const parts = f.newPath.split('/');
      if (parts.length > 1) {
        let acc = '';
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          affectedDirs.add(acc);
        }
      }
    }

    for (const dir of affectedDirs) {
      for (const candidate of ['AGENTS.md', 'CLAUDE.md']) {
        const subPath = `${dir}/${candidate}`;
        await tryAddInstruction(subPath, dir);
      }
    }

    return instructions;
  }

  /**
   * Discovers automated test files related to modified source code.
   */
  private async discoverRelatedTests(
    diff: DiffContext,
    rootPath: string,
    maxFiles: number
  ): Promise<TestContext[]> {
    const relatedTests: TestContext[] = [];
    const seenTestPaths = new Set<string>();

    const diffFileMap = new Map<string, boolean>();
    for (const f of diff.files) {
      diffFileMap.set(toPosix(f.newPath), true);
    }

    // Filter to source files that are NOT themselves tests
    const sourceFiles = diff.files.filter((f) => {
      const p = f.newPath.toLowerCase();
      return (
        !p.includes('.test.') &&
        !p.includes('.spec.') &&
        !p.startsWith('tests/') &&
        !p.startsWith('__tests__/')
      );
    });

    for (const sf of sourceFiles) {
      if (relatedTests.length >= maxFiles) break;

      const posixPath = toPosix(sf.newPath);
      const parsed = path.posix.parse(posixPath);
      const baseNameWithoutExt = parsed.name;
      const ext = parsed.ext;

      const dirPrefix = parsed.dir ? `${parsed.dir}/` : '';

      // Candidate test locations
      const candidates: string[] = [
        // Same directory
        `${dirPrefix}${baseNameWithoutExt}.test${ext}`,
        `${dirPrefix}${baseNameWithoutExt}.spec${ext}`,
        // tests/ or tests/unit/ mirroring
        `tests/${posixPath.replace(/^src\//, '')}`.replace(ext, `.test${ext}`),
        `tests/unit/${posixPath.replace(/^src\//, '')}`.replace(ext, `.test${ext}`),
        `tests/${baseNameWithoutExt}.test${ext}`,
        `tests/unit/${baseNameWithoutExt}.test${ext}`,
        `__tests__/${baseNameWithoutExt}.test${ext}`,
      ];

      for (const candidate of candidates) {
        const cleanCandidate = toPosix(path.posix.normalize(candidate));
        if (seenTestPaths.has(cleanCandidate)) continue;

        const fullTestPath = path.resolve(rootPath, cleanCandidate);
        const exists = await fileExists(fullTestPath);
        const modifiedInDiff = diffFileMap.has(cleanCandidate);

        if (exists || modifiedInDiff) {
          seenTestPaths.add(cleanCandidate);
          let snippet: string | undefined;

          if (exists) {
            try {
              const content = await fs.readFile(fullTestPath, 'utf-8');
              const lines = content.split(/\r?\n/);
              // Read first 30 lines for signature / suite overview
              snippet = lines.slice(0, 30).join('\n');
            } catch {
              // Ignore snippet error
            }
          }

          relatedTests.push({
            testPath: cleanCandidate,
            relatedSourcePath: posixPath,
            existsInWorkspace: exists,
            modifiedInDiff,
            contentSnippet: snippet,
          });

          if (relatedTests.length >= maxFiles) break;
        }
      }
    }

    return relatedTests;
  }

  /**
   * Enforces total context character budget by trimming lowest priority items first.
   * Priority: Task > Diff > Policy > Instructions > Changed Code > Tests > Metadata
   * Guarantees that calculateTotalChars(context) <= maxTotalChars.
   */
  private enforceTotalBudget(
    context: EvaluationContext,
    maxTotalChars: number
  ): EvaluationContext {
    let currentTotal = this.calculateTotalChars(context);
    if (currentTotal <= maxTotalChars) {
      return context;
    }

    // Tier 1: Clear full file contents if included
    if (context.files.some((fc) => fc.content !== undefined)) {
      context.files = context.files.map((fc) => ({
        ...fc,
        content: undefined,
      }));
      currentTotal = this.calculateTotalChars(context);
      if (currentTotal <= maxTotalChars) return context;
    }

    // Tier 2: Trim test snippets
    if (context.relatedTests.some((t) => t.contentSnippet !== undefined)) {
      context.relatedTests = context.relatedTests.map((t) => ({
        ...t,
        contentSnippet: undefined,
      }));
      currentTotal = this.calculateTotalChars(context);
      if (currentTotal <= maxTotalChars) return context;
    }

    // Tier 3: Trim surrounding code spans (clamp each span to 20 lines)
    context.files = context.files.map((fc) => ({
      ...fc,
      spans: fc.spans.map((span) => {
        const lines = span.code.split('\n');
        if (lines.length > 20) {
          return {
            ...span,
            code: lines.slice(0, 20).join('\n') + '\n[Code span truncated]',
          };
        }
        return span;
      }),
    }));
    currentTotal = this.calculateTotalChars(context);
    if (currentTotal <= maxTotalChars) return context;

    // Tier 4: Trim instructions to 500 chars
    context.instructions = context.instructions.map((inst) => ({
      ...inst,
      content:
        inst.content.length > 500
          ? inst.content.substring(0, 500) + '\n[Instruction truncated]'
          : inst.content,
    }));
    currentTotal = this.calculateTotalChars(context);
    if (currentTotal <= maxTotalChars) return context;

    // Tier 5: More aggressive trimming for code spans (clamp to 5 lines) and instructions (100 chars)
    context.instructions = context.instructions.map((inst) => ({
      ...inst,
      content:
        inst.content.length > 100
          ? inst.content.substring(0, 100) + '\n[Instruction truncated]'
          : inst.content,
    }));
    context.files = context.files.map((fc) => ({
      ...fc,
      spans: fc.spans.map((span) => {
        const lines = span.code.split('\n');
        if (lines.length > 5) {
          return {
            ...span,
            code: lines.slice(0, 5).join('\n') + '\n[Code span truncated]',
          };
        }
        return span;
      }),
    }));
    currentTotal = this.calculateTotalChars(context);
    if (currentTotal <= maxTotalChars) return context;

    // Tier 6: Trim diff.raw if it causes total to exceed maxTotalChars
    const diffNotice = '\n[Diff truncated due to budget limit]';
    const nonDiffChars = currentTotal - (context.diff?.raw?.length ?? 0);
    const availableForDiff = maxTotalChars - nonDiffChars - diffNotice.length;

    if (context.diff?.raw && context.diff.raw.length > Math.max(0, availableForDiff)) {
      if (availableForDiff > 0) {
        context.diff = {
          ...context.diff,
          raw: context.diff.raw.substring(0, availableForDiff) + diffNotice,
          truncated: true,
        };
      } else {
        context.diff = {
          ...context.diff,
          raw: diffNotice.trim(),
          truncated: true,
        };
      }
      currentTotal = this.calculateTotalChars(context);
      if (currentTotal <= maxTotalChars) return context;
    }

    // Tier 7: Drop all code spans and instructions if budget still exceeded
    context.files = context.files.map((fc) => ({ ...fc, spans: [] }));
    context.instructions = [];
    context.relatedTests = [];
    currentTotal = this.calculateTotalChars(context);
    if (currentTotal <= maxTotalChars) return context;

    // Final Fallback Guarantee: clamp diff.raw and task.task to strictly satisfy budget
    const taskLen = context.task?.task?.length ?? 0;
    if (context.diff?.raw) {
      const allowedDiff = Math.max(0, maxTotalChars - taskLen);
      context.diff = {
        ...context.diff,
        raw: context.diff.raw.substring(0, allowedDiff),
        truncated: true,
      };
      currentTotal = this.calculateTotalChars(context);
      if (currentTotal <= maxTotalChars) return context;
    }

    if (context.task?.task && currentTotal > maxTotalChars) {
      context.task = {
        ...context.task,
        task: context.task.task.substring(0, maxTotalChars),
      };
    }

    return context;
  }

  /**
   * Calculates total estimated character count across all context components.
   */
  private calculateTotalChars(ctx: EvaluationContext): number {
    let total = 0;
    if (ctx.task?.task) total += ctx.task.task.length;
    if (ctx.diff?.raw) total += ctx.diff.raw.length;
    for (const f of ctx.files) {
      for (const s of f.spans) total += s.code.length;
      if (f.content) total += f.content.length;
    }
    for (const inst of ctx.instructions) {
      total += inst.content.length;
    }
    for (const t of ctx.relatedTests) {
      if (t.contentSnippet) total += t.contentSnippet.length;
    }
    return total;
  }
}
