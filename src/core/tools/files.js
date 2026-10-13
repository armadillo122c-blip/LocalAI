'use strict';

// File tools: list, read, search, write, edit, delete.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { isBinaryBuffer, detectEol, truncate, formatBytes } = require('../util');
const { isSensitivePath, isProtectedPath, redactSecrets, REDACTION_MARK, toPosix } = require('../safety');
const { buildHunks, unifiedDiff } = require('../diff');

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'target',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vs',
  '.vscode-test', 'coverage', '.cache', '.parcel-cache', '.turbo', 'obj', '.terraform', 'vendor', 'Pods', '.dart_tool',
]);
const MAX_READ_BYTES = 2 * 1024 * 1024;

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Ask for approval when a path is outside the project or points at a secret file.
async function guardRead(ctx, target, toolLabel) {
  if (!target.inside) {
    const res = await ctx.approve({
      kind: 'outside',
      title: `${toolLabel} outside the project`,
      message: `The AI wants to access a path outside your project folder:\n${target.abs}`,
      blanket: false,
    });
    if (!res.approved) return rejection('access outside the project', res.feedback);
  }
  if (isSensitivePath(target.abs)) {
    const res = await ctx.approve({
      kind: 'sensitive',
      title: 'Read a file that may contain secrets',
      message: `${target.rel} looks like it may contain secrets (keys, tokens, passwords). Allow the AI to read it?`,
      blanket: false,
    });
    if (!res.approved) return rejection('reading this sensitive file', res.feedback);
  }
  return null;
}

async function guardWrite(ctx, target, approval) {
  if (!target.inside) {
    approval.kind = 'outside';
    approval.blanket = false;
    approval.title = `${approval.title} (OUTSIDE PROJECT)`;
    approval.message = `Warning: this path is outside your project folder:\n${target.abs}`;
  } else if (isProtectedPath(target.rel)) {
    approval.blanket = false;
    approval.message = 'This path is inside the .git folder.';
  }
  const needs = !target.inside || isProtectedPath(target.rel) || ctx.permissions.edit !== 'auto' || ctx.forceApproval;
  if (!needs) return null;
  const res = await ctx.approve(approval);
  if (!res.approved) return rejection('this change', res.feedback);
  return null;
}

function rejection(what, feedback) {
  return {
    ok: false,
    rejected: true,
    output: `The user rejected ${what}.` + (feedback ? ` User feedback: ${feedback}` : ' Do not retry the same action; adjust your approach or ask the user.'),
  };
}

// ------------------------------------------------------------- list_files

const listFiles = {
  name: 'list_files',
  category: 'read',
  description: 'List files and folders in the project (recursively, skipping node_modules, .git, build output). Use this to explore the project structure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Folder path relative to the project root. Default: "."' },
      depth: { type: 'integer', description: 'How many folder levels to show (1-6). Default: 3' },
    },
  },
  summarize: (a) => a.path || '.',
  async run(args, ctx) {
    const target = ctx.resolve(args.path || '.');
    const blocked = await guardRead(ctx, target, 'List files');
    if (blocked) return blocked;
    let stat;
    try {
      stat = await fsp.stat(target.abs);
    } catch {
      return { ok: false, output: `Folder not found: ${args.path || '.'}` };
    }
    if (!stat.isDirectory()) return { ok: false, output: `${target.rel} is a file, not a folder. Use read_file to read it.` };
    const maxDepth = Math.min(Math.max(parseInt(args.depth, 10) || 3, 1), 6);
    const maxEntries = 400;
    const lines = [];
    let count = 0;
    let truncated = false;
    async function walk(dir, depth, indent) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (count >= maxEntries) {
          truncated = true;
          return;
        }
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) {
            lines.push(`${indent}${e.name}/ (skipped)`);
            count++;
            continue;
          }
          lines.push(`${indent}${e.name}/`);
          count++;
          if (depth < maxDepth) await walk(path.join(dir, e.name), depth + 1, indent + '  ');
        } else {
          lines.push(`${indent}${e.name}`);
          count++;
        }
      }
    }
    await walk(target.abs, 1, '');
    if (!lines.length) return { ok: true, output: `${target.rel} is empty.` };
    return {
      ok: true,
      output: `${target.rel === '.' ? 'Project root' : target.rel}:\n${lines.join('\n')}${truncated ? `\n... (stopped after ${maxEntries} entries; list a subfolder to see more)` : ''}`,
    };
  },
};

// -------------------------------------------------------------- read_file

