'use strict';

// Terminal panel: shows output of AI-run commands and lets the user run their own.
(function () {
  const LA = window.LA;
  const { $, h, icon } = LA;
  const MAX_CHARS = 400000;

  let ctx = null;
  let running = false;
  let lastCommand = '';
  let lastOutput = '';
  let lastSource = '';
  const history = [];
  let histIdx = -1;

  function out() {
    return $('#terminalOutput');
  }

  function append(node) {
    const o = out();
    const stick = o.scrollTop + o.clientHeight >= o.scrollHeight - 30;
    o.append(node);
    while (o.textContent.length > MAX_CHARS && o.firstChild) o.firstChild.remove();
    if (stick) o.scrollTop = o.scrollHeight;
  }

  function handleEvent(ev) {
    if (ev.type === 'start') {
      lastCommand = ev.command;
      lastSource = ev.source;
      lastOutput = '';
      if (ev.source === 'user') setRunning(true);
      append(h('div.cmd' + (ev.source === 'ai' ? '.ai' : ''), { text: `> ${ev.command}` }));
      ctx?.onActivity?.();
    } else if (ev.type === 'data') {
      lastOutput = (lastOutput + ev.text).slice(-8000);
      append(document.createTextNode(ev.text));
    } else if (ev.type === 'exit') {
      const ok = ev.code === 0 && !ev.timedOut && !ev.aborted;
      const label = ev.aborted ? 'stopped' : ev.timedOut ? 'timed out' : `exit code ${ev.code}`;
      const line = h('div.' + (ok ? 'exit-ok' : 'exit-bad'), { text: (lastOutput.endsWith('\n') || !lastOutput ? '' : '\n') + `[${label}]` });
      if (!ok && !ev.aborted && lastSource === 'user' && ctx?.onFix) {
        const cmd = lastCommand;
        const output = lastOutput;
        line.append(h('button.btn.small.fix-btn', { text: 'Ask AI to fix', on: { click: () => ctx.onFix(cmd, output, ev.code) } }));
      }
      append(line);
      append(document.createTextNode('\n'));
      if (ev.source === 'user') setRunning(false);
    }
  }

  function setRunning(v) {
    running = v;
    $('#terminalKill').classList.toggle('hidden', !v);
    $('#terminalInput').disabled = v;
    if (!v) $('#terminalInput').focus();
  }

  function toggle(force) {
    const el = $('#terminal');
    const show = force ?? el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    $('#terminalToggle').classList.toggle('active', show);
    if (show) setTimeout(() => $('#terminalInput').focus(), 0);
    ctx?.onToggle?.(show);
    return show;
  }

  function setCwd(p) {
    $('#terminalCwd').textContent = p || 'No project folder (runs in your home folder)';
  }

  function init(c) {
    ctx = c;
    $('#terminalTitle').innerHTML = icon('terminal') + 'Terminal';
    $('#terminalKill').innerHTML = icon('stop');
    $('#terminalClear').innerHTML = icon('trash');
    $('#terminalClose').innerHTML = icon('x');
    $('#terminalKill').classList.add('hidden');
    $('#terminalKill').addEventListener('click', () => window.api.killTerminal());
    $('#terminalClear').addEventListener('click', () => (out().textContent = ''));
    $('#terminalClose').addEventListener('click', () => toggle(false));

    const input = $('#terminalInput');
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && input.value.trim() && !running) {
        const command = input.value.trim();
        history.unshift(command);
        histIdx = -1;
        input.value = '';
        const res = await window.api.runTerminal({ command, cwd: ctx.getCwd() });
        if (res?.error) {
          append(h('div.exit-bad', { text: res.error }));
          setRunning(false);
        }
      } else if (e.key === 'ArrowUp' && history.length) {
        histIdx = Math.min(histIdx + 1, history.length - 1);
        input.value = history[histIdx];
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        histIdx = Math.max(histIdx - 1, -1);
        input.value = histIdx >= 0 ? history[histIdx] : '';
        e.preventDefault();
      }
    });

    // drag to resize
    const handle = $('#terminalResize');
    const panel = $('#terminal');
    try {
      const saved = Number(localStorage.getItem('terminalHeight'));
      if (saved > 100) panel.style.height = saved + 'px';
    } catch {
      /* storage unavailable */
    }
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = panel.offsetHeight;
      const move = (ev) => {
        const hgt = Math.max(110, Math.min(window.innerHeight * 0.7, startH + (startY - ev.clientY)));
        panel.style.height = hgt + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        try {
          localStorage.setItem('terminalHeight', String(panel.offsetHeight));
        } catch {
          /* ignore */
        }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  LA.terminal = { init, handleEvent, toggle, setCwd };
})();
