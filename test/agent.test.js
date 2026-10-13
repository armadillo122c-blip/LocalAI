'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMockOllama } = require('./mock-ollama');
const { OllamaClient } = require('../src/core/ollama');
const { AgentRun } = require('../src/core/agent');
const { createDefaultRegistry } = require('../src/core/tools');
const { ChangeStore } = require('../src/core/changes');
const { builtinPersona } = require('../src/core/personas');
const { defaultSettings } = require('../src/core/store');

let mock;
test.before(async () => {
  mock = await startMockOllama({ delayMs: 0 });
});
test.after(async () => {
  await mock.close();
});

function makeRun({ text, model = 'mock-coder:7b', personaId = 'nexus', effort = 'medium', decide = () => 'approve', permissions, settingsPatch = {}, files = {}, noProject = false }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-agent-'));
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, f), c);
  const persona = builtinPersona(personaId);
  if (permissions) persona.permissions = { ...persona.permissions, ...permissions };
  const events = [];
  const approvals = [];
  const chat = { id: 'chat_test', messages: [], items: [] };
  const run = new AgentRun({
    ollama: new OllamaClient(mock.url),
    registry: createDefaultRegistry(),
    changeStore: new ChangeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'localai-bk-'))),
    chat,
    persona,
    effortId: effort,
    model,
    settings: { ...defaultSettings(), ...settingsPatch },
    root: noProject ? null : root,
    homeDir: root,
    knownFolders: { Desktop: path.join(root, 'Desktop') },
    emit: (ev) => events.push(ev),
    requestApproval: async (req) => {
      approvals.push(req);
      return { decision: decide(req) };
    },
  });
  return { run, root, chat, events, approvals, start: () => run.run({ text, attachments: [] }) };
}

const toolItems = (chat) => chat.items.filter((i) => i.type === 'tool');

test('native tool calling: plan, write, run, verify, summarize', async () => {
  const t = makeRun({ text: 'Create hello.js and run it' });
  const reason = await t.start();
  assert.equal(reason, 'done');
  assert.equal(fs.readFileSync(path.join(t.root, 'hello.js'), 'utf8'), "console.log('Hello, LocalAI!');\n");
  const tools = toolItems(t.chat);
  assert.deepEqual(tools.map((i) => i.name), ['update_plan', 'write_file', 'run_command', 'update_plan']);
  assert.ok(tools.every((i) => i.status === 'ok'), JSON.stringify(tools.map((i) => [i.name, i.status, i.output])));
  assert.match(tools[2].output, /Hello, LocalAI!/);
  assert.ok(tools[1].display.change.id);
  // edit approval was requested (Nexus asks before edits)
  assert.equal(t.approvals.length, 1);
  assert.equal(t.approvals[0].category, 'edit');
  const plan = t.chat.items.find((i) => i.type === 'plan');
  assert.ok(plan.steps.every((s) => s.status === 'done'));
  const last = t.chat.items.filter((i) => i.type === 'assistant').pop();
  assert.match(last.text, /Done!/);
  // the request carried tools, num_ctx and the persona prompt
  const req = mock.requests.filter((r) => r.path === '/api/chat').pop();
  assert.ok(req.body.tools.length > 0);
  assert.equal(req.body.options.num_ctx, 8192);
  assert.match(req.body.messages[0].content, /Nexus Code/);
  assert.match(req.body.messages[0].content, /Effort level: MEDIUM/);
  assert.ok(t.events.some((e) => e.type === 'assistant-delta'));
  assert.ok(t.events.some((e) => e.type === 'tool-output'));
});

test('text-mode fallback for models without native tools', async () => {
  const t = makeRun({ text: 'Create hello.js and run it', model: 'mock-text:3b' });
  const reason = await t.start();
  assert.equal(reason, 'done');
  assert.ok(fs.existsSync(path.join(t.root, 'hello.js')));
  const chatReqs = mock.requests.filter((r) => r.path === '/api/chat' && r.body.model === 'mock-text:3b');
  assert.ok(chatReqs.every((r) => !r.body.tools));
  assert.match(chatReqs[0].body.messages[0].content, /<tool_call>/);
  assert.ok(t.chat.messages.some((m) => m.role === 'user' && m.content.startsWith('<tool_result')));
  // tool-call markup is hidden from the displayed text
  assert.ok(t.chat.items.filter((i) => i.type === 'assistant').every((i) => !i.text.includes('<tool_call>')));
});

