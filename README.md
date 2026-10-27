# JARVIS-V4

JARVIS-V4 is a local-first desktop AI assistant built with Electron and Ollama. It combines a streaming chat interface with a durable, approval-gated agent runtime that can use tools, run scheduled tasks, remember context, automate an isolated browser, and query user-approved documents.

The core chat, memory, task state, and tool execution stay on your machine. Ollama provides the language model; no cloud model is required.

> **Current status:** Phases 1-4 are implemented and verified within their documented scope. Phase 5B background presence, local face unlock, Phase 5A local voice, and a portable Windows build are implemented and validated. Automated voice tests, including a deterministic fake-microphone end-to-end run, pass; live wake-phrase, follow-up, barge-in, locked-session, microphone-release, face-unlock, tray-reopen, PIN-fallback, and camera-shutdown checks have been confirmed on the target hardware. Signed installers, auto-update/rollback, cross-device sync, export/delete acceptance, formal security review, and CI crash recovery remain future work.

## At a Glance

| Area | Status |
| --- | --- |
| Streaming chat with Ollama | Available |
| Durable `DEEP WORK` agent | Available |
| Native tool calling and signed skills | Available |
| Policy checks, approvals, and audit trail | Available |
| Headless scheduler | Available |
| Unified memory with export/delete | Available |
| Real system monitoring | Available in `DEEP WORK` only |
| Sandboxed browser automation | Available with an origin allowlist |
| Personal integrations | Fixture-only in this build |
| Local document retrieval | Available for approved text folders |
| Local face unlock | Available; Human/TFJS/WebGL, PIN fallback |
| Background presence / auto-start | Windows and macOS |
| Portable Windows build | `JARVIS.exe` via `npm run package:win` |
| Fully local voice loop | Available; opt-in local Whisper/VAD with barge-in |
| Signed installers, auto-update, cross-device sync | Not implemented yet |

## Two Modes

### FAST

FAST is the direct streaming chat path. It is intended for conversation and quick answers, and it does not execute tools.

Live telemetry requests are deliberately refused in FAST with a prompt to enable DEEP WORK. JARVIS will not invent a GPU, CPU, or memory reading, and it will not substitute one metric for another.

### DEEP WORK

DEEP WORK runs the durable agent in the main process. It supports native tool calls, approvals, cancellation, planner/verifier checks, step/time/token limits, and task recovery after a window close, renderer reload, or app restart.

The durable backend is enabled by default. Toggle `DEEP WORK` in the UI to use it, or set `JARVIS_DURABLE_AGENT=0` to disable the backend.

Default model settings:

- Model: `llama3.1:8b`
- FAST chat context: `num_ctx=3072`
- Durable agent context: `num_ctx=4096`
- Idle keep-alive: `10m`

## What Is Included

