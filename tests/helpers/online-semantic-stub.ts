import type { DecisionProvider, SemanticDecision, SemanticQuestion } from '../../src/types/provider.js';

/**
 * Unit-test stand-in for a successful TypeSafe response; it never makes a network request.
 * Rules whose id is in `violatedIds` (or starts with `violated_`) are judged as violated.
 */
export function createOnlineSemanticStub(violatedIds: Iterable<string> = []): DecisionProvider {
  const violated = new Set(violatedIds);
  return {
    name: 'typesafe',
    async isAvailable() { return true; },
    async evaluate(_context, questions: SemanticQuestion[]): Promise<SemanticDecision[]> {
      const metadata = { provider: 'typesafe', effectiveModel: 'jev-test', questionsCount: questions.length };
      return questions.map((question) => ({
        id: question.id,
        provider: 'typesafe',
        metadata,
        confidence: 0.99,
        probability: violated.has(question.id) || question.id.startsWith('violated_') ? 0.98 : 0.02,
        rationale: `stub answer for ${question.id}`,
      }));
    },
  };
}
