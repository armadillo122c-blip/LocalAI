'use strict';

// Rendering of chat items: user/assistant messages, tool cards (with diffs and
// approval prompts), plans and notices.
(function () {
  const LA = window.LA;
  const { h, icon, markdown, avatar, escapeHtml } = LA;

  const TOOL_META = {
    list_files: { label: 'List files', icon: 'list' },
    read_file: { label: 'Read', icon: 'file' },
    search_files: { label: 'Search', icon: 'search' },
    write_file: { label: 'Write', icon: 'edit' },
    edit_file: { label: 'Edit', icon: 'edit' },
    delete_file: { label: 'Delete', icon: 'trash' },
    run_command: { label: 'Run', icon: 'terminal' },
    fetch_url: { label: 'Fetch', icon: 'globe' },
    update_plan: { label: 'Plan', icon: 'clipboard' },
  };

  const openState = new Map(); // item id -> bool (user toggled)
  const liveOutput = new Map(); // item id -> streamed command output

  function stripToolMarkup(text) {
    return String(text || '').replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '').trimEnd();
  }

  // ----------------------------------------------------------------- items

  function renderItem(item, ctx) {
    let el;
    switch (item.type) {
      case 'user':
        el = renderUser(item);
        break;
      case 'assistant':
        el = renderAssistant(item, ctx);
        break;
      case 'tool':
        el = renderTool(item, ctx);
        break;
      case 'plan':
        el = renderPlan(item, ctx);
        break;
      case 'notice':
        el = renderNotice(item, ctx);
        break;
      default:
        el = h('div');
    }
    el.dataset.id = item.id;
    return el;
  }

  function renderUser(item) {
    const bubble = h('div.bubble', {}, item.text || '');
    if (item.attachments?.length) {
      bubble.append(
        h(
          'div.attachments',
          {},
          item.attachments.map((a) => h('span.chip', { html: icon(a.kind === 'image' ? 'file' : 'paperclip') }, h('span', { text: a.name }))),
        ),
      );
    }
    return h('div.msg-user', {}, bubble);
  }

  function renderAssistant(item, ctx) {
    const p = item.persona || ctx.persona;
    const el = h('div.msg-ai');
    el.style.setProperty('--pc', p?.color || 'var(--accent)');
    const content = h('div.content');
    const who = h('div.who', {}, p?.name || 'Assistant');
    if (item.stats?.tps) who.append(h('span.stats', { text: `${item.stats.tps} tok/s` }));
    if (item.stopped) who.append(h('span.stats', { text: '(stopped)' }));
    content.append(who);
    if (item.thinking && ctx.showThinking) {
      const det = h('details.thinking', {}, h('summary', { html: icon('bulb') + (item.streaming && !item.text ? 'Thinking…' : 'Thought process') }), h('div.thinking-body', { text: item.thinking.trim() }));
      if (item.streaming && !item.text) det.open = true;
      content.append(det);
    }
    const md = h('div.md');
    const text = stripToolMarkup(item.text);
    md.innerHTML = markdown(text);
    if (item.streaming) {
      const target = md.lastElementChild && !md.lastElementChild.classList.contains('code-block') ? md.lastElementChild : md;
      target.append(h('span.cursor'));
    }
    content.append(md);
    el.append(avatar(p, 'sm'), content);
    return el;
  }

  // ------------------------------------------------------------------ tool

  function defaultOpen(item) {
    if (item.status === 'approval') return true;
    if (item.name === 'run_command') return item.status === 'running' || item.status === 'error';
    if (item.display?.diff && (item.name === 'edit_file' || item.name === 'write_file')) return item.status !== 'rejected';
    return false;
  }

  function renderTool(item, ctx) {
    if (item.name === 'update_plan' && item.status === 'ok') return h('div.hidden');
    const meta = TOOL_META[item.name] || { label: item.name, icon: 'sparkles' };
    const isOpen = openState.has(item.id) ? openState.get(item.id) : defaultOpen(item);
    const danger = item.approval && (item.approval.kind === 'danger' || item.approval.kind === 'outside');
    const el = h('div.tool' + (isOpen ? '.open' : '') + (item.approval ? '.approval' : '') + (danger ? '.danger' : ''));

    const statusEl = h('span.t-status.' + item.status);
    if (item.status === 'running') statusEl.append(h('span.spinner'));
    else if (item.status === 'ok') statusEl.innerHTML = icon('check');
    else if (item.status === 'error') statusEl.innerHTML = icon('x');
    else if (item.status === 'approval') statusEl.innerHTML = icon('alert');
    else statusEl.innerHTML = icon('x');

    const head = h('div.tool-head', {}, statusEl, h('span.t-icon', { html: icon(meta.icon) }), h('span.t-name', { text: meta.label }), h('span.t-sum', { text: item.summary || '', title: item.summary || '' }));
    const d = item.display || {};
    const actions = h('span.tool-actions');
    if (d.diff) {
      if (d.diff.added) actions.append(h('span.tool-badge.add', { text: '+' + d.diff.added }));
      if (d.diff.removed) actions.append(h('span.tool-badge.del', { text: '−' + d.diff.removed }));
    }
    if (item.name === 'run_command' && d.exitCode != null) {
      actions.append(h('span.tool-badge', { text: d.timedOut ? 'timed out' : `exit ${d.exitCode}` }));
    }
    if (item.status === 'rejected') actions.append(h('span.tool-badge', { text: 'rejected' }));
    if (item.status === 'cancelled') actions.append(h('span.tool-badge', { text: 'cancelled' }));
    if (d.change && !d.change.undone) {
      actions.append(
        h('button.btn.small.ghost', {
          html: icon('undo') + 'Undo',
          title: 'Restore the file to how it was before this change',
          on: {
            click: (e) => {
              e.stopPropagation();
              ctx.onUndo(item);
            },
          },
        }),
      );
    }
    if (d.change?.undone) actions.append(h('span.tool-badge.undone', { text: 'undone' }));
    head.append(actions, h('span.chev', { html: icon('chevronRight') }));
    head.addEventListener('click', () => {
      const now = !el.classList.contains('open');
      el.classList.toggle('open', now);
      openState.set(item.id, now);
    });
    el.append(head);

    const body = h('div.tool-body');
    const ap = item.approval;
    if (ap?.diff || d.diff) body.append(renderDiff(ap?.diff || d.diff));
    if (item.name === 'run_command' || item.name === 'fetch_url' || !d.diff) {
      const out = item.status === 'running' || item.status === 'approval' ? liveOutput.get(item.id) || '' : item.output || '';
      if (out || item.status === 'running') {
        const pre = h('pre.tool-output', { text: out || (item.name === 'run_command' ? '' : '…') });
        pre.dataset.live = item.id;
        body.append(pre);
      }
    } else if (item.output && item.status === 'error') {
      body.append(h('pre.tool-output', { text: item.output }));
    }
    if (item.status === 'error' && d.diff && item.output) body.append(h('pre.tool-output', { text: item.output }));
    if (ap) body.append(renderApproval(ap, ctx));
    if (body.childNodes.length) el.append(body);
    return el;
  }

  function renderDiff(diff) {
    const box = h('div.diff');
    let shown = 0;
    const max = 500;
    diff.hunks.forEach((hunk, i) => {
      if (i > 0) box.append(h('div.diff-sep', { text: '⋯' }));
      for (const l of hunk.lines) {
        if (shown++ > max) return;
        const cls = l.type === '+' ? '.add' : l.type === '-' ? '.del' : '';
        box.append(
          h('div.diff-line' + cls, {}, h('span.ln', { text: l.type === '+' ? '' : l.oldNo ?? '' }), h('span.ln', { text: l.type === '-' ? '' : l.newNo ?? '' }), h('span.tx', { text: (l.type === ' ' ? '  ' : l.type + ' ') + l.text })),
        );
      }
    });
    if (shown > max) box.append(h('div.diff-sep', { text: `… ${shown - max} more lines` }));
    if (!diff.hunks.length) box.append(h('div.diff-sep', { text: 'Empty file' }));
    return box;
  }

  const APPROVAL_TEXT = {
    edit: { q: 'Apply this change?', yes: 'Apply', all: 'Apply all edits in this task', no: 'Reject' },
    command: { q: 'Run this command?', yes: 'Run', all: 'Allow all commands in this task', no: 'Deny' },
    danger: { q: 'Potentially dangerous — run anyway?', yes: 'Run anyway', no: 'Deny' },
    delete: { q: 'Delete this file?', yes: 'Delete', no: 'Keep file' },
    outside: { q: 'Allow access outside the project folder?', yes: 'Allow once', no: 'Deny' },
    sensitive: { q: 'Allow reading a sensitive file?', yes: 'Allow', no: 'Deny' },
    web: { q: 'Fetch this URL?', yes: 'Fetch', all: 'Allow web access in this task', no: 'Deny' },
  };

  function renderApproval(ap, ctx) {
    const t = APPROVAL_TEXT[ap.kind] || APPROVAL_TEXT.command;
    const box = h('div.approval-box');
    box.append(h('div.q', { html: icon('alert') + escapeHtml(ap.kind === 'outside' && ap.title ? ap.title : t.q) }));
    if (ap.reasons?.length) box.append(h('ul.reasons', {}, ap.reasons.map((r) => h('li', { text: r }))));
    if (ap.message) box.append(h('div.msg', { text: ap.message }));
    if (ap.command) {
      box.append(h('div.cmd', { text: ap.command }));
      if (ap.cwd && ap.cwd !== '.') box.append(h('div.msg', { text: `in ${ap.cwd}` }));
    }
    if (ap.url) box.append(h('div.cmd', { text: ap.url }));
    const feedback = h('input.feedback', { placeholder: 'Optional: tell the AI what to do instead' });
    const decide = (decision) => {
      box.querySelectorAll('button').forEach((b) => (b.disabled = true));
      ctx.onApprove(ap, decision, feedback.value.trim());
    };
    const buttons = h('div.buttons');
    buttons.append(h('button.btn.' + (ap.kind === 'danger' || ap.kind === 'delete' || ap.kind === 'outside' ? 'danger' : 'primary'), { text: t.yes, on: { click: () => decide('approve') } }));
    if (t.all && ap.blanket !== false) buttons.append(h('button.btn', { text: t.all, on: { click: () => decide('approve_all') } }));
    buttons.append(h('button.btn', { text: t.no, on: { click: () => decide('reject') } }));
    buttons.append(feedback);
    feedback.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') decide('reject');
    });
    box.append(buttons);
    return box;
  }

  // --------------------------------------------------------------- plan etc

  function renderPlan(item, ctx) {
    const steps = item.steps || [];
    const done = steps.filter((s) => s.status === 'done').length;
    const bar = h('div.plan-progress', {}, h('div', { style: { width: `${steps.length ? (done / steps.length) * 100 : 0}%` } }));
    return h(
      'div.plan' + (ctx.running ? '' : '.idle'),
      {},
      h('div.plan-head', { html: icon('clipboard') + 'Plan' }, bar, h('span.faint', { text: `${done}/${steps.length}` })),
      h(
        'ol',
        {},
        steps.map((s) => h('li.' + s.status, {}, h('span.box', { html: s.status === 'done' ? icon('check') : '' }), h('span', { text: s.text }))),
      ),
    );
  }

  function renderNotice(item, ctx) {
    if (item.level === 'error') {
      const el = h('div.notice.error', {}, h('div.err-title', { html: icon('alert') + escapeHtml(item.text) }));
      if (item.hint) el.append(h('div.hint', { html: markdown(item.hint) }));
      const actions = h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' } });
      if (item.code === 'unreachable' || item.code === 'bad-url') actions.append(h('button.btn.small', { text: 'Open settings', on: { click: () => ctx.onOpenSettings() } }));
      if (ctx.canRetry) actions.append(h('button.btn.small', { text: 'Retry', on: { click: () => ctx.onRetry() } }));
      if (actions.childNodes.length) el.append(actions);
      return el;
    }
    const el = h('div.notice.' + (item.level || 'info'), { html: icon(item.level === 'warn' ? 'alert' : 'info') }, h('span', { text: item.text }));
    if (item.action === 'continue' && ctx.isLast(item)) {
      el.append(h('button.btn.small', { text: 'Continue', on: { click: () => ctx.onContinue() } }));
    }
    return el;
  }

  // ---------------------------------------------------- streaming updates

  function appendLiveOutput(id, text) {
    const prev = liveOutput.get(id) || '';
    const next = (prev + text).slice(-60000);
    liveOutput.set(id, next);
    const pre = document.querySelector(`pre[data-live="${id}"]`);
    if (pre) {
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = next;
      if (stick) pre.scrollTop = pre.scrollHeight;
    }
  }

  function clearLive(id) {
    liveOutput.delete(id);
  }

  LA.chat = { renderItem, appendLiveOutput, clearLive, stripToolMarkup, TOOL_META };
})();
