import type { DecisionProvider, SemanticDecision, SemanticQuestion } from '../../src/types/provider.js';

const lowProbability = new Set([
  'unrelated_changes',
  'tests_required',
  'security_sensitive_change',
  'auth_requires_tests',
  'payment_behavior_change',
  'breaking_change',
  'debug_leftovers',
]);

/** Unit-test stand-in for a successful TypeSafe response; it never makes a network request. */
export function createOnlineSemanticStub(): DecisionProvider {
  return {
    name: 'typesafe',
    async isAvailable() { return true; },
    async evaluate(_context, questions: SemanticQuestion[]): Promise<SemanticDecision[]> {
      const metadata = {
        requestedProvider: 'typesafe',
        effectiveProvider: 'typesafe',
        effectiveModel: 'jev-test',
        fallback: false,
        questionsCount: questions.length,
      };
      return questions.map((question) => ({
        id: question.id,
        provider: 'typesafe',
        metadata,
        confidence: 0.99,
        ...(question.type === 'boolean'
          ? { probability: lowProbability.has(question.id) ? 0.02 : 0.98 }
          : question.type === 'score'
          ? { score: 0, value: 'negligible' }
          : { value: 'none' }),
      }));
    },
  };
}
