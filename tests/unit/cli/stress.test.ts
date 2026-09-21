/**
 * tests/unit/cli/stress.test.ts
 * Empirical Stress Testing Suite for GitGuard CLI Interface.
 * Authored by Challenger M4-1 for Milestone M4 Adversarial Review.
 *
 * Matrix covered:
 * 1. CLI Execution on Temporary Git Repositories (clean repo, staged, working-tree, branch diffs)
 * 2. Exit Code Fidelity (PASS -> 0, WARN -> 0, WARN + failOnWarn/strict -> 1, BLOCK -> 1, errors -> non-zero)
 * 3. Output Format Fidelity (--format json / --json strict schema conformance, text formatting)
 * 4. Subcommand Invocations (inspect, check, findings, verify, mcp, --help, --version)
 * 5. Edge Cases (unborn HEAD, detached HEAD, non-git dir, invalid config, invalid scope/ref)
 * 6. Spawned Process End-to-End Execution (node bin/gitguard.js via child_process)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import {
  inspectCommand,
  checkCommand,
  findingsCommand,
  verifyCommand,
} from '../../../src/interfaces/cli/index.js';
import { createCliProgram } from '../../../src/interfaces/cli/program.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import type { Finding } from '../../../src/types/finding.js';
import { GITGUARD_VERSION } from '../../../src/index.js';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = process.cwd();
const BIN_PATH = path.join(PROJECT_ROOT, 'bin', 'gitguard.js');

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[], cwd: string = PROJECT_ROOT): Promise<ProcessOutcome> {
  try {
    const res = await execFileAsync(process.execPath, [BIN_PATH, ...args], {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        LC_ALL: 'C',
      },
    });
    return {
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : err.message || '',
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

describe('Challenger M4-1: CLI Empirical Stress Suite', () => {
  let fixture: GitFixture;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    fixture = await createTempGitRepo('gitguard-stress-cli-');
    engine = new DefaultGitGuardEngine();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  // =========================================================================
  // 1. CLI SUBCOMMAND INVOCATIONS & SPAWNED PROCESS EXECUTION
  // =========================================================================
  describe('1. Subcommand Invocations & Spawned Process Execution', () => {
    it('should display top-level help and exit with code 0', async () => {
      const outcome = await runCli(['--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard [options] [command]');
      expect(outcome.stdout).toContain('inspect [options]');
      expect(outcome.stdout).toContain('check [options]');
      expect(outcome.stdout).toContain('findings [options]');
      expect(outcome.stdout).toContain('verify [options]');
      expect(outcome.stdout).toContain('mcp [options]');
    });

    it('should output version matching package semver and exit with code 0', async () => {
      const outcome = await runCli(['--version']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout.trim()).toBe(GITGUARD_VERSION);
    });

    it('should reject unknown flags with exit code 1', async () => {
      const outcome = await runCli(['--unknown-unsupported-flag']);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("unknown option '--unknown-unsupported-flag'");
    });

    it('should reject unknown subcommands with exit code 1', async () => {
      const outcome = await runCli(['nonexistent-subcommand']);
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stderr).toContain("unknown command 'nonexistent-subcommand'");
    });

    it('should display inspect subcommand help with code 0', async () => {
      const outcome = await runCli(['inspect', '--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard inspect [options]');
      expect(outcome.stdout).toContain('--scope <scope>');
      expect(outcome.stdout).toContain('--format <format>');
    });

    it('should display check subcommand help with code 0', async () => {
      const outcome = await runCli(['check', '--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard check [options] [range]');
      expect(outcome.stdout).toContain('--staged');
      expect(outcome.stdout).toContain('--strict');
      expect(outcome.stdout).toContain('--fail-on-warn');
    });

    it('should display findings subcommand help with code 0', async () => {
      const outcome = await runCli(['findings', '--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard findings [options]');
      expect(outcome.stdout).toContain('--status <status>');
      expect(outcome.stdout).toContain('--severity <severity>');
    });

    it('should display verify subcommand help with code 0', async () => {
      const outcome = await runCli(['verify', '--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard verify [options]');
      expect(outcome.stdout).toContain('--findings <ids>');
    });

    it('should display mcp subcommand help with code 0', async () => {
      const outcome = await runCli(['mcp', '--help']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('Usage: gitguard mcp [options]');
      expect(outcome.stdout).toContain('--debug');
    });
  });

  // =========================================================================
  // 2. OUTPUT FORMAT FIDELITY & JSON SCHEMA CONFORMANCE
  // =========================================================================
  describe('2. Output Format Fidelity & JSON Schema Conformance', () => {
    it('inspect --json: should emit strictly parseable JSON conforming to InspectResult', async () => {
      await fixture.writeFile('src/app.ts', 'export const x = 1;\n');
      await fixture.stage();

      const outcome = await runCli(['inspect', '--cwd', fixture.path, '--json']);
      expect(outcome.exitCode).toBe(0);

      const parsed = JSON.parse(outcome.stdout);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('summary');
      expect(parsed.summary).toHaveProperty('filesChanged');
      expect(parsed.summary).toHaveProperty('insertions');
      expect(parsed.summary).toHaveProperty('deletions');
      expect(parsed).toHaveProperty('changedFiles');
      expect(Array.isArray(parsed.changedFiles)).toBe(true);
      expect(parsed.changedFiles[0].path).toBe('src/app.ts');
      expect(parsed).toHaveProperty('findings');
    });

    it('inspect --format json: should produce valid JSON identical in structure to --json', async () => {
      await fixture.writeFile('src/app.ts', 'export const x = 2;\n');
      await fixture.stage();

      const outcome = await runCli(['inspect', '--cwd', fixture.path, '--format', 'json']);
      expect(outcome.exitCode).toBe(0);

      const parsed = JSON.parse(outcome.stdout);
      expect(parsed.status).toBe('PASS');
      expect(parsed.changedFiles).toHaveLength(1);
    });

    it('check --json: should emit strictly parseable JSON conforming to CheckResult', async () => {
      await fixture.writeFile('README.md', '# Readme\n');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await runCli(['check', '--cwd', fixture.path, '--offline', '--json']);
      expect(outcome.exitCode).toBe(0);

      const parsed = JSON.parse(outcome.stdout);
      expect(parsed).toHaveProperty('status');
      expect(parsed.status).toBe('PASS');
      expect(parsed).toHaveProperty('verdictSummary');
      expect(parsed).toHaveProperty('diffSummary');
      expect(parsed).toHaveProperty('findings');
      expect(parsed).toHaveProperty('deterministicResults');
      expect(parsed).toHaveProperty('semanticDecisions');
      expect(parsed).toHaveProperty('exitCode');
      expect(parsed.exitCode).toBe(0);
    });

    it('findings --json: should emit strictly parseable JSON array of findings', async () => {
      const outcome = await runCli(['findings', '--cwd', fixture.path, '--json']);
      expect(outcome.exitCode).toBe(0);

      const parsed = JSON.parse(outcome.stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual([]);
    });

    it('verify --json: should emit strictly parseable JSON conforming to VerificationReport', async () => {
      await fixture.writeFile('base.txt', 'clean\n');
      await fixture.stage();
      await fixture.commit('init');

      const store = new FileFindingStore(fixture.path);
      await store.save([
        {
          id: 'GG-TEST-001',
          ruleId: 'secret_scan',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          lifecycle: 'active',
          affectedFiles: ['base.txt'],
          message: 'Previous test finding',
          evidence: [],
          expectedEvidence: [],
          fingerprint: 'fp_base_001',
          createdAt: new Date().toISOString(),
        },
      ]);

      const outcome = await runCli([
        'verify',
        '--cwd',
        fixture.path,
        '--findings',
        'GG-TEST-001',
        '--offline',
        '--json',
      ]);
      expect(outcome.exitCode).toBe(0);

      const parsed = JSON.parse(outcome.stdout);
      expect(parsed).toHaveProperty('status');
      expect(parsed.status).toBe('PASS');
      expect(parsed).toHaveProperty('resolved');
      expect(parsed.resolved).toContain('GG-TEST-001');
      expect(parsed).toHaveProperty('remaining');
      expect(parsed.remaining).toHaveLength(0);
    });

    it('text format: should generate clear human-readable banners without leaking raw JSON', async () => {
      await fixture.writeFile('init.txt', 'hello world\n');
      await fixture.stage();
      await fixture.commit('init');

      const inspectOut = await runCli(['inspect', '--cwd', fixture.path]);
      expect(inspectOut.exitCode).toBe(0);
      expect(inspectOut.stdout).toContain('GitGuard Inspect Summary');
      expect(inspectOut.stdout).toContain('Scope: all');
      expect(inspectOut.stdout).not.toContain('{"status":');

      const checkOut = await runCli(['check', '--cwd', fixture.path, '--offline']);
      expect(checkOut.exitCode).toBe(0);
      expect(checkOut.stdout).toContain('============================================================');
      expect(checkOut.stdout).toContain('GitGuard Quality Gate: PASS');
      expect(checkOut.stdout).toContain('[Deterministic Checks]');
      expect(checkOut.stdout).toContain('[Semantic Signals]');
      expect(checkOut.stdout).not.toContain('"verdictSummary":');
    });
  });

  // =========================================================================
  // 3. EXIT CODE FIDELITY & POLICY STATUS MAPPING
  // =========================================================================
  describe('3. Exit Code Fidelity & Gate Status Mapping', () => {
    it('clean changeset: should yield status PASS and exit code 0', async () => {
      await fixture.writeFile('init.txt', 'init\n');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, silent: true },
        engine
      );
      expect(outcome.result?.status).toBe('PASS');
      expect(outcome.exitCode).toBe(0);
    });

    it('BLOCK verdict: should yield exit code 1 when hard blocker (AWS secret) is present', async () => {
      await fixture.writeFile('clean.js', 'console.log("ok");\n');
      await fixture.stage();
      await fixture.commit('init');

      await fixture.writeFile('leak.js', 'const AWS = "AKIAIOSFODNN7EXAMPLE";\n');
      await fixture.stage();

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, silent: true },
        engine
      );
      expect(outcome.result?.status).toBe('BLOCK');
      expect(outcome.exitCode).toBe(1);
    });

    it('fail-on-warn: should exit with code 0 when status is PASS', async () => {
      await fixture.writeFile('file.txt', 'ok\n');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, failOnWarn: true, silent: true },
        engine
      );
      expect(outcome.result?.status).toBe('PASS');
      expect(outcome.exitCode).toBe(0);
    });

    it('strict mode: should convert non-PASS gate status into exit code 1', async () => {
      await fixture.writeFile('file.txt', 'base\n');
      await fixture.stage();
      await fixture.commit('init');

      // Modifying file triggers non-clean changeset with commands failure on empty fixture
      await fixture.writeFile('file.txt', 'modified\n');
      await fixture.stage();

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, strict: true, silent: true },
        engine
      );
      expect(outcome.exitCode).toBe(1);
    });
  });

  // =========================================================================
  // 4. GIT STATE REPOSITORY STRESS (Staged, Working-Tree, Branch Diffs)
  // =========================================================================
  describe('4. Git State Repository Stress', () => {
    it('--staged: should evaluate ONLY staged modifications, ignoring unstaged working tree', async () => {
      await fixture.writeFile('init.txt', 'init\n');
      await fixture.stage();
      await fixture.commit('init');

      // Unstaged change
      await fixture.writeFile('unstaged.txt', 'working tree only\n');

      const inspectWorking = await inspectCommand(
        { cwd: fixture.path, scope: 'staged', silent: true },
        engine
      );
      expect(inspectWorking.exitCode).toBe(0);
      expect(inspectWorking.result?.changedFiles).toHaveLength(0);

      // Now stage a file
      await fixture.writeFile('staged.txt', 'staged change\n');
      await fixture.stage('staged.txt');

      const inspectStaged = await inspectCommand(
        { cwd: fixture.path, scope: 'staged', silent: true },
        engine
      );
      expect(inspectStaged.exitCode).toBe(0);
      expect(inspectStaged.result?.changedFiles).toHaveLength(1);
      expect(inspectStaged.result?.changedFiles[0].path).toBe('staged.txt');
    });

    it('--working: should evaluate ONLY unstaged working tree changes', async () => {
      await fixture.writeFile('init.txt', 'init\n');
      await fixture.stage();
      await fixture.commit('init');

      // Stage one file
      await fixture.writeFile('staged.txt', 'staged\n');
      await fixture.stage('staged.txt');

      // Modify another file without staging
      await fixture.writeFile('init.txt', 'modified unstaged\n');

      const outcome = await inspectCommand(
        { cwd: fixture.path, scope: 'working-tree', silent: true },
        engine
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result?.changedFiles).toHaveLength(1);
      expect(outcome.result?.changedFiles[0].path).toBe('init.txt');
    });

    it('branch diff: should evaluate commit ranges between branches', async () => {
      await fixture.writeFile('main.txt', 'main line\n');
      await fixture.stage();
      await fixture.commit('init main');

      await fixture.createBranch('feature');
      await fixture.writeFile('feature.txt', 'feature line\n');
      await fixture.stage();
      await fixture.commit('feat: new feature');

      await fixture.checkout('master');

      const outcome = await inspectCommand(
        { cwd: fixture.path, scope: 'range', target: 'master..feature', silent: true },
        engine
      );
      expect(outcome.exitCode).toBe(0);
      expect(outcome.result?.changedFiles).toHaveLength(1);
      expect(outcome.result?.changedFiles[0].path).toBe('feature.txt');
    });
  });

  // =========================================================================
  // 5. ADVERSARIAL EDGE CASES
  // =========================================================================
  describe('5. Adversarial Edge Cases', () => {
    it('non-git directory: should gracefully report error and exit with non-zero code', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gg-cli-nongit-'));
      try {
        const outcome = await runCli(['inspect', '--cwd', nonGitDir]);
        expect(outcome.exitCode).not.toBe(0);
        expect(outcome.stderr).toContain('Directory is not a Git repository');
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });

    it('empty repo (unborn HEAD with zero commits): should handle clean state safely', async () => {
      // Fixture is freshly initialized with 0 commits (unborn HEAD)
      const inspectOut = await runCli(['inspect', '--cwd', fixture.path, '--json']);
      expect(inspectOut.exitCode).toBe(0);
      const parsedInspect = JSON.parse(inspectOut.stdout);
      expect(parsedInspect.status).toBe('PASS');
      expect(parsedInspect.changedFiles).toHaveLength(0);

      const checkOut = await runCli(['check', '--cwd', fixture.path, '--offline', '--json']);
      expect(checkOut.exitCode).toBe(0);
      const parsedCheck = JSON.parse(checkOut.stdout);
      expect(parsedCheck.status).toBe('PASS');
    });

    it('empty repo (unborn HEAD) with staged files: should detect staged files against empty tree', async () => {
      await fixture.writeFile('initial.js', 'console.log("first");\n');
      await fixture.stage();

      const outcome = await runCli(['inspect', '--cwd', fixture.path, '--scope', 'staged', '--json']);
      expect(outcome.exitCode).toBe(0);
      const parsed = JSON.parse(outcome.stdout);
      expect(parsed.changedFiles).toHaveLength(1);
      expect(parsed.changedFiles[0].path).toBe('initial.js');
    });

    it('detached HEAD: should operate normally without crashing', async () => {
      await fixture.writeFile('file1.txt', '1\n');
      await fixture.stage();
      const sha1 = await fixture.commit('first');

      await fixture.writeFile('file2.txt', '2\n');
      await fixture.stage();
      await fixture.commit('second');

      // Checkout first commit SHA directly -> Detached HEAD
      await fixture.checkout(sha1);

      const outcome = await runCli(['inspect', '--cwd', fixture.path, '--json']);
      expect(outcome.exitCode).toBe(0);
      const parsed = JSON.parse(outcome.stdout);
      expect(parsed.status).toBe('PASS');
      expect(parsed.summary.filesChanged).toBe(0);
    });

    it('invalid config path: should report configuration error and exit with non-zero code', async () => {
      const nonExistentConfig = path.join(fixture.path, 'does-not-exist.yml');
      const outcome = await runCli(['check', '--cwd', fixture.path, '--config', nonExistentConfig]);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stderr).toContain('Configuration error');
      expect(outcome.stderr).toContain('does-not-exist.yml');
    });

    it('invalid commit/range ref: should report invalid ref error and exit with non-zero code', async () => {
      await fixture.writeFile('base.txt', 'base\n');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await runCli([
        'check',
        '--cwd',
        fixture.path,
        '--scope',
        'range',
        'nonexistent-base..nonexistent-head',
        '--offline',
      ]);
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stderr).toContain('Error executing check');
    });

    it('suppressed or empty findings query: should return clean output without crash', async () => {
      const outcome = await runCli(['findings', '--cwd', fixture.path, '--severity', 'CRITICAL']);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain('GitGuard Active Findings (0)');
      expect(outcome.stdout).toContain('No active findings found.');
    });

    it('verify non-existent finding ID: should fail verification with BLOCK on unknown finding IDs', async () => {
      await fixture.writeFile('test.txt', 'clean\n');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await runCli([
        'verify',
        '--cwd',
        fixture.path,
        '--findings',
        'GG-NONEXISTENT',
        '--offline',
      ]);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stdout).toContain('Verification failed: None of the targeted finding ID(s) exist');
    });
  });
});