- **Durable agent runtime:** Goals become persisted tasks with step events and a timeline. Interrupted tasks can be resumed, and pending approvals survive a restart.
- **Reliable chat path:** The UI keeps its busy state until the real Ollama stream finishes and saves the completed assistant reply to history. Model auto-detection prefers `llama3.1:8b` and never selects embedding-only models for chat.
- **Native tool protocol:** Ollama native function calling is the default. A strict JSON-object fallback exists for models without native tools; legacy XML `<tool_call>` tags are never executed.
- **Policy and approvals:** Tools carry `read`, `write`, or `destructive` risk labels. Untrusted tool output taints a task so later writes require approval. Background tasks fail closed when no approval path is available.
- **Planner and verifier:** Multi-step plans are validated, failed steps can be revised, and high-risk results can be rejected. Loop detection and step, time, and token caps bound execution.
- **Signed skill catalog:** The skill manifest is Ed25519-signed and every skill script is hash-checked. Invalid signatures or modified scripts fail closed. Native tools and signed skills share the same policy boundary.
- **Unified memory:** Facts, preferences, episodes, procedures, and relationships are stored in one local schema. Retrieval is budgeted, sensitive records can be excluded, and users can inspect, export, edit, and delete memory. Procedural memory is written only after a verified, non-tainted task.
- **Headless scheduler:** One-off and recurring jobs run without the chat window. Runs and results are persisted, quiet hours and interruption limits are supported, and scheduled tasks use background-restricted permissions.
- **Real system monitoring:** The `system_metrics` tool samples real machine data. Monitoring is a DEEP WORK capability; FAST mode does not fabricate live readings.
- **Sandboxed browser:** A hidden Electron browser uses an isolated session, denied permissions, no downloads or popups, and an origin allowlist. Actions are auditable, screenshots are retained under `userData`, and an emergency stop is available.
- **Fixture integrations:** Calendar, email, contacts, tasks, notes, and messaging use local fixture data with explicit scopes, per-minute rate limits, an encrypted secret vault, and revoke/delete controls. No real OAuth or external network calls are made in this build.
- **Document context:** Users approve folders through a native picker. The index supports text files and code, returns citations with file paths and line ranges, enforces scopes, and supports retention pruning and index deletion. Source files are never modified.
- **Background presence:** JARVIS can stay resident in the tray, start at login as an opt-in, start hidden in the tray by default on login, focus the existing instance on a second launch, and suspend/resume the scheduler around system sleep. Auto-start uses the OS login-item API and is currently implemented for Windows and macOS.
- **Local face unlock:** A PIN can be paired with a locally enrolled face. Detection, iris landmarks, liveness, anti-spoofing, and 1024-value embeddings run in the renderer with vendored Human/TFJS/WebGL models. Only encrypted embeddings are stored; raw frames are never sent over IPC or written to disk. Face recognition can clear the UI session lock, but it cannot approve tools, integrations, or any other privileged action.
- **Portable Windows build:** `npm run package:win` produces `dist/win-unpacked/JARVIS.exe` through electron-builder. The executable metadata and Task Manager name are `JARVIS`. The output is local and gitignored.
- **Local voice loop:** The wake word is explicitly opt-in and runs entirely on the machine: Web Audio energy VAD, raw PCM capture encoded as 16 kHz WAV, and the bundled native Whisper sidecar. There is no cloud speech fallback, no Chromium Web Speech dependency, and no ffmpeg requirement. Saying "Hey JARVIS" opens command capture, inline commands are supported, and user speech stops Piper output for barge-in. The persisted opt-in also auto-starts while the startup lock screen is showing, so the wake phrase can focus the lock screen; commands are still withheld until PIN or face unlock succeeds. Microphone permission is gated separately from the camera and expires automatically.

## Architecture

| Layer | Responsibility |
| --- | --- |
| `main.js` | App lifecycle, tray, session lock, camera and microphone permission gates, single-instance lock, IPC sender validation, memory/scheduler/agent/browser/integration/document/ambient services |
| `preload.js` | Narrow `contextBridge` API exposed to the renderer |
| `core/` | Durable runtime, policy engine, planner/verifier, token-budgeted prompts, memory, scheduler, browser tools, integrations, documents, model gateway, evals |
| `backend/` | IPC controllers, Electron browser driver, ambient/login-item service, encrypted secret vault, auth helpers, encrypted face store, loopback face-model server, microphone/media permission gates |
| `renderer/` | UI, chat streaming, task timeline, approvals, settings, face lock/enrollment, local voice VAD/wake module, and thin client modules; no agent/tool loop |
| `skills/` | Signed JS/Python skills and the signed manifest |
| `bin/whisper/` | Pinned native whisper.cpp runtime and local English model |
| `tests/` | Node unit/integration tests and real Electron smoke suites |

The agent loop lives in the main process:

```text
goal
  -> build a token-budgeted prompt
  -> call Ollama
  -> receive a native tool call (or strict JSON fallback)
  -> validate arguments and authorize with policy
  -> request approval when required
  -> execute the tool in a child process or native service
  -> persist the real result
  -> revise, verify, or continue
  -> complete, fail, or cancel
```

The renderer only starts tasks, sends approvals/cancellations, and renders task events. It never calls skills directly.

## Security Model

