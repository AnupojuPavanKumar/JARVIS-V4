// code_inspector.js — JARVIS skill: Securely reads and inspects text files
// args: { targetPath: string }
const path = require('path');
const fs = require('fs');

const args = JSON.parse(process.argv[2] || '{}');
const targetPath = args.targetPath || '.';

// Determine the true root of the workspace.
const workspaceRoot = fs.realpathSync(path.resolve(__dirname, '../../'));
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
  const files = fs.readdirSync(realPath);
  console.log(JSON.stringify({ ok: true, data: `Directory contents of [${targetPath}]:\n` + files.join('\n') }));
  process.exit(0);
}

// Binary check: Prevent reading huge binaries into LLM context
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
  // Ignore if unreadable, the readFileSync will catch it.
}

try {
  const content = fs.readFileSync(realPath, 'utf8');
  // Limit output to prevent blowing up the LLM context window
  if (content.length > 20000) {
    console.log(JSON.stringify({ ok: true, data: content.substring(0, 20000) + '\n\n...[FILE TRUNCATED DUE TO SIZE]...' }));
  } else {
    console.log(JSON.stringify({ ok: true, data: content }));
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'Failed to read file: ' + e.message }));
}
