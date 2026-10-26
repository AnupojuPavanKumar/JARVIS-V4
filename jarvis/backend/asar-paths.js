'use strict';

const path = require('path');

/**
 * Electron exposes packed files through Node's patched fs, but child processes
 * cannot open paths inside app.asar. Files that are explicitly unpacked live
 * beside the archive under app.asar.unpacked. This helper maps an asar path to
 * the unpacked path so Python, PowerShell, Piper, and skill subprocesses can
 * execute it.
 */
function unpackedPath(value) {
  const input = String(value || '');
  const marker = `${path.sep}app.asar${path.sep}`;
  if (input.includes(marker)) {
    return input.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  // Packaged app root itself, e.g. C:\...\resources\app.asar
  const escaped = path.sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return input.replace(
    new RegExp(`${escaped}app\\.asar$`),
    `${path.sep}app.asar.unpacked`
  );
}

module.exports = { unpackedPath };
