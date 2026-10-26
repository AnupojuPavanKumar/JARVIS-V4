# Vendored Human face runtime

- Package: `@vladmandic/human`
- Version: `3.3.6`
- Source: https://github.com/vladmandic/human
- License: MIT (see `LICENSE`)

`human.js` is the browser UMD build copied from `node_modules/@vladmandic/human/dist/human.js`.
The `models/` directory contains only the graph models used by JARVIS face
unlock: `blazeface`, `facemesh`, `iris`, `faceres`, `antispoof`, and `liveness`.

These files are served to the renderer from a loopback-only HTTP server in
`backend/face/face-model-server.js`. Inference runs locally in the Electron
renderer via TensorFlow.js/WebGL. No image or embedding is uploaded.

To update, install the new `@vladmandic/human` version, copy the same files from
`node_modules`, then run the face store/model server tests and manually validate
enrollment and unlock with a real camera.
