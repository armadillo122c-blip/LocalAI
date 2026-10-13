'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTextToolCalls, ThinkSplitter } = require('../src/core/toolcalls');
const { fitMessages, toolLimits } = require('../src/core/context');
const { buildHunks } = require('../src/core/diff');
const { mergePersonas, BUILTIN_PERSONAS } = require('../src/core/personas');
const { resolveEffort, thinkParam } = require('../src/core/effort');
const { sanitizeSettings } = require('../src/core/store');

const tools = new Set(['read_file', 'write_file', 'run_command']);

test('parses <tool_call> blocks', () => {
  const r = parseTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>', tools);
  assert.deepEqual(r.calls, [{ name: 'read_file', arguments: { path: 'a.js' } }]);
  assert.equal(r.text, 'Let me look.');
});

test('parses fenced JSON and bare JSON tool calls', () => {
  let r = parseTextToolCalls('```json\n{"name": "run_command", "arguments": {"command": "npm test"}}\n```', tools);
  assert.equal(r.calls[0].name, 'run_command');
  r = parseTextToolCalls('{"name": "read_file", "parameters": {"path": "x"}}', tools);
  assert.deepEqual(r.calls[0].arguments, { path: 'x' });
  r = parseTextToolCalls('<tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"y\\"}"}</tool_call>', tools);
  assert.deepEqual(r.calls[0].arguments, { path: 'y' });
});

test('ignores code blocks that are not tool calls', () => {
  const text = 'Example:\n```json\n{"name": "my-package", "version": "1.0.0"}\n```';
  const r = parseTextToolCalls(text, tools);
  assert.equal(r.calls.length, 0);
  assert.equal(r.text, text);
});

test('ThinkSplitter separates inline reasoning across chunks', () => {
  const s = new ThinkSplitter();
  let content = '';
  let thinking = '';
  for (const chunk of ['<thi', 'nk>plan', 'ning</th', 'ink>\n\nAnswer', ' here']) {
    const r = s.push(chunk);
    content += r.content;
    thinking += r.thinking;
  }
  const f = s.flush();
  content += f.content;
  thinking += f.thinking;
  assert.equal(thinking, 'planning');
  assert.equal(content, 'Answer here');
  const plain = new ThinkSplitter();
  assert.equal(plain.push('Hello <think> world').content, 'Hello <think> world');
});

test('fitMessages trims old content but keeps the latest request', () => {
  const big = 'x'.repeat(20000);
  const messages = [
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'ok', tool_calls: [{ function: { name: 'read_file', arguments: {} } }] },
    { role: 'tool', content: big, tool_name: 'read_file' },
    { role: 'assistant', content: big },
    { role: 'user', content: 'latest request' },
    { role: 'assistant', content: 'working' },
  ];
  const { messages: out, trimmed } = fitMessages(messages, 2000);
  assert.equal(trimmed, true);
  assert.ok(out.some((m) => m.content === 'latest request'));
  const total = out.reduce((s, m) => s + m.content.length, 0);
  assert.ok(total / 3.6 < 2600, `total ${total}`);
  assert.notEqual(out[0].role, 'tool');
});

test('toolLimits scales with the context window', () => {
  assert.ok(toolLimits(4096).readChars < toolLimits(32768).readChars);
  assert.ok(toolLimits(2048).readChars >= 4000);
});

test('buildHunks counts changes', () => {
  const d = buildHunks('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 1);
});

test('personas: built-ins are kept, edits survive, custom personas are added', () => {
  const merged = mergePersonas([{ id: 'nexus', systemPrompt: 'custom prompt' }, { id: 'my-ai', name: 'My AI', systemPrompt: 'hi', permissions: { edit: 'bogus' } }]);
  assert.equal(merged.length, BUILTIN_PERSONAS.length + 1);
  assert.equal(merged.find((p) => p.id === 'nexus').systemPrompt, 'custom prompt');
  assert.equal(merged.find((p) => p.id === 'nexus').name, 'Nexus Code');
  const mine = merged.find((p) => p.id === 'my-ai');
  assert.equal(mine.builtin, false);
  assert.equal(mine.permissions.edit, 'ask');
  assert.equal(merged.find((p) => p.id === 'ultracode').defaultEffort, 'max');
});

test('effort levels honor user limits and model capabilities', () => {
  const e = resolveEffort('high', { high: { maxSteps: 7, maxMinutes: 2 } });
  assert.equal(e.maxSteps, 7);
  assert.equal(e.maxMinutes, 2);
  assert.equal(e.planRequired, true);
  assert.equal(resolveEffort('nope').id, 'medium');
  assert.equal(thinkParam(resolveEffort('max'), { thinking: true }), true);
  assert.equal(thinkParam(resolveEffort('max'), { thinking: false }), undefined);
  assert.equal(thinkParam(resolveEffort('instant'), { thinking: true }), false);
  assert.equal(thinkParam(resolveEffort('medium'), { thinking: true }), undefined);
});

test('settings are sanitized', () => {
  const s = sanitizeSettings({ contextLength: 10, effort: 'bogus', temperature: '0.4', theme: 'neon' });
  assert.equal(s.contextLength, 2048);
  assert.equal(s.effort, 'medium');
  assert.equal(s.temperature, 0.4);
  assert.equal(s.theme, 'dark');
  assert.equal(s.personas.length, BUILTIN_PERSONAS.length);
});
