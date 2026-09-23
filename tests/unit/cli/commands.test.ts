/**
 * tests/unit/cli/commands.test.ts
 * Unit tests for GitGuard CLI commands and Commander application wiring.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { createTempGitRepo, type GitFixture } from '../../helpers/git-fixture.js';
import { DefaultGitGuardEngine } from '../../../src/core/engine.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import type { Finding } from '../../../src/types/finding.js';

describe('CLI Commands & Handlers', () => {
  let fixture: GitFixture;
  let engine: DefaultGitGuardEngine;

  beforeEach(async () => {
    fixture = await createTempGitRepo();
    engine = new DefaultGitGuardEngine();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('inspectCommand', () => {
    it('should format inspect text output for clean repo', async () => {
      await fixture.writeFile('init.txt', 'init');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await inspectCommand(
        { cwd: fixture.path, silent: true },
        engine
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('GitGuard Inspect Summary');
      expect(outcome.output).toContain('Status: PASS');
      expect(outcome.result).toBeDefined();
      expect(outcome.result?.changedFiles).toHaveLength(0);
    });

    it('accepts --staged and --working shortcuts consistently with check', async () => {
      await fixture.writeFile('committed.txt', 'initial\n');
      await fixture.stage();
      await fixture.commit('initial');
      await fixture.writeFile('staged.txt', 'staged\n');
      await fixture.stage('staged.txt');
      await fixture.writeFile('working.txt', 'working\n');

      const staged = await inspectCommand(
        { cwd: fixture.path, staged: true, silent: true }, engine
      );
      expect(staged.result?.changedFiles.map((file) => file.path)).toEqual(['staged.txt']);

      const working = await inspectCommand(
        { cwd: fixture.path, working: true, silent: true }, engine
      );
      expect(working.result?.changedFiles.map((file) => file.path)).toEqual(['working.txt']);
    });

    it('should output JSON when --json or --format json is specified', async () => {
      await fixture.writeFile('file.txt', 'hello');
      await fixture.stage();

      const outcome = await inspectCommand(
        { cwd: fixture.path, json: true, silent: true },
        engine
      );

      expect(outcome.exitCode).toBe(0);
      const parsed = JSON.parse(outcome.output);
      expect(parsed.status).toBe('PASS');
      expect(parsed.changedFiles).toHaveLength(1);
      expect(parsed.summary.filesChanged).toBe(1);
    });

    it('should handle non-git directory error and return non-zero exit code', async () => {
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-cli-'));
      try {
        const outcome = await inspectCommand(
          { cwd: nonGitDir, silent: true },
          engine
        );
        expect(outcome.exitCode).toBe(3); // NotAGitRepositoryError has exitCode 3
        expect(outcome.output).toContain('Error executing inspect');
      } finally {
        await fs.rm(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('checkCommand', () => {
    it('should return exitCode 0 on clean changeset', async () => {
      await fixture.writeFile('init.txt', 'init');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, silent: true },
        engine
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('GitGuard Quality Gate: PASS');
      expect(outcome.result?.status).toBe('PASS');
    });

    it('should output formatted JSON when requested', async () => {
      await fixture.writeFile('init.txt', 'init');
      await fixture.stage();
      await fixture.commit('init');

      const outcome = await checkCommand(
        undefined,
        { cwd: fixture.path, offline: true, format: 'json', silent: true },
        engine
      );

      expect(outcome.exitCode).toBe(0);
      const parsed = JSON.parse(outcome.output);
      expect(parsed.status).toBe('PASS');
      expect(parsed.diffSummary).toBeDefined();
    });

    it('should return exitCode 1 when quality gate triggers BLOCK', async () => {
      await fixture.writeFile('file.js', 'console.log("clean");');
      await fixture.stage();
      await fixture.commit('init');

      // Add secret to trigger BLOCK
      await fixture.writeFile('file.js', 'const AWS_KEY = "AKIA1234567890EXAMPLE";');
      await fixture.stage();

      const outcome = await checkCommand(
        undefined,
        {
          cwd: fixture.path,
          offline: true,
          silent: true,
          config: undefined,
        },
        engine
      );

      expect(outcome.exitCode).toBe(1);
      expect(outcome.result?.status).toBe('BLOCK');
      expect(outcome.output).toContain('GitGuard Quality Gate: BLOCK');
    });
  });

  describe('findingsCommand', () => {
    it('should format active findings in text and JSON', async () => {
      const mockFinding: Finding = {
        id: 'GG-001',
        ruleId: 'unrelated_changes',
        source: 'semantic',
        status: 'warn',
        severity: 'WARN',
        lifecycle: 'active',
        affectedFiles: ['src/app.ts'],
        message: 'Unrelated refactor in app.ts',
        evidence: [],
        expectedEvidence: ['Separate into distinct PR'],
        fingerprint: 'fp_12345',
        createdAt: new Date().toISOString(),
      };

      if (engine.findingManager.storeFinding) {
        engine.findingManager.storeFinding(mockFinding);
      }

      const textOutcome = await findingsCommand(
        { silent: true },
        engine
      );
      expect(textOutcome.exitCode).toBe(0);
      expect(textOutcome.output).toContain('GitGuard Active Findings');
      expect(textOutcome.output).toContain('GG-001');

      const jsonOutcome = await findingsCommand(
        { json: true, silent: true },
        engine
      );
      expect(jsonOutcome.exitCode).toBe(0);
      const parsed = JSON.parse(jsonOutcome.output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('GG-001');
    });
  });

  describe('verifyCommand', () => {
    it('should verify resolved findings and output verification report', async () => {
      await fixture.writeFile('test.txt', 'clean\n');
      await fixture.stage();
      await fixture.commit('init');

      const store = new FileFindingStore(fixture.path);
      await store.save([
        {
          id: 'GG-RESOLVED-001',
          ruleId: 'secret_scan',
          source: 'deterministic',
          status: 'block',
          severity: 'CRITICAL',
          lifecycle: 'active',
          affectedFiles: ['test.txt'],
          message: 'Previous finding resolved',
          evidence: [],
          expectedEvidence: [],
          fingerprint: 'fp_test_123',
          createdAt: new Date().toISOString(),
        },
      ]);

      const outcome = await verifyCommand(
        {
          cwd: fixture.path,
          findings: 'GG-RESOLVED-001',
          offline: true,
          silent: true,
        },
        engine
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.output).toContain('GitGuard Verification Loop: PASS');
      expect(outcome.report?.status).toBe('PASS');
    });
  });

  describe('Commander Program Wiring', () => {
    it('should construct Commander CLI with all expected subcommands and flags', () => {
      const program = createCliProgram();
      expect(program.name()).toBe('gitguard');

      const commandNames = program.commands.map((c) => c.name());
      expect(commandNames).toContain('inspect');
      expect(commandNames).toContain('check');
      expect(commandNames).toContain('findings');
      expect(commandNames).toContain('verify');
      expect(commandNames).toContain('mcp');

      const inspect = program.commands.find((command) => command.name() === 'inspect');
      const inspectFlags = inspect?.options.map((option) => option.long);
      expect(inspectFlags).toContain('--staged');
      expect(inspectFlags).toContain('--working');
    });
  });
});
