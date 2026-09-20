/**
 * tests/unit/analysis/semantic.test.ts
 * Unit test suite for Semantic Analysis layer:
 * - Standard System One Questions (questions.ts)
 * - Deterministic Mock Provider (mock-provider.ts)
 * - TypeSafe System One Provider & Fallback (typesafe-provider.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MVP_STANDARD_QUESTIONS,
  STANDARD_QUESTIONS_MAP,
  getStandardQuestion,
  getAllStandardQuestions,
} from '../../../src/analysis/semantic/questions.js';
import { DeterministicMockProvider } from '../../../src/analysis/semantic/mock-provider.js';
import { TypeSafeSystemOneProvider } from '../../../src/analysis/semantic/typesafe-provider.js';
import type { EvaluationContext } from '../../../src/types/context.js';
import type { SemanticQuestion } from '../../../src/types/provider.js';
import { ProviderError } from '../../../src/types/errors.js';

describe('Semantic Analysis Layer', () => {
  const createBaseContext = (overrides?: Partial<EvaluationContext>): EvaluationContext => ({
    task: {
      task: 'Implement user login authentication with JWT verification',
      taskPresent: true,
      keywords: ['login', 'authentication', 'jwt', 'user'],
    },
    diff: {
      raw: 'diff --git a/src/auth.ts b/src/auth.ts\n+export function login(user, token) { verifyJwt(token); }',
      files: [
        {
          newPath: 'src/auth.ts',
          status: 'modified',
          binary: false,
          hunks: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              header: '@@ -0,0 +1 @@',
              lines: ['+export function login(user, token) { verifyJwt(token); }'],
            },
          ],
          additions: 1,
          deletions: 0,
        },
      ],
      insertions: 1,
      deletions: 0,
      truncated: false,
    },
    files: [],
    instructions: [],
    relatedTests: [],
    repository: {
      rootPath: '/mock/repo',
      branch: 'main',
      headSha: 'c0ffee',
      isClean: false,
    },
    evidence: [],
    ...overrides,
  });

  describe('Standard Questions (questions.ts)', () => {
    it('defines all 10 canonical MVP semantic questions', () => {
      expect(MVP_STANDARD_QUESTIONS).toHaveLength(10);
      const ids = MVP_STANDARD_QUESTIONS.map((q) => q.id);

      expect(ids).toContain('task_completed');
      expect(ids).toContain('task_scope_match');
      expect(ids).toContain('unrelated_changes');
      expect(ids).toContain('tests_required');
      expect(ids).toContain('tests_present');
      expect(ids).toContain('behavior_change');
      expect(ids).toContain('security_sensitive_change');
      expect(ids).toContain('breaking_change');
      expect(ids).toContain('debug_leftovers');
      expect(ids).toContain('regression_risk');
    });

    it('retrieves questions via getStandardQuestion and getAllStandardQuestions', () => {
      const q = getStandardQuestion('task_completed');
      expect(q).toBeDefined();
      expect(q?.type).toBe('boolean');
      expect(q?.prompt).toContain('fulfill the requirements');

      const all = getAllStandardQuestions();
      expect(all.length).toBeGreaterThanOrEqual(11); // 10 MVP + change_type
    });

    it('configures regression_risk score levels correctly', () => {
      const riskQuestion = STANDARD_QUESTIONS_MAP.regression_risk;
      expect(riskQuestion.type).toBe('score');
      expect(riskQuestion.levels).toBeDefined();
      expect(riskQuestion.levels).toHaveLength(5);
      expect(riskQuestion.levels?.[0].name).toBe('negligible');
      expect(riskQuestion.levels?.[4].name).toBe('critical');
    });
  });

  describe('DeterministicMockProvider (mock-provider.ts)', () => {
    const provider = new DeterministicMockProvider();

    it('is always available offline without network or keys', async () => {
      expect(provider.name).toBe('mock');
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('produces 100% reproducible identical outputs on identical inputs', async () => {
      const context = createBaseContext();
      const run1 = await provider.evaluate(context, MVP_STANDARD_QUESTIONS);
      const run2 = await provider.evaluate(context, MVP_STANDARD_QUESTIONS);

      expect(run1).toEqual(run2);
    });

    it('evaluates task_completed accurately based on keyword match ratio', async () => {
      // High match context
      const contextHigh = createBaseContext({
        task: {
          task: 'Add login helper',
          taskPresent: true,
          keywords: ['login', 'helper'],
        },
        diff: {
          raw: 'diff --git a/src/login.ts b/src/login.ts\n+export function loginHelper() {}',
          files: [{ newPath: 'src/login.ts', status: 'added', binary: false, hunks: [], additions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
      });
      const [resHigh] = await provider.evaluate(contextHigh, [STANDARD_QUESTIONS_MAP.task_completed]);
      expect(resHigh.probability).toBe(0.94);

      // Low match context
      const contextLow = createBaseContext({
        task: {
          task: 'Refactor database migration schema',
          taskPresent: true,
          keywords: ['database', 'migration', 'schema'],
        },
        diff: {
          raw: 'diff --git a/src/ui.css b/src/ui.css\n+body { color: red; }',
          files: [{ newPath: 'src/ui.css', status: 'modified', binary: false, hunks: [], additions: 1, deletions: 0 }],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
      });
      const [resLow] = await provider.evaluate(contextLow, [STANDARD_QUESTIONS_MAP.task_completed]);
      expect(resLow.probability).toBe(0.35);

      // Empty task context defaults to 1.0 completed
      const contextEmpty = createBaseContext({
        task: { task: '', taskPresent: false, keywords: [] },
      });
      const [resEmpty] = await provider.evaluate(contextEmpty, [STANDARD_QUESTIONS_MAP.task_completed]);
      expect(resEmpty.probability).toBe(1.0);
    });

    it('evaluates tests_required and tests_present based on code changes and test files', async () => {
      // Logic file change (> 15 lines) with NO test files in diff
      const contextNoTests = createBaseContext({
        diff: {
          raw: 'diff --git a/src/service.ts b/src/service.ts',
          files: [
            {
              newPath: 'src/service.ts',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 20,
              deletions: 5,
            },
          ],
          insertions: 20,
          deletions: 5,
          truncated: false,
        },
      });

      const decisionsNoTests = await provider.evaluate(contextNoTests, [
        STANDARD_QUESTIONS_MAP.tests_required,
        STANDARD_QUESTIONS_MAP.tests_present,
      ]);

      const reqDecision = decisionsNoTests.find((d) => d.id === 'tests_required');
      const presDecision = decisionsNoTests.find((d) => d.id === 'tests_present');

      expect(reqDecision?.probability).toBe(0.88); // High tests required
      expect(presDecision?.probability).toBe(0.1); // Tests not present

      // Documentation-only changes (no tests required)
      const contextDocOnly = createBaseContext({
        diff: {
          raw: 'diff --git a/README.md b/README.md',
          files: [
            {
              newPath: 'README.md',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 50,
              deletions: 0,
            },
          ],
          insertions: 50,
          deletions: 0,
          truncated: false,
        },
      });

      const decisionsDoc = await provider.evaluate(contextDocOnly, [
        STANDARD_QUESTIONS_MAP.tests_required,
      ]);
      expect(decisionsDoc[0].probability).toBe(0.05);

      // Tests present in diff
      const contextWithTests = createBaseContext({
        diff: {
          raw: 'diff --git a/tests/service.test.ts b/tests/service.test.ts',
          files: [
            {
              newPath: 'src/service.ts',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 10,
              deletions: 0,
            },
            {
              newPath: 'tests/service.test.ts',
              status: 'added',
              binary: false,
              hunks: [],
              additions: 30,
              deletions: 0,
            },
          ],
          insertions: 40,
          deletions: 0,
          truncated: false,
        },
      });

      const decisionsWithTests = await provider.evaluate(contextWithTests, [
        STANDARD_QUESTIONS_MAP.tests_present,
      ]);
      expect(decisionsWithTests[0].probability).toBe(0.92);
    });

    it('evaluates security_sensitive_change correctly when security keywords exist', async () => {
      const securityContext = createBaseContext({
        diff: {
          raw: 'diff --git a/src/auth/jwt-token.ts b/src/auth/jwt-token.ts',
          files: [
            {
              newPath: 'src/auth/jwt-token.ts',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 5,
              deletions: 0,
            },
          ],
          insertions: 5,
          deletions: 0,
          truncated: false,
        },
      });

      const [decision] = await provider.evaluate(securityContext, [
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
      ]);
      expect(decision.probability).toBe(0.86);

      // Normal non-security context
      const normalContext = createBaseContext({
        diff: {
          raw: 'diff --git a/src/utils/calc.ts b/src/utils/calc.ts\n+export const sum = (a, b) => a + b;',
          files: [
            {
              newPath: 'src/utils/calc.ts',
              status: 'modified',
              binary: false,
              hunks: [],
              additions: 1,
              deletions: 0,
            },
          ],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
      });

      const [normalDecision] = await provider.evaluate(normalContext, [
        STANDARD_QUESTIONS_MAP.security_sensitive_change,
      ]);
      expect(normalDecision.probability).toBe(0.06);
    });

    it('evaluates debug_leftovers when console.log or debugger is present in additions', async () => {
      const debugContext = createBaseContext({
        diff: {
          raw: 'diff --git a/src/api.ts b/src/api.ts',
          files: [
            {
              newPath: 'src/api.ts',
              status: 'modified',
              binary: false,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 0,
                  newStart: 1,
                  newLines: 1,
                  header: '@@ -0,0 +1 @@',
                  lines: ['+console.log("DEBUG test info", data);'],
                },
              ],
              additions: 1,
              deletions: 0,
            },
          ],
          insertions: 1,
          deletions: 0,
          truncated: false,
        },
      });

      const [debugDecision] = await provider.evaluate(debugContext, [
        STANDARD_QUESTIONS_MAP.debug_leftovers,
      ]);
      expect(debugDecision.probability).toBe(0.95);

      // Clean context without debug prints
      const cleanContext = createBaseContext();
      const [cleanDecision] = await provider.evaluate(cleanContext, [
        STANDARD_QUESTIONS_MAP.debug_leftovers,
      ]);
      expect(cleanDecision.probability).toBe(0.02);
    });

    it('evaluates regression_risk tiers across different diff sizes', async () => {
      // Small diff (< 20 lines) -> negligible
      const small = createBaseContext({ diff: { raw: '', files: [], insertions: 10, deletions: 2, truncated: false } });
      const [smallRes] = await provider.evaluate(small, [STANDARD_QUESTIONS_MAP.regression_risk]);
      expect(smallRes.value).toBe('negligible');
      expect(smallRes.score).toBe(0.1);

      // Medium diff (150 lines) -> medium
      const med = createBaseContext({ diff: { raw: '', files: [], insertions: 100, deletions: 50, truncated: false } });
      const [medRes] = await provider.evaluate(med, [STANDARD_QUESTIONS_MAP.regression_risk]);
      expect(medRes.value).toBe('medium');
      expect(medRes.score).toBe(0.6);

      // Huge diff (> 400 lines) -> high
      const huge = createBaseContext({ diff: { raw: '', files: [], insertions: 350, deletions: 100, truncated: false } });
      const [hugeRes] = await provider.evaluate(huge, [STANDARD_QUESTIONS_MAP.regression_risk]);
      expect(hugeRes.value).toBe('high');
      expect(hugeRes.score).toBe(0.85);
    });

    it('evaluates change_type choice classification', async () => {
      const docContext = createBaseContext({
        diff: {
          raw: '',
          files: [{ newPath: 'docs/guide.md', status: 'modified', binary: false, hunks: [], additions: 5, deletions: 0 }],
          insertions: 5,
          deletions: 0,
          truncated: false,
        },
      });
      const [docRes] = await provider.evaluate(docContext, [STANDARD_QUESTIONS_MAP.change_type]);
      expect(docRes.value).toBe('documentation');

      const bugContext = createBaseContext({
        task: { task: 'Fix issue with login timeout', taskPresent: true, keywords: ['fix', 'bug'] },
      });
      const [bugRes] = await provider.evaluate(bugContext, [STANDARD_QUESTIONS_MAP.change_type]);
      expect(bugRes.value).toBe('bug_fix');
    });

    it('evaluates fallback gracefully for custom non-standard questions', async () => {
      const customBool: SemanticQuestion = {
        id: 'custom_compliance_check',
        type: 'boolean',
        prompt: 'Is this compliant with internal policy?',
      };
      const [res] = await provider.evaluate(createBaseContext(), [customBool]);
      expect(res.probability).toBe(0.5);
      expect(res.provider).toBe('mock');
    });
  });

  describe('TypeSafeSystemOneProvider (typesafe-provider.ts)', () => {
    it('isAvailable returns false when API key is missing', async () => {
      const provider = new TypeSafeSystemOneProvider({ apiKey: '' });
      expect(await provider.isAvailable()).toBe(false);
    });

    it('isAvailable returns true when API key is configured', async () => {
      const provider = new TypeSafeSystemOneProvider({ apiKey: 'ts_test_key_12345' });
      expect(await provider.isAvailable()).toBe(true);
    });

    it('transparently falls back to DeterministicMockProvider when API key is absent', async () => {
      const provider = new TypeSafeSystemOneProvider({ apiKey: '' });
      const context = createBaseContext();

      const decisions = await provider.evaluate(context, [
        STANDARD_QUESTIONS_MAP.task_completed,
        STANDARD_QUESTIONS_MAP.tests_required,
      ]);

      expect(decisions).toHaveLength(2);
      expect(decisions[0].provider).toBe('mock');
      expect(decisions[0].probability).toBeDefined();
    });

    it('throws ProviderError in strict mode when API key is absent', async () => {
      const provider = new TypeSafeSystemOneProvider({ apiKey: '', strict: true });
      const context = createBaseContext();

      await expect(
        provider.evaluate(context, [STANDARD_QUESTIONS_MAP.task_completed])
      ).rejects.toThrow(ProviderError);
    });

    it('successfully calls TypeSafe API when key and endpoint are working', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          decisions: [
            {
              id: 'task_completed',
              probability: 0.97,
              confidence: 0.95,
              rationale: 'All requested JWT verification logic is implemented.',
            },
          ],
        }),
      });

      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'ts_valid_key',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const context = createBaseContext();
      const decisions = await provider.evaluate(context, [STANDARD_QUESTIONS_MAP.task_completed]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe('task_completed');
      expect(decisions[0].probability).toBe(0.97);
      expect(decisions[0].provider).toBe('typesafe');
      expect(decisions[0].rationale).toContain('All requested JWT verification');
    });

    it('transparently falls back to DeterministicMockProvider on network or HTTP errors', async () => {
      const failingFetch = vi.fn().mockRejectedValue(new Error('Network connection timeout'));

      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'ts_key',
        fetchFn: failingFetch as unknown as typeof fetch,
        strict: false,
      });

      const context = createBaseContext();
      const decisions = await provider.evaluate(context, [STANDARD_QUESTIONS_MAP.task_completed]);

      expect(failingFetch).toHaveBeenCalledTimes(1);
      expect(decisions).toHaveLength(1);
      expect(decisions[0].provider).toBe('mock');
      expect(decisions[0].probability).toBeDefined();
    });

    it('throws ProviderError on API error in strict mode', async () => {
      const errorResponseFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Service unavailable',
      });

      const provider = new TypeSafeSystemOneProvider({
        apiKey: 'ts_key',
        fetchFn: errorResponseFetch as unknown as typeof fetch,
        strict: true,
      });

      const context = createBaseContext();

      await expect(
        provider.evaluate(context, [STANDARD_QUESTIONS_MAP.task_completed])
      ).rejects.toThrow(ProviderError);
    });
  });
});
