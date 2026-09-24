# Skill Manifest Signing

The skills system uses Ed25519 signatures to ensure `manifest.json` hasn't been tampered with. It operates in a **FAIL-CLOSED** manner. The skills manifest will **NOT** load if `manifest.sig` is missing, or if the signature is invalid. 

## One-time key generation (do this on a secure machine)

Generate an Ed25519 keypair and keep the private key *outside* the repository (e.g. `%USERPROFILE%\.jarvis-keys\skills_signing_priv.pem`).

```bash
node -e "const fs=require('fs'),{generateKeyPairSync}=require('crypto'); const {publicKey, privateKey} = generateKeyPairSync('ed25519'); fs.writeFileSync('skills_signing_priv.pem', privateKey.export({type:'pkcs8',format:'pem'})); fs.writeFileSync('skills_signing_pub.pem', publicKey.export({type:'spki',format:'pem'}));"
```

## Re-sign the manifest after any edit

We provide an npm script to sign the manifest. You must provide the private key via the `JARVIS_SIGNING_KEY` environment variable.

```bash
set JARVIS_SIGNING_KEY=C:\Users\hp\.jarvis-keys\skills_signing_priv.pem
npm run sign-skills
```

This will generate `skills/manifest.sig` which must be committed alongside `manifest.json`.

## Public key pin

`SKILLS_PUBLIC_KEY_PEM` in `main.js` must contain the public key in
SPKI/PEM form. If the keys are rotated, the new public key must be
pinned in `main.js` and the app rebuilt.
