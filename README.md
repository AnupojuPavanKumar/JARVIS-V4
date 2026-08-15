# JARVIS-V4-LITE

JARVIS-V4-LITE is an advanced, Electron-based desktop AI assistant designed for extensibility, local privacy, and agentic workflows. It leverages local language models (via Ollama) and a robust IPC-driven architecture to execute a wide variety of tools and skills directly on your desktop.

## 🚀 Features

- **Local-First AI Integration:** Fully integrated with Ollama for running local LLMs, ensuring privacy and offline capabilities.
- **Agentic Skill System:** Features an extensible `skills/` directory where Node.js and Python scripts can be registered as tools. The LLM can dynamically call these skills to perform real-world actions.
- **Persistent Memory System:** Uses a local TF-IDF vector space model for conversational memory, allowing JARVIS to recall past interactions and context.
- **Voice Capabilities:** Includes local transcription (Whisper) and Text-to-Speech (Piper TTS) for a complete voice-interactive experience.
- **Safe Execution Environment:** Skills are executed via child processes with explicit paths and arguments (no shell injection), with built-in rate-limiting and security audits.

## 🛠️ System Architecture

JARVIS is built on a standard Electron architecture, divided into three main layers:

1. **Main Process (`main.js`)**: Manages window lifecycle, system trays, safe code execution, and serves as the bridge (via `ipcMain`) to the underlying operating system and file system.
2. **Preload Script (`preload.js`)**: Safely exposes specific `ipcRenderer` channels to the renderer process via `contextBridge`, establishing a secure security boundary.
3. **Renderer Process (`renderer.js` / UI)**: Handles the user interface, state management, memory (TF-IDF), and the **ToolExecutor** which parses LLM outputs and triggers tool calls.

### The Agentic Loop (`ToolExecutor.js`)
When JARVIS generates text, the `ToolExecutor` constantly monitors the stream for `<tool_call>` blocks. If detected, it pauses generation, invokes the relevant skill via IPC, and feeds the result back into the context so the LLM can complete its thought process.

## 🧰 Available Skills

JARVIS comes pre-packaged with a variety of skills registered in `skills/manifest.json`:

- **System:** System Status, Process Manager, Kill Process, Workspace Navigator
- **Web & Info:** Weather, News, Wikipedia Summary, Crypto Price, IP Lookup, Define Word
- **Utilities:** Get Date & Time, Calculator, Unit Converter, Translate Text
- **Desktop Automation:** Open Application, Open URL, Read URL

*To add a new skill, create a Node.js or Python script in the `skills/` directory and register it in `manifest.json`.*

## 🔒 Security

- **No Shell Injection:** Processes are spawned using array-based arguments with `shell: false`.
- **Path Traversal Guards:** File system skills (like Workspace Navigator) enforce strict directory boundaries.
- **Critical Process Protection:** The Process Manager maintains a hardcoded allowlist/blocklist to prevent JARVIS from terminating vital OS processes.

## 🚀 Getting Started

1. Ensure you have Node.js and Ollama installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the application:
   ```bash
   npm start
   ```

## 📝 License

This project is intended for educational and personal use.
