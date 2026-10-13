'use strict';

// JSON persistence for settings and chats (stored in the app's user-data folder,
// never inside the project).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { DEFAULT_URL } = require('./ollama');
const { mergePersonas } = require('./personas');
const { defaultEffortLimits, EFFORT_IDS, DEFAULT_EFFORT } = require('./effort');
const { uid } = require('./util');

function defaultSettings() {
  return {
    ollamaUrl: process.env.OLLAMA_HOST ? normalizeHost(process.env.OLLAMA_HOST) : DEFAULT_URL,
    model: '',
    contextLength: 8192,
    temperature: null,
    personaId: 'nexus',
    effort: DEFAULT_EFFORT,
    effortLimits: defaultEffortLimits(),
    commandTimeoutSec: 120,
    shell: 'auto',
    hideSecretEnv: true,
    safeMode: false,
    theme: 'dark',
    showThinking: true,
    terminalOpen: false,
    recentProjects: [],
    lastProject: '',
    personas: [],
  };
}

function normalizeHost(h) {
  let v = String(h).trim();
  if (v.startsWith('0.0.0.0')) v = v.replace('0.0.0.0', '127.0.0.1');
  if (!/^https?:\/\//.test(v)) v = 'http://' + v;
  if (!/:\d+$/.test(v.replace(/^https?:\/\//, ''))) v += ':11434';
  return v;
}

// Writes to the same file are serialized; each write goes to a temp file first.
const writeQueues = new Map();
function writeJsonAtomic(file, data) {
  const text = JSON.stringify(data, null, 2);
  const prev = writeQueues.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${uid()}.tmp`;
    await fsp.writeFile(tmp, text);
    await fsp.rename(tmp, file);
  });
  writeQueues.set(file, next);
  next.finally(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  }).catch(() => {});
  return next;
}

function sanitizeSettings(s) {
  const d = defaultSettings();
  const out = { ...d, ...s };
  out.contextLength = Math.min(Math.max(parseInt(out.contextLength, 10) || d.contextLength, 2048), 262144);
  out.commandTimeoutSec = Math.min(Math.max(parseInt(out.commandTimeoutSec, 10) || d.commandTimeoutSec, 5), 3600);
  out.temperature = out.temperature === null || out.temperature === '' || !Number.isFinite(Number(out.temperature)) ? null : Math.min(Math.max(Number(out.temperature), 0), 2);
  if (!EFFORT_IDS.includes(out.effort)) out.effort = DEFAULT_EFFORT;
  const limits = defaultEffortLimits();
  for (const id of EFFORT_IDS) {
    const u = (out.effortLimits || {})[id] || {};
    limits[id] = {
      maxSteps: Math.min(Math.max(parseInt(u.maxSteps, 10) || limits[id].maxSteps, 1), 500),
      maxMinutes: Math.min(Math.max(parseInt(u.maxMinutes, 10) || limits[id].maxMinutes, 1), 480),
    };
  }
  out.effortLimits = limits;
  out.theme = out.theme === 'light' ? 'light' : 'dark';
  out.recentProjects = (Array.isArray(out.recentProjects) ? out.recentProjects : []).filter((p) => typeof p === 'string').slice(0, 12);
  out.personas = mergePersonas(out.personas);
  if (!out.personas.some((p) => p.id === out.personaId)) out.personaId = 'nexus';
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.settingsFile = path.join(dir, 'settings.json');
    this.chatsDir = path.join(dir, 'chats');
    this.indexFile = path.join(this.chatsDir, 'index.json');
    this.settings = null;
    this.index = null;
  }

  async loadSettings() {
    let raw = {};
    try {
      raw = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8'));
    } catch {
      raw = {};
    }
    this.settings = sanitizeSettings(raw);
    return this.settings;
  }

  async saveSettings(patch) {
    if (!this.settings) await this.loadSettings();
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    await writeJsonAtomic(this.settingsFile, this.settings);
    return this.settings;
  }

  async addRecentProject(p) {
    const list = [p, ...(this.settings.recentProjects || []).filter((x) => x !== p)].slice(0, 12);
    return this.saveSettings({ recentProjects: list, lastProject: p });
  }

  // ------------------------------------------------------------- chats

  async loadIndex() {
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'));
      if (!Array.isArray(this.index)) this.index = [];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  async listChats(projectPath = null) {
    const index = await this.loadIndex();
    return index
      .filter((c) => (projectPath ? c.projectPath === projectPath : !c.projectPath))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  newChat({ projectPath = null, title = 'New chat' } = {}) {
    const now = Date.now();
    return { id: uid('chat_'), title, projectPath, createdAt: now, updatedAt: now, messages: [], items: [] };
  }

  chatFile(id) {
    if (!/^chat_[a-z0-9]+$/.test(id)) throw new Error('Invalid chat id');
    return path.join(this.chatsDir, `${id}.json`);
  }

  async loadChat(id) {
    const raw = await fsp.readFile(this.chatFile(id), 'utf8');
    return JSON.parse(raw);
  }

  async saveChat(chat) {
    chat.updatedAt = Date.now();
    await writeJsonAtomic(this.chatFile(chat.id), chat);
    const index = await this.loadIndex();
    const meta = { id: chat.id, title: chat.title, projectPath: chat.projectPath || null, updatedAt: chat.updatedAt, personaId: chat.personaId || null };
    const i = index.findIndex((c) => c.id === chat.id);
    if (i >= 0) index[i] = meta;
    else index.push(meta);
    await writeJsonAtomic(this.indexFile, index);
    return meta;
  }

  async deleteChat(id) {
    await fsp.rm(this.chatFile(id), { force: true });
    const index = await this.loadIndex();
    this.index = index.filter((c) => c.id !== id);
    await writeJsonAtomic(this.indexFile, this.index);
  }

  async renameChat(id, title) {
    const chat = await this.loadChat(id);
    chat.title = String(title).slice(0, 120) || chat.title;
    return this.saveChat(chat);
  }
}

module.exports = { Store, defaultSettings, sanitizeSettings };
