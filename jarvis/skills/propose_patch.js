// propose_patch.js — JARVIS skill: Proposes a unified diff without writing to disk
// args: { workspaceRoot?: string, targetPath: string, newContent: string }
const path = require('path');
const fs = require('fs');
const Diff = require('diff');

const args = JSON.parse(process.argv[2] || '{}');
const targetPath = args.targetPath || '';

// Determine the true root of the workspace. Prefer an explicitly supplied
// workspace root, but only if it resolves to a valid existing directory.
let workspaceRoot;
if (args.workspaceRoot) {
  try {
    const candidate = fs.realpathSync(args.workspaceRoot);
    if (fs.statSync(candidate).isDirectory()) {
      workspaceRoot = candidate;
    }
  } catch (e) {
    // Invalid workspace root, fall back to the default below.
  }
}
if (!workspaceRoot) {
  workspaceRoot = fs.realpathSync(path.resolve(__dirname, '../../'));
}

if (typeof targetPath !== 'string' || !targetPath) {
  console.log(JSON.stringify({ ok: false, error: 'Missing required param "targetPath"' }));
  process.exit(0);
}
if (typeof args.newContent !== 'string') {
  console.log(JSON.stringify({ ok: false, error: 'Missing required param "newContent"' }));
  process.exit(0);
}

const absolutePath = path.resolve(workspaceRoot, targetPath);

// Resolve the target. If it does not exist yet, resolve its nearest existing
// ancestor so a new file can still be validated against the workspace root.
let realPath;
try {
  realPath = fs.realpathSync(absolutePath);
} catch (e) {
  let cursor = absolutePath;
  const remainder = [];
  while (cursor && !fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    remainder.unshift(path.basename(cursor));
    cursor = parent;
  }
  let realAncestor;
  try {
    realAncestor = fs.realpathSync(cursor);
  } catch (e2) {
    console.log(JSON.stringify({ ok: false, error: 'Path does not exist: ' + targetPath }));
    process.exit(0);
  }
  if (realAncestor !== workspaceRoot && !realAncestor.startsWith(workspaceRoot + path.sep)) {
    console.log(JSON.stringify({ ok: false, error: 'Access Denied: Path is outside the approved workspace root.' }));
    process.exit(0);
  }
  realPath = path.join(realAncestor, ...remainder);
}

// Security Check: Ensure the resolved path is inside the workspace
if (realPath !== workspaceRoot && !realPath.startsWith(workspaceRoot + path.sep)) {
  console.log(JSON.stringify({ ok: false, error: 'Access Denied: Path is outside the approved workspace root.' }));
  process.exit(0);
}

const exists = fs.existsSync(realPath);
if (exists) {
  const stat = fs.statSync(realPath);
  if (stat.isDirectory()) {
    console.log(JSON.stringify({ ok: false, error: 'Target path is a directory, not a file.' }));
    process.exit(0);
  }
}

// Binary check: Prevent reading huge binaries into LLM context
const ext = path.extname(realPath).toLowerCase();
const binaryExts = ['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz'];
if (binaryExts.includes(ext)) {
  console.log(JSON.stringify({ ok: false, error: 'Access Denied: Cannot inspect binary files.' }));
  process.exit(0);
}

// Null byte check as a fallback for unknown binary extensions
if (exists) {
  try {
    const fd = fs.openSync(realPath, 'r');
    const buffer = Buffer.alloc(1024);
    const bytesRead = fs.readSync(fd, buffer, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        console.log(JSON.stringify({ ok: false, error: 'Access Denied: File contains binary null bytes.' }));
        process.exit(0);
      }
    }
  } catch (e) {
    // Ignore if unreadable, the readFileSync below will catch it.
  }
}

let currentContent = '';
if (exists) {
  try {
    currentContent = fs.readFileSync(realPath, 'utf8');
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: 'Failed to read file: ' + e.message }));
    process.exit(0);
  }
}

let diff;
try {
  diff = Diff.createPatch(targetPath, currentContent, args.newContent);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Failed to create patch: ' + e.message }));
  process.exit(0);
}

let truncated = false;
let data = diff;
if (diff.length > 20000) {
  truncated = true;
  data = diff.substring(0, 20000) + '\n\n...[FILE TRUNCATED DUE TO SIZE]...';
}

console.log(JSON.stringify({ ok: true, data, truncated }));
