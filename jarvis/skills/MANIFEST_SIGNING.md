# Skill Manifest Signing

The skills system refuses to load `manifest.json` if `manifest.sig` is present
and the signature is invalid. The expected workflow is:

## One-time key generation (do this on a secure machine)

```bash
node -e "const {generateKeyPairSync} = require('crypto'); const {publicKey, privateKey} = generateKeyPairSync('ed25519'); require('fs').writeFileSync('skills_signing_priv.pem', privateKey.export({type:'pkcs8',format:'pem'})); require('fs').writeFileSync('skills_signing_pub.pem', publicKey.export({type:'spki',format:'pem'}));"
```

## Re-sign the manifest after any edit

```bash
node -e "const fs=require('fs'),{createPrivateKey,sign}=require('crypto'); const raw=fs.readFileSync('skills/manifest.json','utf8'); const key=createPrivateKey(fs.readFileSync('skills_signing_priv.pem')); const sig=sign(null,Buffer.from(raw),key); fs.writeFileSync('skills/manifest.sig',sig);"
```

## Public key pin

`SKILLS_PUBLIC_KEY_PEM` in `main.js` must contain the public key in
SPKI/PEM form. If the keys are rotated, the new public key must be
pinned in `main.js` and the app rebuilt.

To disable signing during development, simply delete `skills/manifest.sig`.
The manifest will load without verification until a sig file is created.
