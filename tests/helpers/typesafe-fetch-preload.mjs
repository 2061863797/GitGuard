// Test-only TypeSafe HTTP stand-in for real MCP stdio subprocesses.
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url !== 'https://api.typesafe.ai/v1/systemone') {
    throw new Error('Unexpected URL in MCP E2E TypeSafe stub: ' + url);
  }
  const request = JSON.parse(String(init?.body || '{}'));
  const questions = request.questions || {};
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'score') return [id, { type: 'score', score: 0, value: 'negligible' }];
    if (question.type === 'choice') return [id, { type: 'choice', choice: 'none' }];
    const low = new Set([
      'unrelated_changes', 'tests_required', 'security_sensitive_change',
      'auth_requires_tests', 'payment_behavior_change', 'breaking_change', 'debug_leftovers',
    ]);
    return [id, { type: 'noul', noul: low.has(id) ? 0.02 : 0.98 }];
  }));
  return new Response(JSON.stringify({ model: 'jev-e2e-stub', answers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