test('debug loop: reproduce, edit, re-run', async () => {
  const t = makeRun({
    text: 'Fix the bug in math.js',
    files: {
      'math.js': 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n',
      'test.js': "const { add } = require('./math');\nif (add(2, 2) !== 4) { console.error('FAIL: add(2,2) = ' + add(2, 2)); process.exit(1); }\nconsole.log('PASS');\n",
    },
  });
  await t.start();
  const runs = toolItems(t.chat).filter((i) => i.name === 'run_command');
  assert.equal(runs[0].status, 'error');
  assert.match(runs[0].output, /FAIL/);
  assert.equal(runs[runs.length - 1].status, 'ok');
  assert.match(runs[runs.length - 1].output, /PASS/);
  assert.match(fs.readFileSync(path.join(t.root, 'math.js'), 'utf8'), /return a \+ b/);
});

test('rejecting an edit leaves the file untouched and tells the model', async () => {
  const t = makeRun({ text: 'Create hello.js and run it', decide: (r) => (r.category === 'edit' ? 'reject' : 'approve') });
  await t.start();
  assert.equal(fs.existsSync(path.join(t.root, 'hello.js')), false);
  const write = toolItems(t.chat).find((i) => i.name === 'write_file');
  assert.equal(write.status, 'rejected');
  assert.ok(t.chat.messages.some((m) => m.role === 'tool' && /rejected/.test(m.content)));
});

test('"approve all" skips later approvals of the same kind', async () => {
  const t = makeRun({ text: 'Create hello.js and run it', permissions: { commands: 'ask' }, decide: () => 'approve_all' });
  await t.start();
  // one approval for the edit, one for the command; plan updates never ask
  assert.deepEqual(t.approvals.map((a) => a.category), ['edit', 'command']);
});

test('dangerous commands always ask even when commands are allowed', async () => {
  const t = makeRun({ text: 'run the dangerous cleanup', decide: () => 'reject', files: { keep: 'x' } });
  fs.mkdirSync(path.join(t.root, 'build'));
  await t.start();
  assert.equal(t.approvals[0].kind, 'danger');
  assert.ok(t.approvals[0].reasons.length > 0);
  assert.ok(fs.existsSync(path.join(t.root, 'build')));
});

test('High effort requires a plan before edits and a verification step', async () => {
  const t = makeRun({ text: 'Write the notes file', effort: 'high', permissions: { edit: 'auto' } });
  await t.start();
  const notices = t.chat.items.filter((i) => i.type === 'notice').map((i) => i.text);
  assert.ok(notices.some((n) => /Verifying changes/.test(n)), notices.join('|'));
  const runs = toolItems(t.chat).filter((i) => i.name === 'run_command');
  assert.equal(runs.length, 1);
  const req = mock.requests.filter((r) => r.path === '/api/chat').pop();
  assert.match(req.body.messages[0].content, /Effort level: HIGH/);
});

test('plan gate blocks edits until update_plan is called', async () => {
  const t = makeRun({ text: 'Create hello.js and run it but skip', effort: 'high', permissions: { edit: 'auto' } });
  // Remove the plan step from this run by using a persona-less script: write first.
  t.run.registry.get('update_plan');
  const origCall = t.run.callModel.bind(t.run);
  let first = true;
  t.run.callModel = async (opts) => {
    if (first) {
      first = false;
      // Simulate a model that tries to edit before planning
      t.run.chat.messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } } }] });
      return { text: '', calls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }] };
    }
    return origCall(opts);
  };
  await t.start();
  const firstWrite = toolItems(t.chat).find((i) => i.name === 'write_file');
  assert.equal(firstWrite.status, 'error');
  assert.match(firstWrite.output, /Plan required/);
  assert.equal(fs.existsSync(path.join(t.root, 'x.txt')), false);
});

test('Maximum effort adds a self-review pass and enables thinking', async () => {
  const t = makeRun({ text: 'Write the notes file', model: 'mock-think:8b', effort: 'max', permissions: { edit: 'auto' } });
  await t.start();
  const notices = t.chat.items.filter((i) => i.type === 'notice').map((i) => i.text);
  assert.ok(notices.some((n) => /self-review/i.test(n)), notices.join('|'));
  const req = mock.requests.filter((r) => r.path === '/api/chat' && r.body.model === 'mock-think:8b').pop();
  assert.equal(req.body.think, true);
  assert.ok(t.chat.items.some((i) => i.type === 'assistant' && i.thinking.includes('think')));
});

test('Instant effort disables thinking and has a tiny budget', async () => {
  const t = makeRun({ text: 'list forever', model: 'mock-think:8b', effort: 'instant' });
  const reason = await t.start();
  assert.equal(reason, 'budget');
  const reqs = mock.requests.filter((r) => r.path === '/api/chat' && r.body.model === 'mock-think:8b' && r.body.think === false);
  assert.ok(reqs.length >= 1);
  const notices = t.chat.items.filter((i) => i.type === 'notice');
  assert.ok(notices.some((n) => /step limit \(4 steps\)/.test(n.text)));
});

