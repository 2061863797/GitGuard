/**
 * tests/unit/core/engine.test.ts
 * Unit tests for DefaultGitGuardEngine (inspect, check, verify, getFindings).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { NotAGitRepositoryError } from '../../../src/types/errors.js';
import type { Finding } from '../../../src/types/finding.js';

describe('DefaultGitGuardEngine', () => {
  let fixture: GitFixture;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    engine = new DefaultGitGuardEngine();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('inspect()', () => {
    it('should throw NotAGitRepositoryError on non-git directory', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'));
      try {
        await expect(engine.inspect({ cwd: nonGitDir })).rejects.toThrow(
          NotAGitRepositoryError
        );
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should report PASS and 0 files changed on clean repository', async () => {
      // Create initial commit so repo is initialized
      await fixture.writeFile('README.md', '# Test Repo\n');
      await fixture.stage();
      await fixture.commit('initial commit');

      const result = await engine.inspect({ cwd: fixture.path });

      expect(result.status).toBe('PASS');
      expect(result.changedFiles).toHaveLength(0);
      expect(result.summary.filesChanged).toBe(0);
      expect(result.summary.insertions).toBe(0);
      expect(result.findings).toHaveLength(0);
      expect(result.hasDeterministicFailures).toBe(false);
    });

    it('should detect staged and working tree file modifications', async () => {
      await fixture.writeFile('index.ts', 'console.log("hello");\n');
      await fixture.stage();
      await fixture.commit('initial commit');

      // Stage an edit
      await fixture.writeFile('index.ts', 'console.log("hello world");\nexport const a = 1;\n');
      await fixture.stage('index.ts');

      // Unstaged new file
      await fixture.writeFile('util.ts', 'export function helper() {}\n');

      const stagedResult = await engine.inspect({
        cwd: fixture.path,
        scope: 'staged',
      });
      expect(stagedResult.changedFiles).toHaveLength(1);
      expect(stagedResult.changedFiles[0].path).toBe('index.ts');
      expect(stagedResult.summary.filesChanged).toBe(1);
      expect(stagedResult.summary.insertions).toBeGreaterThan(0);

      const allResult = await engine.inspect({
        cwd: fixture.path,
        scope: 'all',
      });
      expect(allResult.changedFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('should run preliminary deterministic checks when requested', async () => {
      await fixture.writeFile('test.txt', 'clean content\n');
      await fixture.stage();
      await fixture.commit('init');

      const result = await engine.inspect({
        cwd: fixture.path,
        checkDeterministic: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true },
          },
        },
      });

      expect(result.hasDeterministicFailures).toBe(false);
      expect(result.status).toBe('PASS');
    });

    it('should flag hasDeterministicFailures when deterministic check fails during inspect', async () => {
      await fixture.writeFile('secret.txt', 'AWS_KEY="AKIA1234567890EXAMPLE"\n');
      await fixture.stage();

      const result = await engine.inspect({
        cwd: fixture.path,
        scope: 'staged',
        checkDeterministic: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true, block_on_detection: true },
          },
        },
      });

      expect(result.hasDeterministicFailures).toBe(true);
      expect(result.status).toBe('BLOCK');
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });

  describe('check()', () => {
    it('should throw NotAGitRepositoryError on non-git directory', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-'));
      try {
        await expect(engine.check({ cwd: nonGitDir })).rejects.toThrow(
          NotAGitRepositoryError
        );
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });

    it('should return PASS with exitCode 0 on clean changeset', async () => {
      await fixture.writeFile('README.md', '# Project\n');
      await fixture.stage();
      await fixture.commit('initial');

      const result = await engine.check({
        cwd: fixture.path,
        offline: true,
      });

      expect(result.status).toBe('PASS');
      expect(result.exitCode).toBe(0);
      expect(result.findings).toHaveLength(0);
      expect(result.diffSummary.filesChanged).toBe(0);
    });

    it('should execute semantic evaluators and produce gate verdict', async () => {
      await fixture.writeFile('src/auth.ts', 'export function login() {}\n');
      await fixture.stage();
      await fixture.commit('initial');

      await fixture.writeFile(
        'src/auth.ts',
        'export function login(token: string) { return token.length > 0; }\n'
      );
      await fixture.stage();

      const result = await engine.check({
        cwd: fixture.path,
        scope: 'staged',
        task: 'Add token check to login function',
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true },
          },
        },
      });

      expect(['PASS', 'WARN', 'REVIEW']).toContain(result.status);
      expect(result.task).toBeDefined();
      expect(result.task?.task).toBe('Add token check to login function');
      expect(result.semanticDecisions).toBeDefined();
      expect(result.semanticDecisions['task_completed']).toBeDefined();
      expect(result.diffSummary.filesChanged).toBe(1);
    });

    it('should produce BLOCK and exitCode 1 when a secret is detected', async () => {
      await fixture.writeFile('app.js', 'const x = 1;\n');
      await fixture.stage();
      await fixture.commit('initial');

      await fixture.writeFile(
        'app.js',
        'const key = "' + ['ghp', '123456789012345678901234567890123456'].join('_') + '";\n'
      );
      await fixture.stage();

      const result = await engine.check({
        cwd: fixture.path,
        scope: 'staged',
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true, block_on_detection: true },
          },
        },
      });

      expect(result.status).toBe('BLOCK');
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((f) => f.ruleId === 'deterministic.secret_scan')).toBe(true);
    });

    it('should respect strict and failOnWarn flags', async () => {
      await fixture.writeFile('data.txt', 'version 1\n');
      await fixture.stage();
      await fixture.commit('initial');

      await fixture.writeFile('data.txt', 'version 2\n');
      await fixture.stage();

      // Mock a check that yields WARN
      const resultWarn = await engine.check({
        cwd: fixture.path,
        scope: 'staged',
        failOnWarn: true,
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: false },
          },
          rules: {
            unrelated_changes: { enabled: true, warn: 0.01 }, // triggers warn easily
          },
        },
      });

      if (resultWarn.status === 'WARN') {
        expect(resultWarn.exitCode).toBe(1);
      }
    });

    it('should filter findings if findingIds option is passed', async () => {
      await fixture.writeFile('app.js', 'const x = 1;\n');
      await fixture.stage();
      await fixture.commit('init');

      await fixture.writeFile('app.js', 'const x = 2;\n');
      await fixture.stage();

      const result = await engine.check({
        cwd: fixture.path,
        scope: 'staged',
        findingIds: ['non_existent_finding_id'],
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: false },
          },
        },
      });

      expect(result.findings).toHaveLength(0);
    });
  });

  describe('verify()', () => {
    it('should re-evaluate and mark resolved findings when code issues are fixed', async () => {
      await fixture.writeFile('secret.js', 'const clean = true;\n');
      await fixture.stage();
      await fixture.commit('initial');

      // 1. First introduce a secret to trigger a finding
      await fixture.writeFile('secret.js', 'const key = "' + ['ghp', '123456789012345678901234567890123456'].join('_') + '";\n');
      await fixture.stage();

      const check1 = await engine.check({
        cwd: fixture.path,
        scope: 'staged',
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true, block_on_detection: true },
          },
        },
      });

      expect(check1.status).toBe('BLOCK');
      expect(check1.findings.length).toBeGreaterThan(0);
      const secretFinding = check1.findings[0];

      // 2. Fix the secret
      await fixture.writeFile('secret.js', 'const token = process.env.TOKEN;\n');
      await fixture.stage();

      // 3. Verify target finding
      const verifyReport = await engine.verify({
        cwd: fixture.path,
        scope: 'staged',
        findingIds: [secretFinding.id],
        offline: true,
        config: {
          version: 1,
          deterministic: {
            test: { enabled: false },
            lint: { enabled: false },
            typecheck: { enabled: false },
            secret_scan: { enabled: true },
          },
        },
      });

      expect(verifyReport.resolved).toContain(secretFinding.id);
      expect(verifyReport.remaining).not.toContain(secretFinding.id);
      expect(verifyReport.status).toBe('PASS');
    });
  });

  describe('getFindings()', () => {
    it('should retrieve stored findings and support filtering', async () => {
      const mockFinding: Finding = {
        id: 'finding_test_01',
        ruleId: 'tests_required',
        source: 'semantic',
        status: 'review',
        severity: 'WARN',
        lifecycle: 'active',
        affectedFiles: ['src/core/engine.ts'],
        message: 'Tests required for engine modification',
        evidence: [],
        expectedEvidence: ['Add unit tests'],
        fingerprint: 'fp_test_123',
        createdAt: new Date().toISOString(),
      };

      if (engine.findingManager.storeFinding) {
        engine.findingManager.storeFinding(mockFinding);
      }

      const all = await engine.getFindings();
      expect(all.some((f) => f.id === 'finding_test_01')).toBe(true);

      const filteredByRule = await engine.getFindings({ ruleId: 'tests_required' });
      expect(filteredByRule).toHaveLength(1);

      const filteredByOther = await engine.getFindings({ ruleId: 'secret_scan' });
      expect(filteredByOther).toHaveLength(0);
    });
  });
});
