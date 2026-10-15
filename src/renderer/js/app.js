'use strict';

// Main UI controller: state, sidebar, selectors, chat thread, composer.
(function () {
  const LA = window.LA;
  const api = window.api;
  const { $, h, icon, toast, popover, closePopover, confirmDialog, promptDialog, avatar, basename, relativeTime, formatDuration, formatBytes } = LA;

  const state = {
    info: null,
    settings: null,
    ollama: { ok: null },
    models: [],
    modelInfo: {},
    project: null,
    chats: [],
    chat: null, // { id, title, projectPath, items }
    running: null, // chatId of the active run
    status: null,
    attachments: [],
    pendingSend: false,
  };
  LA.state = state;

  // ------------------------------------------------------------- helpers

  const persona = () => state.settings.personas.find((p) => p.id === state.settings.personaId) || state.settings.personas[0];
  const effortDef = (id) => state.info.efforts.find((e) => e.id === id) || state.info.efforts[2];
  const effortLimits = (id) => state.settings.effortLimits[id] || effortDef(id);
  const modelFor = (p) => (p && p.model) || state.settings.model;

  async function saveSettings(patch) {
    const res = await api.saveSettings(patch);
    if (res?.error) {
      toast(res.error, 'error');
      return state.settings;
    }
    state.settings = res;
    return res;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme;
  }

  function newChatId() {
    const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
    return 'chat_' + Date.now().toString(36) + rand;
  }

  // ---------------------------------------------------------------- ollama

  let statusTimer = null;
  async function refreshOllama({ quiet = true } = {}) {
    const st = await api.ollamaStatus();
    const wasOk = state.ollama.ok;
    state.ollama = st;
    if (st.ok) {
      const models = await api.listModels();
      state.models = Array.isArray(models) ? models : [];
      if (state.models.length && !state.models.some((m) => m.name === state.settings.model)) {
        const preferred = state.models.find((m) => /coder|code|qwen|llama3|deepseek|mistral|gemma/i.test(m.name)) || state.models[0];
        await saveSettings({ model: preferred.name });
      }
      await loadModelInfo(modelFor(persona()));
      if (!quiet && wasOk === false) toast('Connected to Ollama', 'success');
    }
    renderOllamaStatus();
    renderBanner();
    renderModelChip();
    renderSelectors();
    if (!state.chat?.items?.length) renderThread();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => refreshOllama(), st.ok ? 30000 : 6000);
  }

  async function loadModelInfo(name) {
    if (!name || state.modelInfo[name]) return state.modelInfo[name];
    const info = await api.modelInfo(name);
    if (info && !info.error) state.modelInfo[name] = info;
    return state.modelInfo[name];
  }

  function renderOllamaStatus() {
    const el = $('#ollamaStatus');
    const st = state.ollama;
    el.innerHTML = '';
    el.append(h('span.status-dot' + (st.ok ? '.ok' : st.ok === false ? '.bad' : '')), h('span', { text: st.ok ? `Ollama ${st.version} · ${state.models.length} model${state.models.length === 1 ? '' : 's'}` : st.ok === false ? 'Ollama not running' : 'Checking Ollama…' }));
    el.title = st.ok ? `Connected to ${st.url}` : st.error || '';
  }

  function renderBanner() {
    const root = $('#banner');
    root.innerHTML = '';
    const st = state.ollama;
    if (st.ok === false) {
      root.append(
        h(
          'div.banner.error',
          { html: icon('alert') },
          h(
            'div.body',
            {},
            h('div.title', { text: `Can't reach Ollama at ${st.url}` }),
            h('div', { text: 'Start Ollama (open the Ollama app from the Start menu, or run "ollama serve" in a terminal). LocalAI reconnects automatically.' }),
            h(
              'div.actions',
              {},
              h('button.btn.small', { html: icon('refresh') + 'Retry now', on: { click: () => refreshOllama({ quiet: false }) } }),
              h('button.btn.small', { text: 'Change URL', on: { click: () => LA.settings.open('general') } }),
              h('button.btn.small.ghost', { html: icon('external') + 'Download Ollama', on: { click: () => api.openExternal('https://ollama.com/download') } }),
            ),
          ),
        ),
      );
    } else if (st.ok && !state.models.length) {
      root.append(
        h(
          'div.banner.warn',
          { html: icon('info') },
          h(
            'div.body',
            {},
            h('div.title', { text: 'No models installed yet' }),
            h('div', { html: 'Open a terminal and download a coding model, for example <code class="mono">ollama pull qwen2.5-coder:7b</code> (≈4.7 GB, good for 16 GB RAM) or <code class="mono">ollama pull qwen3:8b</code>. Then press Refresh.' }),
            h('div.actions', {}, h('button.btn.small', { html: icon('refresh') + 'Refresh', on: { click: () => refreshOllama({ quiet: false }) } })),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------- sidebar

  async function setProject(p, { newChat = true } = {}) {
    if (p) {
      const res = await api.setProject(p);
      if (res?.error) {
        toast(res.error, 'error');
        await api.removeRecentProject(p).then((s) => !s?.error && (state.settings = s));
        renderProjects();
        return;
      }
      state.settings = res;
    } else {
      state.settings = await api.setProject(null);
    }
    state.project = p || null;
    LA.terminal.setCwd(state.project);
    renderProjects();
    await refreshChats();
    if (newChat) startNewChat();
  }

  async function pickProject() {
    const res = await api.pickProject();
    if (!res || res.error) return res?.error && toast(res.error, 'error');
    state.settings = res.settings;
    await setProject(res.path);
  }

  function renderProjects() {
    const cur = $('#currentProject');
    cur.innerHTML = '';
    if (state.project) {
      cur.append(
        h(
          'div.project-card',
          { title: state.project },
          h('span', { html: icon('folder') }),
          h('div.meta', {}, h('div.name', { text: basename(state.project) }), h('div.path', { text: state.project })),
          h('button.icon-btn', { html: icon('external'), title: 'Show in file explorer', on: { click: () => api.revealProject(state.project) } }),
          h('button.icon-btn', { html: icon('x'), title: 'Close project', on: { click: () => setProject(null) } }),
        ),
      );
    } else {
      cur.append(h('div.project-empty', {}, 'No folder open. ', h('a', { href: '#', text: 'Open a project', on: { click: (e) => (e.preventDefault(), pickProject()) } }), ' to let the AI work on files.'));
    }
    const list = $('#recentProjects');
    list.innerHTML = '';
    for (const p of state.settings.recentProjects.filter((x) => x !== state.project).slice(0, 6)) {
      list.append(
        h(
          'div.list-item',
          { title: p, on: { click: () => setProject(p) } },
          h('span', { html: icon('folder') }),
          h('span.label', { text: basename(p) }),
          h('button.icon-btn.item-action', {
            html: icon('x'),
            title: 'Remove from recent',
            on: {
              click: async (e) => {
                e.stopPropagation();
                state.settings = await api.removeRecentProject(p);
                renderProjects();
              },
            },
          }),
        ),
      );
    }
  }

  async function refreshChats() {
    const list = await api.listChats();
    state.chats = Array.isArray(list) ? list : [];
    renderChatList();
  }

  function renderChatList() {
    const root = $('#chatList');
    root.innerHTML = '';
    if (!state.chats.length) {
      root.append(h('div.list-empty', { text: 'No chats yet' }));
      return;
    }
    for (const c of state.chats) {
      const p = state.settings.personas.find((x) => x.id === c.personaId);
      const where = c.projectPath ? basename(c.projectPath) : 'No project';
      const item = h(
        'div.list-item' + (state.chat?.id === c.id ? '.active' : ''),
        { title: `${c.title}\n${where} · ${relativeTime(c.updatedAt)}`, on: { click: () => openChat(c.id), dblclick: () => renameChat(c) } },
        state.running === c.id ? h('span.dot-running') : h('span', { html: icon(p?.icon || 'chat'), style: { color: p?.color || '' } }),
        h('span.label', {}, c.title, h('span.chat-where', { text: where })),
        h('button.icon-btn.item-action', {
          html: icon('trash'),
          title: 'Delete chat',
          on: {
            click: async (e) => {
              e.stopPropagation();
              if (!(await confirmDialog({ title: 'Delete chat?', message: `"${c.title}" will be deleted. File changes made in this chat are not affected.`, confirmText: 'Delete', danger: true }))) return;
              const res = await api.deleteChat(c.id);
              if (res?.error) return toast(res.error, 'error');
              if (state.chat?.id === c.id) startNewChat();
              refreshChats();
            },
          },
        }),
      );
      root.append(item);
    }
  }

  async function renameChat(c) {
    const title = await promptDialog({ title: 'Rename chat', value: c.title });
    if (!title) return;
    await api.renameChat(c.id, title);
    if (state.chat?.id === c.id) {
      state.chat.title = title;
      renderTitle();
    }
    refreshChats();
  }

  // ----------------------------------------------------------- selectors

  function renderModelChip() {
    const chip = $('#modelChip');
    const name = state.settings.model;
    chip.innerHTML = icon('cpu');
    chip.append(h('span.name', { text: name || (state.ollama.ok ? 'Select a model' : 'No model') }), h('span', { html: icon('chevronDown', 'chev') }));
  }

  function capabilityBadges(info) {
    if (!info) return [];
    const out = [];
    out.push(h('span.badge' + (info.tools ? '.on' : ''), { text: info.tools ? 'tools' : 'no native tools', title: info.tools ? 'Supports native tool calling' : 'Uses text-based tool calls (compatibility mode)' }));
    if (info.thinking) out.push(h('span.badge.accent', { text: 'reasoning' }));
    if (info.vision) out.push(h('span.badge', { text: 'vision' }));
    return out;
  }

  async function openModelPicker() {
    const anchor = $('#modelChip');
    const box = h('div');
    box.append(h('div.pop-title', { text: 'Ollama model · shared by all AIs' }));
    if (!state.models.length) {
      box.append(h('div.pop-foot', { text: state.ollama.ok ? 'No models installed. Run: ollama pull qwen2.5-coder:7b' : 'Ollama is not running.' }));
    }
    for (const m of state.models) {
      const info = state.modelInfo[m.name];
      const row = h(
        'div.pop-item' + (m.name === state.settings.model ? '.selected' : ''),
        {
          on: {
            click: async () => {
              closePopover();
              await saveSettings({ model: m.name });
              await loadModelInfo(m.name);
              renderModelChip();
              renderSelectors();
              if (!state.chat?.items?.length) renderThread();
            },
          },
        },
        h('span', { html: icon('cpu') }),
        h(
          'div.pi-main',
          {},
          h('div.pi-name.mono', { text: m.name }),
          h('div.pi-meta', { text: [m.parameterSize, m.quantization, formatBytes(m.size)].filter(Boolean).join(' · ') }),
          h('div', { style: { display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' } }, capabilityBadges(info)),
        ),
        m.name === state.settings.model ? h('span.check', { html: icon('check') }) : null,
      );
      box.append(row);
    }
    box.append(
      h('div.pop-sep'),
      h('div.pop-item', { on: { click: () => (closePopover(), refreshOllama({ quiet: false })) } }, h('span', { html: icon('refresh') }), h('div.pi-main', {}, h('div.pi-name', { text: 'Refresh models' }))),
      h('div.pop-foot', { html: icon('info') + '<span>Every AI persona runs on this model — switching AIs never downloads anything. Install more with <code class="mono">ollama pull &lt;name&gt;</code>.</span>' }),
    );
    popover(anchor, box, { placement: 'bottom', align: 'right', width: 380 });
    // load capability badges lazily
    let changed = false;
    for (const m of state.models) {
      if (!state.modelInfo[m.name]) {
        await loadModelInfo(m.name);
        changed = true;
      }
    }
    if (changed && document.querySelector('.popover') && box.isConnected) {
      closePopover();
      openModelPicker();
    }
  }

  // --------------------------------------------------------- permissions

  const PERM_MODES = [
    { id: 'default', label: 'Ask', icon: 'lock', desc: 'Asks before file changes and risky commands (per AI settings).' },
    { id: 'acceptEdits', label: 'Accept edits', icon: 'edit', desc: 'Applies file changes without asking. Still asks before risky commands, deletes and anything outside the project.' },
    { id: 'plan', label: 'Plan', icon: 'clipboard', desc: 'Read-only: explores your code and writes a plan. Changes nothing, runs nothing.' },
    { id: 'bypass', label: 'Bypass permissions', icon: 'alert', desc: 'Does everything without asking: edits, deletes, any command, web access, files anywhere. Changes are still backed up and can be undone.' },
  ];
  const permDef = (id) => PERM_MODES.find((m) => m.id === id) || PERM_MODES[0];

  function renderPermSelector() {
    const m = permDef(state.settings.permissionMode);
    const el = $('#permSelector');
    el.className = `selector perm perm-${m.id}`;
    el.innerHTML = icon(m.icon);
    el.append(h('span.label', { text: m.label }), h('span', { html: icon('chevronDown', 'chev') }));
    el.title = `${m.label} — ${m.desc} (Shift+Tab to switch)`;
  }

  async function setPermissionMode(id) {
    if (id === 'bypass' && state.settings.permissionMode !== 'bypass') {
      const ok = await confirmDialog({
        title: 'Bypass all permissions?',
        message: 'The AI will edit and delete files anywhere, run any command and use the internet without asking you first.\n\nFile changes are still backed up and can be undone from the chat, but command effects (installs, deletions by commands, git pushes…) cannot be undone.',
        confirmText: 'Bypass permissions',
        danger: true,
      });
      if (!ok) return;
    }
    await saveSettings({ permissionMode: id });
    renderPermSelector();
    if (state.running) toast(`${permDef(id).label} applies from your next message`, 'info', 2000);
  }

  function openPermPicker() {
    const box = h('div');
    box.append(h('div.pop-title', { text: 'Permissions' }));
    for (const m of PERM_MODES) {
      box.append(
        h(
          'div.pop-item' + (m.id === state.settings.permissionMode ? '.selected' : ''),
          { on: { click: () => (closePopover(), setPermissionMode(m.id)) } },
          h('span', { html: icon(m.icon), style: { color: m.id === 'bypass' ? 'var(--red)' : '', display: 'grid', marginTop: '2px' } }),
          h('div.pi-main', {}, h('div.pi-name', { text: m.label }), h('div.pi-desc', { text: m.desc })),
          m.id === state.settings.permissionMode ? h('span.check', { html: icon('check') }) : null,
        ),
      );
    }
    box.append(h('div.pop-foot', { html: icon('info') + '<span>Shift+Tab in the message box switches between Ask, Accept edits and Plan.</span>' }));
    popover($('#permSelector'), box, { placement: 'top', width: 380 });
  }

  function renderSelectors() {
    renderPermSelector();
    const p = persona();
    const ps = $('#personaSelector');
    ps.innerHTML = '';
    ps.append(avatar(p, 'sm'), h('span.label', { text: p.name }), h('span', { html: icon('chevronDown', 'chev') }));
    ps.title = `${p.name} — ${p.tagline}`;

    const e = effortDef(state.settings.effort);
    const idx = state.info.efforts.findIndex((x) => x.id === e.id);
    const es = $('#effortSelector');
    es.innerHTML = '';
    es.append(h('span.effort-meter' + (e.id === 'max' ? '.max' : ''), {}, [0, 1, 2, 3, 4].map((i) => h('i' + (i <= idx ? '.on' : '')))), h('span.label', { text: e.label }), h('span', { html: icon('chevronDown', 'chev') }));
    es.title = `Effort: ${e.label} — ${e.summary}`;

    const model = modelFor(p);
    $('#poweredBy').innerHTML = model ? icon('cpu') + `<span>on ${LA.escapeHtml(model)}</span>` : '';
    $('#poweredBy').title = model ? `${p.name} is powered by the Ollama model ${model}` : '';
  }

  function openPersonaPicker() {
    const box = h('div');
    box.append(h('div.pop-title', { text: 'AI lineup' }));
    for (const p of state.settings.personas) {
      const eff = effortDef(p.defaultEffort);
      box.append(
        h(
          'div.pop-item' + (p.id === state.settings.personaId ? '.selected' : ''),
          { on: { click: () => (closePopover(), selectPersona(p.id)) } },
          avatar(p, 'sm'),
          h(
            'div.pi-main',
            {},
            h('div.pi-name', {}, p.name, p.builtin ? null : h('span.badge', { text: 'custom' })),
            h('div.pi-desc', { text: p.tagline || p.description }),
            h('div.pi-meta', { text: `${p.personality ? p.personality + ' · ' : ''}${eff.label} effort · ${modelFor(p) || 'no model'}${p.model ? ' (own model)' : ''}` }),
          ),
          p.id === state.settings.personaId ? h('span.check', { html: icon('check') }) : null,
        ),
      );
    }
    box.append(
      h('div.pop-sep'),
      h('div.pop-item', { on: { click: () => (closePopover(), LA.settings.open('personas')) } }, h('span', { html: icon('sliders') }), h('div.pi-main', {}, h('div.pi-name', { text: 'Manage AIs…' }), h('div.pi-desc', { text: 'Edit prompts, permissions and behavior, or create your own' }))),
    );
    popover($('#personaSelector'), box, { placement: 'top', width: 400 });
  }

  async function selectPersona(id) {
    const p = state.settings.personas.find((x) => x.id === id);
    if (!p) return;
    await saveSettings({ personaId: id, effort: p.defaultEffort });
    await loadModelInfo(modelFor(p));
    renderSelectors();
    if (!state.chat?.items?.length) renderThread();
    toast(`${p.name} · ${effortDef(p.defaultEffort).label} effort`, 'info', 1600);
  }

  function openEffortPicker() {
    const info = state.modelInfo[modelFor(persona())];
    const box = h('div');
    box.append(h('div.pop-title', { text: 'Effort' }));
    state.info.efforts.forEach((e, i) => {
      const lim = effortLimits(e.id);
      const extras = [e.planRequired ? 'plan required' : null, e.verifyRetries ? `verify ×${e.verifyRetries}` : null, e.selfReview ? 'self-review' : null, info?.thinking && e.think === 'on' ? 'reasoning on' : null].filter(Boolean);
      box.append(
        h(
          'div.pop-item' + (e.id === state.settings.effort ? '.selected' : ''),
          {
            on: {
              click: async () => {
                closePopover();
                await saveSettings({ effort: e.id });
                renderSelectors();
                if (!state.chat?.items?.length) renderThread();
              },
            },
          },
          h('span.effort-meter' + (e.id === 'max' ? '.max' : ''), { style: { marginTop: '4px' } }, [0, 1, 2, 3, 4].map((j) => h('i' + (j <= i ? '.on' : '')))),
          h(
            'div.pi-main',
            {},
            h('div.pi-name', {}, e.label, e.id === 'medium' ? h('span.badge', { text: 'default' }) : null, e.id === persona().defaultEffort && e.id !== 'medium' ? h('span.badge.accent', { text: `${persona().name} default` }) : null),
            h('div.pi-desc', { text: e.summary }),
            h('div.pi-meta', { text: `${lim.maxSteps} steps · ${lim.maxMinutes} min${extras.length ? ' · ' + extras.join(' · ') : ''}` }),
          ),
          e.id === state.settings.effort ? h('span.check', { html: icon('check') }) : null,
        ),
      );
    });
    const model = modelFor(persona());
    const note = !info
      ? 'Model capabilities unknown until Ollama is connected.'
      : info.thinking
        ? `${model} has a reasoning mode: High and Maximum turn it on, Instant and Low turn it off.`
        : `${model} has no built-in reasoning mode, so effort works through planning, step budgets and enforced verification — not hidden reasoning.`;
    box.append(
      h('div.pop-sep'),
      h('div.pop-foot', { html: icon('info') + `<span>${LA.escapeHtml(note)}</span>` }),
      h('div.pop-item', { on: { click: () => (closePopover(), LA.settings.open('effort')) } }, h('span', { html: icon('sliders') }), h('div.pi-main', {}, h('div.pi-name', { text: 'Configure limits…' }))),
    );
    popover($('#effortSelector'), box, { placement: 'top', width: 400 });
  }

  // --------------------------------------------------------------- thread

  const thread = () => $('#thread');
  const messages = () => $('#messages');

  function itemCtx() {
    return {
      persona: persona(),
      running: !!state.chat && state.running === state.chat.id,
      showThinking: state.settings.showThinking,
      onApprove: (ap, decision, feedback) => api.approve({ id: ap.id, decision, feedback }),
      onUndo: undoChange,
      onContinue: () => send('Continue where you left off.'),
      onOpenSettings: () => LA.settings.open('general'),
      canRetry: !state.running,
      onRetry: () => {
        const last = [...state.chat.items].reverse().find((i) => i.type === 'user');
        if (last) send(last.text);
      },
      isLast: (item) => state.chat.items[state.chat.items.length - 1] === item && !state.running,
    };
  }

  function nearBottom() {
    const m = messages();
    return m.scrollTop + m.clientHeight >= m.scrollHeight - 120;
  }

  function scrollToBottom(force = false) {
    const m = messages();
    if (force || nearBottom()) m.scrollTop = m.scrollHeight;
  }

  function renderTitle() {
    const t = $('#chatTitle');
    t.innerHTML = '';
    t.append(document.createTextNode(state.chat?.title || 'New chat'));
    t.append(h('span.sub', { text: state.project ? basename(state.project) : 'No project · home folder' }));
  }

  function renderThread() {
    renderTitle();
    const root = thread();
    root.innerHTML = '';
    if (!state.chat || !state.chat.items.length) {
      root.append(renderWelcome());
      return;
    }
    const ctx = itemCtx();
    for (const item of state.chat.items) root.append(LA.chat.renderItem(item, ctx));
    scrollToBottom(true);
  }

  function rerenderItem(item) {
    const old = thread().querySelector(`[data-id="${item.id}"]`);
    const el = LA.chat.renderItem(item, itemCtx());
    if (old) old.replaceWith(el);
    else thread().append(el);
  }

  function rerenderNotices() {
    for (const item of state.chat?.items || []) {
      if (item.type === 'plan' || (item.type === 'notice' && (item.action || item.level === 'error'))) rerenderItem(item);
    }
  }

  const SUGGESTIONS = {
    default: [
      ['Explain this project', 'Give me an overview of this project: structure, main parts and how to run it.'],
      ['Find and fix bugs', 'Look for bugs in this project, fix the most important ones and verify the fixes.'],
      ['Write tests', 'Add tests for the most important functions and run them.'],
      ['Build & run', 'Build and run this project, then fix any errors you hit.'],
    ],
    blocksmith: [
      ['New Paper plugin', 'Create a Paper plugin with a /heal command and a join message. Set up the Gradle build.'],
      ['Skript script', 'Write a Skript script for a simple /spawn command with a cooldown.'],
      ['Fix build errors', 'Run the Gradle build and fix any compile errors for this Minecraft version.'],
      ['Server tuning', 'Review my server config files and suggest performance improvements.'],
    ],
    bugzero: [
      ['Fix failing tests', 'Run the tests, find the root cause of every failure and fix it.'],
      ['Debug an error', 'I get this error: <paste it here>. Find the cause and fix it.'],
      ['Crash on startup', 'The app crashes on startup. Reproduce it and fix it.'],
      ['Hunt bugs', 'Look for likely bugs and edge cases in the main code paths.'],
    ],
    architect: [
      ['Architecture overview', 'Map this codebase and write docs/ARCHITECTURE.md with a diagram.'],
      ['Plan a feature', 'Plan how to add user accounts to this project, step by step.'],
      ['Refactor plan', 'Propose a refactor to make this codebase more modular.'],
      ['Tech choices', 'What stack would you recommend for a small web app with auth and a database?'],
    ],
    sentinel: [
      ['Security review', 'Review this project for security vulnerabilities and report them by severity.'],
      ['Code review', 'Review the main source files for bugs and code quality issues.'],
      ['Check secrets', 'Check whether any secrets or API keys are hard-coded in this project.'],
      ['Test coverage', 'Run the tests and tell me which important code paths are untested.'],
    ],
    deeptrace: [
      ['Explain a library', 'How does the main library this project uses work? Check its docs.'],
      ['API lookup', 'Find the official docs for the API this project calls and summarize the endpoints we use.'],
      ['Study a repo', 'Read the README of https://github.com/ollama/ollama and summarize how its REST API works.'],
      ['Upgrade guide', 'What changes do I need to upgrade our main dependency to its latest version?'],
    ],
  };

  function renderWelcome() {
    const p = persona();
    const el = h('div.welcome');
    el.append(avatar(p, 'lg'), h('h1', { text: p.name }), h('div.tag', { text: p.tagline }), h('div.persona-desc', { text: p.description }));
    const model = modelFor(p);
    const e = effortDef(state.settings.effort);
    el.append(h('div.persona-desc', { style: { marginTop: '8px' }, text: `${e.label} effort · ${model ? 'powered by ' + model : 'no model selected'}` }));
    const list = SUGGESTIONS[p.id] || SUGGESTIONS.default;
    el.append(
      h(
        'div.suggestions',
        {},
        list.map(([title, prompt]) =>
          h('div.suggestion', { on: { click: () => setInput(prompt) } }, h('b', { text: title }), h('span', { text: prompt.length > 80 ? prompt.slice(0, 78) + '…' : prompt })),
        ),
      ),
    );
    if (!state.project) {
      el.append(
        h(
          'div.welcome-project',
          {},
          h('span', { html: icon('folder') }),
          h('span', { text: `No project open: the AI works from your home folder${state.info.home ? ` (${state.info.home})` : ''} and asks before each file access or command. Open a folder to let it work freely inside it.` }),
          h('button.btn.small.primary', { text: 'Open folder', on: { click: pickProject } }),
        ),
      );
    }
    return el;
  }

  function setInput(text) {
    const input = $('#input');
    input.value = text;
    autosize();
    input.focus();
    input.setSelectionRange(text.length, text.length);
  }

  function startNewChat() {
    state.chat = null;
    state.attachments = [];
    renderAttachments();
    renderThread();
    renderChatList();
    renderStatus();
    updateComposer();
    $('#input').focus();
  }

  async function openChat(id) {
    const chat = await api.loadChat(id);
    if (!chat || chat.error) return toast(chat?.error || 'Could not open chat', 'error');
    if ((chat.projectPath || null) !== state.project) {
      if (chat.projectPath) await setProject(chat.projectPath, { newChat: false });
      else await setProject(null, { newChat: false });
    }
    state.chat = { id: chat.id, title: chat.title, projectPath: chat.projectPath, items: chat.items || [] };
    if (chat.running) state.running = chat.id;
    renderThread();
    renderChatList();
    renderStatus();
    updateComposer();
  }

  async function undoChange(item) {
    const change = item.display?.change;
    if (!change) return;
    let res = await api.undoChange({ changeId: change.id, chatId: state.chat?.id, itemId: item.id });
    if (res?.conflict) {
      const ok = await confirmDialog({ title: 'Undo anyway?', message: res.message, confirmText: 'Undo anyway', danger: true });
      if (!ok) return;
      res = await api.undoChange({ changeId: change.id, chatId: state.chat?.id, itemId: item.id, force: true });
    }
    if (res?.error || !res?.ok) return toast(res?.error || res?.message || 'Undo failed', 'error');
    change.undone = true;
    rerenderItem(item);
    toast(res.message, 'success');
  }

  // ----------------------------------------------------------- agent events

  const pendingRender = new Set();
  let renderScheduled = false;
  function scheduleRender(item) {
    pendingRender.add(item);
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      const stick = nearBottom();
      for (const it of pendingRender) rerenderItem(it);
      pendingRender.clear();
      if (stick) scrollToBottom(true);
    });
  }

  function onAgentEvent(ev) {
    if (ev.type === 'run-start') {
      state.running = ev.chatId;
      updateComposer();
      renderChatList();
      return;
    }
    if (ev.type === 'run-end') {
      state.running = null;
      state.status = null;
      renderStatus();
      updateComposer();
      refreshChats();
      if (state.chat?.id === ev.chatId) rerenderNotices();
      if (document.hidden && ev.reason === 'done') new Notification('LocalAI', { body: 'Task finished' });
      return;
    }
    if (!state.chat || ev.chatId !== state.chat.id) return;
    const items = state.chat.items;
    switch (ev.type) {
      case 'item-add': {
        if (!items.length) thread().innerHTML = '';
        items.push(ev.item);
        const stick = nearBottom();
        thread().append(LA.chat.renderItem(ev.item, itemCtx()));
        if (stick || ev.item.type === 'user') scrollToBottom(true);
        break;
      }
      case 'item-update': {
        const item = items.find((i) => i.id === ev.id);
        if (!item) return;
        Object.assign(item, ev.patch);
        if (item.type === 'tool' && item.status !== 'running' && item.status !== 'approval') LA.chat.clearLive(item.id);
        scheduleRender(item);
        if (item.approval) setTimeout(() => scrollToBottom(true), 30);
        break;
      }
      case 'item-remove': {
        state.chat.items = items.filter((i) => i.id !== ev.id);
        thread().querySelector(`[data-id="${ev.id}"]`)?.remove();
        break;
      }
      case 'assistant-delta': {
        const item = items.find((i) => i.id === ev.id);
        if (!item) return;
        item.text = (item.text || '') + (ev.text || '');
        item.thinking = (item.thinking || '') + (ev.thinking || '');
        scheduleRender(item);
        break;
      }
      case 'tool-output':
        LA.chat.appendLiveOutput(ev.id, ev.text);
        break;
      case 'status':
        state.status = ev.status.running ? ev.status : null;
        renderStatus();
        break;
      default:
    }
  }

  // ------------------------------------------------------------ status bar

  const PHASES = { starting: 'Starting', thinking: 'Thinking', tool: 'Working', approval: 'Waiting for your approval', summarizing: 'Summarizing' };
  let statusTick = null;
  function renderStatus() {
    const bar = $('#statusBar');
    const st = state.status;
    if (!st || !state.chat || state.running !== state.chat.id) {
      bar.classList.add('hidden');
      clearInterval(statusTick);
      statusTick = null;
      return;
    }
    bar.classList.remove('hidden');
    const elapsed = Date.now() - st.startedAt - (st.pausedMs || 0);
    const pct = st.maxSteps ? Math.min(100, (st.step / st.maxSteps) * 100) : 0;
    bar.innerHTML = '';
    const parts = [
      st.phase === 'approval' ? h('span', { html: icon('alert'), style: { color: 'var(--yellow)', display: 'grid' } }) : h('span.spinner'),
      h('span.phase', { text: PHASES[st.phase] || 'Working' }),
      h('span.pill', { text: `${st.effortLabel || ''} effort` }),
      h('span', { text: `Step ${st.step || 1}/${st.maxSteps}` }),
      h('div.budget', { title: 'Step budget used' }, h('div', { style: { width: pct + '%' } })),
      h('span', { text: `${formatDuration(elapsed)} / ${st.maxMinutes}:00` }),
      st.plan ? h('span.pill', { text: `Plan ${st.plan.done}/${st.plan.total}` }) : null,
      h('span.detail', { text: st.detail || '', title: st.detail || '' }),
    ];
    bar.append(...parts.filter(Boolean));
    if (!statusTick) statusTick = setInterval(renderStatus, 1000);
  }

  // -------------------------------------------------------------- composer

  function autosize() {
    const input = $('#input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 240) + 'px';
    updateComposer();
  }

  function updateComposer() {
    const btn = $('#sendBtn');
    const runningHere = !!(state.running && state.chat && state.running === state.chat.id);
    const hasInput = !!($('#input').value.trim() || state.attachments.length);
    $('#stopBtn').classList.toggle('hidden', !runningHere);
    btn.innerHTML = icon('send');
    btn.title = runningHere ? 'Send now — the AI reads it at its next step (Enter)' : 'Send (Enter)';
    btn.disabled = !hasInput || (!!state.running && !runningHere);
    $('#input').placeholder = runningHere ? 'Message the AI while it works — it reads this at its next step…' : 'Ask a question or describe a coding task…';
  }

  function renderAttachments() {
    const root = $('#attachmentChips');
    root.innerHTML = '';
    state.attachments.forEach((a, i) => {
      root.append(
        h(
          'span.chip',
          { title: a.path },
          h('span', { html: icon(a.kind === 'image' ? 'file' : 'paperclip') }),
          h('span', { text: a.name }),
          h('button', {
            html: icon('x'),
            title: 'Remove',
            on: {
              click: () => {
                state.attachments.splice(i, 1);
                renderAttachments();
                updateComposer();
              },
            },
          }),
        ),
      );
    });
  }

  function addAttachments(list) {
    for (const a of list || []) {
      if (a.error) toast(`${a.name}: ${a.error}`, 'error');
      else if (!state.attachments.some((x) => x.path === a.path)) state.attachments.push(a);
    }
    renderAttachments();
    updateComposer();
  }

  async function send(textOverride) {
    const input = $('#input');
    const text = (textOverride ?? input.value).trim();
    if (!text && !state.attachments.length) return;
    if (state.running && state.chat?.id === state.running) return queueMessage(text);
    if (state.running) {
      toast('Another chat is still working. Stop it first, or wait for it to finish.', 'error');
      return;
    }
    if (state.ollama.ok === false) {
      toast("Ollama isn't running. Start it and try again.", 'error');
      return;
    }
    const p = persona();
    if (!modelFor(p)) {
      toast('Pick an Ollama model first (top right).', 'error');
      return;
    }
    const isNew = !state.chat;
    const id = isNew ? newChatId() : state.chat.id;
    if (isNew) {
      state.chat = { id, title: text.slice(0, 60) || 'New chat', projectPath: state.project, items: [] };
      thread().innerHTML = '';
      renderTitle();
    }
    const attachments = state.attachments.map(({ name, kind, content, data }) => ({ name, kind, content, data }));
    if (textOverride == null) {
      input.value = '';
      autosize();
    }
    state.attachments = [];
    renderAttachments();
    state.running = id;
    updateComposer();
    const res = await api.send({ chatId: isNew ? null : id, newChatId: isNew ? id : undefined, text: text || 'See the attached files.', attachments, projectPath: state.project, personaId: p.id, effort: state.settings.effort, model: state.settings.model, permissionMode: state.settings.permissionMode });
    if (res?.error) {
      state.running = null;
      updateComposer();
      toast(res.error, 'error');
      if (isNew && !state.chat.items.length) startNewChat();
      return;
    }
    state.chat.title = res.title;
    renderTitle();
    refreshChats();
  }

  // Message for the task that is running in this chat: it is shown at once and read at the next step.
  async function queueMessage(text) {
    const attachments = state.attachments.map(({ name, kind, content, data }) => ({ name, kind, content, data }));
    const input = $('#input');
    input.value = '';
    state.attachments = [];
    renderAttachments();
    autosize();
    const p = persona();
    const res = await api.send({ chatId: state.chat.id, text: text || 'See the attached files.', attachments, projectPath: state.project, personaId: p.id, effort: state.settings.effort, model: state.settings.model, permissionMode: state.settings.permissionMode });
    if (res?.error) {
      toast(res.error, 'error');
      setInput(text);
    }
  }

  function stop() {
    if (state.running) api.stop(state.running);
  }

  // ----------------------------------------------------------------- init

  function staticIcons() {
    $('#brandLogo').innerHTML = icon('nexus');
    $('#newChatBtn').innerHTML = icon('plus') + 'New chat';
    $('#openProjectBtn').innerHTML = icon('folderPlus');
    $('#settingsBtn').innerHTML = icon('settings');
    $('#terminalToggle').innerHTML = icon('terminal');
    $('#attachBtn').innerHTML = icon('paperclip');
    $('#stopBtn').innerHTML = icon('stop');
  }

  function wire() {
    $('#newChatBtn').addEventListener('click', startNewChat);
    $('#openProjectBtn').addEventListener('click', pickProject);
    $('#settingsBtn').addEventListener('click', () => LA.settings.open());
    $('#ollamaStatus').addEventListener('click', () => (state.ollama.ok ? openModelPicker() : refreshOllama({ quiet: false })));
    $('#modelChip').addEventListener('click', openModelPicker);
    $('#personaSelector').addEventListener('click', openPersonaPicker);
    $('#effortSelector').addEventListener('click', openEffortPicker);
    $('#permSelector').addEventListener('click', openPermPicker);
    $('#terminalToggle').addEventListener('click', () => LA.terminal.toggle());
    $('#attachBtn').addEventListener('click', async () => addAttachments(await api.pickAttachments(state.project)));
    $('#sendBtn').addEventListener('click', () => send());
    $('#stopBtn').addEventListener('click', stop);

    const input = $('#input');
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && e.shiftKey) {
        // Cycle Ask → Accept edits → Plan (Bypass only from the menu, with a confirmation)
        e.preventDefault();
        const cycle = ['default', 'acceptEdits', 'plan'];
        const i = cycle.indexOf(state.settings.permissionMode);
        setPermissionMode(cycle[(i + 1) % cycle.length]);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    // drag & drop attachments
    const composer = $('#composer');
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        dragDepth++;
        composer.classList.add('dragging');
      }
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) composer.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      composer.classList.remove('dragging');
      const paths = [...(e.dataTransfer?.files || [])].map((f) => api.pathForFile(f)).filter(Boolean);
      if (paths.length) addAttachments(await api.readAttachments(paths));
    });

    // code copy + external links (event delegation)
    $('#thread').addEventListener('click', (e) => {
      const copy = e.target.closest('.code-copy');
      if (copy) {
        LA.copyText(copy.closest('.code-block').querySelector('code').textContent);
        return;
      }
      const link = e.target.closest('a[href]');
      if (link) {
        e.preventDefault();
        if (/^https?:/.test(link.getAttribute('href'))) api.openExternal(link.getAttribute('href'));
      }
    });
    $('#banner').addEventListener('click', (e) => {
      const link = e.target.closest('a[href]');
      if (link) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && state.running && !document.querySelector('.modal-backdrop, .popover')) {
        stop();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        startNewChat();
      } else if (mod && e.key === '`') {
        e.preventDefault();
        LA.terminal.toggle();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        LA.settings.open();
      }
    });

    api.onAgentEvent(onAgentEvent);
    api.onTerminalEvent((ev) => LA.terminal.handleEvent(ev));
    api.onChatsChanged(() => refreshChats());
  }

  async function init() {
    staticIcons();
    state.info = await api.appInfo();
    state.settings = await api.getSettings();
    applyTheme();
    LA.terminal.init({
      getCwd: () => state.project,
      onToggle: (show) => saveSettings({ terminalOpen: show }),
      onFix: (cmd, output, code) => {
        setInput(`I ran \`${cmd}\` and it failed (exit code ${code}):\n\n\`\`\`\n${output.slice(-3500).trim()}\n\`\`\`\n\nFind the cause and fix it.`);
      },
    });
    if (state.settings.terminalOpen) LA.terminal.toggle(true);
    wire();
    LA.settings.init({
      state,
      saveSettings,
      onChange: async (what) => {
        applyTheme();
        if (what === 'ollama') {
          state.modelInfo = {};
          await refreshOllama({ quiet: false });
        }
        await loadModelInfo(modelFor(persona()));
        renderSelectors();
        renderModelChip();
        renderChatList();
        if (!state.chat?.items?.length) renderThread();
        else renderThread();
      },
    });
    renderSelectors();
    renderModelChip();
    if (state.settings.lastProject) await setProject(state.settings.lastProject, { newChat: false });
    else {
      renderProjects();
      await refreshChats();
    }
    LA.terminal.setCwd(state.project);
    startNewChat();
    refreshOllama();
  }

  LA.app = { state, send, startNewChat, openChat, refreshOllama, renderSelectors, selectPersona, pickProject };
  window.addEventListener('DOMContentLoaded', init);
})();
