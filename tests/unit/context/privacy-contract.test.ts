import { describe, it, expect } from 'vitest';
import { sanitizeEvaluationContext, redactSecrets, omitSensitiveDiffHunks, REDACTION_TOKEN } from '../../../src/context/filter.js';
import { parseDiff, parseDiffGitPaths } from '../../../src/git/diff-parser.js';
import { TypeSafeSystemOneProvider } from '../../../src/analysis/semantic/typesafe-provider.js';
import { STANDARD_QUESTIONS_MAP } from '../../../src/analysis/semantic/questions.js';
import { GITGUARD_VERSION } from '../../../src/version.js';
import type { EvaluationContext } from '../../../src/types/context.js';

const githubToken = ['ghp', '123456789012345678901234567890123456'].join('_');
const awsToken = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const opaqueToken = 'opaque_1234567890';

function evaluationContext(): EvaluationContext {
  return {
    task: {
      task: 'Update api_key=' + opaqueToken + ' with ' + githubToken + ' and ' + awsToken,
      source: 'cli', keywords: ['update', opaqueToken, githubToken, awsToken.toLowerCase()],
    },
    diff: parseDiff('diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+api_key=' + opaqueToken + '\n'),
    files: [], instructions: [], relatedTests: [], evidence: [],
    repository: { rootPath: '/fixture', branch: 'main', headSha: 'abc', isClean: false },
  };
}

describe('Privacy and Git path contracts', () => {
  it.each([
    'api_key=' + opaqueToken,
    'password: shortsecret12',
    'AUTH_TOKEN = ' + opaqueToken,
    '"api_key": "' + opaqueToken + '"',
    "password='" + opaqueToken + "'",
  ])('redacts named assignments using colons, equals signs and JSON keys: %s', (input) => {
    const redacted = redactSecrets(input);
    expect(redacted).toContain(REDACTION_TOKEN);
    expect(redacted).not.toContain(opaqueToken);
    expect(redacted).not.toContain('shortsecret12');
  });

  it('preserves assignment separators while redacting a value', () => {
    expect(redactSecrets('api_key=' + opaqueToken + ';')).toBe('api_key=' + REDACTION_TOKEN + ';');
  });

  it('removes raw and lowercased secret keywords and redacts structured hunks', () => {
    const sanitized = sanitizeEvaluationContext(evaluationContext());
    expect(sanitized.task?.keywords).toEqual(['update']);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(awsToken);
    expect(serialized).not.toContain(awsToken.toLowerCase());
    expect(serialized).not.toContain(opaqueToken);
    expect(sanitized.diff.files[0].hunks[0].lines[1]).toContain(REDACTION_TOKEN);
  });

  it('retains SDK opt-out behavior for trusted callers', () => {
    const context = evaluationContext();
    const sanitized = sanitizeEvaluationContext(context, { redactSecrets: false });
    expect(sanitized.task?.keywords).toEqual(context.task?.keywords);
    expect(sanitized.task?.task).toBe(context.task?.task);
  });

  it('sends a redacted request body, including keywords, with the current shared version', async () => {
    let body = '';
    let userAgent = '';
    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'synthetic-test-key', strict: true,
      fetchFn: (async (_url, init) => {
        body = String(init?.body);
        userAgent = new Headers(init?.headers).get('User-Agent') || '';
        return new Response(JSON.stringify({ model: 'test-jev', answers: {
          task_completed: { type: 'noul', noul: 0.99, confidence: 0.99, rationale: 'Test response' },
        } }), { status: 200 });
      }) as typeof fetch,
    });
    await provider.evaluate(sanitizeEvaluationContext(evaluationContext()), [STANDARD_QUESTIONS_MAP.task_completed]);
    expect(userAgent).toBe('GitGuard/' + GITGUARD_VERSION);
    expect(JSON.parse(body).state.keywords).toEqual(['update']);
    for (const secret of [githubToken, awsToken, awsToken.toLowerCase(), opaqueToken]) expect(body).not.toContain(secret);
    expect(body).toContain(REDACTION_TOKEN);
  });

  it.each(['中文.ts', 'test "quote".ts', 'slash\\123.ts', 'tab\tname.ts'])(
    'parses literal Unicode and C-style escaped filenames: %s',
    (filePath) => {
      const header = 'diff --git ' + JSON.stringify('a/' + filePath) + ' ' + JSON.stringify('b/' + filePath);
      expect(parseDiffGitPaths(header)).toEqual({ oldPath: filePath, newPath: filePath });
      expect(parseDiff(header + '\nnew file mode 100644\n').files[0].newPath).toBe(filePath);
    }
  );

  it('decodes Git UTF-8 octal byte runs without corrupting unescaped Unicode', () => {
    const octal = String.raw`\344\270\255\346\226\207.ts`;
    expect(parseDiffGitPaths('diff --git "a/' + octal + '" "b/' + octal + '"'))
      .toEqual({ oldPath: '中文.ts', newPath: '中文.ts' });
    expect(parseDiffGitPaths('diff --git a/old.ts "b/new \\"quoted\\".ts"'))
      .toEqual({ oldPath: 'old.ts', newPath: 'new "quoted".ts' });
  });

  it('omits sensitive hunks in quoted Unicode filenames through the shared parser', () => {
    const filePath = '私密 "环境".env';
    const raw = 'diff --git ' + JSON.stringify('a/' + filePath) + ' ' + JSON.stringify('b/' + filePath) +
      '\n@@ -0,0 +1 @@\n+ARBITRARY_VALUE=should_never_leave_the_machine';
    const result = omitSensitiveDiffHunks(raw);
    expect(result).toContain('[Diff omitted for sensitive file: ' + filePath + ']');
    expect(result).not.toContain('should_never_leave_the_machine');
  });
});
