'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDocumentTools } = require('../core/documents/document-tools');

test('document search is an untrusted read tool with citations and redacted audit metadata', async () => {
  const audit = [];
  const tools = createDocumentTools({
    index: {
      async search(query, options) {
        assert.equal(query, 'launch');
        assert.equal(options.scope, 'work');
        return {
          query,
          citations: [{
            path: 'C:/approved/project.md',
            title: 'Launch Plan',
            scope: 'work',
            lineStart: 1,
            lineEnd: 4,
            snippet: 'Launch Plan',
            score: 2.5,
          }],
          searchedChunks: 3,
        };
      },
    },
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
  });

  assert.equal(tools.length, 1);
  const tool = tools[0];
  assert.equal(tool.id, 'document_search');
  assert.equal(tool.risk, 'read');
  assert.equal(tool.untrusted, true);
  assert.equal(tool.params.query.required, true);

  const result = await tool.execute({ query: 'launch', scope: 'work', max_results: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.taint, true);
  assert.equal(result.result.citations[0].lineStart, 1);
  assert.equal(JSON.stringify(audit).includes('launch'), false);
  assert.ok(audit.some(entry => entry.action === 'DOCUMENT_SEARCH' && entry.verdict === 'ALLOWED'));
});

test('document search returns a structured failure without leaking query text in audit', async () => {
  const audit = [];
  const tool = createDocumentTools({
    index: {
      async search() {
        throw new Error('index unavailable');
      },
    },
    audit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
  })[0];

  const result = await tool.execute({ query: 'private phrase' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'document-search-error');
  assert.equal(JSON.stringify(audit).includes('private phrase'), false);
  assert.ok(audit.some(entry => entry.verdict === 'DENY'));
});
