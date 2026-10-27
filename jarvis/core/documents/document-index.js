'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isSecretProjectFile } = require('../../backend/security/secret-files');

const INDEX_VERSION = 1;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CHUNKS_PER_FILE = 200;
const DEFAULT_MAX_TOTAL_CHUNKS = 20000;
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP_LINES = 2;

const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py',
  '.html', '.htm', '.css', '.yml', '.yaml', '.toml',
]);

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.cache', '.next', 'dist', 'build',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'when', 'where',
  'which', 'who', 'how', 'are', 'was', 'were', 'been', 'have', 'has', 'had',
  'into', 'about', 'over', 'under', 'than', 'then', 'there', 'their', 'them',
  'you', 'your', 'our', 'its', 'not', 'but', 'can', 'could', 'should', 'would',
]);

function iso(value) {
  return new Date(value).toISOString();
}

function makeId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function normalizeScope(scope, fallback = 'general') {
  const value = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
  if (!value) return fallback;
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(value)) {
    throw new Error('scope must be 1-40 lowercase letters, numbers, dashes, or underscores');
  }
  return value;
}

function safeScope(value, fallback = 'general') {
  try {
    return normalizeScope(value, fallback);
  } catch {
    return fallback;
  }
}

function isInsideFolder(folderPath, filePath) {
  const relative = path.relative(folderPath, filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function tokenize(value) {
  const matches = String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  return [...new Set(matches.filter(token => token.length >= 2 && !STOP_WORDS.has(token)))];
}

function isProbablyText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('utf8');
  if (!sample) return true;
  const replacementCount = (sample.match(/\uFFFD/g) || []).length;
  return replacementCount / sample.length < 0.02;
}

function chunkText(text, maxChunks = DEFAULT_MAX_CHUNKS_PER_FILE) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks = [];
  let start = 0;
  let truncated = false;

  while (start < lines.length) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      break;
    }
    let end = start;
    let chars = 0;
    while (end < lines.length && (chars < CHUNK_CHARS || end === start)) {
      chars += lines[end].length + 1;
      end += 1;
    }
    const content = lines.slice(start, end).join('\n').trim();
    if (content) {
      chunks.push({
        id: '',
        text: content,
        lineStart: start + 1,
        lineEnd: end,
      });
    }
    if (end >= lines.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_LINES);
  }

  return { chunks, truncated };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== INDEX_VERSION) {
    return {
      version: INDEX_VERSION,
      updatedAt: iso(Date.now()),
      retentionDays: null,
      folders: [],
      documents: [],
      lastIndexedAt: null,
    };
  }
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter(folder => (
      folder && typeof folder.path === 'string' && path.isAbsolute(folder.path) && typeof folder.scope === 'string'
    )).map(folder => ({
      id: typeof folder.id === 'string' ? folder.id : makeId('folder', folder.path),
      path: folder.path,
      scope: safeScope(folder.scope),
      addedAt: typeof folder.addedAt === 'string' ? folder.addedAt : iso(Date.now()),
    }))
    : [];
  const documents = Array.isArray(raw.documents)
    ? raw.documents
      .filter(doc => doc && typeof doc.path === 'string' && path.isAbsolute(doc.path) && Array.isArray(doc.chunks))
      .map(doc => {
        const containingFolder = folders.find(folder => isInsideFolder(folder.path, doc.path));
        if (!containingFolder) return null;
        const documentId = typeof doc.id === 'string' ? doc.id : makeId('doc', doc.path);
        const chunks = doc.chunks
          .filter(chunk => chunk && typeof chunk.text === 'string' && chunk.text)
          .map((chunk, index) => ({
            id: typeof chunk.id === 'string' ? chunk.id : `${documentId}_${index}`,
            text: chunk.text,
            lower: chunk.text.toLowerCase(),
            lineStart: Number.isInteger(chunk.lineStart) ? chunk.lineStart : 1,
            lineEnd: Number.isInteger(chunk.lineEnd) ? chunk.lineEnd : 1,
          }));
        return {
          id: documentId,
          path: doc.path,
          title: typeof doc.title === 'string' ? doc.title : path.basename(doc.path),
          scope: containingFolder.scope,
          mtimeMs: Number.isFinite(doc.mtimeMs) ? doc.mtimeMs : 0,
          size: Number.isFinite(doc.size) ? doc.size : 0,
          indexedAt: typeof doc.indexedAt === 'string' ? doc.indexedAt : iso(Date.now()),
          chunks,
        };
      })
      .filter(doc => doc && doc.chunks.length > 0)
    : [];
  return {
    version: INDEX_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : iso(Date.now()),
    retentionDays: Number.isInteger(raw.retentionDays) && raw.retentionDays > 0 ? raw.retentionDays : null,
    folders,
    documents,
    lastIndexedAt: typeof raw.lastIndexedAt === 'string' ? raw.lastIndexedAt : null,
  };
}

