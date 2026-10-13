'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../src/core/tools/files');
const { runCommandTool } = require('../src/core/tools/command');
const { normalizePlan } = require('../src/core/tools/plan');
const { htmlToText, isPrivateHost, rewriteUrl } = require('../src/core/tools/web');
const { ChangeStore } = require('../src/core/changes');
const { resolveProjectPath } = require('../src/core/safety');

function setup({ edit = 'auto', commands = 'risky', approve = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-tools-'));
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-backups-'));
  const store = new ChangeStore(backups);
  const approvals = [];
  const ctx = {
    root,
    limits: { readChars: 20000, outputChars: 8000 },
    settings: { commandTimeoutSec: 30, shell: 'auto', hideSecretEnv: true },
    permissions: { edit, commands, web: 'ask' },
    resolve: (p) => resolveProjectPath(root, p),
    relative: (abs) => path.relative(root, abs) || '.',
    approve: async (req) => {
      approvals.push(req);
      return { approved: typeof approve === 'function' ? approve(req) : approve };
    },
    recordChange: (c) => store.record(c),
    setPlan: () => {},
  };
  return { root, ctx, store, approvals };
}

test('write_file creates files and records an undoable change', async () => {
  const { root, ctx, store } = setup();
  const res = await files.writeFile.run({ path: 'src/new.js', content: 'const a = 1;\n' }, ctx);
  assert.equal(res.ok, true, res.output);
  assert.equal(fs.readFileSync(path.join(root, 'src/new.js'), 'utf8'), 'const a = 1;\n');
  assert.equal(res.display.change.kind, 'create');
  const undo = await store.undo(res.display.change.id);
  assert.equal(undo.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'src/new.js')), false);
});

test('write_file asks for approval in ask mode and does nothing when rejected', async () => {
  const { root, ctx, approvals } = setup({ edit: 'ask', approve: false });
  const res = await files.writeFile.run({ path: 'a.txt', content: 'hi' }, ctx);
  assert.equal(res.rejected, true);
  assert.equal(approvals.length, 1);
  assert.ok(approvals[0].diff.added === 1);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
});

test('writing outside the project always asks, even in auto mode', async () => {
  const { ctx, approvals } = setup({ edit: 'auto', approve: false });
  const res = await files.writeFile.run({ path: '../escape.txt', content: 'x' }, ctx);
  assert.equal(res.rejected, true);
  assert.equal(approvals[0].kind, 'outside');
  assert.equal(approvals[0].blanket, false);
});

test('edit_file replaces exact text and preserves CRLF line endings', async () => {
  const { root, ctx, store } = setup();
  const file = path.join(root, 'win.txt');
  fs.writeFileSync(file, 'line one\r\nline two\r\nline three\r\n');
  const res = await files.editFile.run({ path: 'win.txt', old_text: 'line two\n', new_text: 'line 2\n' }, ctx);
  assert.equal(res.ok, true, res.output);
  assert.equal(fs.readFileSync(file, 'utf8'), 'line one\r\nline 2\r\nline three\r\n');
  const undo = await store.undo(res.display.change.id);
  assert.equal(undo.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'line one\r\nline two\r\nline three\r\n');
});

test('edit_file tolerates indentation differences', async () => {
  const { root, ctx } = setup();
  const file = path.join(root, 'a.py');
  fs.writeFileSync(file, 'def f():\n    x = 1\n    return x\n');
  const res = await files.editFile.run({ path: 'a.py', old_text: 'x = 1\nreturn x', new_text: 'x = 2\nreturn x * 2' }, ctx);
  assert.equal(res.ok, true, res.output);
  assert.equal(fs.readFileSync(file, 'utf8'), 'def f():\n    x = 2\n    return x * 2\n');
});

test('edit_file reports ambiguous and missing matches', async () => {
  const { root, ctx } = setup();
  fs.writeFileSync(path.join(root, 'b.js'), 'a();\na();\n');
  let res = await files.editFile.run({ path: 'b.js', old_text: 'a();', new_text: 'b();' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /2 times/);
  res = await files.editFile.run({ path: 'b.js', old_text: 'zzz', new_text: 'y' }, ctx);
  assert.match(res.output, /not found/);
  res = await files.editFile.run({ path: 'b.js', old_text: 'a();', new_text: 'b();', replace_all: true }, ctx);
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'b.js'), 'utf8'), 'b();\nb();\n');
});

test('undo detects later modifications', async () => {
  const { root, ctx, store } = setup();
  const res = await files.writeFile.run({ path: 'c.txt', content: 'v1' }, ctx);
  fs.writeFileSync(path.join(root, 'c.txt'), 'v2 by user');
  const undo = await store.undo(res.display.change.id);
  assert.equal(undo.conflict, true);
  const forced = await store.undo(res.display.change.id, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false);
});

