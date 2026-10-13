'use strict';

// Parsing of tool calls written as text, for models without native tool calling
// (and for models that sometimes print tool calls instead of using the API).

function tryParseJson(text) {
  const attempts = [text, text.replace(/,\s*([}\]])/g, '$1')];
  for (const t of attempts) {
    try {
      return JSON.parse(t);
    } catch {
      /* next */
    }
  }
  return null;
}

function normalizeCall(obj, toolNames) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  const name = fn.name || fn.tool || fn.tool_name;
  if (typeof name !== 'string' || !toolNames.has(name)) return null;
  let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
  if (typeof args === 'string') args = tryParseJson(args) || {};
  return { name, arguments: args && typeof args === 'object' ? args : {} };
}

/**
 * Extract tool calls from model text.
 * Supports <tool_call>{...}</tool_call>, fenced ```json blocks and a bare JSON object reply.
 * Returns { calls, text } where text has the tool-call markup removed.
 */
function parseTextToolCalls(content, toolNames) {
  const names = toolNames instanceof Set ? toolNames : new Set(toolNames);
  const calls = [];
  let text = String(content || '');

  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g, (match, inner) => {
    const body = inner.replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = tryParseJson(body);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const found = list.map((o) => normalizeCall(o, names)).filter(Boolean);
    if (found.length) {
      calls.push(...found);
      return '';
    }
    return match;
  });

  if (!calls.length) {
    text = text.replace(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g, (match, inner) => {
      const parsed = tryParseJson(inner.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const found = list.map((o) => normalizeCall(o, names)).filter(Boolean);
      if (found.length && found.length === list.length) {
        calls.push(...found);
        return '';
      }
      return match;
    });
  }

  if (!calls.length) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = tryParseJson(trimmed);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const found = list.map((o) => normalizeCall(o, names)).filter(Boolean);
      if (found.length && found.length === list.length) {
        calls.push(...found);
        text = '';
      }
    }
  }
  return { calls, text: text.replace(/\n{3,}/g, '\n\n').trim() };
}

// Split a leading <think>...</think> block out of streamed content
// (reasoning models that inline their thinking instead of using the `thinking` field).
class ThinkSplitter {
  constructor() {
    this.state = 'start'; // start | think | content
    this.pending = '';
  }

  push(chunk) {
    let content = '';
    let thinking = '';
    let s = this.pending + chunk;
    this.pending = '';
    if (this.state === 'start') {
      const t = s.trimStart();
      if (t.startsWith('<think>')) {
        this.state = 'think';
        s = t.slice(7);
      } else if ('<think>'.startsWith(t)) {
        this.pending = s; // could still become <think>
        return { content, thinking };
      } else {
        this.state = 'content';
      }
    }
    if (this.state === 'think') {
      const end = s.indexOf('</think>');
      if (end === -1) {
        const keep = partialSuffix(s, '</think>');
        thinking += s.slice(0, s.length - keep);
        this.pending = s.slice(s.length - keep);
        return { content, thinking };
      }
      thinking += s.slice(0, end);
      s = s.slice(end + 8).replace(/^\s+/, '');
      this.state = 'content';
    }
    content += s;
    return { content, thinking };
  }

  flush() {
    const rest = this.pending;
    this.pending = '';
    return this.state === 'think' ? { content: '', thinking: rest } : { content: rest, thinking: '' };
  }
}

function partialSuffix(s, tag) {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

module.exports = { parseTextToolCalls, ThinkSplitter, tryParseJson };
