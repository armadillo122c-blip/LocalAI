'use strict';

// The agent loop: stream a model response, run the tool calls it makes,
// feed results back, and repeat until the task is done, the budget is used,
// or the user stops it. Effort gates (plan / verify / self-review) are enforced here.

const path = require('path');
const { ToolRegistry } = require('./tools');
const { buildSystemPrompt } = require('./prompt');
const { fitMessages, toolLimits } = require('./context');
const { parseTextToolCalls, ThinkSplitter, tryParseJson } = require('./toolcalls');
const { resolveEffort, thinkParam } = require('./effort');
const { nudgeReason } = require('./guards');
const { resolveProjectPath, toPosix } = require('./safety');
const { uid, estimateTokens, truncate, abortError } = require('./util');

const MAX_CALLS_PER_STEP = 8;
const DISPLAY_OUTPUT_CHARS = 20000;

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypass']);

// The session permission mode (chosen in the UI) overrides the persona's own
// permissions, like Claude Code's Ask / Accept Edits / Plan / Bypass modes.
function effectivePermissions(persona, settings, mode = 'default') {
  const p = { ...persona.permissions };
  if (mode === 'plan') {
    // Read-only: explore and propose a plan, change nothing.
    p.edit = 'off';
    p.commands = 'off';
  } else if (mode === 'acceptEdits') {
    p.edit = 'auto';
  } else if (mode === 'bypass') {
    // Full access: enable every tool; approvals are skipped in approve().
    p.edit = 'auto';
    if (p.commands === 'off') p.commands = 'risky';
    p.web = 'auto';
  }
  // Safe mode still forces prompts, but never over a deliberate bypass.
  if (settings.safeMode && mode !== 'bypass') {
    if (p.edit === 'auto') p.edit = 'ask';
    if (p.commands === 'risky') p.commands = 'ask';
    if (p.web === 'auto') p.web = 'ask';
  }
  return p;
}

function personaBadge(p) {
  return { id: p.id, name: p.name, icon: p.icon, color: p.color };
}

class AgentRun {
  /**
   * @param {object} o
   * @param {import('./ollama').OllamaClient} o.ollama
   * @param {ToolRegistry} o.registry
   * @param {import('./changes').ChangeStore} o.changeStore
   * @param {object} o.chat         { id, messages: [], items: [] }
   * @param {object} o.persona
   * @param {string} o.effortId
   * @param {string} o.model
   * @param {object} o.settings
   * @param {string|null} o.root
   * @param {(ev: object) => void} o.emit
   * @param {(req: object) => Promise<{decision: string, feedback?: string}>} o.requestApproval
   * @param {() => void} [o.onSave]
   */
  constructor(o) {
    Object.assign(this, o);
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.blanket = new Set();
    this.queue = [];
    this.toolNudges = 0;
    this.currentRequest = '';
    this.permissionMode = this.permissionMode || 'default';
    this.closed = false;
    this.extraMs = 0;
    this.pausedMs = 0;
    this.step = 0;
    this.toolCallCount = 0;
    this.planItem = null;
  }

  stop() {
    this.controller.abort();
  }

  /**
   * A message the user sent while the agent is working. It is shown right away
   * and handed to the model before its next step. Returns false once the run is over.
   */
  enqueue({ text, attachments = [] }) {
    if (this.closed || this.signal.aborted) return false;
    const item = this.addItem({
      type: 'user',
      text,
      attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
      persona: personaBadge(this.persona),
      effort: this.effortId,
      queued: true,
    });
    this.queue.push({ item, text, attachments });
    this.save();
    return true;
  }

