/**
 * JARVIS Workspace Navigator Skill
 * Standalone Node.js script — NO Electron dependency.
 * Allows JARVIS to navigate and explore the local file system.
 *
 * Usage: node workspace_navigator.js <command> <json-args>
 *   Commands: list-dir, read-file, search-workspace
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Path Traversal Guard ────────────────────────────────────────────────────
// Ensure the resolved path stays within an allowed base (home dir by default).
// The calling code in main.js may pass an allowedBase via args.allowedBase.
function isPathSafe(resolvedPath, allowedBase) {
  const base = allowedBase ? path.resolve(allowedBase) : os.homedir();
  return resolvedPath.startsWith(base);
}

// ─── Commands ────────────────────────────────────────────────────────────────

function listDir(args) {
  try {
    let dirPath = args.path || process.cwd();
    dirPath = path.resolve(dirPath);

    if (!isPathSafe(dirPath, args.allowedBase)) {
      return { success: false, error: 'Access denied: path is outside the allowed workspace.' };
    }

    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = files.map(dirent => `${dirent.isDirectory() ? '[DIR]' : '[FILE]'} ${dirent.name}`);

    return { success: true, path: dirPath, contents: result, count: result.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function readFile(args) {
  try {
    if (!args.path) return { success: false, error: 'Path argument required.' };

    const filePath = path.resolve(args.path);

    if (!isPathSafe(filePath, args.allowedBase)) {
      return { success: false, error: 'Access denied: path is outside the allowed workspace.' };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const maxLines = args.maxLines || 1000;
    const lines = content.split('\n');

    let finalContent = content;
    if (lines.length > maxLines) {
      finalContent = lines.slice(0, maxLines).join('\n') + `\n\n... [TRUNCATED ${lines.length - maxLines} lines]`;
    }

    return { success: true, path: filePath, content: finalContent };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function searchWorkspace(args) {
  try {
    if (!args.query) return { success: false, error: 'Query argument required.' };

    let baseDir = args.path ? path.resolve(args.path) : process.cwd();

    if (!isPathSafe(baseDir, args.allowedBase)) {
      return { success: false, error: 'Access denied: path is outside the allowed workspace.' };
    }

    const query = args.query.toLowerCase();
    const results = [];

    function searchDir(dir) {
      if (results.length >= 50) return;
      let files;
      try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }

      for (const file of files) {
        if (results.length >= 50) break;
        const fullPath = path.join(dir, file.name);

        if (file.isDirectory()) {
          if (['node_modules', '.git', '.gemini', 'dist', 'build'].includes(file.name)) continue;
          searchDir(fullPath);
        } else {
          const ext = path.extname(file.name).toLowerCase();
          const textExts = ['.js', '.json', '.html', '.css', '.txt', '.md', '.py', '.log', '.csv'];
          if (!textExts.includes(ext) && ext !== '') continue;

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 1024 * 1024) continue;

            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.toLowerCase().includes(query)) {
              const lines = content.split('\n');
              const matches = [];
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(query)) {
                  matches.push({ line: i + 1, text: lines[i].trim() });
                  if (matches.length > 3) break;
                }
              }
              results.push({ file: fullPath, matches });
            }
          } catch (e) { /* skip unreadable files */ }
        }
      }
    }

    searchDir(baseDir);
    return { success: true, query, basePath: baseDir, results, totalFound: results.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
const rawArgs = process.argv[2];
let args = {};
try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch (e) { args = {}; }
const command = args.command || 'list-dir';

const commands = { 'list-dir': listDir, 'read-file': readFile, 'search-workspace': searchWorkspace };
const handler = commands[command];

if (!handler) {
  process.stdout.write(JSON.stringify({ success: false, error: `Unknown command: ${command}. Valid: ${Object.keys(commands).join(', ')}` }));
  process.exit(1);
}

const result = handler(args);
process.stdout.write(JSON.stringify(result));
process.exit(result.success ? 0 : 1);