- **Local-first inference:** Core chat and agent inference use Ollama at `127.0.0.1:11434`. Network-backed skills (weather, news, URL reading) and explicitly allowlisted browser origins are the exceptions.
- **IPC boundary:** IPC handlers validate both the sender webContents and renderer origin. Context isolation is enabled and Node integration is disabled in the UI.
- **Signed skills:** Manifest signatures and per-script SHA-256 hashes are checked before loading. Tampering fails closed.
- **No shell injection:** Skills are spawned with array arguments and `shell: false`; they still run with your user privileges, so only trust skills you signed or reviewed.
- **Approval-gated actions:** Writes, destructive operations, messages, and other externally visible actions require approval when policy demands it. Untrusted output taints the task.
- **Secret handling:** Integration credentials and face embeddings use Electron `safeStorage`; both fail closed when secure OS encryption is unavailable. Raw credentials are not placed in prompts, logs, or tool output.
- **Face camera boundary:** Camera permission is granted only for an armed unlock or enrollment attempt, video-only, with a short expiry. Raw frames stay in the renderer and are discarded after inference. Face verification changes only the local session lock and is not connected to approvals or privileged IPC.
- **Microphone boundary:** Audio capture is denied by default and granted only after an explicit wake-word or push-to-talk activation, audio-only, through a bounded main-process gate. Camera and microphone requests are separate; combined audio+video requests are denied. Voice segments are sent only to the local Whisper sidecar child process and are deleted after transcription. If the session is locked, wake-word audio can focus the lock screen but commands are not executed until PIN or face unlock succeeds.
- **Browser boundary:** Only loopback origins are allowed by default. External origins must be explicitly added with `JARVIS_BROWSER_ALLOWED_ORIGINS`. Downloads, popups, webviews, and permission requests are denied.
- **Auditability:** Security decisions, browser actions, integrations, scheduler runs, and ambient changes are recorded locally with bounded retention.

This is a desktop agent with real system access. Review approval requests and only enable integrations, folders, and external origins you intend to use.

## Getting Started

### Prerequisites

- **Node.js 22.12 or newer** (required by Electron 44)
- **npm**
- **Ollama** with a chat-capable model installed
- Local voice is self-contained: the repository includes the native whisper.cpp runtime and English model under `jarvis/bin/whisper`. No Python, PyTorch, or system `ffmpeg` installation is required.

### Install and Run

```bash
cd jarvis
npm install
ollama pull llama3.1:8b
npm start
```

Make sure Ollama is running before starting JARVIS. The default model is `llama3.1:8b`; the app can also detect other installed chat models and will avoid selecting embedding-only models for chat.

### Run as JARVIS on Windows

`npm start` runs Electron's development host, so Windows Task Manager will show **Electron** for that process. To get a `JARVIS` process name, build and run the packaged executable:

```powershell
npm run package:win
.\dist\win-unpacked\JARVIS.exe
```

The build uses electron-builder and writes to `jarvis/dist/`, which is gitignored. `JARVIS.exe` has `ProductName`/`FileDescription` set to `JARVIS` and Task Manager shows `JARVIS`. External helpers that run as child processes (Piper, Python-based skills, the native Whisper sidecar, and the Ollama launcher) are kept outside the ASAR archive and resolved through `backend/asar-paths.js`. `bin/whisper/**` is pinned by byte size and SHA-256 at startup, and `whisper-cli.exe` is excluded from electron-builder's code-signing list so its pinned bytes stay valid. The upstream sidecar binary itself is unsigned; sign the installer and app for production distribution. The portable folder is self-contained; it is not a signed installer. `npm run package:win:installer` is wired for an NSIS installer, but signed installers and auto-update are not part of this milestone.

Development and packaged builds share the existing `jarvis-ai-os` Electron `userData` folder, so an existing PIN, face profile, memory, scheduler, and settings carry over. Use an explicit `--user-data-dir` launch when you want an isolated test profile.

For a Windows/NVIDIA GPU setup, the repository includes optional helpers:

```powershell
npm run ollama:gpu
npm run start:gpu
```

These scripts set CUDA and Ollama GPU options for the local machine. Adjust them if your GPU setup differs.

### Enable Auto-Start

Open **Settings → Background presence** and enable **Start JARVIS at login**. Auto-start is opt-in. **Start hidden in the tray at login** is enabled by default; uncheck it if you want the window visible at login.

