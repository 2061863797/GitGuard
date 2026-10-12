// Test-only TypeSafe HTTP stand-in for real MCP stdio subprocesses.
// Rules whose id starts with "violated_" are judged as violated ("yes"); all others "no".
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url !== 'https://api.typesafe.ai/v1/systemone') {
    throw new Error('Unexpected URL in MCP E2E TypeSafe stub: ' + url);
  }
  const request = JSON.parse(String(init?.body || '{}'));
  const questions = request.questions || {};
  const answers = Object.fromEntries(Object.keys(questions).map((id) => (
    [id, { noul: id.startsWith('violated_') ? 0.98 : 0.02, rationale: 'e2e stub' }]
  )));
  return new Response(JSON.stringify({ model: 'jev-e2e-stub', answers }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