const readFile = {
  name: 'read_file',
  category: 'read',
  description: 'Read a text file from the project. For large files, read a range of lines with start_line/end_line.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root' },
      start_line: { type: 'integer', description: 'First line to read (1-based, optional)' },
      end_line: { type: 'integer', description: 'Last line to read (inclusive, optional)' },
    },
    required: ['path'],
  },
  summarize: (a) => a.path + (a.start_line ? `:${a.start_line}-${a.end_line || ''}` : ''),
  async run(args, ctx) {
    const target = ctx.resolve(args.path);
    const blocked = await guardRead(ctx, target, 'Read file');
    if (blocked) return blocked;
    let stat;
    try {
      stat = await fsp.stat(target.abs);
    } catch {
      return { ok: false, output: `File not found: ${args.path}. Use list_files or search_files to find the right path.` };
    }
    if (stat.isDirectory()) return { ok: false, output: `${args.path} is a folder. Use list_files instead.` };
    if (stat.size > MAX_READ_BYTES) return { ok: false, output: `${args.path} is too large (${formatBytes(stat.size)}). Use search_files to find the relevant part.` };
    const buf = await fsp.readFile(target.abs);
    if (isBinaryBuffer(buf)) return { ok: false, output: `${args.path} is a binary file (${formatBytes(stat.size)}) and can't be read as text.` };
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    let start = Math.max(1, parseInt(args.start_line, 10) || 1);
    let end = Math.min(total, parseInt(args.end_line, 10) || total);
    if (start > total) return { ok: false, output: `${args.path} has only ${total} lines.` };
    if (end < start) end = start;
    let body = lines.slice(start - 1, end).join('\n');
    const limit = ctx.limits.readChars;
    let note = '';
    if (body.length > limit) {
      body = body.slice(0, limit);
      const shownLines = body.split('\n').length - 1;
      end = start + Math.max(shownLines - 1, 0);
      body = body.split('\n').slice(0, Math.max(shownLines, 1)).join('\n');
      note = `\n[File continues. Read more with start_line=${end + 1}.]`;
    }
    const header = start === 1 && end === total ? `${target.rel} (${total} lines)` : `${target.rel} (lines ${start}-${end} of ${total})`;
    return { ok: true, output: `${header}\n${redactSecrets(body)}${note}` };
  },
};

// ----------------------------------------------------------- search_files

const searchFiles = {
  name: 'search_files',
  category: 'read',
  description: 'Search text in project files (like grep). Returns matching lines as path:line: text. Case-insensitive.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search for' },
      path: { type: 'string', description: 'Folder to search in, relative to the project root. Default: "."' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression. Default: false' },
      file_pattern: { type: 'string', description: 'Only search files whose name matches, e.g. "*.js" or "*.py"' },
    },
    required: ['query'],
  },
  summarize: (a) => `"${a.query}"${a.path && a.path !== '.' ? ` in ${a.path}` : ''}`,
  async run(args, ctx) {
    if (!args.query) return { ok: false, output: 'query is required' };
    const target = ctx.resolve(args.path || '.');
    const blocked = await guardRead(ctx, target, 'Search');
    if (blocked) return blocked;
    let re;
    try {
      re = args.regex ? new RegExp(args.query, 'i') : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch (err) {
      return { ok: false, output: `Invalid regex: ${err.message}` };
    }
    const nameRe = args.file_pattern ? globToRegExp(args.file_pattern) : null;
    const results = [];
    const maxResults = 80;
    let filesScanned = 0;
    async function walk(dir) {
      if (results.length >= maxResults || ctx.signal?.aborted) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= maxResults) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name)) await walk(full);
          continue;
        }
        if (!e.isFile() || isSensitivePath(full)) continue;
        if (nameRe && !nameRe.test(e.name)) continue;
        let buf;
        try {
          const st = await fsp.stat(full);
          if (st.size > 1024 * 1024) continue;
          buf = await fsp.readFile(full);
        } catch {
          continue;
        }
        if (isBinaryBuffer(buf)) continue;
        filesScanned++;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const rel = toPosix(path.relative(ctx.root || target.abs, full));
            results.push(`${rel}:${i + 1}: ${truncate(lines[i].trim(), 200, '')}`);
            if (results.length >= maxResults) return;
          }
        }
      }
    }
    const st = await fsp.stat(target.abs).catch(() => null);
    if (!st) return { ok: false, output: `Path not found: ${args.path}` };
    if (st.isFile()) {
      const lines = (await fsp.readFile(target.abs, 'utf8')).split(/\r?\n/);
      lines.forEach((l, i) => {
        if (results.length < maxResults && re.test(l)) results.push(`${target.rel}:${i + 1}: ${truncate(l.trim(), 200, '')}`);
      });
    } else {
      await walk(target.abs);
    }
    if (!results.length) return { ok: true, output: `No matches for "${args.query}" (${filesScanned} files searched).` };
    const more = results.length >= maxResults ? `\n... (showing first ${maxResults} matches; narrow the search)` : '';
    return { ok: true, output: redactSecrets(results.join('\n')) + more };
  },
};