  /** Move queued user messages into the conversation. Returns true if there were any. */
  drainQueue() {
    if (!this.queue.length || !this.modelInfo) return false;
    for (const q of this.queue.splice(0)) {
      this.chat.messages.push(this.buildUserMessage(q.text, q.attachments));
      this.updateItem(q.item, { queued: false });
      this.currentRequest = q.text;
      this.toolNudges = 0;
    }
    // New instructions get some room even if the budget was nearly used.
    const minSteps = Math.min(this.effort.maxSteps, 8);
    if (this.effort.maxSteps - this.step + 1 < minSteps) this.effort.maxSteps = this.step - 1 + minSteps;
    const minMs = Math.min(this.effort.maxMinutes, 5) * 60000;
    const left = this.deadline() - Date.now();
    if (left < minMs) this.extraMs += minMs - left;
    this.budgetWarned = false;
    this.save();
    return true;
  }

  throwIfAborted() {
    if (this.signal.aborted) throw abortError();
  }

  // ------------------------------------------------------------ items/events

  addItem(item) {
    const full = { id: uid('it_'), time: Date.now(), ...item };
    this.chat.items.push(full);
    this.emit({ type: 'item-add', item: full });
    return full;
  }

  updateItem(item, patch) {
    Object.assign(item, patch);
    this.emit({ type: 'item-update', id: item.id, patch });
  }

  removeItem(item) {
    const idx = this.chat.items.indexOf(item);
    if (idx >= 0) this.chat.items.splice(idx, 1);
    this.emit({ type: 'item-remove', id: item.id });
  }

  status(phase, detail = '') {
    const e = this.effort;
    this.emit({
      type: 'status',
      status: {
        running: true,
        phase,
        detail,
        step: this.step,
        maxSteps: e?.maxSteps,
        toolCalls: this.toolCallCount,
        startedAt: this.started,
        pausedMs: this.pausedMs,
        maxMinutes: e?.maxMinutes,
        effort: e?.id,
        effortLabel: e?.label,
        plan: this.taskState?.plan ? { done: this.taskState.plan.filter((s) => s.status === 'done').length, total: this.taskState.plan.length } : null,
      },
    });
  }

  save() {
    try {
      this.onSave?.();
    } catch {
      /* persistence errors must not break the run */
    }
  }

  // ------------------------------------------------------------------- run

