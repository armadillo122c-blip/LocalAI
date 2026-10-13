'use strict';

// Backup journal for every file change the agent makes, so each change can be undone.
// Layout: <dir>/<changeId>/meta.json and <dir>/<changeId>/before (original bytes).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { uid, sha256 } = require('./util');

class ChangeStore {
  constructor(dir) {
    this.dir = dir;
  }

  async record({ file, before, after, chatId = null, tool = '' }) {
    const id = uid('chg_');
    const folder = path.join(this.dir, id);
    await fsp.mkdir(folder, { recursive: true });
    if (before) await fsp.writeFile(path.join(folder, 'before'), before);
    const kind = before == null ? 'create' : after == null ? 'delete' : 'modify';
    const meta = {
      id,
      file,
      kind,
      tool,
      chatId,
      time: Date.now(),
      beforeExists: before != null,
      afterHash: after != null ? sha256(after) : null,
      undone: false,
    };
    await fsp.writeFile(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async get(id) {
    if (!/^chg_[a-z0-9]+$/.test(id)) throw new Error('Invalid change id');
    const raw = await fsp.readFile(path.join(this.dir, id, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  }

  /**
   * Restore the file to its state before the change.
   * If the file was modified again afterwards, returns { conflict: true } unless force is set.
   */
  async undo(id, { force = false } = {}) {
    const meta = await this.get(id);
    if (meta.undone) return { ok: false, message: 'This change was already undone.' };
    let current = null;
    try {
      current = await fsp.readFile(meta.file);
    } catch {
      current = null;
    }
    const currentHash = current ? sha256(current) : null;
    if (!force && currentHash !== meta.afterHash) {
      return {
        ok: false,
        conflict: true,
        message: `${path.basename(meta.file)} was changed again after this edit. Undoing will overwrite those later changes.`,
      };
    }
    if (meta.beforeExists) {
      const before = await fsp.readFile(path.join(this.dir, id, 'before'));
      await fsp.mkdir(path.dirname(meta.file), { recursive: true });
      await fsp.writeFile(meta.file, before);
    } else if (current) {
      await fsp.unlink(meta.file);
    }
    meta.undone = true;
    await fsp.writeFile(path.join(this.dir, id, 'meta.json'), JSON.stringify(meta, null, 2));
    return { ok: true, message: `Restored ${path.basename(meta.file)}` };
  }

  // Remove backups older than `days`.
  async purge(days = 30) {
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    for (const name of entries) {
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(this.dir, name, 'meta.json'), 'utf8'));
        if (meta.time < cutoff) {
          await fsp.rm(path.join(this.dir, name), { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* ignore broken entries */
      }
    }
    return removed;
  }
}

module.exports = { ChangeStore };