- A login launch starts hidden by default. Opening JARVIS manually still shows the window.
- Closing the main window hides JARVIS in the tray. Use the tray menu to quit fully.
- In development, the login item points at `electron.exe` plus this repository folder. In the packaged build it points at `JARVIS.exe`. Toggle auto-start off and on after switching builds or moving the folder so the login item is rewritten.
- Windows sign-out/sign-in auto-start was verified on 2026-10-21: JARVIS launched automatically from the enabled login item. The tray-first default is covered by tests and applies on the next login.
- Windows controls whether the tray icon appears in the `^` overflow or is pinned. Use Windows taskbar settings to pin it if you want it always visible.

### Set Up Face Unlock

1. Set a usable 4-digit PIN when prompted, or in **Settings → Security**. Face enrollment is intentionally blocked until a real PIN exists.
2. Open **Settings → Local Face Unlock** and choose **Enroll face**.
3. Keep one face in the frame, face the camera, look at the screen, and blink once. Three consistent local samples are required.

On startup and whenever JARVIS is reopened from the tray, the session locks. The lock screen can use a configured face profile or the PIN; the camera is active only for that attempt and stops after success, failure, cancellation, or timeout. Closing the window or hiding JARVIS stops the camera immediately.

The face profile is encrypted with Electron `safeStorage` (Windows DPAPI on this build). Removing it requires the current PIN. Face recognition is convenience security for the JARVIS session, not Windows account security, and it does not authorize approvals or external actions.

### Optional Local Voice

Local voice is opt-in. Enable **Wake Word** from the hamburger menu, or use the microphone button for a one-shot voice command. The first activation asks the main process to arm the microphone. Disabling wake word or quitting stops recording and closes the gate. The persisted opt-in auto-starts with JARVIS, including at the startup lock screen. If the session locks while wake word is active, the mic remains in wake-phrase-only mode so "Hey JARVIS" can focus the lock screen; commands are withheld until unlock. The main-process gate accepts only this explicit wake-word mode while locked; ordinary one-shot requests are rejected.

Say **“Hey JARVIS”** followed by a command, or say the wake phrase and then the command. While JARVIS is speaking, speaking over it stops Piper output (barge-in). If the session is locked, only the wake phrase is recognized: JARVIS focuses the lock screen, but does not execute a command until PIN or face unlock succeeds.

JARVIS ships the native whisper.cpp 1.9.5 runtime and a quantized English base model under `jarvis/bin/whisper`. No Python, PyTorch, or system `ffmpeg` install is required. At startup, main verifies the byte size and SHA-256 of the executable, its DLLs, and the model. If any file is missing or modified, local transcription is disabled with a diagnostic while the rest of JARVIS keeps running. Each utterance runs in a JARVIS-owned `whisper-cli.exe` child using CPU inference, English decoding, and four threads. The renderer converts captured PCM to a 16 kHz mono WAV before sending it over IPC, and the temporary WAV is deleted after transcription. There is no resident loopback server and no cloud speech fallback.

Piper TTS remains optional and expects binaries and models under `jarvis/bin/piper`. Missing TTS does not disable voice input.

> The local loop uses energy VAD plus Whisper, not a dedicated wake-word engine. It is fully local, but it is not always-listening by default and nearby speech may be transcribed locally after wake word is enabled. A deterministic fake-microphone end-to-end test passes (capture -> 16 kHz WAV -> local Whisper -> command queue), including no-gesture auto-start, true-relaunch lock-screen wake-only focus, barge-in, and microphone-gate teardown. Live wake-phrase, follow-up command, barge-in, locked-session, and microphone-release checks have also been confirmed on the target hardware.

## Configuration

Set environment variables before launching JARVIS. PowerShell example:

```powershell
$env:JARVIS_MODEL_KEEP_ALIVE = "10m"
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_DURABLE_AGENT` | enabled | Set to `0` to disable the durable agent backend |
| `JARVIS_BROWSER_ENABLED` | enabled | Set to `0` to disable browser tools |
| `JARVIS_BROWSER_ALLOWED_ORIGINS` | loopback only | Comma-separated extra origins allowed for browser navigation |
| `JARVIS_INTEGRATIONS_ENABLED` | enabled | Set to `0` to disable fixture integrations |
| `JARVIS_DOCUMENTS_ENABLED` | enabled | Set to `0` to disable the document index |
| `JARVIS_MODEL_KEEP_ALIVE` | `10m` | Ollama idle residency window; use `0` to unload immediately |
| `JARVIS_PLANNER_MODEL` | default model | Optional model override for planning |
| `JARVIS_VERIFIER_MODEL` | default model | Optional model override for verification |
| `JARVIS_SMALL_MODEL` | unset | Optional model for lightweight classification/routing |
| `JARVIS_STRONG_MODEL` | unset | Optional model for harder tasks |
| `JARVIS_CLOUD_MODEL` | unset | Optional cloud model for explicitly routed work |
| `JARVIS_SIGNING_KEY` | unset | Private Ed25519 key path used only by `npm run sign-skills` |
| `JARVIS_TEST_MODE` | unset | Test-only flag; skips the single-instance lock |

