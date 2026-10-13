'use strict';

// Keeps the conversation inside the model's context window.

const { estimateTokens, headTail } = require('./util');

function messageTokens(m) {
  let t = 6 + estimateTokens(m.content);
  if (m.tool_calls) t += estimateTokens(JSON.stringify(m.tool_calls));
  if (m.images) t += 768 * m.images.length;
  return t;
}

// Strip app-only fields before sending to Ollama.
function toApiMessage(m) {
  const out = { role: m.role, content: m.content || '' };
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
  if (m.tool_name) out.tool_name = m.tool_name;
  if (m.images?.length) out.images = m.images;
  return out;
}

/**
 * Fit messages into `budget` tokens:
 *  1. shrink older tool results,
 *  2. drop the oldest messages (never the latest user request),
 *  3. truncate whatever is still too large.
 * Returns { messages, trimmed }.
 */
function fitMessages(messages, budget) {
  let msgs = messages.map(toApiMessage);
  const total = () => msgs.reduce((s, m) => s + messageTokens(m), 0);
  if (total() <= budget) return { messages: msgs, trimmed: false };

  // 1. compress older tool outputs (keep the most recent 4 messages intact)
  const keepRecent = 4;
  for (let i = 0; i < msgs.length - keepRecent && total() > budget; i++) {
    const m = msgs[i];
    if ((m.role === 'tool' || (m.role === 'user' && m.content.startsWith('<tool_result'))) && m.content.length > 600) {
      msgs[i] = { ...m, content: headTail(m.content, 500, 0.4) + '\n[older output trimmed to save context]' };
    }
  }

  // 2. drop oldest messages, but keep the most recent real user request
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !msgs[i].content.startsWith('<tool_result') && !msgs[i].content.startsWith('[LocalAI]')) {
      lastUser = i;
      break;
    }
  }
  let dropped = 0;
  while (total() > budget && msgs.length > 1) {
    if (lastUser - dropped <= 0) break;
    msgs.shift();
    dropped++;
  }
  // don't start with orphan tool results
  while (msgs.length > 1 && msgs[0].role === 'tool') {
    msgs.shift();
    dropped++;
  }

  // 3. truncate largest messages until it fits
  let guard = 0;
  while (total() > budget && guard++ < 20) {
    let idx = 0;
    msgs.forEach((m, i) => {
      if (messageTokens(m) > messageTokens(msgs[idx])) idx = i;
    });
    const m = msgs[idx];
    const over = (total() - budget) * 3.6;
    const target = Math.max(400, Math.floor(m.content.length - over - 200));
    if (target >= m.content.length) break;
    msgs[idx] = { ...m, content: headTail(m.content, target, 0.3) };
  }

  if (dropped) {
    msgs.unshift({ role: 'user', content: '[LocalAI] Earlier messages in this conversation were removed to fit the context window.' });
    if (msgs[1]?.role === 'user') msgs.splice(1, 0, { role: 'assistant', content: 'Understood.' });
  }
  return { messages: msgs, trimmed: true };
}

/**
 * Character budgets for tool output so a single result can't flood the context.
 */
function toolLimits(numCtx) {
  const chars = Math.floor(numCtx * 3.6);
  return {
    readChars: Math.max(4000, Math.min(60000, Math.floor(chars * 0.3))),
    outputChars: Math.max(3000, Math.min(30000, Math.floor(chars * 0.2))),
  };
}

module.exports = { fitMessages, toolLimits, messageTokens, toApiMessage };
