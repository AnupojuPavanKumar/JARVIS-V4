const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const manifestPath = path.join(__dirname, 'skills', 'manifest.json');
const manifestRaw = fs.readFileSync(manifestPath, 'utf8');

const signature = crypto.sign(null, Buffer.from(manifestRaw), privateKey);

const sigPath = path.join(__dirname, 'skills', 'manifest.sig');
fs.writeFileSync(sigPath, signature);

console.log("Successfully signed skills/manifest.json and wrote skills/manifest.sig");
