/**
 * tests/unit/analysis/deterministic_stress.test.ts
 * Empirical Challenger M2-1 Stress Test Suite for Deterministic Analysis Layer.
 *
 * Covers:
 * 1. Command Injection Resilience & Dangerous Metacharacter Shielding
 * 2. Process Timeout Handling & Subprocess Failure Isolation
 * 3. Secret Scanner Edge Cases, Fake-outs, Redaction, and Boundary Conditions
 * 4. Semantic Decision Provider Offline Resilience & Fallback Integrity
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DeterministicRunner,
  detectDangerousShellTokens,
  tokenizeCommand,
  resolveExecutable,
} from '../../../src/analysis/deterministic/runner.js';
import {
  scanDiffForSecrets,
  redactSecret,
  SECRET_PATTERNS,
} from '../../../src/analysis/deterministic/secrets.js';
import { DeterministicMockProvider } from '../../../src/analysis/semantic/mock-provider.js';
import { TypeSafeSystemOneProvider } from '../../../src/analysis/semantic/typesafe-provider.ts';
import { MVP_STANDARD_QUESTIONS } from '../../../src/analysis/semantic/questions.js';
import { SecurityViolationError, ProviderError } from '../../../src/types/errors.js';
import type { DiffContext } from '../../../src/types/diff.js';
import type { EvaluationContext } from '../../../src/types/context.js';

describe('Empirical Challenger M2-1: Deterministic Stress Suite', () => {
  const createBaseContext = (diff?: Partial<DiffContext>): EvaluationContext => ({
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
      headSha: 'cafebabe1234',
      isClean: true,
    },
    evidence: [],
  });

  // =========================================================================
  // 1. COMMAND INJECTION RESILIENCE & METACHARACTER SHIELDING
  // =========================================================================
  describe('1. Command Injection Resilience', () => {
    it('detectDangerousShellTokens should catch all unquoted shell chaining tokens', () => {
      const dangerousPayloads = [
        'pnpm test; rm -rf /',
        'pnpm test ; dir',
        'pnpm test && bad_cmd',
        'pnpm test & background_task',
        'pnpm test || fallback_cmd',
        'pnpm test | cat /etc/passwd',
        'pnpm test > out.txt',
        'pnpm test >> out.txt',
        'pnpm test < in.txt',
        'pnpm test `whoami`',
        'pnpm test $(whoami)',
        'pnpm test \n malicious_command',
        'pnpm test \r\n malicious_command',
        '; calc.exe',
        '& notepad.exe',
        '| cmd.exe',
        'echo hello; calc.exe',
        'echo `calc`',
        'echo $(calc)',
      ];

      for (const payload of dangerousPayloads) {
        const detected = detectDangerousShellTokens(payload);
        expect(
          detected,
          `Expected payload "${payload}" to be flagged as dangerous`
        ).not.toBeNull();
      }
    });

    it('detectDangerousShellTokens permits metacharacters strictly enclosed within quotes', () => {
      const safeQuotedPayloads = [
        'node -e "console.log(\'hello; world\');"',
        'node -e "console.log(\'a && b || c | d > e < f\');"',
        ...(process.platform !== 'win32' ? ["node -e 'console.log(\"a; b & c\");'"] : []),
        'node -e "console.log(\\"a; b & c\\");"',
        'vitest run --testNamePattern="auth; session"',
        'pnpm lint --filter="@org/pkg"',
      ];

      for (const payload of safeQuotedPayloads) {
        const detected = detectDangerousShellTokens(payload);
        expect(
          detected,
          `Expected safe quoted payload "${payload}" to be permitted`
        ).toBeNull();
      }
    });

    it('detectDangerousShellTokens detects unclosed quotes and handles escaped quotes', () => {
      // Unclosed quotes
      expect(detectDangerousShellTokens('pnpm test "')).toBe('unclosed_quote');
      expect(detectDangerousShellTokens('pnpm test " & calc')).toBe('unclosed_quote');
      if (process.platform !== 'win32') {
        expect(detectDangerousShellTokens("pnpm test '")).toBe('unclosed_quote');
      }

      // Escaped quotes inside quotes should not toggle quote state prematurely
      expect(detectDangerousShellTokens('node -e "console.log(\\"hi;\\")"')).toBeNull();
    });

    it('empirically probes if single quotes mask shell operators when executing batch scripts via cmd.exe', async () => {
      // Single quotes must NOT mask shell operators on Windows/cmd.exe
      const singleQuotedInjection = "pnpm ' & echo INJECTED & '";
      const token = detectDangerousShellTokens(singleQuotedInjection);

      if (process.platform === 'win32') {
        // Must be flagged as dangerous token '&' on Windows
        expect(token).toBe('&');

        const runner = new DeterministicRunner();
        const context = createBaseContext();
        await expect(
          runner.run(context, {
            commands: {
              test: { run: singleQuotedInjection },
            },
          })
        ).rejects.toThrow(SecurityViolationError);
      } else {
        expect(token).toBeNull();
      }
    });

    it('guarantees that single-quoted injection payload never spawns subprocess or creates marker files', async () => {
      const markerPath = path.resolve(process.cwd(), 'injection-probe-marker.tmp');
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }

      try {
        const maliciousPayload = `pnpm ' & echo INJECTED > "${markerPath}" & '`;
        const runner = new DeterministicRunner();
        const context = createBaseContext();

        if (process.platform === 'win32') {
          await expect(
            runner.run(context, {
              commands: {
                test: { run: maliciousPayload },
              },
            })
          ).rejects.toThrow(SecurityViolationError);

          // Empirical ground truth: The command was blocked before execution, so no marker file was written
          expect(fs.existsSync(markerPath)).toBe(false);
        }
      } finally {
        if (fs.existsSync(markerPath)) {
          fs.unlinkSync(markerPath);
        }
      }
    });



    it('rejects commands with injection vectors across test, lint, and typecheck checks', async () => {
      const runner = new DeterministicRunner();
      const context = createBaseContext();

      const injectionVectors = [
        'pnpm test; rm -rf /',
        'npm run lint && calc.exe',
        'tsc | malicious_pipe',
        'vitest run `whoami`',
        'tsc $(whoami)',
        'echo test > pwned.txt',
      ];

      for (const vector of injectionVectors) {
        await expect(
          runner.run(context, {
            commands: {
              test: { run: vector },
            },
          }),
          `Expected vector "${vector}" to throw SecurityViolationError on test`
        ).rejects.toThrow(SecurityViolationError);

        await expect(
          runner.run(context, {
            commands: {
              lint: { run: vector },
            },
          }),
          `Expected vector "${vector}" to throw SecurityViolationError on lint`
        ).rejects.toThrow(SecurityViolationError);

        await expect(
          runner.run(context, {
            commands: {
              typecheck: { run: vector },
            },
          }),
          `Expected vector "${vector}" to throw SecurityViolationError on typecheck`
        ).rejects.toThrow(SecurityViolationError);
      }
    });

    it('handles quotes within arguments and preserves token boundaries in tokenizeCommand', () => {
      const tokens1 = tokenizeCommand('vitest run --grep="pattern with spaces" --timeout=5000');
      expect(tokens1).toEqual(['vitest', 'run', '--grep=pattern with spaces', '--timeout=5000']);

      const tokens2 = tokenizeCommand('node -e \'console.log("hello")\'');
      expect(tokens2).toEqual(['node', '-e', 'console.log("hello")']);

      const tokensEmpty = tokenizeCommand('');
      expect(tokensEmpty).toEqual([]);

      const tokensSpacesOnly = tokenizeCommand('    \t   ');
      expect(tokensSpacesOnly).toEqual([]);
    });

    it('safely handles empty command string and produces skipped result', async () => {
      const runner = new DeterministicRunner();
      const context = createBaseContext();

      const results = await runner.run(context, {
        commands: {
          test: { run: '   ' },
        },
      });

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult?.status).toBe('skipped');
      expect(testResult?.summary).toContain('No command configured');
    });
  });

  // =========================================================================
  // 2. PROCESS TIMEOUT HANDLING & SUBPROCESS FAILURE ISOLATION
  // =========================================================================
  describe('2. Process Timeout Handling & Subprocess Failure Isolation', () => {
    it('cleanly terminates long-running process on timeout and returns status failed', async () => {
      const runner = new DeterministicRunner();
      const context = createBaseContext();

      const startTime = Date.now();
      const results = await runner.run(context, {
        commands: {
          test: {
            // Infinite loop that never finishes on its own
            run: 'node -e "setInterval(()=>{}, 1000);"',
            timeoutMs: 250,
          },
        },
      });
      const elapsed = Date.now() - startTime;

      // Ensure it aborted within reasonable bound (< 5000ms, not indefinite)
      expect(elapsed).toBeLessThan(5000);

      const testResult = results.find((r) => r.id === 'test');
      expect(testResult).toBeDefined();
      expect(testResult?.status).toBe('failed');
      expect(testResult?.exitCode).toBe(124);
      expect(testResult?.summary).toContain('timed out after 250ms');
      expect(testResult?.violations).toHaveLength(1);
      expect(testResult?.violations?.[0].rule).toBe('test_timeout');
      expect(testResult?.violations?.[0].severity).toBe('block');
    });

    it('isolates non-existent commands and returns status failed with exit code 127 without crashing', async () => {
      const runner = new DeterministicRunner();
      const context = createBaseContext();

      const results = await runner.run(context, {
        commands: {
          typecheck: {
            run: 'completely_fictitious_binary_xyz_998877 --flag',
          },
        },
      });

      const tscResult = results.find((r) => r.id === 'typecheck');
      expect(tscResult).toBeDefined();
      expect(tscResult?.status).toBe('failed');
      expect(tscResult?.exitCode).toBe(127);
      expect(tscResult?.summary).toContain('not found');
      expect(tscResult?.violations?.[0].rule).toBe('typecheck_not_found');
    });

    it('accurately captures non-zero exit codes and stderr output on process failure', async () => {
      const runner = new DeterministicRunner();
      const context = createBaseContext();

      const results = await runner.run(context, {
        commands: {
          lint: {
            run: 'node -e "console.error(\'Critical linter error on line 42\'); process.exit(42);"',
          },
        },
      });

      const lintResult = results.find((r) => r.id === 'lint');
      expect(lintResult).toBeDefined();
      expect(lintResult?.status).toBe('failed');
      expect(lintResult?.exitCode).toBe(42);
      expect(lintResult?.stderr).toContain('Critical linter error on line 42');
      expect(lintResult?.violations?.[0].rule).toBe('lint_failure');
    });

    it('resolves executables correctly with resolveExecutable helper', () => {
      const nodePath = resolveExecutable('node');
      expect(nodePath).not.toBeNull();
      expect(typeof nodePath).toBe('string');

      const nonExistent = resolveExecutable('definitely_does_not_exist_abc_123');
      expect(nonExistent).toBeNull();
    });
  });

  // =========================================================================
  // 3. SECRET SCANNER EDGE CASES, FAKE-OUTS, AND BOUNDARIES
  // =========================================================================
  describe('3. Secret Scanner Edge Cases & Redaction', () => {
    it('redactSecret handles edge cases: null, empty, short, and long secrets', () => {
      expect(redactSecret('')).toBe('***[REDACTED]***');
      expect(redactSecret('abc')).toBe('***[REDACTED]***');
      expect(redactSecret('123456')).toBe('***[REDACTED]***');
      expect(redactSecret('1234567')).toBe('123...[REDACTED]...67');
      expect(redactSecret('AKIA1234567890ABCDEF')).toBe('AKI...[REDACTED]...EF');
      expect(redactSecret(null as unknown as string)).toBe('***[REDACTED]***');
      expect(redactSecret(undefined as unknown as string)).toBe('***[REDACTED]***');
    });

    it('never leaks the raw secret payload in violation message', () => {
      const rawSecret = 'AKIAIOSFODNN7EXAMPLE';
      const diff: DiffContext = {
        raw: `+const key = "${rawSecret}";`,
        files: [
          {
            newPath: 'aws.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: [`+const key = "${rawSecret}";`],
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

      const violations = scanDiffForSecrets(diff);
      expect(violations).toHaveLength(1);
      expect(violations[0].message).not.toContain(rawSecret);
      expect(violations[0].message).toContain('AKI...[REDACTED]...LE');
    });

    it('safely handles empty diff, null files, or missing hunks', () => {
      expect(scanDiffForSecrets({} as unknown as DiffContext)).toHaveLength(0);
      expect(scanDiffForSecrets({ files: [] } as unknown as DiffContext)).toHaveLength(0);
      expect(
        scanDiffForSecrets({
          files: [
            {
              newPath: 'empty.ts',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 0,
              deletions: 0,
            },
          ],
        } as unknown as DiffContext)
      ).toHaveLength(0);
    });

    it('skips binary files entirely even if diff text is binary', () => {
      const binaryDiff: DiffContext = {
        raw: 'Binary files a/img.png and b/img.png differ',
        files: [
          {
            newPath: 'img.png',
            status: 'modified',
            binary: true,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 0,
                newLines: 0,
                header: 'Binary',
                lines: ['+AKIAIOSFODNN7EXAMPLE in binary chunk'],
              },
            ],
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

    it('does not flag secrets in deleted lines or context lines', () => {
      const diff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'clean.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 1,
                header: '@@ -1,3 +1,1 @@',
                lines: [
                  ' const contextKey = "AKIAIOSFODNN7EXAMPLE";',
                  '-const oldDeletedKey = "AKIAIOSFODNN7EXAMPLE";',
                  '+const cleanKey = process.env.KEY;',
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

      const violations = scanDiffForSecrets(diff);
      expect(violations).toHaveLength(0);
    });

    it('filters out case-insensitive fake-out placeholders', () => {
      const diff: DiffContext = {
        raw: 'diff',
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
                newLines: 4,
                header: '@@ -0,0 +1,4 @@',
                lines: [
                  '+password = "placeholder"',
                  '+password = "PLACEHOLDER"',
                  '+api_key = "ChangeMe"',
                  '+secret_key = "YOUR_SECRET_HERE"',
                ],
              },
            ],
            additions: 4,
            deletions: 0,
          },
        ],
        insertions: 4,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(diff);
      expect(violations).toHaveLength(0);
    });

    it('detects diverse secret types across multiple hunks', () => {
      const diff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'credentials.ts',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 6,
                header: '@@ -0,0 +1,6 @@',
                lines: [
                  '+const awsKey = "ASIAIOSFODNN7EXAMPLE";',
                  '+const slack = "' + ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-') + '";',
                  '+const stripe = "' + ['sk', 'live', '123456789012345678901234'].join('_') + '";',
                  '+const privKey = "-----BEGIN OPENSSH PRIVATE KEY-----";',
                  '+const genericSecret = \'password: "MySuperSecretPassword123!"\';',
                  '+const safeVar = "not a secret";',
                ],
              },
            ],
            additions: 6,
            deletions: 0,
          },
        ],
        insertions: 6,
        deletions: 0,
        truncated: false,
      };

      const violations = scanDiffForSecrets(diff);
      expect(violations.length).toBeGreaterThanOrEqual(5);

      const rules = violations.map((v) => v.rule);
      expect(rules).toContain('aws_access_key');
      expect(rules).toContain('slack_token');
      expect(rules).toContain('stripe_key');
      expect(rules).toContain('private_key');
      expect(rules).toContain('hardcoded_secret');
    });

    it('detects multiline split credentials across consecutive addition lines', () => {
      // When a credential key and value are split across multiple lines in YAML/JSON or multiline declarations
      const multilineDiff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'credentials.yml',
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

      const violations = scanDiffForSecrets(multilineDiff);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe('aws_secret_key');
      expect(violations[0].file).toBe('credentials.yml');
      expect(violations[0].line).toBe(1);
      expect(violations[0].message).toContain('wJa...[REDACTED]...EY');
    });

    it('detects PKCS#8 encrypted private keys (BEGIN ENCRYPTED PRIVATE KEY)', () => {
      const encryptedKeyDiff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'cert.pem',
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
      expect(violations[0].file).toBe('cert.pem');
    });

    it('detects GitHub Fine-Grained Personal Access Tokens (github_pat_)', () => {
      const fineGrainedPat = 'github_pat_11' + 'A'.repeat(80);
      const patDiff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'deploy.env',
            status: 'added',
            binary: false,
            hunks: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: [`+GITHUB_TOKEN=${fineGrainedPat}`],
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
      expect(violations[0].message).toContain('git...[REDACTED]...AA');
    });

    it('detects all standard private key header variations including EC, DSA, and PKCS#8 unencrypted', () => {
      const variants = [
        '-----BEGIN EC PRIVATE KEY-----',
        '-----BEGIN DSA PRIVATE KEY-----',
        '-----BEGIN PRIVATE KEY-----',
      ];

      for (const header of variants) {
        const diff: DiffContext = {
          raw: 'diff',
          files: [
            {
              newPath: 'key.pem',
              status: 'added',
              binary: false,
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  header: '@@ -0,0 +1 @@',
                  lines: [`+${header}`],
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

        const violations = scanDiffForSecrets(diff);
        expect(violations, `Expected header "${header}" to be flagged`).toHaveLength(1);
        expect(violations[0].rule).toBe('private_key');
      }
    });

    it('detects diverse GitHub token family prefixes (gho_, ghu_, ghs_, ghr_)', () => {
      const prefixes = ['gho_', 'ghu_', 'ghs_', 'ghr_'];

      for (const prefix of prefixes) {
        const token = prefix + '1234567890abcdefghijklmnopqrstuvwxyzAB';
        const diff: DiffContext = {
          raw: 'diff',
          files: [
            {
              newPath: 'ci.yml',
              status: 'added',
              binary: false,
              hunks: [
                {
                  oldStart: 0,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  header: '@@ -0,0 +1 @@',
                  lines: [`+TOKEN: ${token}`],
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

        const violations = scanDiffForSecrets(diff);
        expect(violations, `Expected prefix "${prefix}" to be detected`).toHaveLength(1);
        expect(violations[0].rule).toBe('github_token');
      }
    });

    it('detects JSON multiline split credentials across consecutive additions', () => {
      const jsonMultilineDiff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'credentials.json',
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
                  '+  aws_secret_key:',
                  '+    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
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

      const violations = scanDiffForSecrets(jsonMultilineDiff);
      expect(violations.length).toBeGreaterThanOrEqual(1);
      const awsViolation = violations.find((v) => v.rule === 'aws_secret_key');
      expect(awsViolation).toBeDefined();
      expect(awsViolation?.message).toContain('wJa...[REDACTED]...EY');
    });

    it('resists ReDoS on very long diff lines with trailing whitespace and repeated chars', () => {
      const longString = 'a'.repeat(50000);
      const diff: DiffContext = {
        raw: 'diff',
        files: [
          {
            newPath: 'huge.ts',
            status: 'modified',
            binary: false,
            hunks: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: '@@ -0,0 +1 @@',
                lines: [`+const blob = "${longString}";`],
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

      const startTime = Date.now();
      const violations = scanDiffForSecrets(diff);
      const elapsed = Date.now() - startTime;

      // Must complete in under 500ms without catastrophic backtracking
      expect(elapsed).toBeLessThan(500);
      expect(violations).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. SEMANTIC DECISION PROVIDER OFFLINE RESILIENCE & FALLBACK INTEGRITY
  // =========================================================================
  describe('4. Semantic Decision Provider Offline Resilience', () => {
    it('DeterministicMockProvider is reproducible and returns identical probabilities across runs', async () => {
      const mockProvider = new DeterministicMockProvider();
      expect(await mockProvider.isAvailable()).toBe(true);

      const context = createBaseContext({
        raw: 'diff --git a/src/auth.ts b/src/auth.ts\n+export function login() {}\n+console.log("debug");',
        files: [
          {
            newPath: 'src/auth.ts',
            status: 'modified',
            binary: false,
            hunks: [],
            additions: 2,
            deletions: 0,
          },
        ],
        insertions: 2,
        deletions: 0,
      });
      context.task = {
        task: 'Implement login and auth token support',
        keywords: ['login', 'auth', 'token'],
      };

      const run1 = await mockProvider.evaluate(context, MVP_STANDARD_QUESTIONS);
      const run2 = await mockProvider.evaluate(context, MVP_STANDARD_QUESTIONS);

      expect(run1).toHaveLength(MVP_STANDARD_QUESTIONS.length);
      expect(run2).toHaveLength(MVP_STANDARD_QUESTIONS.length);

      for (let i = 0; i < run1.length; i++) {
        expect(run1[i].id).toBe(run2[i].id);
        expect(run1[i].probability).toBe(run2[i].probability);
        expect(run1[i].score).toBe(run2[i].score);
        expect(run1[i].value).toBe(run2[i].value);
        expect(run1[i].confidence).toBe(run2[i].confidence);
      }
    });

    it('TypeSafeSystemOneProvider seamlessly falls back to mock provider when API key is missing', async () => {
      const typeSafeProvider = new TypeSafeSystemOneProvider({ apiKey: '' });
      expect(await typeSafeProvider.isAvailable()).toBe(false);

      const context = createBaseContext();
      const decisions = await typeSafeProvider.evaluate(context, MVP_STANDARD_QUESTIONS);

      expect(decisions).toHaveLength(MVP_STANDARD_QUESTIONS.length);
      // Fallback provider fills decisions
      expect(decisions[0].provider).toBe('mock');
    });

    it('TypeSafeSystemOneProvider throws ProviderError in strict mode when API key is missing', async () => {
      const strictProvider = new TypeSafeSystemOneProvider({ apiKey: '', strict: true });

      const context = createBaseContext();
      await expect(
        strictProvider.evaluate(context, MVP_STANDARD_QUESTIONS)
      ).rejects.toThrow(ProviderError);
    });

    it('TypeSafeSystemOneProvider transparently falls back to mock provider on network error', async () => {
      const mockFailingFetch = async () => {
        throw new Error('Connection refused (ECONNREFUSED)');
      };

      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'fake-api-key',
        fetchFn: mockFailingFetch as unknown as typeof fetch,
        strict: false,
      });

      const context = createBaseContext();
      const decisions = await provider.evaluate(context, MVP_STANDARD_QUESTIONS);

      expect(decisions).toHaveLength(MVP_STANDARD_QUESTIONS.length);
      expect(decisions[0].provider).toBe('mock');
    });

    it('TypeSafeSystemOneProvider throws ProviderError on network error when strict: true', async () => {
      const mockFailingFetch = async () => {
        throw new Error('Connection refused (ECONNREFUSED)');
      };

      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'fake-api-key',
        fetchFn: mockFailingFetch as unknown as typeof fetch,
        strict: true,
      });

      const context = createBaseContext();
      await expect(
        provider.evaluate(context, MVP_STANDARD_QUESTIONS)
      ).rejects.toThrow(ProviderError);
    });
  });
});