Skill signing details are in [`jarvis/skills/MANIFEST_SIGNING.md`](jarvis/skills/MANIFEST_SIGNING.md).

## Testing and Evals

Run these from the `jarvis/` directory:

```bash
npm test
npm run test:electron
npm run eval:phase3
npm run eval:phase3:real
npm audit --omit=dev
```

- `npm test` runs the Node unit and integration suite.
- `npm run test:electron` boots the real renderer, agent, scheduler, memory, main process, and browser fixture smoke suites.
- `npm run eval:phase3` runs the deterministic 31-scenario evaluation suite.
- `npm run eval:phase3:real` runs the real-model evaluation against Ollama and reports completion, task success, tool-call validity, latency, and a model recommendation. It requires a running Ollama instance with `llama3.1:8b` installed.
- `npm audit --omit=dev` checks the shipped dependency tree. The full `npm audit` also includes electron-builder's development-only packaging dependencies.

Current local verification (2026-10-24):

- 292 Node tests: 291 pass, 1 expected opt-in real-model skip, 0 failures.
- All six Electron smoke suites pass, including the tray-first default, start-hidden override, face settings, loopback model server, local voice bridge, and voice-button binding checks.
- Auth/PIN, encrypted face storage, face controller boundaries, the loopback model server, and PIN rate-limit reset have dedicated unit tests, including upgrading the legacy skipped-PIN profile to a real PIN. A packaged PIN-unlock regression is covered by `tests/auth-ui.test.js`: the boot overlay starts hidden, cannot remain over the app, plays once on the first unlock, and is not replayed when the same session is unlocked again. The lock screen keeps PIN entry in one centered column; during a face attempt the local camera preview appears inside the emblem at the top, and the face action collapses to a compact secondary pill below the keypad.
- Phase 5A tests cover wake-phrase normalization, inline command extraction, energy-VAD boundaries, microphone-gate expiry, separate audio/video media decisions, removal of Chromium Web Speech from the wake path, PCM-to-WAV encoding, ArrayBuffer normalization at the IPC boundary, native whisper.cpp sidecar decoding, and the barge-in stop/events wiring.
- Deterministic fake-microphone end-to-end runs passed against the real packaged renderer and main process: local VAD captured generated speech, the renderer produced 16 kHz mono WAV, the bundled Whisper sidecar returned "what time is it", and the command reached the queue with no cloud call. Additional runs verified no-gesture auto-start, barge-in while TTS was active, a true packaged relaunch with a real PIN starting locked and auto-starting wake-word-only capture, a minimized locked window focusing with zero commands executed, and a post-stop `getUserMedia` denial with `VOICE_MIC_ARM`/`VOICE_MIC_DISARM` audit entries. These are test harnesses, not always-on product behavior.
- A local Human/TFJS probe loaded the vendored iris model, produced a 1024-value embedding with iris annotations, liveness/anti-spoof scores, and frontal gesture output without sending frames off the machine.
- Deterministic Phase 3 eval passes: 31 scenarios, 26 expected completions, 0 unsafe actions, and 0 silent budget violations.
- Real-model eval was previously verified with `llama3.1:8b`: 5/5 completed, 4/5 task success, 5/5 valid tool calls.
- Windows sign-out/sign-in auto-start was verified on 2026-10-21; the tray-first default and login-item readback remain covered by tests. A final live sign-out/sign-in after the face and voice changes is still recommended.
- `JARVIS.exe` was built and launched with `ProductName`/`FileDescription` `JARVIS`; Task Manager showed the `JARVIS` process.
- The rebuilt portable app was validated with an isolated real-PIN profile: the first PIN unlock played the boot sequence, showed the dashboard and greeting, and a close-to-tray followed by a second-launch re-open did not replay the boot sequence or greeting.
- The startup intro is now a restrained, silent sequence: no synthesized startup audio, no ring/hex explosion or grid flicker, a calmer system log, a thin progress line, and reduced-motion support.
- The production dependency audit reports 0 vulnerabilities. The full audit currently reports eight moderate, dev-only advisories from electron-builder's packaging dependencies; they are not shipped in the app runtime.
- The automated fake-microphone path verifies local VAD, WAV encoding, Whisper transcription, command dispatch, no-gesture auto-start, barge-in, true-relaunch lock-screen wake-only focus, and microphone-gate release. Live hardware validation on the target machine also confirmed the real wake phrase, follow-up commands, barge-in, locked-session command refusal, microphone release on disable/quit, face unlock, tray-reopen locking, PIN fallback, and physical camera shutdown after an attempt.

