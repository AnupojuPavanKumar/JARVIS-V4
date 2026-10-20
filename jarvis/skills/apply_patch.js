// apply_patch.js — JARVIS skill: Applies a unified diff with a .bak backup
// args: { workspaceRoot?: string, targetPath: string, patch: string }
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
if (typeof args.patch !== 'string' || !args.patch) {
  console.log(JSON.stringify({ ok: false, error: 'Missing required param "patch"' }));
  process.exit(0);
}

const absolutePath = path.resolve(workspaceRoot, targetPath);

let realPath;
try {
  realPath = fs.realpathSync(absolutePath);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Path does not exist: ' + targetPath }));
  process.exit(0);
}

// Security Check: Ensure the resolved path is inside the workspace
if (realPath !== workspaceRoot && !realPath.startsWith(workspaceRoot + path.sep)) {
  console.log(JSON.stringify({ ok: false, error: 'Access Denied: Path is outside the approved workspace root.' }));
  process.exit(0);
}

const stat = fs.statSync(realPath);
if (stat.isDirectory()) {
  console.log(JSON.stringify({ ok: false, error: 'Target path is a directory, not a file.' }));
  process.exit(0);
}

// Binary check: Prevent patching binaries
const ext = path.extname(realPath).toLowerCase();
const binaryExts = ['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.zip', '.tar', '.gz'];
if (binaryExts.includes(ext)) {
  console.log(JSON.stringify({ ok: false, error: 'Access Denied: Cannot inspect binary files.' }));
  process.exit(0);
}

// Null byte check as a fallback for unknown binary extensions
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

let currentContent;
try {
  currentContent = fs.readFileSync(realPath, 'utf8');
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Failed to read file: ' + e.message }));
  process.exit(0);
}

let patched;
try {
  patched = Diff.applyPatch(currentContent, args.patch);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Patch did not apply cleanly — file may have changed since propose_patch was called.' }));
  process.exit(0);
}

if (patched === false) {
  console.log(JSON.stringify({ ok: false, error: 'Patch did not apply cleanly — file may have changed since propose_patch was called.' }));
  process.exit(0);
}

const backupPath = realPath + '.bak';
try {
  fs.rmSync(backupPath, { force: true });
  fs.copyFileSync(realPath, backupPath);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Failed to create backup: ' + e.message }));
  process.exit(0);
}

try {
  fs.writeFileSync(realPath, patched, 'utf8');
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Failed to write file: ' + e.message }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, backupPath: targetPath + '.bak' }));
