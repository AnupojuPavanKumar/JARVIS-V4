'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registerDocumentController = require('../backend/controllers/DocumentController');
const { DocumentIndex } = require('../core/documents/document-index');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-document-controller-'));
}

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

test('document controller requires the native picker before indexing and supports removal', async () => {
  const root = tempDir();
  const approved = path.join(root, 'approved');
  try {
    fs.mkdirSync(approved, { recursive: true });
    fs.writeFileSync(path.join(approved, 'notes.md'), '# Notes\nApproved local content.\n');
    const index = new DocumentIndex({ baseDir: path.join(root, 'index'), now: () => NOW });
    await index.init();
    const ipc = fakeIpc();
    const audit = [];
    registerDocumentController({
      ipcMain: ipc,
      documentIndex: index,
      dialog: {
        async showOpenDialog() {
          return { canceled: false, filePaths: [approved] };
        },
      },
      secAudit: (action, detail, verdict) => audit.push({ action, detail, verdict }),
    });

    const arbitrary = await ipc.handlers.get('documents-add-folder')({}, { path: root, scope: 'work' });
    assert.equal(arbitrary.ok, false);
    assert.match(arbitrary.error, /system picker/);

    const picked = await ipc.handlers.get('documents-pick-folder')({});
    assert.equal(picked.ok, true);
    assert.equal(picked.path, approved);

    const added = await ipc.handlers.get('documents-add-folder')({}, { path: picked.path, scope: 'work' });
    assert.equal(added.ok, true);
    assert.equal(added.documentCount, 1);
    assert.equal(added.folders.length, 1);
    assert.equal(added.folders[0].scope, 'work');

    const status = await ipc.handlers.get('documents-status')();
    assert.equal(status.ok, true);
    assert.equal(status.documentCount, 1);

    const removed = await ipc.handlers.get('documents-remove-folder')({}, { folderId: added.folders[0].id });
    assert.equal(removed.ok, true);
    assert.equal(removed.documentCount, 0);
    assert.equal(removed.folders.length, 0);

    const deleted = await ipc.handlers.get('documents-delete-all')();
    assert.equal(deleted.ok, true);
    assert.ok(audit.some(entry => entry.action === 'DOCUMENT_ADD_FOLDER'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