> The real eval's `two-step-tools` scenario is a known non-gating weakness: `llama3.1:8b` completes the task but calls only one of the two requested tools. The gate threshold is 60% task success; this remains a measured model limitation rather than a runtime failure.

## Known Limitations

- **Voice:** The local VAD/Whisper/barge-in loop is implemented and covered by automated tests, including deterministic fake-microphone end-to-end runs for command capture, no-gesture auto-start, true-relaunch lock-screen wake-only focus, barge-in, and gate teardown. Live wake-phrase, follow-up, barge-in, locked-session refusal, and microphone-release checks have been confirmed on the target hardware. It still uses energy VAD rather than a dedicated wake-word model, so accuracy and CPU latency vary by microphone and machine. There is no cloud speech fallback and no ffmpeg dependency.
- **Integrations:** Calendar, email, contacts, tasks, notes, and messaging are fixture-only. Real OAuth connectors, smart-home control, and external write sandboxes are future work.
- **Documents:** The index is text-only. PDF/OCR and office-document parsing are not implemented; retrieval is lexical rather than embedding-based.
- **Face unlock:** The engine is Human/TFJS/WebGL, not a strict native ONNX pipeline. Real-camera enrollment, unlock, tray-reopen locking, PIN fallback, and physical camera shutdown have been confirmed on the target hardware. Face unlock is convenience security for the JARVIS session, not Windows account security.
- **Packaging:** A portable unsigned `JARVIS.exe` build is available. Signed installers, auto-update with rollback, crash reporting, and backup/restore are not implemented. In development, `npm start` still appears as Electron in Task Manager.
- **Cross-device:** Task/memory sync, handoff, and end-to-end encrypted personal data are not implemented.
- **Auto-start:** Windows login-item registration, readback, and sign-out/sign-in auto-start were verified end-to-end on 2026-10-21. The new tray-first default and face changes are covered by tests; a final live sign-out/sign-in after those changes is still recommended. Linux auto-start and an OS service/launch-agent mode are not implemented.
- **Real-model reliability:** The `two-step-tools` eval still shows one-tool sequencing. Enabling the planner or using a stronger model may improve this, but the current no-planner FAST path is retained as an honest measurement.

## Project Layout

```text
JARVIS-V4-main/
├── README.md
├── rules.md
└── jarvis/
    ├── main.js              # Electron main process and services
    ├── preload.js           # contextBridge API
    ├── core/                # runtime, policy, planning, memory, scheduler, tools, evals
    ├── backend/             # controllers, browser driver, ambient service, vault
    ├── renderer/            # UI, modules, vendored browser assets
    ├── skills/              # signed skills and manifest
    ├── tests/               # Node tests and Electron smoke suites
    ├── scripts/             # eval runner
    ├── bin/whisper/         # native whisper.cpp runtime and English model
    ├── bin/piper/           # optional Piper TTS binaries/models
    └── start-ollama-gpu.ps1 # optional Windows/NVIDIA helper
```

Task state, memory, scheduler data, integration fixtures, document indexes, browser artifacts, and ambient configuration live under Electron `userData`. They are not written into the source tree.

## License

This project is intended for educational and personal use. See `jarvis/package.json` for the declared license.
