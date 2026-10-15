# LocalAI — a local AI coding agent

A small, fast desktop app for AI-assisted coding that runs **entirely on your computer** with
[Ollama](https://ollama.com). Pick a project folder and the AI can read and edit files, run
builds and tests, debug errors, and work through multi-step tasks. Every change is shown as a
diff, you approve risky actions, and every edit can be undone.

- **Ollama-powered**: uses your installed models through Ollama's local API, with streamed responses
- **Real agent**: reads, creates, edits, moves and deletes files and folders, runs terminal commands, searches the web, plans → works → tests → fixes
- **Talk while it works**: send messages mid-task to steer the AI; it reads them at its next step
- **Nine AI personas** sharing one installed model, each with its own prompt, permissions and defaults
- **Effort levels** (Instant → Maximum) that change step and time budgets, planning and verification rules
- **Safe by default**: project sandbox, diff previews, approvals for dangerous commands and deletions, undo, secret masking
- **Lightweight**: plain JavaScript and Electron with no frameworks; the only dependency is Electron

---

## Requirements

| | |
|---|---|
| OS | Windows 10/11 (also runs on macOS and Linux) |
| Node.js | **22.12 or newer** (LTS) — https://nodejs.org |
| Ollama | https://ollama.com/download |
| Hardware | 16 GB RAM works well with 7B–8B models; an NVIDIA GPU makes them much faster |

### Recommended models (16 GB RAM + NVIDIA GPU)

| Model | Size | Notes |
|---|---|---|
| `qwen2.5-coder:7b` | 4.7 GB | Best all-round choice for coding; native tool calling |
| `qwen3:8b` | 5.2 GB | Tool calling **and** a reasoning mode (used at High/Maximum effort) |
| `llama3.1:8b` | 4.9 GB | Solid general model with tool calling |
| `qwen2.5-coder:14b` | 9 GB | Stronger; needs ~12 GB VRAM to run fast |

Models without native tool calling still work: LocalAI switches to a text-based tool format automatically
("compatibility mode"), but results are less reliable.

---

## Install and launch

1. **Install Ollama** from https://ollama.com/download and start it (it runs in the system tray).
2. **Download a model** — open a terminal (PowerShell or Command Prompt) and run:
   ```
   ollama pull qwen2.5-coder:7b
   ```
3. **Install Node.js 22 LTS** from https://nodejs.org.
4. **Get LocalAI** — clone this repository or download it as a ZIP and extract it.
5. **Start it**:
   - **Windows:** double-click `start.bat` (it installs dependencies the first time), or
   - **Any OS:** in the project folder run
     ```
     npm install
     npm start
     ```
   The first start downloads the Electron runtime (about 100 MB) once.

### Optional: build a Windows app (.exe)

```
npm run dist
```
This uses [electron-builder](https://www.electron.build/) to create an installer and a portable `.exe` in `dist/`.

---

## Using LocalAI

1. **Open a project folder** (sidebar → *Project* → folder icon). The AI works freely inside this folder.
   With no folder open, it still works from your home folder (e.g. *"make a folder called notes on my
   Desktop"*), but asks before every file access and command.
2. **Pick an AI, an effort level and a permission mode** with the selectors under the message box. The Ollama model
   (top right) is shared by all AIs. Switching AIs is instant and never downloads anything.
3. **Describe a task**, e.g. *"Run the tests and fix whatever fails"*. Attach files with the paperclip
   button or by dragging them onto the window.
4. Watch the agent work: streaming answers, tool calls (read / edit / run …), command output, the plan
   checklist, and a status bar with the step, time budget and current action.
5. **Choose how much the AI may do on its own** with the permissions button (like Claude Code):
   - **Ask** (default): asks before file changes and risky commands, per the AI's settings
   - **Accept edits**: applies file changes without asking; still asks for risky commands, deletes and anything outside the project
   - **Plan**: read-only; the AI explores and writes a plan, changes nothing
   - **Bypass permissions**: does everything without asking, after a confirmation. File changes are still backed up and undoable; effects of commands are not.

   `Shift+Tab` in the message box cycles Ask → Accept edits → Plan.
   **Approve or reject** proposed edits (shown as diffs) and commands. *Apply all edits in this task*
   skips further edit prompts for the current task only.
6. **Send messages while it works**: just type and press Enter. Your message shows as *queued* and the AI reads
   it at its next step, so you can correct or extend the task without stopping it.
7. **Undo** any file change (edits, new files, deletions, new folders, moves) from its card in the chat.
   **Stop** a task at any time with the red stop button or `Esc`.
8. Toggle the **terminal panel** (the `>_` button, or Ctrl + backtick) to see command output or run your own
   commands. If one fails, click **Ask AI to fix**.

Shortcuts: `Enter` send · `Shift+Enter` new line · `Esc` stop · `Ctrl+N` new chat · `Ctrl+,` settings · ``Ctrl+` `` (backtick) terminal.

---

## The AI lineup

All personas run on the same installed Ollama model. A persona changes the system prompt, tool
permissions and default effort, not the model.

| AI | Focus | Default effort | Edits | Commands | Web |
|---|---|---|---|---|---|
| **Nexus Code** | Main coding agent | Medium | ask | ask if risky | ask |
| **BlockSmith** | Minecraft mods, plugins, Skript, servers | Medium | ask | ask if risky | ask |
| **BugZero** | Debugging and automatic fixes | Medium | ask | ask if risky | ask |
| **Architect X** | Planning, system design, architecture | Medium | ask | always ask | ask |
| **Sentinel** | Code review, security, QA | Medium | ask | always ask | off |
| **FlashCode** | Fast answers, small edits | Low | ask | ask if risky | off |
| **DeepTrace** | Docs, APIs, GitHub research | Medium | ask | always ask | ask |
| **Overdrive** | Autonomous plan → code → test → improve | High | auto (undoable) | ask if risky | ask |
| **UltraCode** | Elite agent for the hardest tasks | **Maximum** | ask | ask if risky | ask |

Open **Settings → AI Profiles** to edit any persona's name, icon, color, description, personality,
system prompt, permissions, default effort, temperature, or to give it its own model. You can also
create, duplicate and delete custom AIs. Built-in AIs can be reset to their defaults.

---

## Effort levels

Effort is separate from the persona and the model. Choosing a persona selects its default effort,
and you can change it at any time. LocalAI **enforces** effort in the agent loop; it is not only an
instruction in the prompt:

| Level | Steps | Time | Planning | Verification | Extras |
|---|---|---|---|---|---|
| Instant | 4 | 3 min | none | none | reasoning off* |
| Low | 10 | 6 min | none | none | reasoning off* |
| **Medium** (default) | 24 | 15 min | for multi-step tasks | 1 forced check/fix round | model default |
| High | 45 | 30 min | **required before edits** | up to 2 rounds | reasoning on* |
| Maximum | 90 | 60 min | **required before edits** | up to 4 rounds | self-review pass, reasoning on* |

- **Steps** are model turns, and each turn can run several tools. **Time** excludes time spent waiting
  for your approval. Both are configurable in **Settings → Effort**.
- **Planning gate**: at High and Maximum, a file edit attempted before the agent has written a plan is
  blocked and the agent is told to plan first.
- **Verification gate**: if the agent tries to finish after changing files without running a check, or
  while the last check is failing, it is sent back to test and fix (up to the round limit).
- **Budget limit**: near the end the agent is told to wrap up. At the limit it must summarize what is done,
  what was verified and what remains. Press **Continue** to keep going.
- \*Reasoning mode is only used when the model supports it (e.g. `qwen3`, `deepseek-r1`). For other
  models the effort menu says so, and effort works through planning, budgets and verification.
- The context window is limited to what the model supports, and tool output is trimmed to fit.

---

## Safety

- **Project sandbox**: paths are resolved against the project folder, and symlinks are followed. Anything
  outside it needs your explicit approval each time. You can still give the AI access to any file on your
  computer this way, one approval at a time. With no project open, every file access and command asks.
- **Diff previews** for every edit. Edits ask first unless the persona is set to auto-apply.
- **Always confirmed**: deleting files and potentially dangerous commands. The approval card lists the
  reason, e.g. deletes files, `git push` or `reset --hard`, system or registry changes, downloads piped to
  a shell, output redirection that overwrites files, or paths outside the project.
- **Backups and undo**: every write, edit and delete is backed up and can be undone from the chat. If the
  file changed again since, you are warned first. Backups are kept for 30 days.
- **Secrets**: `.env` files, keys and credential files need approval to read. Tokens and API keys in tool
  output are masked. Secret-looking environment variables (`*_API_KEY`, `*_TOKEN`, …) are removed from
  commands the AI runs.
- **Safe mode** (Settings → Permissions & Safety) asks before every action, whatever the persona allows.
- The UI is sandboxed: Electron context isolation, no Node.js in the renderer, a strict Content Security
  Policy, and model output rendered as escaped Markdown. Chats, settings and backups are stored in your user profile
  (`%APPDATA%\LocalAI` on Windows), never in the project.

---

## Settings

- **General**: Ollama URL (with a connection test), model, context window (8,192 by default), temperature, theme, thinking display
- **AI Profiles**: the persona editor described above
- **Effort**: step and time limits per level
- **Permissions & Safety**: safe mode, hiding secret environment variables, command timeout (120 s), shell (cmd, PowerShell, pwsh, bash)

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *Can't reach Ollama* | Start the Ollama app (or run `ollama serve`). Check the URL in Settings (default `http://127.0.0.1:11434`). LocalAI reconnects automatically. |
| *No models installed* | `ollama pull qwen2.5-coder:7b`, then click **Refresh models** in the model menu. |
| *model not found* | The model was removed or renamed. Pick another model, or `ollama pull <name>`. |
| Slow responses | Run `ollama ps` to check that the model is on the GPU. Use a 7B/8B model, or lower the context window. |
| Out of memory | Pick a smaller model, or set the context window to 4,096–8,192. |
| Agent stops early | Raise the effort level or its limits (Settings → Effort), or press **Continue**. |
| Commands hang | Servers and watch modes never exit; they are stopped at the timeout. Ask for a one-off build or test. |
| Weird tool behaviour | Use a model with native tool calling (`qwen2.5-coder`, `qwen3`, `llama3.1`). |
| *"As an AI I can't access files"* / *"Shall I proceed?"* | LocalAI sends the model back to work automatically (you'll see a note). If it keeps happening, pick a model with the **tools** badge. |
| *working folder does not exist* | The AI ran a command in a folder that isn't there. It usually fixes this itself; opening the folder as a project avoids it. |
| Web search fails | `web_search` uses DuckDuckGo. Check your connection, or give the AI a URL to read with `fetch_url`. |

---

## Architecture

```
src/
  core/                 Plain Node.js, no Electron (testable on its own)
    agent.js            Agent loop: streaming, tool execution, approvals, effort gates, budgets
    ollama.js           Ollama REST client (status, models, capabilities, streaming chat)
    prompt.js           System prompt = persona + environment + rules + effort (+ text tool protocol)
    personas.js         Built-in AI lineup and persona validation
    effort.js           Effort levels and their enforced limits
    context.js          Fits history into the context window; tool-output budgets
    toolcalls.js        Text tool-call parsing (compatibility mode), <think> splitting
    safety.js           Path sandbox, risky-command analysis, secret redaction
    changes.js          Backup journal and undo
    shell.js            Cross-platform command runner (timeouts, kill tree, UTF-8)
    store.js            Settings and chat persistence
    tools/              Tool registry and tools: files (list/read/search/write/edit/delete/
                        create_folder/move_path), run_command, web_search, fetch_url, update_plan
  main/                 Electron main process (IPC, windows) and preload bridge
  renderer/             UI: plain HTML/CSS/JS (chat, selectors, settings, terminal)
test/                   node:test unit and integration tests, mock Ollama server, Electron E2E
```

### Adding a tool

Create a module that exports a tool object and register it in `src/core/tools/index.js`:

```js
module.exports.myTool = {
  name: 'my_tool',
  category: 'read',            // read | edit | command | web | plan (drives permissions)
  description: 'What it does, for the model',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  summarize: (args) => args.path,
  async run(args, ctx) {
    // ctx.resolve(path) → { abs, rel, inside }, ctx.approve({...}), ctx.recordChange({...}),
    // ctx.signal (stop button), ctx.limits, ctx.permissions, ctx.onOutput(text)
    return { ok: true, output: 'result text for the model' };
  },
};
```

## Development

```
npm test                 # unit + integration tests (agent loop against a mock Ollama)
npm run mock-ollama      # fake Ollama on :11434 with scripted models, for trying the UI without a GPU
npm i -D playwright && npm run test:e2e    # drives the real app (Linux without display: xvfb-run)
```