function globToRegExp(glob) {
  const parts = String(glob).split(/[,;]/).map((g) => g.trim()).filter(Boolean);
  const src = parts
    .map((g) => '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    .join('|');
  return new RegExp(src || '.*', 'i');
}

// ------------------------------------------------------------- write_file

async function applyWrite(ctx, target, before, newText, toolName) {
  await fsp.mkdir(path.dirname(target.abs), { recursive: true });
  const afterBuf = Buffer.from(newText, 'utf8');
  await fsp.writeFile(target.abs, afterBuf);
  return ctx.recordChange({ file: target.abs, before, after: afterBuf, tool: toolName });
}

function previewTitle(verb, rel) {
  return `${verb} ${rel}`;
}

const writeFile = {
  name: 'write_file',
  category: 'edit',
  description: 'Create a new file or completely replace an existing file with the given content. Parent folders are created automatically. Prefer edit_file for small changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root' },
      content: { type: 'string', description: 'The full content of the file' },
    },
    required: ['path', 'content'],
  },
  summarize: (a) => a.path,
  async run(args, ctx) {
    if (typeof args.content !== 'string') return { ok: false, output: 'content (string) is required' };
    if (args.content.includes(REDACTION_MARK)) {
      return { ok: false, output: 'Refusing to write: the content contains a [REDACTED ...] placeholder, which would destroy a secret. Edit around it with edit_file instead.' };
    }
    const target = ctx.resolve(args.path);
    const existed = await exists(target.abs);
    let before = null;
    let oldText = '';
    if (existed) {
      const st = await fsp.stat(target.abs);
      if (st.isDirectory()) return { ok: false, output: `${args.path} is a folder.` };
      before = await fsp.readFile(target.abs);
      oldText = before.toString('utf8');
    }
    let content = args.content;
    if (existed && detectEol(oldText) === '\r\n') content = content.replace(/\r?\n/g, '\r\n');
    if (existed && oldText === content) return { ok: true, output: `${target.rel} already has this content. No changes made.` };
    const diff = buildHunks(oldText, content);
    const blocked = await guardWrite(ctx, target, {
      kind: 'edit',
      category: 'edit',
      title: previewTitle(existed ? 'Overwrite' : 'Create', target.rel),
      path: target.rel,
      diff,
      blanket: true,
    });
    if (blocked) return { ...blocked, display: { path: target.rel, diff } };
    const change = await applyWrite(ctx, target, before, content, 'write_file');
    const lineCount = content.split('\n').length;
    return {
      ok: true,
      changed: target.abs,
      output: `${existed ? 'Updated' : 'Created'} ${target.rel} (${lineCount} lines, +${diff.added} -${diff.removed}).`,
      display: { path: target.rel, diff, change },
    };
  },
};

// -------------------------------------------------------------- edit_file

function findAll(haystack, needle) {
  const out = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

// Match ignoring trailing whitespace and indentation differences, line by line.
function fuzzyLineMatch(content, oldText) {
  const lines = content.split('\n');
  const want = oldText.split('\n');
  while (want.length && !want[want.length - 1].trim()) want.pop();
  while (want.length && !want[0].trim()) want.shift();
  if (!want.length) return [];
  const norm = (s) => s.trim();
  const matches = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (norm(lines[i + j]) !== norm(want[j])) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ startLine: i, endLine: i + want.length });
  }
  return matches;
}

function reindent(newText, oldBlockFirstLine, wantFirstLine) {
  // Shift new_text indentation by the difference between the file's and the model's indentation.
  const fileIndent = oldBlockFirstLine.match(/^\s*/)[0];
  const modelIndent = wantFirstLine.match(/^\s*/)[0];
  if (fileIndent === modelIndent) return newText;
  return newText
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith(modelIndent)) return fileIndent + line.slice(modelIndent.length);
      return line;
    })
    .join('\n');
}