  async run({ text, attachments = [] }) {
    this.started = Date.now();
    this.effort = resolveEffort(this.effortId, this.settings.effortLimits);
    this.mode = PERMISSION_MODES.has(this.permissionMode) ? this.permissionMode : 'default';
    this.bypass = this.mode === 'bypass';
    this.permissions = effectivePermissions(this.persona, this.settings, this.mode);
    this.verifyLeft = this.effort.verifyRetries;
    this.reviewPending = this.effort.selfReview;
    this.planGateUsed = false;
    this.budgetWarned = false;
    this.taskState = { changedFiles: new Set(), unverified: false, lastCheckOk: null, verifyRejected: false, plan: null, recentCalls: [] };

    const userItem = this.addItem({
      type: 'user',
      text,
      attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })),
      persona: personaBadge(this.persona),
      effort: this.effort.id,
    });
    void userItem;
    let reason = 'done';
    try {
      this.status('starting', 'Loading model info');
      this.modelInfo = await this.ollama.modelInfo(this.model);
      const configured = Number(this.settings.contextLength) || 8192;
      this.numCtx = this.modelInfo.contextLength ? Math.min(configured, this.modelInfo.contextLength) : configured;
      this.limits = toolLimits(this.numCtx);
      this.toolMode = this.modelInfo.tools ? 'native' : 'text';
      // Without a project the tools still work, but every file access and command needs approval.
      this.tools = this.registry.available({ permissions: this.permissions, hasProject: !!(this.root || this.homeDir) });

      this.chat.messages.push(this.buildUserMessage(text, attachments));
      this.currentRequest = text;
      this.save();
      reason = await this.loop();
    } catch (err) {
      if (err.name === 'AbortError' || this.signal.aborted) {
        reason = 'stopped';
        this.addItem({ type: 'notice', level: 'info', text: 'Stopped.' });
      } else {
        reason = 'error';
        this.addItem({ type: 'notice', level: 'error', text: err.message, hint: err.hint || '', code: err.code || '' });
      }
    } finally {
      this.closed = true;
      // Messages that arrived too late (or after Stop) stay in the history for the next turn.
      for (const q of this.queue.splice(0)) {
        this.chat.messages.push({ role: 'user', content: q.text });
        this.updateItem(q.item, { queued: false });
      }
      this.emit({ type: 'status', status: { running: false } });
      this.save();
    }
    return reason;
  }

  buildUserMessage(text, attachments) {
    let content = text || '';
    const images = [];
    for (const a of attachments) {
      if (a.kind === 'text') {
        content += `\n\n<attached_file name="${a.name}">\n${a.content}\n</attached_file>`;
      } else if (a.kind === 'image') {
        if (this.modelInfo.vision) images.push(a.data);
        else this.addItem({ type: 'notice', level: 'warn', text: `${a.name} was not sent: ${this.model} can't see images. Use a vision model (e.g. llava, qwen2.5vl, gemma3) for screenshots.` });
      }
    }
    const msg = { role: 'user', content };
    if (images.length) msg.images = images;
    return msg;
  }

  deadline() {
    return this.started + this.effort.maxMinutes * 60000 + this.pausedMs + this.extraMs;
  }

  async loop() {
    for (this.step = 1; ; this.step++) {
      this.throwIfAborted();
      this.drainQueue();
      if (this.step > this.effort.maxSteps || Date.now() > this.deadline()) {
        await this.budgetSummary(this.step > this.effort.maxSteps ? 'steps' : 'time');
        return 'budget';
      }
      const note = this.budgetNote();
      this.status('thinking');
      const resp = await this.callModel({ note });

      if (!resp.calls.length) {
        if (this.queue.length) continue; // the user sent something meanwhile: keep going
        const canAct = this.tools.some((t) => t.category === 'edit' || t.category === 'command');
        const why = canAct && this.toolNudges < 2 ? nudgeReason({ request: this.currentRequest, reply: resp.text, usedTools: this.toolCallCount > 0 }) : null;
        if (why) {
          // The model talked instead of acting: it claimed it can't, listed manual
          // steps, or asked for permission to continue. Send it back to work.
          this.toolNudges++;
          const names = this.tools.map((t) => t.name).join(', ');
          const content =
            why === 'confirm'
              ? `[LocalAI] Don't ask whether to proceed — the user already asked you to do this, and anything risky gets its own approval prompt. Continue now with your tools and finish the task, then give a short summary.`
              : `[LocalAI] You DO have working tools on this computer: ${names}. Do not tell the user to do it themselves and do not say you can't access their computer. Call the right tool now to do what they asked. (If you are declining for a different reason, explain that reason instead.)`;
          this.chat.messages.push({ role: 'user', content });
          this.addItem({ type: 'notice', level: 'info', text: why === 'confirm' ? 'The model stopped to ask for permission — telling it to carry on.' : 'The model answered without using its tools — reminding it that it can act on your computer.' });
          this.save();
          continue;
        }
        const gate = this.finishGate(resp.text);
        if (gate) {
          this.chat.messages.push({ role: 'user', content: gate.note });
          this.addItem({ type: 'notice', level: 'info', text: gate.label });
          this.save();
          continue;
        }
        return 'done';
      }

      const calls = resp.calls.slice(0, MAX_CALLS_PER_STEP);
      const textResults = [];
      const cancelFrom = (from) => {
        for (const c of calls.slice(from)) this.pushToolResult(c, 'Cancelled by the user.', textResults);
        this.flushTextResults(textResults);
        throw abortError();
      };
      for (let i = 0; i < calls.length; i++) {
        if (this.signal.aborted) cancelFrom(i);
        try {
          await this.executeTool(calls[i], textResults);
        } catch (err) {
          if (err.name === 'AbortError') cancelFrom(i + 1);
          throw err;
        }
      }
      if (resp.calls.length > MAX_CALLS_PER_STEP) {
        textResults.push(`(Only the first ${MAX_CALLS_PER_STEP} tool calls were run. Call the rest in your next reply.)`);
      }
      this.flushTextResults(textResults);
      this.save();
    }
  }

  budgetNote() {
    if (this.budgetWarned || this.effort.maxSteps < 6) return null;
    const stepsLeft = this.effort.maxSteps - this.step + 1;
    const msLeft = this.deadline() - Date.now();
    if (stepsLeft <= 2 || msLeft < Math.min(120000, this.effort.maxMinutes * 60000 * 0.15)) {
      this.budgetWarned = true;
      return `[LocalAI] Budget almost used up (${stepsLeft} step(s), ~${Math.max(1, Math.round(msLeft / 60000))} min left). Finish the most important remaining work, verify it if you can, then give your final summary.`;
    }
    return null;
  }

  /** Decide whether the agent may finish, or must verify / fix / review first. */
  finishGate(finalText) {
    const ts = this.taskState;
    if (/\?\s*$/.test(String(finalText || '').trim())) return null; // asking the user something
    if (!ts.changedFiles.size) return null;
    const files = [...ts.changedFiles].map((f) => (this.root ? toPosix(path.relative(this.root, f)) : f)).slice(0, 8).join(', ');
    const canRun = this.tools.some((t) => t.name === 'run_command');
    if (canRun && this.verifyLeft > 0 && !ts.verifyRejected) {
      if (ts.unverified) {
        this.verifyLeft--;
        return {
          label: `Verifying changes (${this.effort.label} effort)`,
          note: `[LocalAI] Verification required (${this.effort.label} effort). You changed ${files} but have not run any check since. Run the most relevant test, build or the program with run_command to verify the change. If it fails, fix the problem and run it again. If verification is truly impossible, explain why in your final answer.`,
        };
      }
      if (ts.lastCheckOk === false) {
        this.verifyLeft--;
        return {
          label: `Last check failed — fixing and retrying (${this.effort.label} effort)`,
          note: `[LocalAI] Your last check failed (see the command output above). Analyze the error, fix the root cause and run the check again. Only stop if it cannot be fixed, and then explain exactly why.`,
        };
      }
    }
    if (this.reviewPending) {
      this.reviewPending = false;
      return {
        label: 'Final self-review (Maximum effort)',
        note: `[LocalAI] Final review (Maximum effort). Before finishing, re-read your changes to ${files}. Check for bugs, unhandled edge cases, leftover debug code, broken call sites, and anything the user asked for that is not done yet. Fix and re-verify any problem you find. If everything is correct, give your final summary, including what you verified.`,
      };
    }
    return null;
  }

  async budgetSummary(kind) {
    const e = this.effort;
    const what = kind === 'steps' ? `step limit (${e.maxSteps} steps)` : `time limit (${e.maxMinutes} min)`;
    this.step = e.maxSteps;
    this.status('summarizing', `Reached the ${what}`);
    await this.callModel({
      note: `[LocalAI] The ${kind === 'steps' ? 'step' : 'time'} budget for this task is used up. Do not call any tools. Summarize what you completed, what was verified, and what still remains to be done.`,
      noTools: true,
    });
    this.addItem({
      type: 'notice',
      level: 'warn',
      text: `Stopped at the ${what} for ${e.label} effort. Press Continue to keep working, or raise the limit in Settings → Effort.`,
      action: 'continue',
    });
  }

  // ----------------------------------------------------------------- model

  async callModel({ note = null, noTools = false } = {}) {
    const system = buildSystemPrompt({
      persona: this.persona,
      effort: this.effort,
      root: this.root,
      tools: this.tools,
      toolMode: this.toolMode,
      settings: this.settings,
      homeDir: this.homeDir,
      knownFolders: this.knownFolders,
      permissionMode: this.mode,
    });
    const schemas = this.toolMode === 'native' && !noTools && this.tools.length ? ToolRegistry.schemas(this.tools) : undefined;
    const reserve = Math.min(4096, Math.floor(this.numCtx * 0.25));
    const budget = this.numCtx - reserve - estimateTokens(system) - (schemas ? estimateTokens(JSON.stringify(schemas)) : 0);
    const { messages } = fitMessages(this.chat.messages, Math.max(budget, 600));
    if (note) messages.push({ role: 'user', content: note });

    const temperature = this.persona.temperature ?? (Number.isFinite(this.settings.temperature) ? this.settings.temperature : null);
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, ...messages],
      options: { num_ctx: this.numCtx, ...(temperature != null ? { temperature } : {}) },
    };
    if (schemas) body.tools = schemas;
    const think = thinkParam(this.effort, this.modelInfo);
    if (think !== undefined) body.think = think;

    const item = this.addItem({ type: 'assistant', text: '', thinking: '', streaming: true, persona: personaBadge(this.persona) });
    let raw = '';
    let thinking = '';
    let nativeCalls = [];
    let stats = null;
    const splitter = new ThinkSplitter();
    let pendingText = '';
    let pendingThink = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (pendingText || pendingThink) {
        this.emit({ type: 'assistant-delta', id: item.id, text: pendingText, thinking: pendingThink });
        pendingText = '';
        pendingThink = '';
      }
    };
    const queue = (t, th) => {
      pendingText += t;
      pendingThink += th;
      if (!timer) timer = setTimeout(flush, 40);
    };

    try {
      for await (const chunk of this.ollama.chat(body, this.signal)) {
        const msg = chunk.message || {};
        if (msg.thinking) {
          thinking += msg.thinking;
          queue('', msg.thinking);
        }
        if (msg.content) {
          const part = splitter.push(msg.content);
          raw += part.content;
          thinking += part.thinking;
          queue(part.content, part.thinking);
        }
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) nativeCalls.push(...msg.tool_calls);
        if (chunk.done) {
          stats = {
            tokens: chunk.eval_count || 0,
            tps: chunk.eval_count && chunk.eval_duration ? +(chunk.eval_count / (chunk.eval_duration / 1e9)).toFixed(1) : null,
            promptTokens: chunk.prompt_eval_count || 0,
            doneReason: chunk.done_reason || '',
          };
        }
      }
      const rest = splitter.flush();
      raw += rest.content;
      thinking += rest.thinking;
      queue(rest.content, rest.thinking);
    } catch (err) {
      if (timer) clearTimeout(timer);
      flush();
      if (err.code === 'no-tools' && this.toolMode === 'native') {
        // Model has no native tool calling: switch to the text protocol and retry.
        this.removeItem(item);
        this.toolMode = 'text';
        this.modelInfo.tools = false;
        return this.callModel({ note, noTools });
      }
      if (err.code === 'no-thinking' && body.think !== undefined) {
        this.removeItem(item);
        this.modelInfo.thinking = false;
        return this.callModel({ note, noTools });
      }
      // Keep partial output in history so a follow-up has context.
      this.updateItem(item, { streaming: false, text: raw, thinking, stopped: this.signal.aborted });
      if (raw.trim()) this.chat.messages.push({ role: 'assistant', content: raw });
      if (!raw.trim() && !thinking.trim()) this.removeItem(item);
      throw err;
    }
    if (timer) clearTimeout(timer);
    flush();

    const toolNames = new Set(this.tools.map((t) => t.name));
    let calls = noTools ? [] : nativeCalls.map((c) => normalizeNativeCall(c)).filter(Boolean);
    let text = raw;
    if (!noTools && !calls.length && toolNames.size) {
      const parsed = parseTextToolCalls(raw, toolNames);
      if (parsed.calls.length) {
        calls = parsed.calls;
        text = parsed.text;
      }
    } else if (noTools) {
      text = parseTextToolCalls(raw, toolNames).text;
    }

    if (stats?.doneReason === 'length') {
      this.addItem({ type: 'notice', level: 'warn', text: 'The response hit the length limit and was cut off. Consider increasing the context window in Settings.' });
    }

    // History message for the model.
    if (this.toolMode === 'native') {
      const m = { role: 'assistant', content: text };
      if (calls.length) m.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
      this.chat.messages.push(m);
    } else {
      this.chat.messages.push({ role: 'assistant', content: raw });
    }

    if (!text.trim() && !thinking.trim()) {
      this.removeItem(item);
    } else {
      this.updateItem(item, { streaming: false, text: text.trim(), thinking, stats });
    }
    if (!calls.length && !text.trim() && !noTools) {
      this.addItem({ type: 'notice', level: 'warn', text: 'The model returned an empty response.' });
    }
    return { text, calls };
  }

  // ----------------------------------------------------------------- tools

  pushToolResult(call, output, textResults) {
    if (this.toolMode === 'native') {
      this.chat.messages.push({ role: 'tool', content: output, tool_name: call.name });
    } else {
      textResults.push(`<tool_result name="${call.name}">\n${output}\n</tool_result>`);
    }
  }

  flushTextResults(textResults) {
    if (this.toolMode !== 'native' && textResults.length) {
      this.chat.messages.push({ role: 'user', content: textResults.join('\n\n') });
    } else if (this.toolMode === 'native' && textResults.length) {
      // notes for native mode go into the last tool message
      const last = this.chat.messages[this.chat.messages.length - 1];
      if (last?.role === 'tool') last.content += '\n' + textResults.filter((t) => !t.startsWith('<tool_result')).join('\n');
    }
    textResults.length = 0;
  }

  async executeTool(call, textResults) {
    const tool = this.tools.find((t) => t.name === call.name);
    const args = call.arguments || {};
    let summary = '';
    try {
      summary = tool?.summarize ? String(tool.summarize(args) || '') : '';
    } catch {
      summary = '';
    }
    const item = this.addItem({ type: 'tool', name: call.name, category: tool?.category || 'unknown', args: sanitizeArgsForDisplay(args), summary: truncate(summary, 200, '…'), status: 'running' });
    this.toolCallCount++;
    this.status('tool', `${call.name} ${summary}`.trim());

    let result;
    const signature = call.name + ':' + JSON.stringify(args);
    const recent = this.taskState.recentCalls;
    const repeats = recent.filter((s) => s === signature).length;
    recent.push(signature);
    if (recent.length > 8) recent.shift();

    if (!tool) {
      const available = this.tools.map((t) => t.name).join(', ') || 'none';
      const known = this.registry.get(call.name);
      result = {
        ok: false,
        output: known
          ? `The tool "${call.name}" is disabled for this AI profile (${this.persona.name}). Available tools: ${available}.`
          : `Unknown tool "${call.name}". Available tools: ${available}.`,
      };
    } else if (repeats >= 2 && tool.category !== 'plan') {
      result = { ok: false, output: `You already called ${call.name} with exactly these arguments ${repeats} times. Don't repeat it — use the earlier result or try a different approach.` };
    } else if (this.effort.planRequired && !this.planGateUsed && !this.taskState.plan && tool.category === 'edit' && tool.name !== 'create_folder' && this.tools.some((t) => t.name === 'update_plan')) {
      this.planGateUsed = true;
      result = {
        ok: false,
        output: `[Plan required at ${this.effort.label} effort] Before changing files, call update_plan with your step-by-step plan (investigate first if needed). Then continue with the change.`,
      };
    } else {
      try {
        result = await tool.run(args, this.toolContext(item));
      } catch (err) {
        if (err.name === 'AbortError' || this.signal.aborted) {
          this.updateItem(item, { status: 'cancelled' });
          this.pushToolResult(call, 'Cancelled by the user.', textResults);
          throw abortError();
        }
        result = { ok: false, output: `Error: ${err.message}` };
      }
    }

    const ts = this.taskState;
    if (result.changed) {
      ts.changedFiles.add(result.changed);
      ts.unverified = true;
    }
    if (result.command) {
      if (ts.changedFiles.size) ts.unverified = false;
      ts.lastCheckOk = result.ok;
    }
    if (result.rejected && call.name === 'run_command') ts.verifyRejected = true;

    const status = this.signal.aborted ? 'cancelled' : result.rejected ? 'rejected' : result.ok ? 'ok' : 'error';
    this.updateItem(item, {
      status,
      output: truncate(result.output, DISPLAY_OUTPUT_CHARS, '[output truncated in view]'),
      display: result.display || null,
      approval: null,
    });
    this.pushToolResult(call, result.output, textResults);
    if (this.signal.aborted) throw abortError();
  }

  toolContext(item) {
    const root = this.root;
    const workDir = root || this.homeDir || null;
    return {
      root,
      workDir,
      noProject: !root,
      signal: this.signal,
      limits: this.limits,
      settings: this.settings,
      permissions: this.permissions,
      forceApproval: !!this.settings.safeMode && !this.bypass,
      // No project: paths resolve against the home folder and count as outside
      // the project, so each access asks the user first.
      resolve: (p) => (root ? resolveProjectPath(root, p) : resolveOutside(workDir, p)),
      relative: (abs) => (root ? toPosix(path.relative(root, abs)) || '.' : abs),
      approve: (req) => this.approve(req, item),
      recordChange: (c) => this.changeStore.record({ ...c, chatId: this.chat.id }),
      onOutput: (text) => this.emit({ type: 'tool-output', id: item.id, text }),
      terminal: (ev) => this.emit({ type: 'terminal', event: ev }),
      setPlan: (steps) => this.setPlan(steps),
    };
  }

  async approve(req, item) {
    // Bypass mode: the user chose to let the AI act without approval prompts.
    // Changes are still backed up and can be undone from the chat.
    if (this.bypass && !this.signal.aborted) {
      this.updateItem(item, { decision: 'auto' });
      return { approved: true };
    }
    if (req.blanket !== false && this.blanket.has(req.category)) return { approved: true };
    if (this.signal.aborted) return { approved: false };
    const request = { id: uid('ap_'), ...req, itemId: item.id, chatId: this.chat.id };
    this.updateItem(item, { status: 'approval', approval: request });
    this.status('approval', req.title);
    const waitStart = Date.now();
    let res;
    try {
      res = await this.requestApproval(request);
    } finally {
      this.pausedMs += Date.now() - waitStart;
    }
    const approved = res && (res.decision === 'approve' || res.decision === 'approve_all');
    if (approved && res.decision === 'approve_all' && req.blanket !== false) this.blanket.add(req.category);
    this.updateItem(item, { status: 'running', approval: null, decision: approved ? 'approved' : 'rejected' });
    this.status('tool', item.summary);
    return { approved: approved && !this.signal.aborted, feedback: res?.feedback || '' };
  }

  setPlan(steps) {
    this.taskState.plan = steps;
    if (this.planItem && this.chat.items.includes(this.planItem)) {
      this.updateItem(this.planItem, { steps });
    } else {
      this.planItem = this.addItem({ type: 'plan', steps });
    }
    this.status('tool', 'Plan updated');
  }
}

function resolveOutside(base, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A path is required.');
  let p = input.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(require('os').homedir(), p.slice(1));
  const abs = path.resolve(base || process.cwd(), p);
  return { abs, rel: abs, inside: false };
}

function normalizeNativeCall(c) {
  const fn = c?.function || c;
  if (!fn?.name) return null;
  let args = fn.arguments ?? {};
  if (typeof args === 'string') args = tryParseJson(args) || {};
  return { name: fn.name, arguments: args };
}

// Big arguments (file contents) are summarized in the UI; the diff shows the change.
function sanitizeArgsForDisplay(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (typeof v === 'string' && v.length > 2000) out[k] = v.slice(0, 2000) + `… (${v.length} chars)`;
    else out[k] = v;
  }
  return out;
}

module.exports = { AgentRun, effectivePermissions, PERMISSION_MODES };
