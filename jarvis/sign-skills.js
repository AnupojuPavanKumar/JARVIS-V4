const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');

const keyPath = process.env.JARVIS_SIGNING_KEY;
if (!keyPath) {
  console.error("Error: JARVIS_SIGNING_KEY environment variable is not set.");
  process.exit(1);
}

if (!fs.existsSync(keyPath)) {
  console.error("Error: Private key file not found at " + keyPath);
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const privateKey = crypto.createPrivateKey(privateKeyPem);

const skillsDir = path.join(__dirname, 'skills');
const manifestPath = path.join(skillsDir, 'manifest.json');
const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
const skills = Array.isArray(manifest.skills) ? manifest.skills : [];

// Bind each skill entry to the bytes of the script it references.
const hashesByScript = new Map();
for (const skill of skills) {
  if (!skill || typeof skill.script !== 'string' || !skill.script) continue;

  const scriptPath = path.resolve(skillsDir, skill.script);
  const relative = path.relative(skillsDir, scriptPath);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    console.error(`Error: Script for skill "${skill.id}" escapes skills/: ${skill.script}`);
    process.exit(1);
  }

  let scriptStat;
  try {
    scriptStat = fs.statSync(scriptPath);
  } catch {
    console.error(`Error: Script not found for skill "${skill.id}": ${skill.script}`);
    process.exit(1);
  }
  if (!scriptStat.isFile()) {
    console.error(`Error: Script for skill "${skill.id}" is not a file: ${skill.script}`);
    process.exit(1);
  }

  const hash = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
  hashesByScript.set(skill.script, hash);
}

// Add/refresh scriptHash in place so the rest of the manifest keeps its formatting.
const eol = manifestRaw.includes('\r\n') ? '\r\n' : '\n';
const existingHashLine = /^[ \t]*"scriptHash"[ \t]*:[ \t]*"(?:[^"\\]|\\.)*"[ \t]*,?[ \t]*(?:\r?\n|$)/gm;
const scriptLine = /^([ \t]*)"script"[ \t]*:[ \t]*("(?:[^"\\]|\\.)*")(,?)[ \t]*$/gm;

let updatedRaw = manifestRaw.replace(existingHashLine, '');
updatedRaw = updatedRaw.replace(scriptLine, (line, indent, scriptToken, comma) => {
  let script;
  try {
    script = JSON.parse(scriptToken);
  } catch {
    return line;
  }

  const hash = hashesByScript.get(script);
  if (!hash) return line;

  return `${indent}"script": ${scriptToken},${eol}${indent}"scriptHash": ${JSON.stringify(hash)}${comma ? ',' : ''}`;
});

// Prove the textual edit produced exactly the intended JSON before signing.
const expected = JSON.parse(manifestRaw);
for (const skill of expected.skills || []) {
  if (skill && typeof skill.script === 'string' && skill.script) {
    skill.scriptHash = hashesByScript.get(skill.script);
  } else if (skill && Object.prototype.hasOwnProperty.call(skill, 'scriptHash')) {
    delete skill.scriptHash;
  }
}

let parsed;
try {
  parsed = JSON.parse(updatedRaw);
} catch (error) {
  console.error("Error: failed to produce valid JSON while adding script hashes: " + error.message);
  process.exit(1);
}
if (!isDeepStrictEqual(parsed, expected)) {
  console.error("Error: manifest.json script hash update did not match expectations; refusing to sign.");
  process.exit(1);
}

if (updatedRaw !== manifestRaw) {
  fs.writeFileSync(manifestPath, updatedRaw);
  console.log("Updated skills/manifest.json with script hashes.");
}

console.log(`Hashed ${hashesByScript.size} skill script(s).`);

const signature = crypto.sign(null, Buffer.from(updatedRaw), privateKey);

const sigPath = path.join(skillsDir, 'manifest.sig');
fs.writeFileSync(sigPath, signature);

console.log("Successfully signed skills/manifest.json and wrote skills/manifest.sig");