class DocumentIndex {
  constructor({
    baseDir,
    now = Date.now,
    maxFiles = DEFAULT_MAX_FILES,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxChunksPerFile = DEFAULT_MAX_CHUNKS_PER_FILE,
    maxTotalChunks = DEFAULT_MAX_TOTAL_CHUNKS,
  } = {}) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      throw new Error('DocumentIndex requires baseDir');
    }
    this.baseDir = baseDir;
    this.filePath = path.join(baseDir, 'index.json');
    this.now = now;
    this.maxFiles = maxFiles;
    this.maxFileBytes = maxFileBytes;
    this.maxChunksPerFile = maxChunksPerFile;
    this.maxTotalChunks = maxTotalChunks;
    this.state = null;
    this.ready = null;
  }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.promises.mkdir(this.baseDir, { recursive: true });
        let raw = null;
        try {
          raw = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
        } catch {
          raw = null;
        }
        this.state = normalizeState(raw);
        await this._persist(this.state);
        return this.stats();
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async _ensure() {
    if (!this.state) await this.init();
  }

  async _persist(state) {
    const tempPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fs.promises.rename(tempPath, this.filePath);
  }

  async _save(state) {
    state.updatedAt = iso(this.now());
    await this._persist(state);
    this.state = state;
  }

  async stats() {
    await this._ensure();
    const scopes = [...new Set(this.state.folders.map(folder => folder.scope))].sort();
    return {
      version: this.state.version,
      folders: this.state.folders.map(folder => {
        const documents = this.state.documents.filter(doc => isInsideFolder(folder.path, doc.path));
        return {
          id: folder.id,
          path: folder.path,
          scope: folder.scope,
          addedAt: folder.addedAt,
          documentCount: documents.length,
          chunkCount: documents.reduce((total, doc) => total + doc.chunks.length, 0),
        };
      }),
      documentCount: this.state.documents.length,
      chunkCount: this.state.documents.reduce((total, doc) => total + doc.chunks.length, 0),
      scopes,
      retentionDays: this.state.retentionDays,
      lastIndexedAt: this.state.lastIndexedAt,
      updatedAt: this.state.updatedAt,
    };
  }

  async listFolders() {
    return (await this.stats()).folders;
  }

  async addFolder(rawPath, scope = 'general') {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      throw new Error('A folder path is required');
    }
    const normalizedScope = normalizeScope(scope);
    const resolved = await fs.promises.realpath(path.resolve(rawPath));
    const info = await fs.promises.stat(resolved);
    if (!info.isDirectory()) throw new Error('Approved path is not a directory');

    await this._ensure();
    const draft = structuredClone(this.state);
    const existing = draft.folders.find(folder => folder.path === resolved);
    if (existing) {
      existing.scope = normalizedScope;
    } else {
      draft.folders.push({
        id: makeId('folder', resolved),
        path: resolved,
        scope: normalizedScope,
        addedAt: iso(this.now()),
      });
    }
    const folder = draft.folders.find(item => item.path === resolved);
    const { documents, truncated } = await this._scanFolder(folder, draft.documents);
    draft.documents = [
      ...draft.documents.filter(doc => !isInsideFolder(resolved, doc.path)),
      ...documents,
    ];
    draft.lastIndexedAt = iso(this.now());
    await this._save(draft);
    return { ...(await this.stats()), truncated };
  }

  async removeFolder(folderIdOrPath) {
    await this._ensure();
    const target = String(folderIdOrPath || '');
    const folder = this.state.folders.find(item => item.id === target || item.path === target);
    if (!folder) throw new Error('Approved folder was not found');
    const draft = structuredClone(this.state);
    draft.folders = draft.folders.filter(item => item.id !== folder.id);
    draft.documents = draft.documents.filter(doc => !isInsideFolder(folder.path, doc.path));
    await this._save(draft);
    return this.stats();
  }

  async reindex() {
    await this._ensure();
    const draft = structuredClone(this.state);
    const documents = [];
    let truncated = false;
    for (const folder of draft.folders) {
      const scanned = await this._scanFolder(folder, draft.documents);
      documents.push(...scanned.documents);
      truncated = truncated || scanned.truncated;
    }
    draft.documents = documents;
    draft.lastIndexedAt = iso(this.now());
    await this._save(draft);
    return { ...(await this.stats()), truncated };
  }

  async setRetention(days) {
    await this._ensure();
    const normalized = days === null || days === 0 ? null : Number(days);
    if (normalized !== null && (!Number.isInteger(normalized) || normalized < 1 || normalized > 3650)) {
      throw new Error('retentionDays must be null or an integer from 1 to 3650');
    }
    const draft = structuredClone(this.state);
    draft.retentionDays = normalized;
    await this._save(draft);
    return this.stats();
  }

  async applyRetention() {
    await this._ensure();
    if (!this.state.retentionDays) return { removed: 0, ...(await this.stats()) };
    const cutoff = this.now() - this.state.retentionDays * 24 * 60 * 60 * 1000;
    const draft = structuredClone(this.state);
    const before = draft.documents.length;
    draft.documents = draft.documents.filter(doc => doc.mtimeMs >= cutoff);
    await this._save(draft);
    return { removed: before - draft.documents.length, ...(await this.stats()) };
  }

  async deleteAll() {
    await this._ensure();
    const draft = structuredClone(this.state);
    const removedDocuments = draft.documents.length;
    draft.folders = [];
    draft.documents = [];
    await this._save(draft);
    return { removedDocuments, ...(await this.stats()) };
  }

  async search(query, { scope = null, maxResults = 5 } = {}) {
    await this._ensure();
    const tokens = tokenize(query);
    if (!query || typeof query !== 'string' || !query.trim()) {
      throw new Error('query is required');
    }
    if (tokens.length === 0) {
      throw new Error('query must contain at least one searchable word');
    }
    const normalizedScope = scope ? normalizeScope(scope) : null;
    const documents = this.state.documents.filter(doc => !normalizedScope || doc.scope === normalizedScope);
    const chunks = [];
    for (const doc of documents) {
      for (const chunk of doc.chunks) {
        chunks.push({ doc, chunk });
      }
    }
    if (chunks.length === 0) {
      return { query: String(query).slice(0, 200), citations: [], searchedChunks: 0, totalChunks: 0 };
    }

    const documentFrequency = new Map();
    for (const token of tokens) {
      let count = 0;
      for (const { chunk } of chunks) {
        if (chunk.lower.includes(token)) count += 1;
      }
      documentFrequency.set(token, count);
    }

    const queryText = String(query).trim().toLowerCase();
    const scored = [];
    for (const { doc, chunk } of chunks) {
      let score = 0;
      for (const token of tokens) {
        const tf = (chunk.lower.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (!tf) continue;
        const df = documentFrequency.get(token) || 0;
        const idf = Math.log(1 + (chunks.length / Math.max(1, df)));
        score += (1 + Math.log(tf)) * idf;
        if (String(doc.title || '').toLowerCase().includes(token)) score += 0.8;
      }
      if (queryText.length >= 4 && chunk.lower.includes(queryText)) score += 1.5;
      if (score > 0) {
        scored.push({ doc, chunk, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.doc.path.localeCompare(b.doc.path));
    const limit = Math.min(20, Math.max(1, Number.isInteger(maxResults) ? maxResults : 5));
    const citations = scored.slice(0, limit).map(({ doc, chunk, score }) => ({
      documentId: doc.id,
      path: doc.path,
      title: doc.title,
      scope: doc.scope,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      snippet: makeSnippet(chunk.text, tokens),
      score: Math.round(score * 1000) / 1000,
    }));

    return {
      query: String(query).slice(0, 200),
      citations,
      searchedChunks: chunks.length,
      totalChunks: this.state.documents.reduce((total, doc) => total + doc.chunks.length, 0),
    };
  }

  async _scanFolder(folder, existingDocuments = []) {
    const documents = [];
    let fileCount = 0;
    let truncated = false;
    let totalChunks = 0;
    const existingByPath = new Map(existingDocuments.map(doc => [doc.path, doc]));

    const walk = async (directory, depth) => {
      if (depth > 12 || fileCount >= this.maxFiles || totalChunks >= this.maxTotalChunks) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (fileCount >= this.maxFiles || totalChunks >= this.maxTotalChunks) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
          await walk(path.join(directory, entry.name), depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        const filePath = path.join(directory, entry.name);
        const relativePath = path.relative(folder.path, filePath).split(path.sep).join('/');
        if (isSecretProjectFile(relativePath)) continue;
        const extension = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) continue;
        let info;
        try {
          info = await fs.promises.stat(filePath);
        } catch {
          continue;
        }
        if (!info.isFile() || info.size > this.maxFileBytes) continue;
        fileCount += 1;

        const cached = existingByPath.get(filePath);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size && cached.scope === folder.scope) {
          documents.push(cached);
          totalChunks += cached.chunks.length;
          continue;
        }

        let buffer;
        try {
          buffer = await fs.promises.readFile(filePath);
        } catch {
          continue;
        }
        if (!isProbablyText(buffer)) continue;
        const text = buffer.toString('utf8');
        const titleMatch = text.match(/^\s*#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim().slice(0, 160) : path.basename(filePath);
        const { chunks, truncated: fileTruncated } = chunkText(text, this.maxChunksPerFile);
        if (fileTruncated) truncated = true;
        const docId = makeId('doc', filePath);
        const preparedChunks = chunks.map((chunk, index) => ({
          ...chunk,
          id: `${docId}_${index}`,
          lower: chunk.text.toLowerCase(),
        }));
        documents.push({
          id: docId,
          path: filePath,
          title,
          scope: folder.scope,
          mtimeMs: info.mtimeMs,
          size: info.size,
          chunks: preparedChunks,
          indexedAt: iso(this.now()),
        });
        totalChunks += preparedChunks.length;
      }
    };

    await walk(folder.path, 0);
    return { documents, truncated };
  }
}

function makeSnippet(text, tokens) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (source.length <= 260) return source;
  const lower = source.toLowerCase();
  let position = -1;
  for (const token of tokens) {
    position = lower.indexOf(token);
    if (position >= 0) break;
  }
  const start = Math.max(0, position >= 0 ? position - 90 : 0);
  const snippet = source.slice(start, start + 260).trim();
  return `${start > 0 ? '…' : ''}${snippet}${start + 260 < source.length ? '…' : ''}`;
}

module.exports = {
  DocumentIndex,
  INDEX_VERSION,
  ALLOWED_EXTENSIONS,
  chunkText,
  tokenize,
  makeId,
};
