'use strict';

// Electron main process: window, IPC, agent runs, terminal and persistence.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { Store } = require('../core/store');
const { OllamaClient } = require('../core/ollama');
const { ChangeStore } = require('../core/changes');
const { createDefaultRegistry } = require('../core/tools');
const { AgentRun } = require('../core/agent');
const { builtinPersona, sanitizePersona } = require('../core/personas');
const { EFFORT_LEVELS } = require('../core/effort');
const { runCommand, resolveShellName, SHELLS } = require('../core/shell');
const { redactSecrets } = require('../core/safety');
const { isBinaryBuffer, uid } = require('../core/util');

const USER_DATA = process.env.LOCALAI_USER_DATA || app.getPath('userData');
if (process.env.LOCALAI_USER_DATA) app.setPath('userData', USER_DATA);

const store = new Store(USER_DATA);
const changeStore = new ChangeStore(path.join(USER_DATA, 'backups'));
const registry = createDefaultRegistry();
const ollama = new OllamaClient(() => store.settings?.ollamaUrl);

/** @type {BrowserWindow|null} */
let win = null;
const runs = new Map(); // chatId -> { run, chat }
const approvals = new Map(); // approvalId -> { resolve, chatId }
const saveTimers = new Map();
let terminalJob = null; // { controller }

// ------------------------------------------------------------------ helpers

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function scheduleSave(chat, delay = 400) {
  clearTimeout(saveTimers.get(chat.id));
  saveTimers.set(
    chat.id,
    setTimeout(() => {
      saveTimers.delete(chat.id);
      store.saveChat(chat).catch((err) => console.error('Failed to save chat', err));
    }, delay),
  );
}

async function getChat(id) {
  if (runs.has(id)) return runs.get(id).chat;
  return store.loadChat(id);
}

function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t || 'New chat';
}

const TEXT_EXT_LIMIT = 200 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

async function readAttachment(filePath) {
  const name = path.basename(filePath);
  const st = await fsp.stat(filePath);
  if (!st.isFile()) throw new Error(`${name} is not a file`);
  if (IMAGE_EXT.test(name)) {
    if (st.size > 8 * 1024 * 1024) throw new Error(`${name} is too large (max 8 MB for images)`);
    const data = (await fsp.readFile(filePath)).toString('base64');
    return { name, path: filePath, kind: 'image', size: st.size, data };
  }
  const buf = await fsp.readFile(filePath);
  if (isBinaryBuffer(buf)) throw new Error(`${name} is a binary file and can't be attached`);
  let content = buf.toString('utf8');
  let truncated = false;
  if (content.length > TEXT_EXT_LIMIT) {
    content = content.slice(0, TEXT_EXT_LIMIT);
    truncated = true;
  }
  content = redactSecrets(content);
  return { name, path: filePath, kind: 'text', size: st.size, content: truncated ? content + '\n[... truncated]' : content };
}

// ------------------------------------------------------------------- window

