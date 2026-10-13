'use strict';

// Generic UI helpers: element builder, toasts, popovers, modals, confirm dialogs.
(function () {
  const LA = window.LA;
  const { icon, escapeHtml } = LA;

  const $ = (sel, root = document) => root.querySelector(sel);

  /** h('div.cls#id', { attrs, on: {click} }, children...) */
  function h(tag, props = {}, ...children) {
    const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9]+)?(.*)$/i);
    const el = document.createElement(name);
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function iconEl(name, cls) {
    const span = document.createElement('span');
    span.style.display = 'contents';
    span.innerHTML = icon(name, cls);
    return span.firstChild;
  }

  function toast(message, type = 'info', ms = 3500) {
    const t = h('div.toast.' + type, { text: message });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), ms);
  }

  // ------------------------------------------------------------- popover

  let openPopover = null;
  function closePopover() {
    if (openPopover) {
      openPopover.el.remove();
      document.removeEventListener('mousedown', openPopover.outside, true);
      document.removeEventListener('keydown', openPopover.key, true);
      openPopover.onClose?.();
      openPopover = null;
    }
  }

  /** Show a popover anchored to `anchor`. placement: 'top' | 'bottom' */
  function popover(anchor, content, { placement = 'top', align = 'left', onClose, width } = {}) {
    const wasSame = openPopover && openPopover.anchor === anchor;
    closePopover();
    if (wasSame) return null;
    const el = h('div.popover', {}, content);
    if (width) el.style.width = width + 'px';
    $('#popoverRoot').append(el);
    const r = anchor.getBoundingClientRect();
    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    let left = align === 'right' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = placement === 'top' ? r.top - ph - 8 : r.bottom + 6;
    if (top < 8) top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    const outside = (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
    };
    const key = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePopover();
      }
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', key, true);
    openPopover = { el, anchor, outside, key, onClose };
    return el;
  }

  // --------------------------------------------------------------- modal

  function modal(el, { onClose } = {}) {
    const backdrop = h('div.modal-backdrop', {}, el);
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', key, true);
      onClose?.();
    };
    const key = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.popover')) {
        e.stopPropagation();
        close();
      }
    };
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    document.addEventListener('keydown', key, true);
    $('#modalRoot').append(backdrop);
    return close;
  }

  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        close();
        resolve(v);
      };
      const box = h(
        'div.modal.small',
        {},
        h('h3', { style: { margin: 0, fontSize: '15px' }, text: title }),
        h('div', { class: 'dim', style: { whiteSpace: 'pre-wrap', fontSize: '13px' }, text: message }),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' } },
          h('button.btn', { text: 'Cancel', on: { click: () => finish(false) } }),
          h('button.btn' + (danger ? '.danger' : '.primary'), { text: confirmText, on: { click: () => finish(true) } }),
        ),
      );
      const close = modal(box, { onClose: () => finish(false) });
      setTimeout(() => box.querySelector('.btn.primary, .btn.danger')?.focus(), 0);
    });
  }

  function promptDialog({ title, value = '', confirmText = 'Save' }) {
    return new Promise((resolve) => {
      let done = false;
      const input = h('input.input', { value });
      const finish = (v) => {
        if (done) return;
        done = true;
        close();
        resolve(v);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value.trim());
      });
      const box = h(
        'div.modal.small',
        {},
        h('h3', { style: { margin: 0, fontSize: '15px' }, text: title }),
        input,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
          h('button.btn', { text: 'Cancel', on: { click: () => finish(null) } }),
          h('button.btn.primary', { text: confirmText, on: { click: () => finish(input.value.trim()) } }),
        ),
      );
      const close = modal(box, { onClose: () => finish(null) });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    });
  }

  // ---------------------------------------------------------- formatting

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
    return (n / 1e3).toFixed(0) + ' KB';
  }

  function relativeTime(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    if (d < 604800000) return Math.floor(d / 86400000) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function basename(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
  }

  function avatar(persona, size = '') {
    const el = h('div.avatar' + (size ? '.' + size : ''), { html: icon(persona?.icon || 'sparkles') });
    el.style.setProperty('--pc', persona?.color || 'var(--accent)');
    return el;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success', 1500);
    } catch {
      toast('Could not copy', 'error');
    }
  }

  Object.assign(LA, { $, h, iconEl, toast, popover, closePopover, modal, confirmDialog, promptDialog, formatDuration, formatBytes, relativeTime, basename, avatar, copyText, escapeHtml });
})();