const editFile = {
  name: 'edit_file',
  category: 'edit',
  description: 'Edit an existing file by replacing an exact snippet of text. old_text must match the file exactly (read the file first) and should include enough surrounding lines to be unique.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root' },
      old_text: { type: 'string', description: 'Exact text to replace (copied from the file)' },
      new_text: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one. Default: false' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  summarize: (a) => a.path,
  async run(args, ctx) {
    const oldArg = args.old_text ?? args.old_string ?? args.search;
    const newArg = args.new_text ?? args.new_string ?? args.replace;
    if (typeof oldArg !== 'string' || typeof newArg !== 'string') return { ok: false, output: 'old_text and new_text (strings) are required' };
    if (newArg.includes(REDACTION_MARK)) {
      return { ok: false, output: 'Refusing to edit: new_text contains a [REDACTED ...] placeholder. Leave secret values untouched.' };
    }
    const target = ctx.resolve(args.path);
    if (!(await exists(target.abs))) return { ok: false, output: `File not found: ${args.path}. Use write_file to create a new file.` };
    const before = await fsp.readFile(target.abs);
    if (isBinaryBuffer(before)) return { ok: false, output: `${args.path} is binary and can't be edited.` };
    let raw = before.toString('utf8');
    const bom = raw.startsWith('﻿') ? '﻿' : '';
    raw = raw.slice(bom.length);
    const eol = detectEol(raw);
    const content = raw.replace(/\r\n/g, '\n');
    const oldText = oldArg.replace(/\r\n/g, '\n');
    const newText = newArg.replace(/\r\n/g, '\n');
    if (!oldText) return { ok: false, output: 'old_text is empty. To create or overwrite a file use write_file.' };
    if (oldText === newText) return { ok: false, output: 'old_text and new_text are identical; nothing to change.' };

    let updated;
    const hits = findAll(content, oldText);
    if (hits.length === 1 || (hits.length > 1 && args.replace_all)) {
      updated = args.replace_all ? content.split(oldText).join(newText) : content.slice(0, hits[0]) + newText + content.slice(hits[0] + oldText.length);
    } else if (hits.length > 1) {
      return { ok: false, output: `old_text appears ${hits.length} times in ${target.rel}. Include more surrounding lines so it is unique, or set replace_all to true.` };
    } else {
      const fuzzy = fuzzyLineMatch(content, oldText);
      if (fuzzy.length === 1 || (fuzzy.length > 1 && args.replace_all)) {
        const lines = content.split('\n');
        const firstWant = oldText.split('\n').find((l) => l.trim()) || '';
        for (const m of [...fuzzy].reverse()) {
          const replacement = reindent(newText.replace(/^\n+|\n+$/g, ''), lines[m.startLine], firstWant).split('\n');
          lines.splice(m.startLine, m.endLine - m.startLine, ...replacement);
        }
        updated = lines.join('\n');
      } else if (fuzzy.length > 1) {
        return { ok: false, output: `old_text matches ${fuzzy.length} places in ${target.rel}. Include more surrounding lines so it is unique.` };
      } else {
        return {
          ok: false,
          output: `old_text was not found in ${target.rel}. Read the file again with read_file and copy the exact text (including indentation), or use write_file to rewrite the whole file.`,
        };
      }
    }
    const finalText = bom + (eol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated);
    const diff = buildHunks(content, updated);
    const blocked = await guardWrite(ctx, target, {
      kind: 'edit',
      category: 'edit',
      title: previewTitle('Edit', target.rel),
      path: target.rel,
      diff,
      blanket: true,
    });
    if (blocked) return { ...blocked, display: { path: target.rel, diff } };
    const change = await applyWrite(ctx, target, before, finalText, 'edit_file');
    return {
      ok: true,
      changed: target.abs,
      output: `Edited ${target.rel} (+${diff.added} -${diff.removed}).\n${unifiedDiff(content, updated, target.rel, 40)}`,
      display: { path: target.rel, diff, change },
    };
  },
};

// ------------------------------------------------------------ delete_file

const deleteFile = {
  name: 'delete_file',
  category: 'edit',
  description: 'Delete a single file from the project. The user is always asked to confirm. A backup is kept so it can be undone.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the project root' },
    },
    required: ['path'],
  },
  summarize: (a) => a.path,
  async run(args, ctx) {
    const target = ctx.resolve(args.path);
    let st;
    try {
      st = await fsp.stat(target.abs);
    } catch {
      return { ok: false, output: `File not found: ${args.path}` };
    }
    if (st.isDirectory()) return { ok: false, output: `${args.path} is a folder. Only single files can be deleted with this tool.` };
    const before = await fsp.readFile(target.abs);
    const preview = isBinaryBuffer(before) ? null : buildHunks(before.toString('utf8'), '');
    const res = await ctx.approve({
      kind: target.inside ? 'delete' : 'outside',
      category: 'delete',
      title: `Delete ${target.inside ? target.rel : target.abs}${target.inside ? '' : ' (OUTSIDE PROJECT)'}`,
      message: `The file will be deleted (${formatBytes(st.size)}). A backup is kept so you can undo it.`,
      path: target.rel,
      diff: preview && preview.removed <= 400 ? preview : null,
      blanket: false,
    });
    if (!res.approved) return rejection('deleting this file', res.feedback);
    await fsp.unlink(target.abs);
    const change = await ctx.recordChange({ file: target.abs, before, after: null, tool: 'delete_file' });
    return { ok: true, changed: target.abs, output: `Deleted ${target.rel}.`, display: { path: target.rel, change } };
  },
};

module.exports = { listFiles, readFile, searchFiles, writeFile, editFile, deleteFile, IGNORED_DIRS, fuzzyLineMatch, globToRegExp };