test('delete_file always asks and keeps a backup', async () => {
  const { root, ctx, store, approvals } = setup({ edit: 'auto' });
  fs.writeFileSync(path.join(root, 'old.txt'), 'bye');
  const res = await files.deleteFile.run({ path: 'old.txt' }, ctx);
  assert.equal(res.ok, true);
  assert.equal(approvals[0].kind, 'delete');
  assert.equal(fs.existsSync(path.join(root, 'old.txt')), false);
  await store.undo(res.display.change.id);
  assert.equal(fs.readFileSync(path.join(root, 'old.txt'), 'utf8'), 'bye');
});

test('read_file asks before reading secrets and supports ranges', async () => {
  const { root, ctx, approvals } = setup({ approve: false });
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=123');
  const res = await files.readFile.run({ path: '.env' }, ctx);
  assert.equal(res.rejected, true);
  assert.equal(approvals[0].kind, 'sensitive');
  fs.writeFileSync(path.join(root, 'long.txt'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  const r2 = await files.readFile.run({ path: 'long.txt', start_line: 10, end_line: 12 }, ctx);
  assert.match(r2.output, /lines 10-12 of 50/);
  assert.match(r2.output, /line 11/);
  assert.doesNotMatch(r2.output, /line 13/);
});

test('list_files and search_files skip ignored folders and secrets', async () => {
  const { root, ctx } = setup();
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'findme');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.js'), 'const x = "findme";');
  fs.writeFileSync(path.join(root, '.env'), 'findme=1');
  const list = await files.listFiles.run({}, ctx);
  assert.match(list.output, /src\//);
  assert.match(list.output, /node_modules\/ \(skipped\)/);
  const search = await files.searchFiles.run({ query: 'findme' }, ctx);
  assert.match(search.output, /src\/app.js:1/);
  assert.doesNotMatch(search.output, /node_modules/);
  assert.doesNotMatch(search.output, /\.env/);
});

test('run_command runs in the project and reports exit codes', async () => {
  const { ctx } = setup();
  const ok = await runCommandTool.run({ command: 'node -e "console.log(40+2)"' }, ctx);
  assert.equal(ok.ok, true, ok.output);
  assert.match(ok.output, /Exit code: 0/);
  assert.match(ok.output, /42/);
  const bad = await runCommandTool.run({ command: 'node -e "process.exit(3)"' }, ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.output, /Exit code: 3/);
});

test('run_command asks for risky commands and respects rejection', async () => {
  const { root, ctx, approvals } = setup({ approve: false });
  fs.writeFileSync(path.join(root, 'keep.txt'), 'x');
  const res = await runCommandTool.run({ command: 'rm keep.txt' }, ctx);
  assert.equal(res.rejected, true);
  assert.equal(approvals[0].kind, 'danger');
  assert.equal(fs.existsSync(path.join(root, 'keep.txt')), true);
});

test('run_command times out and is killed', async () => {
  const { ctx } = setup();
  ctx.settings.commandTimeoutSec = 1;
  const res = await runCommandTool.run({ command: 'node -e "setTimeout(()=>{}, 10000)"' }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.output, /timed out/);
});

test('run_command is cancelled by the abort signal', async () => {
  const { ctx } = setup();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const res = await runCommandTool.run({ command: 'node -e "setTimeout(()=>{}, 10000)"' }, ctx);
  assert.match(res.output, /cancelled/);
  assert.ok(Date.now() - started < 5000);
});

test('run_command hides secret environment variables', async () => {
  const { ctx } = setup();
  process.env.MY_TEST_API_KEY = 'super-secret-value-123';
  const res = await runCommandTool.run({ command: 'node -e "console.log(process.env.MY_TEST_API_KEY || \'hidden\')"' }, ctx);
  delete process.env.MY_TEST_API_KEY;
  assert.match(res.output, /hidden/);
});

test('plan normalization accepts many shapes', () => {
  assert.deepEqual(normalizePlan({ steps: [{ step: 'A', status: 'done' }, { text: 'B', status: 'in progress' }] }), [
    { text: 'A', status: 'done' },
    { text: 'B', status: 'in_progress' },
  ]);
  assert.deepEqual(normalizePlan({ plan: '1. First\n2. [x] Second' }), [
    { text: 'First', status: 'pending' },
    { text: 'Second', status: 'done' },
  ]);
  assert.deepEqual(normalizePlan({ steps: ['One', 'Two'] }).length, 2);
});

test('web helpers', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('192.168.1.5'), true);
  assert.equal(isPrivateHost('docs.python.org'), false);
  assert.equal(rewriteUrl('https://github.com/a/b/blob/main/README.md'), 'https://raw.githubusercontent.com/a/b/main/README.md');
  const text = htmlToText('<html><head><title>Doc</title><script>x()</script></head><body><h1>API</h1><p>Use <code>foo()</code>&amp; bar</p></body></html>');
  assert.match(text, /# Doc/);
  assert.match(text, /## API/);
  assert.match(text, /`foo\(\)`& bar/);
  assert.doesNotMatch(text, /x\(\)/);
});
