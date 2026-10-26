'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DocumentIndex } = require('../core/documents/document-index');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-document-index-'));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('indexes approved text folders with scoped line citations', async () => {
  const root = tempDir();
  const approved = path.join(root, 'approved');
  try {
    write(path.join(approved, 'project.md'), '# Launch Plan\n\nOwner: Ada\nLaunch date: Friday.\n');
    write(path.join(approved, 'notes.txt'), 'Alpha notes.\nBudget review follows.\n');
    write(path.join(approved, 'sub', 'nested.md'), '# Nested\nA hidden launch dependency.\n');
    write(path.join(approved, 'manual.pdf'), 'not indexed');
    write(path.join(approved, '.private.md'), 'hidden launch text');
    write(path.join(approved, 'node_modules', 'ignored.md'), 'launch ignored');

    const index = new DocumentIndex({ baseDir: path.join(root, 'index'), now: () => NOW });
    await index.init();
    const added = await index.addFolder(approved, 'work');
    assert.equal(added.documentCount, 3);
    assert.equal(added.folders.length, 1);
    assert.equal(added.folders[0].scope, 'work');
    assert.ok(added.folders[0].chunkCount >= 3);

    const results = await index.search('launch');
    assert.equal(results.citations.length >= 2, true);
    assert.equal(results.citations[0].scope, 'work');
    assert.equal(results.citations.some(citation => citation.path.endsWith('project.md')), true);
    const project = results.citations.find(citation => citation.path.endsWith('project.md'));
    assert.equal(project.title, 'Launch Plan');
    assert.equal(project.lineStart, 1);
    assert.match(project.snippet, /Launch/);
    assert.match(project.path, /approved/);

    const scoped = await index.search('launch', { scope: 'personal' });
    assert.equal(scoped.citations.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reindex refreshes changed files and removeFolder deletes only its documents', async () => {
  const root = tempDir();
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  try {
    write(path.join(first, 'a.md'), '# First\nOriginal alpha.\n');
    write(path.join(second, 'b.md'), '# Second\nBeta material.\n');
    const index = new DocumentIndex({ baseDir: path.join(root, 'index'), now: () => NOW });
    await index.init();
    await index.addFolder(first, 'work');
    await index.addFolder(second, 'work');
    assert.equal((await index.stats()).documentCount, 2);

    write(path.join(first, 'a.md'), '# First\nReplacement gamma material.\n');
    fs.utimesSync(path.join(first, 'a.md'), new Date(NOW + 1000), new Date(NOW + 1000));
    await index.reindex();
    const refreshed = await index.search('gamma');
    assert.equal(refreshed.citations.length, 1);
    assert.match(refreshed.citations[0].path, /a\.md/);

    const stats = await index.stats();
    await index.removeFolder(stats.folders.find(folder => folder.path === fs.realpathSync(first)).id);
    const remaining = await index.stats();
    assert.equal(remaining.documentCount, 1);
    assert.equal(remaining.folders.length, 1);
    assert.equal((await index.search('beta')).citations.length, 1);
    assert.equal((await index.search('gamma')).citations.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reload reassigns document scope from its approved folder', async () => {
  const root = tempDir();
  const approved = path.join(root, 'approved');
  try {
    write(path.join(approved, 'note.md'), '# Scoped\nFolder-owned content.\n');
    const baseDir = path.join(root, 'index');
    const index = new DocumentIndex({ baseDir, now: () => NOW });
    await index.init();
    await index.addFolder(approved, 'work');

    const indexPath = path.join(baseDir, 'index.json');
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    raw.documents[0].scope = 'personal';
    fs.writeFileSync(indexPath, JSON.stringify(raw), 'utf8');

    const reloaded = new DocumentIndex({ baseDir, now: () => NOW });
    await reloaded.init();
    assert.equal((await reloaded.search('folder-owned', { scope: 'work' })).citations.length, 1);
    assert.equal((await reloaded.search('folder-owned', { scope: 'personal' })).citations.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retention and deleteAll remove indexed content without touching source files', async () => {
  const root = tempDir();
  const approved = path.join(root, 'approved');
  const file = path.join(approved, 'old.md');
  try {
    write(file, '# Old\nRetention candidate.\n');
    fs.utimesSync(file, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    const index = new DocumentIndex({ baseDir: path.join(root, 'index'), now: () => NOW });
    await index.init();
    await index.addFolder(approved, 'personal');
    const pruned = await index.setRetention(30);
    assert.equal(pruned.retentionDays, 30);
    const applied = await index.applyRetention();
    assert.equal(applied.removed, 1);
    assert.equal(applied.documentCount, 0);
    assert.equal(fs.existsSync(file), true);

    const deleted = await index.deleteAll();
    assert.equal(deleted.folders.length, 0);
    assert.equal(deleted.documentCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects invalid scopes, files, and unknown folders', async () => {
  const root = tempDir();
  try {
    const file = path.join(root, 'not-a-folder.txt');
    write(file, 'text');
    const index = new DocumentIndex({ baseDir: path.join(root, 'index'), now: () => NOW });
    await index.init();
    await assert.rejects(() => index.addFolder(file, 'work'), /not a directory/);
    await assert.rejects(() => index.addFolder(root, 'Bad Scope!'), /scope/);
    await assert.rejects(() => index.removeFolder('folder_missing'), /not found/);
    await assert.rejects(() => index.search(''), /query is required/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
