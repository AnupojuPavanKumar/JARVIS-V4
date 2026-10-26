'use strict';

// A small deterministic evaluation set for the lexical retrieval path. It is
// intentionally tiny and model-free so it can run in CI with no Ollama daemon.
const DEFAULT_CASES = Object.freeze([
  {
    name: 'preference is retrieved by a related request',
    query: 'What coffee should I drink?',
    expectedText: 'User prefers oat milk flat whites for coffee',
  },
  {
    name: 'procedure is retrieved by a matching workflow',
    query: 'How should I back up the project notes?',
    expectedText: 'Verified procedure for: back up the project notes',
  },
  {
    name: 'unrelated query does not retrieve a private fact',
    query: 'What is the weather?',
    expectedText: null,
    forbiddenText: 'User email is',
  },
]);

async function evaluateRetrieval(store, cases = DEFAULT_CASES) {
  if (!store || typeof store.retrieve !== 'function') {
    throw new Error('evaluateRetrieval requires a MemoryStore');
  }
  const results = [];
  for (const testCase of cases) {
    const result = await store.retrieve(testCase.query, {
      maxRecords: 6,
      maxChars: 1800,
      allowPersonal: false,
    });
    const texts = result.records.map(record => record.text);
    const found = testCase.expectedText
      ? texts.some(text => text.includes(testCase.expectedText))
      : true;
    const forbidden = testCase.forbiddenText
      ? texts.some(text => text.includes(testCase.forbiddenText))
      : false;
    const budgetOk = result.chars <= result.budget.maxChars
      && result.records.length <= result.budget.maxRecords;
    results.push({
      name: testCase.name,
      pass: found && !forbidden && budgetOk,
      query: testCase.query,
      texts,
      budgetOk,
    });
  }
  return {
    ok: results.every(result => result.pass),
    results,
  };
}

module.exports = {
  DEFAULT_CASES,
  evaluateRetrieval,
};
