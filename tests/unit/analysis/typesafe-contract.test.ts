/**
 * tests/unit/analysis/typesafe-contract.test.ts
 * Comprehensive test suite verifying TypeSafe System One / Jev official API contract,
 * questions/answers map schemas, rate-limit retry, observable metadata, and dual-context secret handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { TypeSafeSystemOneProvider } from '../../../src/analysis/semantic/typesafe-provider.js';
import { STANDARD_QUESTIONS_MAP } from '../../../src/analysis/semantic/questions.js';
import { DefaultContextBuilder } from '../../../src/context/builder.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { GitAdapter, GitStatusResult } from '../../../src/types/git.js';
import { FileFindingStore } from '../../../src/findings/store.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

function createDummyContext(diffText = 'diff --git a/src/index.ts b/src/index.ts\n+console.log("hello");'): EvaluationContext {
  return {
    repository: {
      root: '/fake/repo',
      branch: 'main',
      headSha: '0123456789abcdef',
      isClean: false,
    },
    diff: {
      scope: 'staged',
      raw: diffText,
      files: [
        {
          path: 'src/index.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          hunks: [],
        },
      ],
      summary: {
        filesChanged: 1,
        insertions: 1,
        deletions: 0,
      },
    },
    task: {
      task: 'Add logging to index.ts',
      requirements: ['Add logging'],
    },
  };
}

describe('TypeSafe System One Official API Contract', () => {
  it('dispatches to /v1/systemone with questions map payload', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    const mockFetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);

      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'jev-latest',
          answers: {
            task_completed: {
              type: 'noul',
              noul: 0.95,
              confidence: 0.99,
              rationale: 'Logging statement was implemented cleanly.',
            },
            unrelated_changes: {
              type: 'noul',
              noul: 0.05,
              confidence: 0.98,
              rationale: 'No unrelated changes detected.',
            },
          },
        }),
      };
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-typesafe-key-123',
      baseUrl: 'https://api.typesafe.ai/v1',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const context = createDummyContext();
    const questions = [
      STANDARD_QUESTIONS_MAP.task_completed,
      STANDARD_QUESTIONS_MAP.unrelated_changes,
    ];

    const decisions = await provider.evaluate(context, questions);

    // 1. Verify endpoint is official /v1/systemone
    expect(capturedUrl).toBe('https://api.typesafe.ai/v1/systemone');

    // 2. Verify payload has questions map
    expect(capturedBody).toHaveProperty('questions');
    expect(typeof capturedBody.questions).toBe('object');
    expect(capturedBody.questions.task_completed.type).toBe('noul');
    expect(capturedBody.questions.task_completed.instructions).toBeDefined();

    // 3. Verify returned decisions
    expect(decisions).toHaveLength(2);
    expect(decisions[0].id).toBe('task_completed');
    expect(decisions[0].probability).toBe(0.95);
    expect(decisions[0].confidence).toBe(0.99);
    expect(decisions[0].provider).toBe('typesafe');
  });

  it('provides observable metadata with evaluateWithReport', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        model: 'jev-2.5',
        answers: {
          task_completed: {
            type: 'noul',
            noul: 0.88,
            confidence: 0.92,
            rationale: 'Looks good',
          },
        },
      }),
    }));

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const report = await provider.evaluateWithReport(createDummyContext(), [
      STANDARD_QUESTIONS_MAP.task_completed,
    ]);

    expect(report.metadata.fallback).toBe(false);
    expect(report.metadata.requestedProvider).toBe('typesafe');
    expect(report.metadata.effectiveProvider).toBe('typesafe');
    expect(report.metadata.effectiveModel).toBe('jev-2.5');
    expect(report.decisions[0].probability).toBe(0.88);
  });

  it('rejects incomplete or invalid HTTP 200 answers in strict mode', async () => {
    const cases = [
      { question: STANDARD_QUESTIONS_MAP.task_completed, answer: {}, reason: 'probability' },
      { question: STANDARD_QUESTIONS_MAP.task_completed, answer: { noul: 1.2 }, reason: 'probability' },
      { question: STANDARD_QUESTIONS_MAP.task_completed, answer: { noul: Number.NaN }, reason: 'probability' },
      { question: STANDARD_QUESTIONS_MAP.change_type, answer: { choice: 'not-a-category' }, reason: 'unknown choice' },
      { question: STANDARD_QUESTIONS_MAP.regression_risk, answer: { score: 9 }, reason: 'score' },
    ];
    for (const { question, answer, reason } of cases) {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ answers: { [question.id]: answer } }),
      });
      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'test', strict: true, fetchFn: mockFetch as unknown as typeof fetch,
      });
      await expect(provider.evaluate(createDummyContext(), [question])).rejects.toThrow(reason);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('retries on HTTP 429 and succeeds on second attempt', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          text: async () => 'Rate limit exceeded',
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'jev-latest',
          answers: {
            task_completed: {
              type: 'noul',
              noul: 0.92,
              confidence: 0.95,
              rationale: 'Succeeded after 429 backoff',
            },
          },
        }),
      };
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      retryBackoffMs: 10,
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const decisions = await provider.evaluate(createDummyContext(), [
      STANDARD_QUESTIONS_MAP.task_completed,
    ]);

    expect(callCount).toBe(2);
    expect(decisions[0].probability).toBe(0.92);
  });

  it('marks fallback=true and exposes fallbackReason when external provider fails', async () => {
    const failingFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Internal Server Error',
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      fetchFn: failingFetch as unknown as typeof fetch,
      strict: false,
    });

    const report = await provider.evaluateWithReport(createDummyContext(), [
      STANDARD_QUESTIONS_MAP.task_completed,
    ]);

    expect(report.metadata.fallback).toBe(true);
    expect(report.metadata.effectiveProvider).toBe('mock');
    expect(report.metadata.fallbackReason).toContain('500');
    expect(report.decisions[0].provider).toBe('mock');
  });

  it('retries on network transient error (fetch exception) and succeeds on retry', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('fetch failed: ECONNRESET');
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'jev-latest',
          answers: {
            task_completed: {
              type: 'noul',
              noul: 0.9,
              confidence: 0.95,
              rationale: 'Recovered from transient network glitch',
            },
          },
        }),
      };
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      retryBackoffMs: 10,
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const decisions = await provider.evaluate(createDummyContext(), [
      STANDARD_QUESTIONS_MAP.task_completed,
    ]);

    expect(callCount).toBe(2);
    expect(decisions[0].probability).toBe(0.9);
  });

  it('parses and respects Retry-After header on HTTP 429', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            get: (h: string) => (h.toLowerCase() === 'retry-after' ? '0.05' : null),
          },
          text: async () => 'Rate limit exceeded',
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          model: 'jev-latest',
          answers: {
            task_completed: {
              type: 'noul',
              noul: 0.98,
              confidence: 0.99,
              rationale: 'Succeeded after Retry-After delay',
            },
          },
        }),
      };
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      retryBackoffMs: 1000, // configured backoff is 1s, but Retry-After says 0.05s (50ms)
      maxRetries: 2,
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const startTime = Date.now();
    const decisions = await provider.evaluate(createDummyContext(), [
      STANDARD_QUESTIONS_MAP.task_completed,
    ]);
    const elapsed = Date.now() - startTime;

    expect(callCount).toBe(2);
    expect(decisions[0].probability).toBe(0.98);
    // Should respect Retry-After (~50ms) instead of waiting for 1000ms
    expect(elapsed).toBeLessThan(800);
  });
});

describe('Dual Context Separation & Secret Handling', () => {
  it('builds rawContext with unredacted diff and semanticContext with redacted secrets', async () => {
    const mockGit: Partial<GitAdapter> = {
      getRepositoryRoot: vi.fn().mockResolvedValue('/fake/repo'),
      getHeadCommit: vi.fn().mockResolvedValue({
        hash: '1234567890abcdef',
        shortHash: '1234567',
        author: 'Dev',
        date: new Date().toISOString(),
        message: 'commit',
      }),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'main',
        headSha: '1234567890abcdef',
        isClean: false,
        stagedFiles: ['src/.env'],
        unstagedFiles: [],
        untrackedFiles: [],
      } satisfies GitStatusResult),
      getDiff: vi.fn().mockResolvedValue(
        'diff --git a/.env b/.env\n+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n+DATABASE_PASSWORD=SuperSecretPassword123!\n'
      ),
      readFileAtRef: vi.fn().mockResolvedValue(''),
    };

    const builder = new DefaultContextBuilder(mockGit as GitAdapter);
    const { rawContext, semanticContext } = await builder.buildDualContext({
      scope: 'staged',
      privacy: { redactSecrets: true },
    });

    // 1. rawContext preserves sensitive strings so deterministic secret scanner can detect them
    expect(rawContext.diff.raw).toContain('AWS_SECRET_ACCESS_KEY');
    expect(rawContext.diff.raw).toContain('SuperSecretPassword123!');

    // 2. semanticContext is redacted so external AI models never receive secrets
    expect(semanticContext.diff.raw).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(semanticContext.diff.raw).not.toContain('SuperSecretPassword123!');
    expect(semanticContext.diff.raw).toContain('[Diff omitted for sensitive file: .env]');
  });
});

describe('FileFindingStore Repository-level Persistence', () => {
  it('saves and reads findings correctly from .git/gitguard/findings.json', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-store-test-'));
    try {
      const store = new FileFindingStore(tmpDir);

      const finding1 = {
        id: 'F-STORE-001',
        ruleId: 'deterministic.secret_scan',
        source: 'deterministic' as const,
        status: 'block' as const,
        severity: 'CRITICAL' as const,
        lifecycle: 'active' as const,
        affectedFiles: ['config.env'],
        message: 'Leaked API token',
        evidence: [],
        expectedEvidence: ['Remove token'],
        fingerprint: 'fp_store_001',
        createdAt: new Date().toISOString(),
      };

      await store.save([finding1]);

      const loaded = await store.list();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('F-STORE-001');
      expect(loaded[0].message).toBe('Leaked API token');

      // Update lifecycle
      const updated = {
        ...finding1,
        lifecycle: 'resolved' as const,
        resolvedAt: new Date().toISOString(),
      };
      await store.save([updated]);

      const reloaded = await store.list();
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].lifecycle).toBe('resolved');

      // Filter active should return 0
      const activeOnly = await store.list({ lifecycle: 'active' });
      expect(activeOnly).toHaveLength(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('resolves git root from a subdirectory and writes atomically with tmp+rename', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitguard-store-sub-'));
    try {
      const gitDir = path.join(tmpDir, '.git');
      const subDir = path.join(tmpDir, 'src', 'components');
      await fs.mkdir(gitDir, { recursive: true });
      await fs.mkdir(subDir, { recursive: true });

      // Instantiate FileFindingStore inside subdirectory
      const store = new FileFindingStore(subDir);
      const testFinding = {
        id: 'F-SUB-001',
        ruleId: 'deterministic.test',
        source: 'deterministic' as const,
        status: 'block' as const,
        severity: 'CRITICAL' as const,
        lifecycle: 'active' as const,
        affectedFiles: ['src/components/Button.tsx'],
        message: 'Failing component test',
        evidence: [],
        expectedEvidence: [],
        fingerprint: 'fp_sub_001',
        createdAt: new Date().toISOString(),
      };

      await store.save([testFinding]);

      // Verify file is written inside repoRoot/.git/gitguard/findings.json
      const expectedPath = path.join(gitDir, 'gitguard', 'findings.json');
      const content = await fs.readFile(expectedPath, 'utf8');
      expect(content).toContain('F-SUB-001');

      const loaded = await store.list();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('F-SUB-001');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('v0.2.1 Core Correctness Hotfixes Regression Suite', () => {
  it('falls back to TYPESAFE_API_KEY when options omits apiKey', async () => {
    const oldEnv = process.env.TYPESAFE_API_KEY;
    try {
      process.env.TYPESAFE_API_KEY = 'env-typesafe-key-999';
      const provider = new TypeSafeSystemOneProvider({});
      expect(await provider.isAvailable()).toBe(true);
    } finally {
      if (oldEnv === undefined) {
        delete process.env.TYPESAFE_API_KEY;
      } else {
        process.env.TYPESAFE_API_KEY = oldEnv;
      }
    }
  });

  it('maps rawScore 1.05 to normalized score and categorical low without false critical block', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-latest',
        answers: {
          regression_risk: {
            type: 'score',
            score: 1.05,
            confidence: 0.95,
            rationale: 'Low blast radius with localized modifications.',
          },
        },
      }),
    });

    const provider = new TypeSafeSystemOneProvider({
      apiKey: 'test-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const context = createDummyContext();
    const decisions = await provider.evaluate(context, [STANDARD_QUESTIONS_MAP.regression_risk]);

    expect(decisions).toHaveLength(1);
    const d = decisions[0];
    expect(d.rawScore).toBe(1.05);
    // Normalized score in 0..1 scale (1.05 / 4 = 0.2625)
    expect(d.score).toBeCloseTo(0.2625, 4);
    // Nearest categorical level mapped to 'low'
    expect(d.value).toBe('low');
  });

  it('preserves complete unbudgeted diff in rawContext for secret scanning (>50KB)', async () => {
    // Generate a 60KB diff where the secret is inserted past 55KB
    const padding = '+line_content_padding_string_to_fill_token_budget_up_to_limit\n'.repeat(900);
    const secretLine = '+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n';
    const largeDiff = `diff --git a/src/app.ts b/src/app.ts\n${padding}${secretLine}`;

    expect(largeDiff.length).toBeGreaterThan(55000);

    const mockGit: Partial<GitAdapter> = {
      getRepositoryRoot: vi.fn().mockResolvedValue('/fake/repo'),
      getHeadCommit: vi.fn().mockResolvedValue({
        hash: '1234567890abcdef',
        shortHash: '1234567',
        author: 'Dev',
        date: new Date().toISOString(),
        message: 'commit',
      }),
      getStatus: vi.fn().mockResolvedValue({
        branch: 'main',
        headSha: '1234567890abcdef',
        isClean: false,
        stagedFiles: ['src/app.ts'],
        unstagedFiles: [],
        untrackedFiles: [],
      } satisfies GitStatusResult),
      getDiff: vi.fn().mockResolvedValue(largeDiff),
      readFileAtRef: vi.fn().mockResolvedValue(''),
      getFileContent: vi.fn().mockResolvedValue(''),
    };

    const builder = new DefaultContextBuilder(mockGit as GitAdapter);
    const { rawContext, semanticContext } = await builder.buildDualContext({
      scope: 'staged',
      budget: { maxDiffChars: 50000 },
    });

    // rawContext.diff is completely untruncated for local scanners
    expect(rawContext.diff.raw).toContain('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');

    // semanticContext.diff is truncated for external AI model context limits
    expect(semanticContext.diff.truncated).toBe(true);
    expect(semanticContext.diff.raw).toContain('[Diff truncated due to budget limit]');
  });
});
