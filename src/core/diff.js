'use strict';

// Minimal line diff (LCS on the changed middle region) producing hunks for previews.

function splitLines(text) {
  if (text == null || text === '') return [];
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Returns an array of ops: { type: ' ' | '-' | '+', text, oldNo, newNo }.
 */
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  let middle;
  if (midA.length * midB.length > 4_000_000) {
    middle = [...midA.map((t) => ({ type: '-', text: t })), ...midB.map((t) => ({ type: '+', text: t }))];
  } else {
    middle = lcsDiff(midA, midB);
  }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: ' ', text: a[i] });
  ops.push(...middle);
  for (let i = endA; i < a.length; i++) ops.push({ type: ' ', text: a[i] });
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.type === ' ') {
      op.oldNo = oldNo++;
      op.newNo = newNo++;
    } else if (op.type === '-') {
      op.oldNo = oldNo++;
    } else {
      op.newNo = newNo++;
    }
  }
  return ops;
}

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: '-', text: a[i++] });
    } else {
      ops.push({ type: '+', text: b[j++] });
    }
  }
  while (i < n) ops.push({ type: '-', text: a[i++] });
  while (j < m) ops.push({ type: '+', text: b[j++] });
  return ops;
}

/**
 * Group ops into hunks with `context` unchanged lines around each change.
 * Returns { hunks: [{ lines: ops[] }], added, removed }.
 */
function buildHunks(oldText, newText, context = 3) {
  const ops = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  const changed = [];
  ops.forEach((op, i) => {
    if (op.type === '+') added++;
    if (op.type === '-') removed++;
    if (op.type !== ' ') changed.push(i);
  });
  const hunks = [];
  let current = null;
  for (const idx of changed) {
    const from = Math.max(0, idx - context);
    const to = Math.min(ops.length - 1, idx + context);
    if (current && from <= current.to + 1) {
      current.to = to;
    } else {
      if (current) hunks.push(current);
      current = { from, to };
    }
  }
  if (current) hunks.push(current);
  return {
    added,
    removed,
    hunks: hunks.map((h) => ({ lines: ops.slice(h.from, h.to + 1) })),
  };
}

// Compact unified-diff text (used in tool results so the model sees what changed).
function unifiedDiff(oldText, newText, label = 'file', maxLines = 80) {
  const { hunks } = buildHunks(oldText, newText, 2);
  const out = [`--- ${label}`, `+++ ${label}`];
  for (const h of hunks) {
    const first = h.lines[0];
    out.push(`@@ line ${first.oldNo || first.newNo} @@`);
    for (const l of h.lines) out.push(l.type + l.text);
  }
  if (out.length > maxLines) return out.slice(0, maxLines).join('\n') + `\n... (${out.length - maxLines} more diff lines)`;
  return out.join('\n');
}

module.exports = { diffLines, buildHunks, unifiedDiff, splitLines };
