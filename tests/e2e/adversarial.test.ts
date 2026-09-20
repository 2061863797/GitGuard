/**
 * tests/e2e/adversarial.test.ts
 * Tier 5: Adversarial Coverage Hardening
 * Validates resilience against encodings, evasions, command injection, and timeout exhaustion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTempGitRepo, GitFixture } from './helpers/e2e-harness.js';
import { loadConfig } from '../../src/policy/config.js';
import { scanDiffForSecrets } from '../../src/analysis/deterministic/secrets.js';
import { UnifiedDiffParser } from '../../src/git/diff-parser.js';
import { GitCLIAdapter } from '../../src/git/adapter.js';
import { DefaultContextBuilder } from '../../src/context/builder.js';
import { DeterministicRunner } from '../../src/analysis/deterministic/runner.js';
import { SecurityViolationError } from '../../src/types/errors.js';
import { DefaultGitGuardEngine } from '../../src/core/engine.js';

describe('Tier 5: Adversarial Coverage Hardening', () => {
  let fixture: GitFixture;
  let adapter: GitCLIAdapter;
  let parser: UnifiedDiffParser;
  let runner: DeterministicRunner;

  beforeEach(async () => {
    fixture = await createTempGitRepo('e2e-adv-');
    adapter = new GitCLIAdapter(fixture.repoPath);
    parser = new UnifiedDiffParser();
    runner = new DeterministicRunner({ cwd: fixture.repoPath });

    // Seed repository with an initial commit
    await fixture.writeFile('README.md', '# Test Repo\n');
    await fixture.stage('README.md');
    await fixture.commit('chore: initial commit');
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  describe('Vector A: File Encodings & Byte Stream Anomalies', () => {
    it('ADV-ENC-01: UTF-8 with BOM in .gitguard.yml parses successfully without error', async () => {
      const bomBuffer = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          'version: 1\n' +
            'deterministic:\n' +
            '  secret_scan:\n' +
            '    enabled: true\n' +
            '    block_on_detection: true\n' +
            'rules:\n' +
            '  task_completed:\n' +
            '    enabled: true\n',
          'utf-8'
        ),
      ]);
      await fixture.writeBinaryFile('.gitguard.yml', bomBuffer);

      const config = await loadConfig(undefined, fixture.repoPath);
      expect(config.version).toBe(1);
      expect(config.deterministic.secret_scan.enabled).toBe(true);
      expect(config.rules.task_completed.enabled).toBe(true);
    });

    it('ADV-ENC-02: UTF-8 with BOM in source diff detected by secret scanner', async () => {
      const bomDiff = [
        'diff --git a/config.ts b/config.ts',
        '--- a/config.ts',
        '+++ b/config.ts',
        '@@ -1,1 +1,1 @@',
        '+\uFEFFAKIAIOSFODNN7EXAMPLE',
      ].join('\n');

      const parsed = parser.parse(bomDiff);
      const violations = scanDiffForSecrets(parsed);

      expect(violations.length).toBeGreaterThanOrEqual(1);
      const awsViolation = violations.find((v) => v.rule === 'aws_access_key');
      expect(awsViolation).toBeDefined();
      expect(awsViolation?.line).toBe(1);
      expect(awsViolation?.file).toBe('config.ts');
      expect(awsViolation?.severity).toBe('block');

      // Also verify via full engine check in repo
      await fixture.writeFile('src/key.ts', '\uFEFFAKIAIOSFODNN7EXAMPLE\n');
      await fixture.stage('src/key.ts');
      const engine = new DefaultGitGuardEngine({ gitAdapter: adapter });
      const checkResult = await engine.check({ scope: 'staged', cwd: fixture.repoPath, offline: true });
      expect(checkResult.status).toBe('BLOCK');
      expect(checkResult.findings.some((f) => f.ruleId.includes('secret') || f.ruleId.includes('aws'))).toBe(true);
    });

    it('ADV-ENC-03: UTF-16LE file with null bytes detected as binary and skipped safely', async () => {
      const utf16Buffer = Buffer.from('const apiKey = "AKIAIOSFODNN7EXAMPLE";\n', 'utf16le');
      await fixture.writeBinaryFile('src/data.bin', utf16Buffer);
      await fixture.stage('src/data.bin');

      const diff = await adapter.getDiff('staged', { cwd: fixture.repoPath });
      expect(diff).toContain('Binary files');

      const parsed = parser.parse(diff);
      const binFile = parsed.files.find((f) => f.newPath === 'src/data.bin');
      expect(binFile).toBeDefined();
      expect(binFile?.binary).toBe(true);

      const violations = scanDiffForSecrets(parsed);
      expect(violations).toHaveLength(0);

      const builder = new DefaultContextBuilder(adapter);
      const context = await builder.buildContext({ scope: 'staged', cwd: fixture.repoPath });
      const fileCtx = context.files.find((f) => f.path === 'src/data.bin');
      expect(fileCtx).toBeDefined();
      expect(fileCtx?.spans).toHaveLength(0);
    });

    it('ADV-ENC-04: CRLF line endings and EOF notice parsed without corrupting line content', async () => {
      const crlfDiff =
        'diff --git a/app.ts b/app.ts\r\n' +
        '--- a/app.ts\r\n' +
        '+++ b/app.ts\r\n' +
        '@@ -1,1 +1,2 @@\r\n' +
        ' console.log("hello");\r\n' +
        '+const key = "AKIAIOSFODNN7EXAMPLE";\r\n' +
        '\\ No newline at end of file\r\n';

      const parsed = parser.parse(crlfDiff);
      expect(parsed.files).toHaveLength(1);
      const file = parsed.files[0];
      expect(file.additions).toBe(1);
      expect(file.hunks).toHaveLength(1);
      expect(file.hunks[0].lines[1]).toBe('+const key = "AKIAIOSFODNN7EXAMPLE";');
      expect(file.hunks[0].lines[1].endsWith('\r')).toBe(false);

      const violations = scanDiffForSecrets(parsed);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].rule).toBe('aws_access_key');
    });

    it('ADV-ENC-05: Quoted and non-ASCII git paths unescaped accurately', async () => {
      const octalDiff = [
        'diff --git "a/\\344\\270\\255\\346\\226\\207.ts" "b/\\344\\270\\255\\346\\226\\207.ts"',
        '--- "a/\\344\\270\\255\\346\\226\\207.ts"',
        '+++ "b/\\344\\270\\255\\346\\226\\207.ts"',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
        'diff --git "a/path/\\"quoted\\".ts" "b/path/\\"quoted\\".ts"',
        '--- "a/path/\\"quoted\\".ts"',
        '+++ "b/path/\\"quoted\\".ts"',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n');

      const parsed = parser.parse(octalDiff);
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].newPath).toBe('中文.ts');
      expect(parsed.files[1].newPath).toBe('path/"quoted".ts');
    });
  });

  describe('Vector C: Secret Scanning Evasion Techniques', () => {
    it('ADV-SEC-01: Backtick template literal password caught by secret scanner', async () => {
      const backtickDiff = [
        'diff --git a/auth.ts b/auth.ts',
        '--- a/auth.ts',
        '+++ b/auth.ts',
        '@@ -1,1 +1,2 @@',
        ' export function auth() {',
        '+  const dbPassword = `superSecretPassword123!`;',
      ].join('\n');

      const parsed = parser.parse(backtickDiff);
      const violations = scanDiffForSecrets(parsed);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations[0].rule).toBe('hardcoded_secret');
      expect(violations[0].severity).toBe('block');
      expect(violations[0].message).toContain('[REDACTED]');
    });

    it('ADV-SEC-02: Multiline token fragmentation scanned within window and contained beyond window', async () => {
      // 1. Within 5-line window: credential declaration split across 2 consecutive lines
      const consecutiveDiff = [
        'diff --git a/aws.ts b/aws.ts',
        '--- a/aws.ts',
        '+++ b/aws.ts',
        '@@ -1,1 +1,3 @@',
        ' const config = {',
        '+  aws_secret_access_key:',
        '+    "1234567890123456789012345678901234567890",',
      ].join('\n');

      const parsedConsecutive = parser.parse(consecutiveDiff);
      const violationsConsecutive = scanDiffForSecrets(parsedConsecutive);
      expect(violationsConsecutive.length).toBeGreaterThanOrEqual(1);
      expect(violationsConsecutive[0].rule).toBe('aws_secret_key');

      // 2. Beyond 5-line window: lines separated by 6 context lines do not cross-match
      const farLinesDiff = [
        'diff --git a/split.ts b/split.ts',
        '--- a/split.ts',
        '+++ b/split.ts',
        '@@ -1,1 +1,9 @@',
        '+const a = "aws_secret_key=";',
        ' context line 1',
        ' context line 2',
        ' context line 3',
        ' context line 4',
        ' context line 5',
        ' context line 6',
        '+const b = "1234567890123456789012345678901234567890";',
      ].join('\n');

      const parsedFar = parser.parse(farLinesDiff);
      const violationsFar = scanDiffForSecrets(parsedFar);
      // Neither isolated addition line matches the complete aws_secret_key pattern independently
      expect(violationsFar.filter((v) => v.rule === 'aws_secret_key')).toHaveLength(0);
    });

    it('ADV-SEC-03: Comment-embedded credentials detected', async () => {
      const commentDiff = [
        'diff --git a/comment.ts b/comment.ts',
        '--- a/comment.ts',
        '+++ b/comment.ts',
        '@@ -1,1 +1,3 @@',
        ' // Context',
        '+// AKIAIOSFODNN7EXAMPLE',
        '+/* AKIAIOSFODNN7EXAMPLL */',
      ].join('\n');

      const parsed = parser.parse(commentDiff);
      const violations = scanDiffForSecrets(parsed);
      expect(violations.length).toBe(2);
      expect(violations[0].rule).toBe('aws_access_key');
      expect(violations[1].rule).toBe('aws_access_key');
    });

    it('ADV-SEC-04: False-positive placeholder bypass correctly distinguishes placeholders from real credentials', async () => {
      const placeholderDiff = [
        'diff --git a/placeholders.ts b/placeholders.ts',
        '--- a/placeholders.ts',
        '+++ b/placeholders.ts',
        '@@ -1,1 +1,5 @@',
        '+const password = "placeholder";',
        '+const passwd = "CHANGEME";',
        '+const api_key = "your_secret_here";',
        '+const auth_token = "placeholder_real_secret_token_12345";',
      ].join('\n');

      const parsed = parser.parse(placeholderDiff);
      const violations = scanDiffForSecrets(parsed);

      // Only the non-exact placeholder variant should trigger a violation
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('hardcoded_secret');
      expect(violations[0].line).toBe(4);
    });

    it('ADV-SEC-05: Duplicate violation suppression on identical line and rule', async () => {
      const duplicateDiff = [
        'diff --git a/dup.ts b/dup.ts',
        '--- a/dup.ts',
        '+++ b/dup.ts',
        '@@ -1,1 +1,2 @@',
        ' const a = 1;',
        '+const key = "AKIAIOSFODNN7EXAMPLE";',
        '@@ -10,1 +10,2 @@',
        ' const b = 2;',
        '+const other = "AKIAIOSFODNN7EXAMPLE";',
      ].join('\n');

      const parsed = parser.parse(duplicateDiff);
      // Manually simulate duplicate lines on line 2 in same file/rule
      parsed.files[0].hunks.push({
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        header: '@@ -1,1 +1,2 @@',
        lines: [' const a = 1;', '+const key = "AKIAIOSFODNN7EXAMPLE";'],
      });

      const violations = scanDiffForSecrets(parsed);
      // Verify deduplication: same file, same rule, same line is reported only once
      const line2Violations = violations.filter((v) => v.line === 2 && v.rule === 'aws_access_key');
      expect(line2Violations).toHaveLength(1);
    });
  });

  describe('Vector D: Command Injection & Deterministic Runner Hardening', () => {
    const dummyContext = {
      repo: { rootPath: '' },
      diff: { raw: '', files: [], insertions: 0, deletions: 0, truncated: false, totalFiles: 0 },
      files: [],
      instructions: [],
      relatedTests: [],
    };

    it('ADV-INJ-01: Semicolon chaining injection strictly rejected', async () => {
      await expect(
        runner.run(dummyContext, {
          checks: { test: { enabled: true, command: 'npm test; rm -rf /' }, secret_scan: { enabled: false } },
        })
      ).rejects.toThrow(SecurityViolationError);
    });

    it('ADV-INJ-02: Shell metacharacters and redirection injection variants strictly rejected', async () => {
      const injectionPayloads = [
        'npm test && calc.exe',
        'npm test | cat /etc/passwd',
        'npm test > hacked.txt',
        'npm test < input.txt',
        'npm test `id`',
        'npm test $(whoami)',
        'npm test \n id',
      ];

      for (const cmd of injectionPayloads) {
        await expect(
          runner.run(dummyContext, {
            checks: { test: { enabled: true, command: cmd }, secret_scan: { enabled: false } },
          })
        ).rejects.toThrow(SecurityViolationError);
      }
    });

    it('ADV-INJ-03: Unclosed quotes injection strictly rejected', async () => {
      await expect(
        runner.run(dummyContext, {
          checks: { test: { enabled: true, command: 'npm test "unterminated' }, secret_scan: { enabled: false } },
        })
      ).rejects.toThrow(SecurityViolationError);
    });

    it('ADV-TMO-01: Subprocess timeout exhaustion triggers exit code 124 and structured violation', async () => {
      const hangingCmd = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`;
      const results = await runner.run(dummyContext, {
        checks: {
          test: { enabled: true, command: hangingCmd, timeoutMs: 250 },
          secret_scan: { enabled: false },
        },
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult).toBeDefined();
      expect(testResult?.status).toBe('failed');
      expect(testResult?.exitCode).toBe(124);
      expect(testResult?.violations).toHaveLength(1);
      expect(testResult?.violations[0].rule).toBe('test_timeout');
      expect(testResult?.summary).toContain('timed out after 250ms');
    });

    it('ADV-TMO-02: Non-existent executable triggers exit code 127 and structured violation', async () => {
      const results = await runner.run(dummyContext, {
        checks: {
          test: { enabled: true, command: 'non_existent_binary_xyz_12345' },
          secret_scan: { enabled: false },
        },
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult).toBeDefined();
      expect(testResult?.status).toBe('failed');
      expect(testResult?.exitCode).toBe(127);
      expect(testResult?.violations).toHaveLength(1);
      expect(testResult?.violations[0].rule).toBe('test_not_found');
      expect(testResult?.summary).toContain('Command not found: non_existent_binary_xyz_12345');
    });
  });
});
