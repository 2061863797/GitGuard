/**
 * tests/unit/context/filter.test.ts
 * Unit tests for Privacy and Secret Redaction filter.
 */

import { describe, it, expect } from 'vitest';
import {
  isSensitiveFile,
  redactSecrets,
  sanitizeEvaluationContext,
  omitSensitiveDiffHunks,
  PrivacyFilter,
  REDACTION_TOKEN,
} from '../../../src/context/filter.js';
import type { EvaluationContext } from '../../../src/types/context.js';

describe('Privacy & Secret Redaction Filter', () => {
  describe('isSensitiveFile', () => {
    it('should identify standard sensitive credential files', () => {
      expect(isSensitiveFile('.env')).toBe(true);
      expect(isSensitiveFile('.env.local')).toBe(true);
      expect(isSensitiveFile('config/.env.prod')).toBe(true);
      expect(isSensitiveFile('secrets/app.env')).toBe(true);
      expect(isSensitiveFile('id_rsa')).toBe(true);
      expect(isSensitiveFile('keys/id_rsa.pub')).toBe(true);
      expect(isSensitiveFile('.ssh/id_ed25519')).toBe(true);
      expect(isSensitiveFile('certs/server.key')).toBe(true);
      expect(isSensitiveFile('ssl/cert.pem')).toBe(true);
      expect(isSensitiveFile('auth/credentials.json')).toBe(true);
      expect(isSensitiveFile('auth/client_secret_xyz.json')).toBe(true);
      expect(isSensitiveFile('config/secrets.yml')).toBe(true);
      expect(isSensitiveFile('data/keystore.jks')).toBe(true);
    });

    it('should not flag normal non-sensitive source and config files', () => {
      expect(isSensitiveFile('src/index.ts')).toBe(false);
      expect(isSensitiveFile('README.md')).toBe(false);
      expect(isSensitiveFile('package.json')).toBe(false);
      expect(isSensitiveFile('tsconfig.json')).toBe(false);
      expect(isSensitiveFile('tests/unit/auth.test.ts')).toBe(false);
      expect(isSensitiveFile('src/environments/environment.ts')).toBe(false);
    });

    it('should support custom pattern extensions', () => {
      expect(isSensitiveFile('internal/vault.conf', ['**/*.conf'])).toBe(true);
      expect(isSensitiveFile('safe.txt', ['**/*.conf'])).toBe(false);
    });
  });

  describe('redactSecrets', () => {
    it('should redact AWS Access Key IDs', () => {
      const text = 'AWS_KEY=AKIAIOSFODNN7EXAMPLE; export it';
      const result = redactSecrets(text);
      expect(result).toBe(`AWS_KEY=${REDACTION_TOKEN}; export it`);
    });

    it('should redact GitHub Personal Access Tokens', () => {
      const text = 'token: ' + ['ghp', '1234567890abcdefghijklmnopqrstuvwxyzAB'].join('_') + ' in header';
      const result = redactSecrets(text);
      expect(result).toContain(REDACTION_TOKEN);
      expect(result).not.toContain('ghp_');
    });

    it('should redact OpenAI and project API keys', () => {
      const standard = 'apiKey: sk-abcdef1234567890abcdef1234567890';
      expect(redactSecrets(standard)).toContain(REDACTION_TOKEN);
      expect(redactSecrets(standard)).not.toContain('sk-abcdef');

      const project = 'const k = "sk-proj-abcdef1234567890abcdef1234567890"';
      expect(redactSecrets(project)).toContain(REDACTION_TOKEN);
      expect(redactSecrets(project)).not.toContain('sk-proj-');
    });

    it('should redact JWT tokens', () => {
      const jwt = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature12345';
      const result = redactSecrets(jwt);
      expect(result).toContain(REDACTION_TOKEN);
      expect(result).not.toContain('eyJhbGci');
    });

    it('should redact private key blocks', () => {
      const keyBlock = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y1u3...samplePrivateData...
-----END RSA PRIVATE KEY-----`;
      const result = redactSecrets(keyBlock);
      expect(result).toContain(REDACTION_TOKEN);
      expect(result).not.toContain('samplePrivateData');
    });

    it('should redact encrypted PEM private key blocks with headers', () => {
      const encryptedKey = `-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,1234567890ABCDEF

MIIEowIBAAKCAQEA0Y1u3...samplePrivateData...
-----END RSA PRIVATE KEY-----`;
      const result = redactSecrets(encryptedKey);
      expect(result).toContain(REDACTION_TOKEN);
      expect(result).not.toContain('samplePrivateData');
      expect(result).not.toContain('Proc-Type');
    });

    it('should redact quoted passwords and secret assignments', () => {
      const line = 'const password = "mySuperSecretPassword123!";';
      const result = redactSecrets(line);
      expect(result).toBe(`const password = "${REDACTION_TOKEN}";`);
    });

    it('redacts unquoted YAML credentials in ordinary files', () => {
      const token = 'abcdef0123456789abcdef0123456789';
      const result = redactSecrets('api_key: ' + token + '\nname: example');
      expect(result).toContain('api_key: ' + REDACTION_TOKEN);
      expect(result).not.toContain(token);
      expect(result).toContain('name: example');
    });

    it('should leave innocent text unredacted', () => {
      const innocent = 'export function add(a: number, b: number): number { return a + b; }';
      expect(redactSecrets(innocent)).toBe(innocent);
    });
  });

  describe('sanitizeEvaluationContext', () => {
    it('should sanitize complete evaluation context including diffs, spans, and instructions', () => {
      const mockContext: EvaluationContext = {
        task: {
          task: 'Fix issue with key sk-1234567890abcdef1234567890abcdef12',
          taskPresent: true,
          keywords: ['key'],
        },
        diff: {
          raw: 'diff --git a/.env b/.env\n+SECRET="superSecretValue123456"',
          files: [
            {
              newPath: '.env',
              status: 'modified',
              binary: false,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  header: '@@ -0,0 +1 @@',
                  lines: ['+SECRET="superSecretValue123456"'],
                },
              ],
              additions: 1,
              deletions: 0,
            },
            {
              newPath: 'src/api.ts',
              status: 'modified',
              binary: false,
              hunks: [
                {
                  oldStart: 10,
                  oldLines: 1,
                  newStart: 10,
                  newLines: 1,
                  header: '@@ -10,1 +10,1 @@',
                  lines: ['+const apiKey = "AKIAIOSFODNN7EXAMPLE";'],
                },
              ],
              additions: 1,
              deletions: 0,
            },
          ],
          insertions: 2,
          deletions: 0,
          truncated: false,
        },
        files: [
          {
            path: '.env',
            status: 'modified',
            binary: false,
            spans: [{ startLine: 1, endLine: 1, code: 'SECRET="superSecretValue123456"' }],
          },
          {
            path: 'src/api.ts',
            status: 'modified',
            binary: false,
            spans: [{ startLine: 10, endLine: 10, code: 'const apiKey = "AKIAIOSFODNN7EXAMPLE";' }],
          },
        ],
        instructions: [
          {
            sourcePath: 'AGENTS.md',
            scope: '/',
            content: 'Do not leak AKIAIOSFODNN7EXAMPLE in logs',
          },
        ],
        relatedTests: [
          {
            testPath: 'tests/api.test.ts',
            relatedSourcePath: 'src/api.ts',
            existsInWorkspace: true,
            modifiedInDiff: false,
            contentSnippet: 'const testKey = "AKIAIOSFODNN7EXAMPLE";',
          },
        ],
        repository: {
          rootPath: '/repo',
          branch: 'main',
          headSha: 'abc',
          isClean: true,
        },
        evidence: [],
      };

      const sanitized = sanitizeEvaluationContext(mockContext);

      // Task redacted
      expect(sanitized.task?.task).toContain(REDACTION_TOKEN);
      expect(sanitized.task?.task).not.toContain('sk-12345');

      // Sensitive file .env should have spans cleared
      const envFileContext = sanitized.files.find((f) => f.path === '.env');
      expect(envFileContext?.spans).toHaveLength(0);

      // Sensitive file .env in diff should have hunks stripped
      const envDiffFile = sanitized.diff.files.find((f) => f.newPath === '.env');
      expect(envDiffFile?.hunks).toHaveLength(0);

      // Sensitive file .env diff hunks should be omitted in sanitized.diff.raw
      expect(sanitized.diff.raw).toContain('[Diff omitted for sensitive file: .env]');
      expect(sanitized.diff.raw).not.toContain('superSecretValue123456');

      // Normal file code span should have secret redacted
      const apiFileContext = sanitized.files.find((f) => f.path === 'src/api.ts');
      expect(apiFileContext?.spans[0].code).toContain(REDACTION_TOKEN);
      expect(apiFileContext?.spans[0].code).not.toContain('AKIAIOSFODNN7EXAMPLE');

      // Instruction content redacted
      expect(sanitized.instructions[0].content).toContain(REDACTION_TOKEN);
      expect(sanitized.instructions[0].content).not.toContain('AKIAIOSFODNN7EXAMPLE');

      // Test snippet redacted
      expect(sanitized.relatedTests[0].contentSnippet).toContain(REDACTION_TOKEN);
      expect(sanitized.relatedTests[0].contentSnippet).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('should omit diff hunks for renamed sensitive files where oldPath is sensitive', () => {
      const renamedContext: EvaluationContext = {
        diff: {
          raw: 'diff --git a/credentials.json b/renamed.json\nsimilarity index 95%\nrename from credentials.json\nrename to renamed.json\n@@ -1,2 +1,2 @@\n-secret_1\n+secret_2',
          files: [
            {
              oldPath: 'credentials.json',
              newPath: 'renamed.json',
              status: 'renamed',
              binary: false,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 2,
                  newStart: 1,
                  newLines: 2,
                  header: '@@ -1,2 +1,2 @@',
                  lines: ['-secret_1', '+secret_2'],
                },
              ],
              additions: 1,
              deletions: 1,
            },
          ],
          insertions: 1,
          deletions: 1,
          truncated: false,
        },
        files: [],
        instructions: [],
        relatedTests: [],
        repository: {
          rootPath: '/repo',
          branch: 'main',
          headSha: '123',
          isClean: false,
        },
        evidence: [],
      };

      const sanitized = sanitizeEvaluationContext(renamedContext);
      expect(sanitized.diff.files[0].hunks).toHaveLength(0);
      expect(sanitized.diff.raw).toContain('[Diff omitted for sensitive file: renamed.json]');
      expect(sanitized.diff.raw).not.toContain('secret_1');
      expect(sanitized.diff.raw).not.toContain('secret_2');
    });

    it('omitSensitiveDiffHunks helper directly omits sensitive hunks and preserves non-sensitive files', () => {
      const raw = `diff --git a/.env b/.env
new file mode 100644
--- /dev/null
+++ b/.env
@@ -0,0 +1,2 @@
+DATABASE_URL=postgres://user:pass@localhost:5432/db
+CUSTOM_SECRET=arbitrary_secret_value_123
diff --git a/src/index.ts b/src/index.ts
index 111..222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
-console.log("old");
+console.log("new");`;

      const result = omitSensitiveDiffHunks(raw);
      expect(result).toContain('[Diff omitted for sensitive file: .env]');
      expect(result).not.toContain('DATABASE_URL');
      expect(result).not.toContain('CUSTOM_SECRET');
      expect(result).toContain('console.log("new");');
    });

    it('PrivacyFilter class provides object-oriented interface', () => {
      const filter = new PrivacyFilter();
      expect(filter.isSensitive('.env.prod')).toBe(true);
      expect(filter.redact('AKIAIOSFODNN7EXAMPLE')).toBe(REDACTION_TOKEN);
      const omitted = filter.omitSensitiveDiff('diff --git a/.env b/.env\n+SECRET=xyz');
      expect(omitted).toContain('[Diff omitted for sensitive file: .env]');
    });
  });
});
