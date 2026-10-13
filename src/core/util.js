'use strict';

const crypto = require('crypto');

function uid(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// Rough token estimate. Good enough for budgeting a context window.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3.6);
}

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

// Keep the beginning and the end of a long text (errors usually live at the end).
function headTail(text, maxChars, headShare = 0.3) {
  text = String(text || '');
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * headShare);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n... [${omitted} characters omitted] ...\n\n${text.slice(text.length - tail)}`;
}

function truncate(text, maxChars, note = '[truncated]') {
  text = String(text || '');
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n... ${note}`;
}

function isBinaryBuffer(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function abortError(message = 'Stopped by user') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

module.exports = {
  uid,
  estimateTokens,
  stripAnsi,
  headTail,
  truncate,
  isBinaryBuffer,
  detectEol,
  sha256,
  formatBytes,
  abortError,
};
