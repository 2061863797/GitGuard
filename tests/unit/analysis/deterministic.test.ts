/**
 * tests/unit/analysis/deterministic.test.ts
 * Unit test suite for Deterministic Analysis layer:
 * - Diff Secret Scanner (secrets.ts)
 * - Deterministic Runner (runner.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  scanDiffForSecrets,
  scanContentForSecrets,
  redactSecret,
  SECRET_PATTERNS,
} from '../../../src/analysis/deterministic/secrets.js';
import {
  DeterministicRunner,
  tokenizeCommand,
} from '../../../src/analysis/deterministic/runner.js';
import type { DiffContext } from '../../../src/types/diff.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import { SecurityViolationError } from '../../../src/types/errors.js';

describe('Deterministic Analysis Layer', () => {
  describe('Diff Secret Scanner (secrets.ts)', () => {
    it('redactSecret should properly mask credentials of varying lengths', () => {
      expect(redactSecret('')).toBe('***[REDACTED]***');
      expect(redactSecret('12345')).toBe('***[REDACTED]***');
      expect(redactSecret('123456')).toBe('***[REDACTED]***');
      expect(redactSecret('AKIA1234567890ABCDEF')).toBe('AKI...[REDACTED]...EF');
      expect(redactSecret(['ghp', 'abcdef1234567890'].join('_'))).toBe('ghp...[REDACTED]...90');
    });

    it('detects unquoted YAML credentials and masks the finding', () => {
      const token = 'abcdef0123456789abcdef0123456789';
      const violations = scanContentForSecrets('name: example\napi_key: ' + token, 'config.yml');
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('unquoted_config_secret');
      expect(violations[0].line).toBe(2);
      expect(violations[0].message).not.toContain(token);
    });

    it('returns empty violations for clean diffs without secrets', () => {
      const cleanDiff: DiffContext = {
        raw: 'diff --git a/src/math.ts b/src/math.ts\n@@ -1,2 +1,3 @@\n export function add(a: number, b: number) {\n+  const sum = a + b;\n+  return sum;\n }',
        files: [
          {
            newPath: 'src/math.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 3,
                header: '@@ -1,2 +1,3 @@',
                lines: [
                  ' export function add(a: number, b: number) {',
                  '+  const sum = a + b;',
                  '+  return sum;',
                  ' }',
                ],
              },
            ],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(cleanDiff);
      expect(violations).toHaveLength(0);
    });

    it('detects AWS Access Key ID in diff additions and assigns correct line number', () => {
      const awsDiff: DiffContext = {
        raw: 'diff --git a/src/aws.ts b/src/aws.ts\n@@ -10,3 +10,4 @@\n context line\n+const awsKey = "AKIAIOSFODNN7EXAMPLE";\n',
        files: [
          {
            newPath: 'src/aws.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 10,
                oldLines: 3,
                newStart: 10,
                newLines: 4,
                header: '@@ -10,3 +10,4 @@',
                lines: [
                  ' context line',
                  '+const awsKey = "AKIAIOSFODNN7EXAMPLE";',
                  ' trailing line',
                ],
              },
            ],
            additions: 1,
            deletions: 0,
          },
        ],
        insertions: 1,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(awsDiff);
      expect(violations).toHaveLength(1);
      expect(violations[0].file).toBe('src/aws.ts');
      expect(violations[0].line).toBe(11);
      expect(violations[0].rule).toBe('aws_access_key');
      expect(violations[0].severity).toBe('block');
      expect(violations[0].message).toContain('AKI...[REDACTED]...LE');
      expect(violations[0].message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('detects GitHub Personal Access Tokens and JWT tokens', () => {
      const tokenDiff: DiffContext = {
        raw: 'diff --git a/src/auth.ts b/src/auth.ts',
        files: [
          {
            newPath: 'src/auth.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 3,
                header: '@@ -1,1 +1,3 @@',
                lines: [
                  '+const ghToken = "' + ['ghp', '1234567890abcdefghijklmnopqrstuvwxyzAB'].join('_') + '";',
                  '+const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureValue12345";',
                  ' export default auth;',
                ],
              },
            ],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(tokenDiff);
      expect(violations).toHaveLength(2);

      const ghViolation = violations.find((v) => v.rule === 'github_token');
      expect(ghViolation).toBeDefined();
      expect(ghViolation?.line).toBe(1);
      expect(ghViolation?.message).toContain('ghp...[REDACTED]...AB');

      const jwtViolation = violations.find((v) => v.rule === 'jwt_token');
      expect(jwtViolation).toBeDefined();
      expect(jwtViolation?.line).toBe(2);
      expect(jwtViolation?.message).toContain('eyJ...[REDACTED]...45');
    });

    it('detects Private Key header and OpenAI secret keys', () => {
      const privateKeyDiff: DiffContext = {
        raw: 'diff --git a/certs/key.pem b/certs/key.pem',
        files: [
          {
            newPath: 'certs/key.pem',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 2,
                header: '@@ -0,0 +1,2 @@',
                lines: [
                  '+-----BEGIN RSA PRIVATE KEY-----',
                  '+sk-proj-1234567890abcdef1234567890abcdef',
                ],
              },
            ],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(privateKeyDiff);
      expect(violations).toHaveLength(2);

      const rsaViolation = violations.find((v) => v.rule === 'private_key');
      expect(rsaViolation).toBeDefined();

      const openAiViolation = violations.find((v) => v.rule === 'openai_secret');
      expect(openAiViolation).toBeDefined();
    });

    it('detects PKCS#8 encrypted private keys (BEGIN ENCRYPTED PRIVATE KEY)', () => {
      const encryptedKeyDiff: DiffContext = {
        raw: 'diff --git a/certs/priv.pem b/certs/priv.pem',
        files: [
          {
            newPath: 'certs/priv.pem',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: ['+-----BEGIN ENCRYPTED PRIVATE KEY-----'],
              },
            ],
            additions: 1,
            deletions: 0,
          },
        ],
        insertions: 1,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(encryptedKeyDiff);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('private_key');
      expect(violations[0].file).toBe('certs/priv.pem');
    });

    it('detects GitHub Fine-Grained PATs (github_pat_)', () => {
      const fineGrainedPat = 'github_pat_11' + 'B'.repeat(80);
      const patDiff: DiffContext = {
        raw: 'diff --git a/.env b/.env',
        files: [
          {
            newPath: '.env',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: [`+GH_TOKEN=${fineGrainedPat}`],
              },
            ],
            additions: 1,
            deletions: 0,
          },
        ],
        insertions: 1,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(patDiff);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('github_token');
      expect(violations[0].message).toContain('git...[REDACTED]...BB');
    });

    it('detects multiline YAML key-value secret declarations across consecutive additions', () => {
      const yamlDiff: DiffContext = {
        raw: 'diff --git a/secrets.yaml b/secrets.yaml',
        files: [
          {
            newPath: 'secrets.yaml',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 2,
                header: '@@ -0,0 +1,2 @@',
                lines: [
                  '+aws_secret_key:',
                  '+  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                ],
              },
            ],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(yamlDiff);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('aws_secret_key');
      expect(violations[0].line).toBe(1);
      expect(violations[0].message).toContain('wJa...[REDACTED]...EY');
    });

    it('does not flag secrets in deleted lines (-)', () => {
      const deletionDiff: DiffContext = {
        raw: 'diff --git a/src/auth.ts b/src/auth.ts',
        files: [
          {
            newPath: 'src/auth.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 2,
                newStart: 1,
                newLines: 1,
                header: '@@ -1,2 +1,1 @@',
                lines: [
                  '-const oldKey = "AKIAIOSFODNN7EXAMPLE";',
                  '+const safeKey = process.env.AWS_KEY;',
                ],
              },
            ],
            additions: 1,
            deletions: 1,
          },
        ],
        insertions: 1,
        deletions: 1,
        truncated: false,
      };

      const violations = scanDiffForSecrets(deletionDiff);
      expect(violations).toHaveLength(0);
    });

    it('skips binary files without crashing', () => {
      const binaryDiff: DiffContext = {
        raw: 'diff --git a/logo.png b/logo.png\nBinary files differ',
        files: [
          {
            newPath: 'logo.png',
            status: 'binary',
            binary: true,
            hunks: [],
            additions: 0,
            deletions: 0,
          },
        ],
        insertions: 0,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(binaryDiff);
      expect(violations).toHaveLength(0);
    });

    it('ignores obvious placeholders and examples', () => {
      const placeholderDiff: DiffContext = {
        raw: 'diff --git a/config.ts b/config.ts',
        files: [
          {
            newPath: 'config.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 2,
                header: '@@ -0,0 +1,2 @@',
                lines: [
                  '+const apiKey = "your_secret_here";',
                  '+const token = "placeholder";',
                ],
              },
            ],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(placeholderDiff);
      expect(violations).toHaveLength(0);
    });
  });

  describe('Deterministic Runner (runner.ts)', () => {
    const createMockContext = (diff?: Partial<DiffContext>): EvaluationContext => ({
      diff: {
        raw: diff?.raw || '',
        files: diff?.files || [],
        insertions: diff?.insertions ?? 0,
        deletions: diff?.deletions ?? 0,
        truncated: false,
      },
      files: [],
      instructions: [],
      relatedTests: [],
      repository: {
        rootPath: process.cwd(),
        branch: 'main',
        headSha: 'abc1234',
        isClean: true,
      },
      evidence: [],
    });

    it('tokenizeCommand safely parses command lines with spaces and quotes', () => {
      expect(tokenizeCommand('pnpm test')).toEqual(['pnpm', 'test']);
      expect(tokenizeCommand('vitest run --reporter="verbose"')).toEqual([
        'vitest',
        'run',
        '--reporter=verbose',
      ]);
      expect(tokenizeCommand('node "script with spaces.js" --flag')).toEqual([
        'node',
        'script with spaces.js',
        '--flag',
      ]);
    });

    it('throws SecurityViolationError when dangerous shell metacharacters are passed', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      await expect(
        runner.run(context, {
          commands: {
            test: { run: 'pnpm test; rm -rf /' },
          },
        })
      ).rejects.toThrow(SecurityViolationError);

      await expect(
        runner.run(context, {
          commands: {
            test: { run: 'pnpm test && bad_command' },
          },
        })
      ).rejects.toThrow(SecurityViolationError);

      await expect(
        runner.run(context, {
          commands: {
            lint: { run: 'npm run lint | bad' },
          },
        })
      ).rejects.toThrow(SecurityViolationError);
    });

    it('throws SecurityViolationError when unclosed quotes are present', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      await expect(
        runner.run(context, {
          commands: {
            test: { run: 'pnpm test "' },
          },
        })
      ).rejects.toThrow(SecurityViolationError);
    });

    it('blocks single-quoted command injection on Windows batch execution', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      if (process.platform === 'win32') {
        await expect(
          runner.run(context, {
            commands: {
              test: { run: "pnpm ' & echo INJECTED & '" },
            },
          })
        ).rejects.toThrow(SecurityViolationError);
      }
    });

    it('runs secret_scan and returns failed result when secrets are present', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext({
        raw: 'diff --git a/api.ts b/api.ts\n+const key = "AKIAIOSFODNN7EXAMPLE";',
        files: [
          {
            newPath: 'api.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: ['+const key = "AKIAIOSFODNN7EXAMPLE";'],
              },
            ],
            additions: 1,
            deletions: 0,
          },
        ],
        insertions: 1,
        deletions: 0,
      });

      const results = await runner.run(context, {});
      const secretResult = results.find((r) => r.id === 'secret_scan');

      expect(secretResult).toBeDefined();
      expect(secretResult?.status).toBe('failed');
      expect(secretResult?.violations?.length).toBeGreaterThan(0);
      expect(secretResult?.exitCode).toBe(1);
    });

    it('rejects unsafe custom patterns passed directly to the runner', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();
      await expect(runner.run(context, {
        checks: { secret_scan: { enabled: true, patterns: ['^(a+)+$'] } },
      })).rejects.toThrow(SecurityViolationError);
    });

    it('skips secret_scan when explicitly disabled in configuration', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        checks: {
          secret_scan: { enabled: false },
        },
      });

      const secretResult = results.find((r) => r.id === 'secret_scan');
      expect(secretResult?.status).toBe('skipped');
    });

    it('executes successful command and returns passed status', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        commands: {
          test: { run: 'node -e "console.log(\'all tests passed\'); process.exit(0);"' },
        },
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult).toBeDefined();
      expect(testResult?.status).toBe('passed');
      expect(testResult?.exitCode).toBe(0);
      expect(testResult?.stdout).toContain('all tests passed');
      expect(testResult?.violations).toHaveLength(0);
    });

    it('captures command failures with non-zero exit code', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        commands: {
          lint: { run: 'node -e "console.error(\'syntax violation\'); process.exit(2);"' },
        },
      });

      const lintResult = results.find((r) => r.id === 'lint');
      expect(lintResult).toBeDefined();
      expect(lintResult?.status).toBe('failed');
      expect(lintResult?.exitCode).toBe(2);
      expect(lintResult?.stderr).toContain('syntax violation');
      expect(lintResult?.violations?.[0].rule).toBe('lint_failure');
    });

    it('handles execution timeouts cleanly without unhandled rejections', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        commands: {
          test: {
            // Infinite loop to force timeout
            run: 'node -e "while(true){}"',
            timeoutMs: 150,
          },
        },
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult).toBeDefined();
      expect(testResult?.status).toBe('failed');
      expect(testResult?.summary).toContain('timed out');
      expect(testResult?.violations?.[0].rule).toBe('test_timeout');
    });

    it('handles non-existent commands (ENOENT) with failed status and error isolation', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        commands: {
          typecheck: {
            run: 'non_existent_binary_xyz_12345 --strict',
          },
        },
      });

      const tscResult = results.find((r) => r.id === 'typecheck');
      expect(tscResult).toBeDefined();
      expect(tscResult?.status).toBe('failed');
      expect(tscResult?.summary).toContain('not found');
      expect(tscResult?.violations?.[0].rule).toBe('typecheck_not_found');
    });

    it('skips unconfigured or disabled commands cleanly', async () => {
      const runner = new DeterministicRunner();
      const context = createMockContext();

      const results = await runner.run(context, {
        checks: {
          test: { enabled: false },
        },
        // No commands provided for lint or typecheck
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult?.status).toBe('skipped');

      const lintResult = results.find((r) => r.id === 'lint');
      expect(lintResult?.status).toBe('skipped');

      const tscResult = results.find((r) => r.id === 'typecheck');
      expect(tscResult?.status).toBe('skipped');
    });
  });
});