function createWindow() {
  const settings = store.settings;
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'LocalAI',
    backgroundColor: settings.theme === 'light' ? '#f6f7f9' : '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // No navigation away from the app; external links open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return { error: err.message || String(err), hint: err.hint || '' };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    home: app.getPath('home'),
    userData: USER_DATA,
    efforts: EFFORT_LEVELS.map(({ id, label, summary, maxSteps, maxMinutes, planRequired, verifyRetries, selfReview, think }) => ({ id, label, summary, maxSteps, maxMinutes, planRequired, verifyRetries, selfReview, think })),
    shells: Object.entries(SHELLS)
      .filter(([, s]) => s.platforms.includes(process.platform))
      .map(([id, s]) => ({ id, label: s.label })),
    defaultShell: resolveShellName('auto'),
  }));

  // settings & personas
  handle('settings:get', () => store.settings);
  handle('settings:save', async (patch) => {
    const before = store.settings.ollamaUrl;
    const s = await store.saveSettings(patch || {});
    if (s.ollamaUrl !== before) ollama.infoCache.clear();
    if (patch && 'theme' in patch) nativeTheme.themeSource = s.theme;
    return s;
  });
  handle('personas:save', async (persona) => {
    const list = store.settings.personas.slice();
    let p = sanitizePersona(persona);
    if (!p.id) p = { ...p, id: 'custom_' + uid() };
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = { ...p, builtin: list[i].builtin };
    else list.push({ ...p, builtin: false });
    const s = await store.saveSettings({ personas: list });
    return { settings: s, persona: s.personas.find((x) => x.id === p.id) };
  });
  handle('personas:delete', async (id) => {
    const target = store.settings.personas.find((p) => p.id === id);
    if (!target || target.builtin) throw new Error('Built-in AIs can be reset but not deleted.');
    const patch = { personas: store.settings.personas.filter((p) => p.id !== id) };
    if (store.settings.personaId === id) patch.personaId = 'nexus';
    return store.saveSettings(patch);
  });
  handle('personas:reset', async (id) => {
    const b = builtinPersona(id);
    if (!b) throw new Error('Not a built-in AI');
    const list = store.settings.personas.map((p) => (p.id === id ? b : p));
    return store.saveSettings({ personas: list });
  });

  // ollama
  handle('ollama:status', () => ollama.status());
  handle('ollama:models', async () => {
    ollama.infoCache.clear();
    return ollama.listModels();
  });
  handle('ollama:modelInfo', (name) => ollama.modelInfo(name));

  // projects
  handle('project:pick', async () => {
    const res = await dialog.showOpenDialog(win, { title: 'Open project folder', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    await store.addRecentProject(res.filePaths[0]);
    return { path: res.filePaths[0], settings: store.settings };
  });
  handle('project:set', async (p) => {
    if (p) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st || !st.isDirectory()) throw new Error(`Folder not found: ${p}`);
      await store.addRecentProject(p);
    } else {
      await store.saveSettings({ lastProject: '' });
    }
    return store.settings;
  });
  handle('project:removeRecent', async (p) => {
    const patch = { recentProjects: store.settings.recentProjects.filter((x) => x !== p) };
    if (store.settings.lastProject === p) patch.lastProject = '';
    return store.saveSettings(patch);
  });
  handle('project:reveal', async (p) => {
    if (p) await shell.openPath(p);
    return true;
  });

  // chats
  handle('chats:list', () => store.listAllChats());
  handle('chats:load', async (id) => {
    const chat = await getChat(id);
    if (!runs.has(id)) {
      // A chat saved mid-task (e.g. the app was closed) must not show live spinners.
      for (const item of chat.items || []) {
        if (item.type === 'tool' && (item.status === 'running' || item.status === 'approval')) {
          item.status = 'cancelled';
          item.approval = null;
        }
        if (item.type === 'assistant' && item.streaming) item.streaming = false;
      }
    }
    return { ...chat, running: runs.has(id) };
  });
  handle('chats:delete', async (id) => {
    if (runs.has(id)) throw new Error('Stop the running task before deleting this chat.');
    await store.deleteChat(id);
    return true;
  });
  handle('chats:rename', async (id, title) => {
    if (runs.has(id)) runs.get(id).chat.title = title;
    return store.renameChat(id, title);
  });

  // attachments
  handle('files:pick', async (defaultPath) => {
    const res = await dialog.showOpenDialog(win, { title: 'Attach files', defaultPath: defaultPath || undefined, properties: ['openFile', 'multiSelections'] });
    if (res.canceled) return [];
    return readAttachments(res.filePaths);
  });
  handle('files:read', (paths) => readAttachments(Array.isArray(paths) ? paths : [paths]));

  // agent
  handle('agent:send', async ({ chatId, newChatId, text, attachments = [], projectPath, personaId, effort, model }) => {
    const settings = store.settings;
    if (chatId && runs.has(chatId)) {
      // Message sent while the agent is working: hand it to the running task.
      if (runs.get(chatId).run.enqueue({ text, attachments })) return { chatId, queued: true, title: runs.get(chatId).chat.title };
      throw new Error('The task is just finishing. Send your message again in a moment.');
    }
    if (runs.size) throw new Error('Another chat is still working. Stop it first, or wait for it to finish.');
    const persona = settings.personas.find((p) => p.id === personaId) || settings.personas[0];
    const useModel = persona.model || model || settings.model;
    if (!useModel) throw new Error('No model selected. Pick an Ollama model first.');
    let chat;
    if (chatId) {
      chat = await store.loadChat(chatId);
    } else {
      chat = store.newChat({ projectPath: projectPath || null, title: titleFrom(text) });
      // The UI picks the id up front so it can follow events that arrive before this call returns.
      if (typeof newChatId === 'string' && /^chat_[a-z0-9]+$/.test(newChatId)) chat.id = newChatId;
    }
    chat.personaId = persona.id;
    const root = chat.projectPath && fs.existsSync(chat.projectPath) ? chat.projectPath : null;
    const run = new AgentRun({
      ollama,
      registry,
      changeStore,
      chat,
      persona,
      effortId: effort || settings.effort,
      model: useModel,
      settings,
      root,
      homeDir: app.getPath('home'),
      knownFolders: knownFolders(),
      emit: (ev) => {
        if (ev.type === 'terminal') send('terminal:event', ev.event);
        else send('agent:event', { chatId: chat.id, ...ev });
      },
      requestApproval: (req) =>
        new Promise((resolve) => {
          approvals.set(req.id, { resolve, chatId: chat.id });
        }),
      onSave: () => scheduleSave(chat),
    });
    runs.set(chat.id, { run, chat });
    await store.saveChat(chat);
    send('agent:event', { chatId: chat.id, type: 'run-start', model: useModel });
    run
      .run({ text, attachments })
      .then((reason) => {
        send('agent:event', { chatId: chat.id, type: 'run-end', reason });
      })
      .catch((err) => {
        send('agent:event', { chatId: chat.id, type: 'run-end', reason: 'error', error: err.message });
      })
      .finally(async () => {
        runs.delete(chat.id);
        clearTimeout(saveTimers.get(chat.id));
        await store.saveChat(chat).catch(() => {});
        send('chats:changed', { projectPath: chat.projectPath });
      });
    return { chatId: chat.id, title: chat.title };
  });

  handle('agent:stop', (chatId) => {
    stopRun(chatId);
    return true;
  });

  handle('agent:approve', ({ id, decision, feedback }) => {
    const entry = approvals.get(id);
    if (!entry) return false;
    approvals.delete(id);
    entry.resolve({ decision, feedback: feedback ? String(feedback).slice(0, 2000) : '' });
    return true;
  });

  handle('changes:undo', async ({ changeId, force, chatId, itemId }) => {
    const res = await changeStore.undo(changeId, { force });
    if (res.ok && chatId && itemId) {
      try {
        const chat = await getChat(chatId);
        const item = chat.items.find((i) => i.id === itemId);
        if (item?.display?.change) item.display.change.undone = true;
        if (!runs.has(chatId)) await store.saveChat(chat);
      } catch {
        /* chat may have been deleted */
      }
    }
    return res;
  });

  // terminal (commands typed by the user)
  handle('terminal:run', async ({ command, cwd }) => {
    if (terminalJob) throw new Error('A command is already running in the terminal.');
    const dir = cwd && fs.existsSync(cwd) ? cwd : app.getPath('home');
    const controller = new AbortController();
    terminalJob = { controller };
    send('terminal:event', { type: 'start', source: 'user', command, cwd: dir });
    const res = await runCommand(command, {
      cwd: dir,
      shell: store.settings.shell,
      timeoutMs: 0,
      signal: controller.signal,
      hideSecrets: false,
      onData: (text) => send('terminal:event', { type: 'data', text }),
    });
    terminalJob = null;
    send('terminal:event', { type: 'exit', code: res.code, aborted: res.aborted, source: 'user' });
    return { code: res.code, output: res.output.slice(-6000) };
  });
  handle('terminal:kill', () => {
    terminalJob?.controller.abort();
    return true;
  });

  handle('shell:openExternal', (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });
}

function knownFolders() {
  const out = {};
  for (const [name, key] of [['Desktop', 'desktop'], ['Documents', 'documents'], ['Downloads', 'downloads']]) {
    try {
      out[name] = app.getPath(key);
    } catch {
      /* not available on this system */
    }
  }
  return out;
}

async function readAttachments(paths) {
  const out = [];
  for (const p of paths.slice(0, 10)) {
    try {
      out.push(await readAttachment(p));
    } catch (err) {
      out.push({ name: path.basename(p), error: err.message });
    }
  }
  return out;
}

function stopRun(chatId) {
  const entry = runs.get(chatId);
  if (entry) entry.run.stop();
  for (const [id, a] of approvals) {
    if (!chatId || a.chatId === chatId) {
      approvals.delete(id);
      a.resolve({ decision: 'reject' });
    }
  }
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    await store.loadSettings();
    nativeTheme.themeSource = store.settings.theme;
    changeStore.purge(30).catch(() => {});
    buildMenu();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    for (const id of runs.keys()) stopRun(id);
    terminalJob?.controller.abort();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
