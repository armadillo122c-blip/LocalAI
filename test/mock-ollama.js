'use strict';

// A scripted fake Ollama server that speaks the real REST API (/api/version, /api/tags,
// /api/show, streaming /api/chat with tool calls). Used by the tests, and handy for
// trying the UI without a GPU:  npm run mock-ollama  (then point Settings at it).

const http = require('http');

const MODELS = {
  'mock-coder:7b': { caps: ['completion', 'tools'], family: 'qwen2', size: 4.7e9, params: '7.6B', ctx: 32768 },
  'mock-think:8b': { caps: ['completion', 'tools', 'thinking'], family: 'qwen3', size: 5.2e9, params: '8.2B', ctx: 40960 },
  'mock-text:3b': { caps: ['completion'], family: 'llama', size: 2.0e9, params: '3.2B', ctx: 8192 },
};

function lastUserRequest(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.content.startsWith('[LocalAI]') && !m.content.startsWith('<tool_result')) return { index: i, text: m.content };
  }
  return { index: -1, text: '' };
}

function call(name, args) {
  return { name, arguments: args };
}

// Each script is a list of turns; a turn is { text?, calls?[] }.
const SCRIPTS = {
  hello: [
    { text: "I'll create the script and run it.", calls: [call('update_plan', { steps: [{ step: 'Create hello.js', status: 'in_progress' }, { step: 'Run it to verify', status: 'pending' }] })] },
    { calls: [call('write_file', { path: 'hello.js', content: "console.log('Hello, LocalAI!');\n" })] },
    { calls: [call('run_command', { command: 'node hello.js' })] },
    { calls: [call('update_plan', { steps: [{ step: 'Create hello.js', status: 'done' }, { step: 'Run it to verify', status: 'done' }] })] },
    { text: 'Done! I created **hello.js** and ran it:\n\n```\nHello, LocalAI!\n```' },
  ],
  bug: [
    { text: 'Let me reproduce the failure first.', calls: [call('run_command', { command: 'node test.js' })] },
    { calls: [call('read_file', { path: 'math.js' })] },
    { text: 'The bug: `add` subtracts instead of adding.', calls: [call('update_plan', { steps: [{ step: 'Fix add()', status: 'in_progress' }, { step: 'Re-run tests', status: 'pending' }] })] },
    { calls: [call('edit_file', { path: 'math.js', old_text: 'return a - b;', new_text: 'return a + b;' })] },
    { calls: [call('run_command', { command: 'node test.js' })] },
    { text: 'Fixed `add()` in math.js — the test now passes.' },
  ],
  unverified: [
    { calls: [call('update_plan', { steps: [{ step: 'Write notes.txt', status: 'in_progress' }] })] },
    { calls: [call('write_file', { path: 'notes.txt', content: 'hello\n' })] },
    { text: 'I wrote notes.txt.' },
  ],
  delete: [{ calls: [call('delete_file', { path: 'old.txt' })] }, { text: 'Deleted old.txt.' }],
  folder: [{ calls: [call('create_folder', { path: 'demo-folder' })] }, { text: 'Created the folder **demo-folder**.' }],
  danger: [{ calls: [call('run_command', { command: 'rm -rf build' })] }, { text: 'Cleaned the build folder.' }],
  outside: [{ calls: [call('write_file', { path: '../outside.txt', content: 'x' })] }, { text: 'Tried to write outside.' }],
  slow: [{ text: 'Working on it. '.repeat(400), slow: true }],
  loop: [{ calls: [call('list_files', { path: '.' })] }],
};

function pickScript(text) {
  const t = text.toLowerCase();
  if (t.includes('hello')) return 'hello';
  if (t.includes('fix') || t.includes('bug')) return 'bug';
  if (t.includes('notes')) return 'unverified';
  if (t.includes('delete')) return 'delete';
  if (t.includes('folder')) return 'folder';
  if (t.includes('dangerous')) return 'danger';
  if (t.includes('outside')) return 'outside';
  if (t.includes('slow')) return 'slow';
  if (t.includes('forever')) return 'loop';
  return null;
}