test('step budget from settings is enforced', async () => {
  const t = makeRun({ text: 'list forever', settingsPatch: { effortLimits: { medium: { maxSteps: 3, maxMinutes: 10 } } } });
  const reason = await t.start();
  assert.equal(reason, 'budget');
  // repeated identical calls are blocked by the loop guard
  const lists = toolItems(t.chat).filter((i) => i.name === 'list_files');
  assert.ok(lists.some((i) => /already called/.test(i.output)));
});

test('stop cancels a streaming response', async () => {
  const t = makeRun({ text: 'be slow please' });
  const p = t.start();
  await new Promise((r) => setTimeout(r, 300));
  t.run.stop();
  const reason = await p;
  assert.equal(reason, 'stopped');
  assert.ok(t.chat.items.some((i) => i.type === 'notice' && i.text === 'Stopped.'));
});

test('persona without command permission gets no run_command tool', async () => {
  const t = makeRun({ text: 'hi there', permissions: { commands: 'off', web: 'off' } });
  await t.start();
  const req = mock.requests.filter((r) => r.path === '/api/chat').pop();
  const names = req.body.tools.map((x) => x.function.name);
  assert.ok(!names.includes('run_command'));
  assert.ok(!names.includes('fetch_url'));
  assert.ok(names.includes('read_file'));
  assert.match(req.body.messages[0].content, /cannot run commands/);
});

test('unreachable Ollama gives a helpful error', async () => {
  const t = makeRun({ text: 'hi' });
  t.run.ollama = new OllamaClient('http://127.0.0.1:1');
  const reason = await t.start();
  assert.equal(reason, 'error');
  const n = t.chat.items.find((i) => i.type === 'notice' && i.level === 'error');
  assert.match(n.text, /Can't reach Ollama/);
  assert.match(n.hint, /ollama serve/);
});

test('missing model suggests ollama pull', async () => {
  const t = makeRun({ text: 'hi', model: 'nope:1b' });
  await t.start();
  const n = t.chat.items.find((i) => i.type === 'notice' && i.level === 'error');
  assert.match(n.hint, /ollama pull nope:1b/);
});

test('without a project the tools still work, asking before each access', async () => {
  const t = makeRun({ text: 'Make a folder for my stuff', noProject: true, permissions: { edit: 'auto' } });
  const reason = await t.start();
  assert.equal(reason, 'done');
  assert.ok(fs.statSync(path.join(t.root, 'demo-folder')).isDirectory());
  assert.equal(t.approvals.length, 1);
  assert.equal(t.approvals[0].kind, 'outside');
  assert.equal(t.approvals[0].blanket, false);
  const req = mock.requests.filter((r) => r.path === '/api/chat').pop();
  const system = req.body.messages[0].content;
  assert.match(system, /Your capabilities/);
  assert.match(system, /home folder/);
  assert.match(system, /Desktop: /);
  assert.ok(req.body.tools.some((x) => x.function.name === 'create_folder'));
});

test('rejected no-project access does nothing', async () => {
  const t = makeRun({ text: 'Make a folder for my stuff', noProject: true, decide: () => 'reject' });
  await t.start();
  assert.equal(fs.existsSync(path.join(t.root, 'demo-folder')), false);
});

test('messages sent while working are read at the next step', async () => {
  const t = makeRun({ text: 'be slow please' });
  const p = t.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.run.enqueue({ text: 'also say hi' }), true);
  const queued = t.chat.items.filter((i) => i.type === 'user').pop();
  assert.equal(queued.queued, true);
  const reason = await p;
  assert.equal(reason, 'done');
  assert.equal(queued.queued, false);
  const userMsgs = t.chat.messages.filter((m) => m.role === 'user').map((m) => m.content);
  assert.deepEqual(userMsgs, ['be slow please', 'also say hi']);
  const last = t.chat.items.filter((i) => i.type === 'assistant').pop();
  assert.match(last.text, /also say hi/);
  assert.equal(t.run.enqueue({ text: 'too late' }), false);
});

test('messages queued before Stop are kept in the history', async () => {
  const t = makeRun({ text: 'be slow please' });
  const p = t.start();
  await new Promise((r) => setTimeout(r, 200));
  t.run.enqueue({ text: 'actually, change of plan' });
  t.run.stop();
  assert.equal(await p, 'stopped');
  assert.ok(t.chat.messages.some((m) => m.role === 'user' && m.content === 'actually, change of plan'));
});
