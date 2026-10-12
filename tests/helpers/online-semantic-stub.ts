import type { DecisionProvider, SemanticDecision, SemanticQuestion } from '../../src/types/provider.js';

/**
 * Unit-test stand-in for a successful TypeSafe response; it never makes a network request.
 * Questions whose id is in `yesIds` (or starts with `problem_`) are answered "yes".
 */
export function createOnlineSemanticStub(yesIds: Iterable<string> = []): DecisionProvider {
  const yes = new Set(yesIds);
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
        probability: yes.has(question.id) || question.id.startsWith('problem_') ? 0.98 : 0.02,
        rationale: `stub answer for ${question.id}`,
      }));
    },
  };
}
