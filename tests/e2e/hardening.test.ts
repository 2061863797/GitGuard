/**
 * tests/e2e/hardening.test.ts
 * Tier 5: Boundary Conditions & Coverage Hardening
 * Covers extreme context budget clamping, diff parsing edge paths,
 * Core Engine edge branches, and untested CLI / MCP interfaces.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createTempGitRepo, GitFixture } from './helpers/e2e-harness.js';
import { loadConfig } from '../../src/policy/config.js';
import { ConfigurationError } from '../../src/types/errors.js';
import { UnifiedDiffParser } from '../../src/git/diff-parser.js';
import { GitCLIAdapter } from '../../src/git/adapter.js';
import { DefaultContextBuilder } from '../../src/context/builder.js';
import { scanDiffForSecrets } from '../../src/analysis/deterministic/secrets.js';
import {
  DefaultGitGuardEngine,
  toDeterministicRunnerConfig,
} from '../../src/core/engine.js';
import { DeterministicMockProvider } from '../../src/analysis/semantic/mock-provider.js';
import { checkCommand } from '../../src/interfaces/cli/check.js';
import { findingsCommand } from '../../src/interfaces/cli/findings.js';
import { verifyCommand } from '../../src/interfaces/cli/verify.js';
import { mcpCommand } from '../../src/interfaces/cli/mcp.js';
import { GitGuardMcpServer } from '../../src/interfaces/mcp/server.js';
import { executeMcpTool } from '../../src/interfaces/mcp/tools.js';

describe('Tier 5: Boundary Conditions & Coverage Hardening', () => {
  let fixture: GitFixture;
  let adapter: GitCLIAdapter;
  let parser: UnifiedDiffParser;
  let builder: DefaultContextBuilder;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-hrd-');
    adapter = new GitCLIAdapter(fixture.repoPath);
    parser = new UnifiedDiffParser();
    builder = new DefaultContextBuilder(adapter);

    // Seed repository with initial commits and docs
    await fixture.writeFile('README.md', '# Hardening Suite\n');
    await fixture.writeFile(
      'AGENTS.md',
      '# Agent Guidelines\n' + 'Strict security guidelines for AI coding agents.\n'.repeat(30)
    );
    await fixture.writeFile('src/app.ts', 'export function run() {\n  return 42;\n}\n');
    await fixture.writeFile('tests/app.test.ts', 'import { run } from "../src/app.js";\n');
    await fixture.stage();
    await fixture.commit('chore: initial repository state');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('Vector E: Extreme Context Budget Boundary Conditions', () => {
    it('HRD-BUD-01: Zero total context budget (maxTotalChars: 0)', async () => {
      await fixture.writeFile('src/app.ts', 'export function run() {\n  return 100;\n}\n');
      await fixture.stage('src/app.ts');

      const context = await builder.buildContext({
        scope: 'staged',
        task: 'Update return value to 100',
        budget: { maxTotalChars: 0 },
        cwd: fixture.repoPath,
      });

      expect(context.instructions).toHaveLength(0);
      for (const file of context.files) {
        expect(file.spans).toHaveLength(0);
      }
      expect(context.relatedTests).toHaveLength(0);
      expect(context.diff.raw).toBe('');
      expect(context.diff.truncated).toBe(true);
      expect(context.task?.task).toBe('');

      // Verify total chars <= 0
      const totalChars = (builder as any).calculateTotalChars(context);
      expect(totalChars).toBeLessThanOrEqual(0);
    });

    it('HRD-BUD-02: 1-character total context budget (maxTotalChars: 1)', async () => {
      await fixture.writeFile('src/app.ts', 'export function run() {\n  return 999;\n}\n');
      await fixture.stage('src/app.ts');

      const context = await builder.buildContext({
        scope: 'staged',
        task: 'Implement critical update',
        budget: { maxTotalChars: 1 },
        cwd: fixture.repoPath,
      });

      const totalChars = (builder as any).calculateTotalChars(context);
      expect(totalChars).toBeLessThanOrEqual(1);
      expect(context.instructions).toHaveLength(0);
      for (const file of context.files) {
        expect(file.spans).toHaveLength(0);
      }
    });

    it('HRD-BUD-03: Large task intent overflowing budget clamped safely', async () => {
      await fixture.writeFile('src/app.ts', 'export const token = "abc";\n');
      await fixture.stage('src/app.ts');

      const massiveTask = 'Task description with excessive details. '.repeat(10);
      const context = await builder.buildContext({
        scope: 'staged',
        task: massiveTask,
        budget: { maxTotalChars: 50 },
        cwd: fixture.repoPath,
      });

      expect(context.task?.task?.length).toBeLessThanOrEqual(50);
      const totalChars = (builder as any).calculateTotalChars(context);
      expect(totalChars).toBeLessThanOrEqual(50);
    });

    it('HRD-BUD-04: Zero diff budget (maxDiffChars: 0) inserts truncation notice', async () => {
      await fixture.writeFile('src/large.ts', 'const a = 1;\n'.repeat(50));
      await fixture.stage('src/large.ts');

      const context = await builder.buildContext({
        scope: 'staged',
        budget: { maxDiffChars: 0 },
        cwd: fixture.repoPath,
      });

      expect(context.diff.truncated).toBe(true);
      expect(context.diff.raw).toContain('[Diff truncated due to budget limit]');
    });

    it('HRD-BUD-05: Complete 7-tier budget collapse progression', async () => {
      // Modify source file with substantial diff
      await fixture.writeFile('src/app.ts', 'const generatedLine = 1;\n'.repeat(60));
      await fixture.stage('src/app.ts');

      const stepBudgets = [4000, 2000, 1000, 500, 200, 80, 20];
      for (const budgetLimit of stepBudgets) {
        const context = await builder.buildContext({
          scope: 'staged',
          task: 'Refactor app structure with comprehensive tests',
          budget: { maxTotalChars: budgetLimit },
          cwd: fixture.repoPath,
        });

        const totalChars = (builder as any).calculateTotalChars(context);
        expect(totalChars).toBeLessThanOrEqual(budgetLimit);

        if (budgetLimit <= 500) {
          expect(context.diff.truncated).toBe(true);
        }
        if (budgetLimit <= 80) {
          expect(context.instructions).toHaveLength(0);
          for (const file of context.files) {
            expect(file.spans).toHaveLength(0);
          }
        }
      }
    });
  });

  describe('Vector B: Diff Parsing Anomalies', () => {
    it('HRD-DIF-01: Pure file rename (100% similarity) produces valid FileContext without errors', async () => {
      await fixture.writeFile('src/original.ts', 'export const original = true;\n');
      await fixture.stage('src/original.ts');
      await fixture.commit('chore: add original file');

      await fixture.exec(['mv', 'src/original.ts', 'src/renamed.ts']);
      await fixture.stage();

      const changedFiles = await adapter.getChangedFiles('staged', { cwd: fixture.repoPath });
      expect(changedFiles).toHaveLength(1);
      const renamed = changedFiles[0];
      expect(renamed.status).toBe('renamed');
      expect(renamed.oldPath).toBe('src/original.ts');
      expect(renamed.path).toBe('src/renamed.ts');
      expect(renamed.additions).toBe(0);
      expect(renamed.deletions).toBe(0);

      const context = await builder.buildContext({ scope: 'staged', cwd: fixture.repoPath });
      const renamedContext = context.files.find((f) => f.path === 'src/renamed.ts');
      expect(renamedContext).toBeDefined();
      expect(renamedContext?.status).toBe('renamed');
      expect(renamedContext?.spans).toHaveLength(0);
    });

    it('HRD-DIF-02: Pure file mode change (chmod +x) parses cleanly with zero hunks', async () => {
      const modeDiff = [
        'diff --git a/deploy.sh b/deploy.sh',
        'old mode 100644',
        'new mode 100755',
      ].join('\n');

      const parsed = parser.parse(modeDiff);
      expect(parsed.totalFiles).toBe(1);
      expect(parsed.files[0].status).toBe('modified');
      expect(parsed.files[0].newPath).toBe('deploy.sh');
      expect(parsed.files[0].hunks).toHaveLength(0);
      expect(parsed.insertions).toBe(0);
      expect(parsed.deletions).toBe(0);

      const engine = new DefaultGitGuardEngine({ gitAdapter: adapter });
      const inspectRes = await engine.inspect({ cwd: fixture.repoPath });
      expect(inspectRes.status).toBeDefined();
    });

    it('HRD-DIF-03: Submodule pointer modification parsed safely and skips directory read', async () => {
      const submoduleDiff = [
        'diff --git a/vendor/sublib b/vendor/sublib',
        'index 1111111..2222222 160000',
        '--- a/vendor/sublib',
        '+++ b/vendor/sublib',
        '@@ -1 +1 @@',
        '-Subproject commit 1111111111111111111111111111111111111111',
        '+Subproject commit 2222222222222222222222222222222222222222',
      ].join('\n');

      const parsed = parser.parse(submoduleDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0].additions).toBe(1);

      // Verify secret scanner ignores the 40-char git commit SHA
      const violations = scanDiffForSecrets(parsed);
      expect(violations).toHaveLength(0);

      // Simulate a submodule directory on filesystem to ensure no EISDIR is thrown
      const subDirPath = path.join(fixture.repoPath, 'vendor', 'sublib');
      await fs.mkdir(subDirPath, { recursive: true });
      await fs.writeFile(path.join(subDirPath, 'sub.txt'), 'submodule payload');

      const getDiffSpy = vi.spyOn(adapter, 'getDiff').mockResolvedValue(submoduleDiff);
      const context = await builder.buildContext({
        cwd: fixture.repoPath,
      });
      getDiffSpy.mockRestore();

      expect(context).toBeDefined();
      const subFile = context.files.find((f) => f.path === 'vendor/sublib');
      expect(subFile?.spans).toHaveLength(0);
    });

    it('HRD-DIF-04: Binary file additions, deletions, and modifications set binary flag', async () => {
      const binaryDiff = [
        'diff --git a/add.png b/add.png',
        'Binary files /dev/null and b/add.png differ',
        'diff --git a/del.png b/del.png',
        'Binary files a/del.png and /dev/null differ',
        'diff --git a/mod.png b/mod.png',
        'Binary files a/mod.png and b/mod.png differ',
      ].join('\n');

      const parsed = parser.parse(binaryDiff);
      expect(parsed.files).toHaveLength(3);
      expect(parsed.files[0].binary).toBe(true);
      expect(parsed.files[1].binary).toBe(true);
      expect(parsed.files[2].binary).toBe(true);
      expect(parsed.insertions).toBe(0);
      expect(parsed.deletions).toBe(0);

      const violations = scanDiffForSecrets(parsed);
      expect(violations).toHaveLength(0);
    });

    it('HRD-DIF-05: Corrupted hunk header line skipped gracefully without parsing abort', async () => {
      const corruptedDiff = [
        'diff --git a/corrupted.ts b/corrupted.ts',
        '--- a/corrupted.ts',
        '+++ b/corrupted.ts',
        '@@ -corrupted +header @@',
        '+line from corrupted hunk',
        '@@ -1,1 +1,2 @@',
        ' export const base = 1;',
        '+export const extra = 2;',
      ].join('\n');

      const parsed = parser.parse(corruptedDiff);
      expect(parsed.files).toHaveLength(1);
      // Valid hunk after corrupted hunk must be parsed successfully
      expect(parsed.files[0].hunks.length).toBeGreaterThanOrEqual(1);
      expect(
        parsed.files[0].hunks.some((h) => h.lines.includes('+export const extra = 2;'))
      ).toBe(true);
    });
  });

  describe('Vector F: Core Engine & Policy Gate Edge Paths', () => {
    it('HRD-ENG-01: Strict mode converts REVIEW verdict to exitCode 1', async () => {
      const mockPolicyEngine = {
        evaluate: vi.fn().mockReturnValue({
          verdict: 'REVIEW',
          summary: 'Review required for risky changes',
          findings: [],
          rulesEvaluated: 1,
          ruleOutcomes: [],
        }),
      };

      const engine = new DefaultGitGuardEngine({
        gitAdapter: adapter,
        policyEngine: mockPolicyEngine as any,
      });

      // Strict mode -> exitCode 1
      const strictCheck = await engine.check({
        strict: true,
        cwd: fixture.repoPath,
        offline: true,
      });
      expect(strictCheck.status).toBe('REVIEW');
      expect(strictCheck.exitCode).toBe(1);

      // Non-strict mode -> exitCode 0
      const nonStrictCheck = await engine.check({
        strict: false,
        cwd: fixture.repoPath,
        offline: true,
      });
      expect(nonStrictCheck.status).toBe('REVIEW');
      expect(nonStrictCheck.exitCode).toBe(0);
    });

    it('HRD-ENG-02: Bulk verify without findingIds automatically queries active findings', async () => {
      const mockFindingManager = {
        getFindings: vi.fn().mockReturnValue([
          {
            id: 'finding-bulk-1',
            ruleId: 'deterministic.secret_scan',
            status: 'block',
            severity: 'CRITICAL',
            lifecycle: 'active',
            affectedFiles: ['src/token.ts'],
            message: 'Secret detected',
            evidence: [],
            expectedEvidence: [],
            fingerprint: 'fp_bulk_1',
            createdAt: new Date().toISOString(),
          },
        ]),
        resolveFindings: vi.fn().mockImplementation((prev) => ({
          status: 'PASS',
          verdictSummary: 'All active findings verified and resolved',
          resolved: prev.map((f: any) => f.id),
          remaining: [],
          findings: [],
          resolvedFindings: prev.map((f: any) => f.id),
          remainingFindings: [],
        })),
      };

      const engine = new DefaultGitGuardEngine({
        gitAdapter: adapter,
        findingManager: mockFindingManager as any,
      });

      const report = await engine.verify({ cwd: fixture.repoPath, offline: true });
      expect(mockFindingManager.getFindings).toHaveBeenCalledWith({ lifecycle: 'active' });
      expect(report.resolved).toContain('finding-bulk-1');
      expect(report.status).toBe('PASS');
    });

    it('HRD-ENG-03: Deterministic runner config mapping covers typecheck commands', () => {
      const runnerConfig = toDeterministicRunnerConfig({
        typecheck: {
          enabled: true,
          run: 'tsc --noEmit',
          timeout_ms: 12000,
        },
      });

      expect(runnerConfig.checks?.typecheck?.enabled).toBe(true);
      expect(runnerConfig.checks?.typecheck?.command).toBe('tsc --noEmit');
      expect(runnerConfig.checks?.typecheck?.timeoutMs).toBe(12000);
      expect(runnerConfig.commands?.typecheck?.run).toBe('tsc --noEmit');
      expect(runnerConfig.commands?.typecheck?.timeoutMs).toBe(12000);
    });

    it('HRD-CFG-01: Zero-config unreadable directory as config path wrapped in ConfigurationError', async () => {
      // Create a directory named .gitguard.yml in the repository
      const dirConfig = path.join(fixture.repoPath, '.gitguard.yml');
      await fs.mkdir(dirConfig, { recursive: true });

      await expect(loadConfig(undefined, fixture.repoPath)).rejects.toThrow(
        ConfigurationError
      );
      await expect(loadConfig(undefined, fixture.repoPath)).rejects.toThrow(
        /Failed to read config/i
      );
    });
  });

  describe('Vector G: CLI & MCP Interface Untested Pathways', () => {
    it('HRD-CLI-01: CLI check --findings id1,id2 parses comma-separated string', async () => {
      const mockEngine = {
        check: vi.fn().mockResolvedValue({
          status: 'PASS',
          verdictSummary: 'Passed',
          diffSummary: { totalFiles: 0, insertions: 0, deletions: 0, files: [] },
          findings: [],
          deterministicResults: [],
          semanticDecisions: [],
          exitCode: 0,
        }),
      };

      const outcome = await checkCommand(
        undefined,
        { findings: 'FINDING-1, FINDING-2', silent: true },
        mockEngine as any
      );

      expect(outcome.exitCode).toBe(0);
      expect(mockEngine.check).toHaveBeenCalledWith(
        expect.objectContaining({
          findingIds: ['FINDING-1', 'FINDING-2'],
        })
      );
    });

    it('HRD-CLI-02: CLI exception catching handles engine failures gracefully', async () => {
      const faultyEngine = {
        check: vi.fn().mockRejectedValue(new Error('Simulated check crash')),
        getFindings: vi.fn().mockRejectedValue(new Error('Simulated findings crash')),
        verify: vi.fn().mockRejectedValue(new Error('Simulated verify crash')),
      };

      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const checkRes = await checkCommand(undefined, { silent: false }, faultyEngine as any);
      expect(checkRes.exitCode).toBe(1);
      expect(checkRes.output).toContain('Error executing check: Simulated check crash');

      const findingsRes = await findingsCommand({ silent: false }, faultyEngine as any);
      expect(findingsRes.exitCode).toBe(1);
      expect(findingsRes.output).toContain('Error retrieving findings: Simulated findings crash');

      const verifyRes = await verifyCommand({ silent: false }, faultyEngine as any);
      expect(verifyRes.exitCode).toBe(1);
      expect(verifyRes.output).toContain('Error executing verify: Simulated verify crash');

      logSpy.mockRestore();
    });

    it('HRD-CLI-03: CLI MCP command launch and SIGINT graceful shutdown', async () => {
      const registeredSignals: Record<string, Function> = {};
      const onSpy = vi.spyOn(process, 'on').mockImplementation((signal: any, handler: any) => {
        registeredSignals[signal] = handler;
        return process;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const startSpy = vi.spyOn(GitGuardMcpServer.prototype, 'start').mockResolvedValue(undefined);
      const closeSpy = vi.spyOn(GitGuardMcpServer.prototype, 'close').mockResolvedValue(undefined);

      const server = await mcpCommand({ debug: true });
      expect(server).toBeDefined();
      expect(startSpy).toHaveBeenCalled();
      expect(registeredSignals['SIGINT']).toBeDefined();
      expect(registeredSignals['SIGTERM']).toBeDefined();

      // Trigger SIGINT signal callback
      await registeredSignals['SIGINT']();
      expect(closeSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);

      onSpy.mockRestore();
      exitSpy.mockRestore();
      startSpy.mockRestore();
      closeSpy.mockRestore();
    });

    it('HRD-MCP-01: MCP server debug diagnostic logs during lifecycle and close failure handling', async () => {
      const server = new GitGuardMcpServer({ debug: true });
      const mockTransport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        onclose: undefined,
        onerror: undefined,
        onmessage: undefined,
      };

      await server.start(mockTransport as any);
      expect(mockTransport.start).toHaveBeenCalled();

      await server.close();
      expect(mockTransport.close).toHaveBeenCalled();

      // Test error recovery when server close throws
      const faultyTransport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockRejectedValue(new Error('Transport close failed')),
        send: vi.fn().mockResolvedValue(undefined),
      };
      const server2 = new GitGuardMcpServer({ debug: true });
      await server2.start(faultyTransport as any);
      await expect(server2.close()).resolves.not.toThrow();
    });

    it('HRD-MCP-02: Unknown MCP tool execution fallback returns structured error', async () => {
      const res = await executeMcpTool('unknown_custom_tool', {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Unknown tool name: "unknown_custom_tool"');
    });

    it('HRD-SEM-01: Mock provider decision edge cases (low risk, test change, security intent)', async () => {
      const provider = new DeterministicMockProvider();

      // 1. totalLines <= 100 -> 'low' regression risk
      const diff50 = {
        raw: '',
        files: [
          {
            newPath: 'src/feature.ts',
            status: 'modified' as const,
            binary: false,
            hunks: [{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 50, header: '', lines: [] }],
            additions: 50,
            deletions: 0,
          },
        ],
        insertions: 50,
        deletions: 0,
        truncated: false,
        totalFiles: 1,
      };
      const ctx1 = {
        repo: { rootPath: '' },
        diff: diff50,
        files: [],
        instructions: [],
        relatedTests: [],
      };
      const dec1 = await provider.evaluate(ctx1, [
        { id: 'regression_risk', type: 'choice', prompt: 'Assess regression risk' },
      ]);
      expect(dec1.find((d) => d.id === 'regression_risk')?.value).toBe('low');

      // 2. all test files -> change_type 'test'
      const testDiff = {
        raw: '',
        files: [
          {
            newPath: 'tests/unit/app.test.ts',
            status: 'modified' as const,
            binary: false,
            hunks: [],
            additions: 10,
            deletions: 0,
          },
        ],
        insertions: 10,
        deletions: 0,
        truncated: false,
        totalFiles: 1,
      };
      const ctx2 = {
        repo: { rootPath: '' },
        diff: testDiff,
        files: [],
        instructions: [],
        relatedTests: [],
      };
      const dec2 = await provider.evaluate(ctx2, [
        { id: 'change_type', type: 'choice', prompt: 'Classify change type' },
      ]);
      expect(dec2.find((d) => d.id === 'change_type')?.value).toBe('test');

      // 3. security task -> change_type 'security'
      const ctx3 = {
        repo: { rootPath: '' },
        diff: {
          raw: '',
          files: [
            {
              newPath: 'src/auth.ts',
              status: 'modified' as const,
              binary: false,
              hunks: [],
              additions: 1,
              deletions: 0,
            },
          ],
          insertions: 1,
          deletions: 0,
          truncated: false,
          totalFiles: 1,
        },
        task: { task: 'Upgrade security token hashing algorithm' },
        files: [],
        instructions: [],
        relatedTests: [],
      };
      const dec3 = await provider.evaluate(ctx3, [
        { id: 'change_type', type: 'choice', prompt: 'Classify change type' },
      ]);
      expect(dec3.find((d) => d.id === 'change_type')?.value).toBe('security');
    });
  });
});