function decideTurn(body) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1] || { content: '' };
  if (last.role === 'user' && last.content.startsWith('[LocalAI] Verification required')) {
    return { text: 'Verifying.', calls: [call('run_command', { command: 'node -e "console.log(1)"' })] };
  }
  if (last.role === 'user' && last.content.startsWith('[LocalAI] Final review')) return { text: 'Reviewed my changes: everything looks correct.' };
  if (last.role === 'user' && last.content.includes('budget for this task is used up')) return { text: 'Summary: I ran out of budget while exploring.' };
  const req = lastUserRequest(messages);
  const name = pickScript(req.text);
  if (!name) {
    return {
      text: `You asked: "${req.text.slice(0, 80)}"\n\nHere is an example:\n\n\`\`\`js\nfunction greet(name) {\n  return \`Hello, \${name}!\`;\n}\n\`\`\`\n\n- Fast\n- **Local**`,
    };
  }
  const script = SCRIPTS[name];
  const turnsSoFar = messages.slice(req.index + 1).filter((m) => m.role === 'assistant').length;
  if (name === 'loop') return script[0];
  return script[Math.min(turnsSoFar, script.length - 1)];
}

function startMockOllama({ port = 0, delayMs = 5 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url, body });
      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/version') return json(200, { version: '0.12.6-mock' });
      if (req.url === '/api/tags') {
        return json(200, {
          models: Object.entries(MODELS).map(([name, m]) => ({
            name,
            model: name,
            size: m.size,
            modified_at: new Date().toISOString(),
            details: { family: m.family, parameter_size: m.params, quantization_level: 'Q4_K_M' },
          })),
        });
      }
      if (req.url === '/api/show') {
        const m = MODELS[body.model];
        if (!m) return json(404, { error: `model '${body.model}' not found` });
        return json(200, { capabilities: m.caps, details: { family: m.family, parameter_size: m.params }, model_info: { [`${m.family}.context_length`]: m.ctx }, template: '' });
      }
      if (req.url === '/api/chat') {
        const m = MODELS[body.model];
        if (!m) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
        if (body.tools && !m.caps.includes('tools')) return json(400, { error: `registry.ollama.ai/library/${body.model} does not support tools` });
        const turn = decideTurn(body);
        const native = !!body.tools;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const send = (obj) => res.write(JSON.stringify({ model: body.model, created_at: new Date().toISOString(), ...obj }) + '\n');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        let closed = false;
        res.on('close', () => (closed = true));
        if (m.caps.includes('thinking') && body.think !== false) {
          for (const w of 'Let me think about the best approach here.'.split(' ')) {
            if (closed) return;
            send({ message: { role: 'assistant', content: '', thinking: w + ' ' }, done: false });
            await wait(delayMs);
          }
        }
        let text = turn.text || '';
        if (!native && turn.calls) {
          text += (text ? '\n' : '') + turn.calls.map((c) => `<tool_call>\n${JSON.stringify(c)}\n</tool_call>`).join('\n');
        }
        const words = text.match(/\S+\s*|\s+/g) || [];
        for (const w of words) {
          if (closed) return;
          send({ message: { role: 'assistant', content: w }, done: false });
          await wait(turn.slow ? 25 : delayMs);
        }
        if (native && turn.calls) {
          send({ message: { role: 'assistant', content: '', tool_calls: turn.calls.map((c) => ({ function: c })) }, done: false });
        }
        send({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: words.length + 5, eval_duration: 250000000, prompt_eval_count: 900 });
        return res.end();
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({ url: `http://127.0.0.1:${p}`, port: p, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 11434);
  startMockOllama({ port, delayMs: 30 }).then(({ url }) => console.log(`Mock Ollama listening on ${url}`));
}

module.exports = { startMockOllama, MODELS };
