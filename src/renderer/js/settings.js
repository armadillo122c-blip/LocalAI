'use strict';

// Settings modal: General, AI Profiles (persona editor), Effort limits, Permissions & Safety.
(function () {
  const LA = window.LA;
  const api = window.api;
  const { h, icon, modal, toast, avatar, confirmDialog } = LA;

  let ctx = null;
  const COLORS = ['#7aa2f7', '#73c991', '#f7768e', '#bb9af7', '#e0af68', '#ffd166', '#2ac3de', '#ff9e64', '#ff7edb', '#9aa5ce'];
  const CTX_OPTIONS = [4096, 8192, 12288, 16384, 24576, 32768, 65536, 131072];

  function field(label, control, help) {
    return h('div.field', {}, h('label', { text: label }), control, help ? h('div.help', { html: help }) : null);
  }

  function toggleRow(label, help, checked, onChange) {
    const input = h('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return h('div.field.row', {}, h('div.ftext', {}, h('div.flabel', { text: label }), help ? h('div.help', { text: help }) : null), h('label.toggle', {}, input, h('span')));
  }

  function select(options, value, onChange) {
    const el = h('select.input');
    for (const [v, label] of options) el.append(h('option', { value: v, text: label, selected: String(v) === String(value) }));
    if (onChange) el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  // -------------------------------------------------------------- general

  function generalPage() {
    const s = ctx.state.settings;
    const url = h('input.input', { value: s.ollamaUrl, placeholder: 'http://127.0.0.1:11434', spellcheck: 'false' });
    const result = h('span.test-result');
    const test = async () => {
      result.className = 'test-result';
      result.textContent = 'Testing…';
      const prev = ctx.state.settings.ollamaUrl;
      await ctx.saveSettings({ ollamaUrl: url.value.trim() });
      const st = await api.ollamaStatus();
      if (st.ok) {
        const models = await api.listModels();
        result.className = 'test-result ok';
        result.textContent = `Connected — Ollama ${st.version}, ${Array.isArray(models) ? models.length : 0} models`;
      } else {
        result.className = 'test-result bad';
        result.textContent = st.error || 'Not reachable';
      }
      if (prev !== ctx.state.settings.ollamaUrl || st.ok) ctx.onChange('ollama');
    };
    const models = ctx.state.models.map((m) => [m.name, `${m.name}${m.parameterSize ? ' · ' + m.parameterSize : ''}`]);
    if (s.model && !models.some(([n]) => n === s.model)) models.unshift([s.model, `${s.model} (not installed)`]);
    if (!models.length) models.push(['', 'No models found']);
    const model = select(models, s.model);
    const info = ctx.state.modelInfo[s.model];
    const ctxValues = CTX_OPTIONS.includes(s.contextLength) ? CTX_OPTIONS : [...CTX_OPTIONS, s.contextLength].sort((a, b) => a - b);
    const ctxSel = select(ctxValues.map((n) => [n, `${n.toLocaleString()} tokens${n === 8192 ? ' (recommended)' : ''}`]), s.contextLength);
    const temp = h('input.input', { type: 'number', min: 0, max: 2, step: 0.1, value: s.temperature ?? '', placeholder: 'Model default' });
    const theme = select([['dark', 'Dark'], ['light', 'Light']], s.theme);
    let showThinking = s.showThinking;

    const save = async () => {
      await ctx.saveSettings({
        ollamaUrl: url.value.trim(),
        model: model.value,
        contextLength: Number(ctxSel.value),
        temperature: temp.value === '' ? null : Number(temp.value),
        theme: theme.value,
        showThinking,
      });
      toast('Settings saved', 'success', 1500);
      ctx.onChange('ollama');
    };

    const content = h(
      'div',
      {},
      h('div.section-title', { text: 'Ollama' }),
      field('Ollama URL', h('div.input-row', {}, url, h('button.btn', { text: 'Test connection', on: { click: test } })), 'Default: http://127.0.0.1:11434 — Ollama must be running (Ollama app or <code class="mono">ollama serve</code>).'),
      result,
      h('div', { style: { height: '12px' } }),
      field('Model', model, 'All AI personas run on this model unless a persona chooses its own. Good picks for 16 GB RAM + NVIDIA GPU: <code class="mono">qwen2.5-coder:7b</code>, <code class="mono">qwen3:8b</code>, <code class="mono">llama3.1:8b</code>; with 12 GB+ VRAM try <code class="mono">qwen2.5-coder:14b</code>.'),
      h(
        'div.grid-2',
        {},
        field('Context window', ctxSel, info?.contextLength ? `This model supports up to ${info.contextLength.toLocaleString()} tokens. Larger windows use more memory.` : 'Larger windows use more memory. 8,192 fits well in 16 GB RAM.'),
        field('Temperature', temp, 'Leave empty to use the model default. Lower = more focused.'),
      ),
      h('div.section-title', { text: 'Appearance' }),
      h('div.grid-2', {}, field('Theme', theme)),
      toggleRow('Show thinking', 'Show the reasoning of models that support it (collapsible).', showThinking, (v) => (showThinking = v)),
    );
    return { title: 'General', content, save };
  }

  // ------------------------------------------------------------- personas

  let selectedPersonaId = null;

  function blankPersona() {
    return {
      id: '',
      name: 'New AI',
      icon: 'sparkles',
      color: '#7aa2f7',
      tagline: 'Custom assistant',
      description: '',
      personality: '',
      systemPrompt: 'You are a helpful coding assistant working in the user\'s project.\n\nDescribe the role, expertise and style of this AI here.',
      permissions: { edit: 'ask', commands: 'risky', web: 'ask' },
      defaultEffort: 'medium',
      temperature: null,
      model: '',
      builtin: false,
    };
  }

  function personasPage(rerender) {
    const s = ctx.state.settings;
    const list = s.personas;
    if (!selectedPersonaId || (selectedPersonaId !== '__new' && !list.some((p) => p.id === selectedPersonaId))) selectedPersonaId = s.personaId;
    const original = selectedPersonaId === '__new' ? blankPersona() : list.find((p) => p.id === selectedPersonaId);
    const draft = JSON.parse(JSON.stringify(original));

    const listEl = h('div.persona-list');
    for (const p of list) {
      listEl.append(
        h(
          'div.persona-row' + (p.id === selectedPersonaId ? '.active' : ''),
          { on: { click: () => ((selectedPersonaId = p.id), rerender()) } },
          avatar(p, 'sm'),
          h('span.pr-name', { text: p.name }),
          p.id === s.personaId ? h('span.badge.on', { text: 'active' }) : !p.builtin ? h('span.badge', { text: 'custom' }) : null,
        ),
      );
    }
    if (selectedPersonaId === '__new') listEl.append(h('div.persona-row.active', {}, avatar(draft, 'sm'), h('span.pr-name', { text: 'New AI' })));
    listEl.append(h('div', { style: { height: '8px' } }), h('button.btn.small', { html: icon('plus') + 'New AI', on: { click: () => ((selectedPersonaId = '__new'), rerender()) } }));

    // editor
    const hero = h('div.persona-hero');
    const drawHero = () => {
      hero.innerHTML = '';
      hero.append(avatar(draft, 'lg'), h('div', {}, h('div.ph-name', { text: draft.name || 'Unnamed' }), h('div.ph-tag', { text: draft.tagline || '' }), h('div.faint', { style: { fontSize: '12px' }, text: `Powered by ${draft.model || ctx.state.settings.model || 'the selected Ollama model'}` })));
    };
    drawHero();
    const bind = (key, el, transform = (v) => v) => {
      el.addEventListener('input', () => {
        draft[key] = transform(el.value);
        drawHero();
      });
      return el;
    };
    const name = bind('name', h('input.input', { value: draft.name, maxlength: 40 }));
    const tagline = bind('tagline', h('input.input', { value: draft.tagline, maxlength: 80 }));
    const description = bind('description', h('textarea.input', { style: { minHeight: '60px', fontFamily: 'var(--font)', fontSize: '13px' }, maxlength: 400 }, draft.description));
    const personality = bind('personality', h('input.input', { value: draft.personality, maxlength: 120, placeholder: 'e.g. Calm, precise, friendly' }));
    const prompt = bind('systemPrompt', h('textarea.input', { rows: 12 }, draft.systemPrompt));

    const iconGrid = h('div.icon-grid');
    const drawIcons = () => {
      iconGrid.innerHTML = '';
      for (const ic of LA.PERSONA_ICONS) {
        const b = h('button.icon-choice' + (draft.icon === ic ? '.selected' : ''), { html: icon(ic), title: ic, on: { click: () => ((draft.icon = ic), drawIcons(), drawHero()) } });
        b.style.setProperty('--pc', draft.color);
        iconGrid.append(b);
      }
    };
    drawIcons();
    const colorRow = h('div.color-row');
    const drawColors = () => {
      colorRow.innerHTML = '';
      for (const c of COLORS) colorRow.append(h('span.swatch' + (draft.color === c ? '.selected' : ''), { style: { background: c }, on: { click: () => ((draft.color = c), drawColors(), drawIcons(), drawHero()) } }));
      const picker = h('input', { type: 'color', value: draft.color, title: 'Custom color' });
      picker.addEventListener('input', () => {
        draft.color = picker.value;
        drawIcons();
        drawHero();
      });
      colorRow.append(picker);
    };
    drawColors();

    const perm = (key, options) => select(options, draft.permissions[key], (v) => (draft.permissions[key] = v));
    const efforts = ctx.state.info.efforts.map((e) => [e.id, e.label]);
    const effortSel = select(efforts, draft.defaultEffort, (v) => (draft.defaultEffort = v));
    const temp = h('input.input', { type: 'number', min: 0, max: 2, step: 0.1, value: draft.temperature ?? '', placeholder: 'Global default' });
    temp.addEventListener('input', () => (draft.temperature = temp.value === '' ? null : Number(temp.value)));
    const modelOpts = [['', `Shared model (${ctx.state.settings.model || 'none'})`], ...ctx.state.models.map((m) => [m.name, m.name])];
    if (draft.model && !modelOpts.some(([n]) => n === draft.model)) modelOpts.push([draft.model, `${draft.model} (not installed)`]);
    const modelSel = select(modelOpts, draft.model, (v) => {
      draft.model = v;
      drawHero();
    });

    const editor = h(
      'div.persona-editor',
      {},
      hero,
      h('div.grid-2', {}, field('Name', name), field('Tagline', tagline)),
      field('Icon', iconGrid),
      field('Color', colorRow),
      field('Description', description),
      field('Personality', personality),
      field('System prompt', prompt, 'LocalAI automatically adds the environment, tool rules, safety rules and effort instructions after this prompt.'),
      h('div.section-title', { text: 'Tool permissions' }),
      h(
        'div.grid-3',
        {},
        field('File edits', perm('edit', [['ask', 'Ask before applying'], ['auto', 'Apply automatically'], ['off', 'Off (read-only)']])),
        field('Terminal commands', perm('commands', [['ask', 'Ask every time'], ['risky', 'Ask for risky ones'], ['off', 'Off']])),
        field('Web access', perm('web', [['ask', 'Ask'], ['auto', 'Allow'], ['off', 'Off']])),
      ),
      h('div.help', { style: { marginTop: '-8px', marginBottom: '16px' }, text: 'Deleting files, dangerous commands and anything outside the project always ask, whatever you choose here. Automatic edits are still shown as diffs and can be undone.' }),
      h('div.section-title', { text: 'Behavior' }),
      h('div.grid-3', {}, field('Default effort', effortSel), field('Temperature', temp), field('Ollama model', modelSel)),
    );

    const save = async () => {
      if (!draft.name.trim()) return toast('Give the AI a name', 'error');
      const res = await api.savePersona(draft);
      if (res?.error) return toast(res.error, 'error');
      ctx.state.settings = res.settings;
      selectedPersonaId = res.persona.id;
      toast(`${res.persona.name} saved`, 'success', 1500);
      ctx.onChange('personas');
      rerender();
    };
    const extra = [];
    extra.push(
      h('button.btn', {
        text: 'Use this AI',
        disabled: !draft.id,
        on: {
          click: async () => {
            await LA.app.selectPersona(draft.id);
            rerender();
          },
        },
      }),
    );
    if (draft.id) {
      extra.push(
        h('button.btn', {
          text: 'Duplicate',
          on: {
            click: async () => {
              const copy = { ...JSON.parse(JSON.stringify(draft)), id: '', builtin: false, name: (draft.name + ' Copy').slice(0, 40) };
              const res = await api.savePersona(copy);
              if (res?.error) return toast(res.error, 'error');
              ctx.state.settings = res.settings;
              selectedPersonaId = res.persona.id;
              ctx.onChange('personas');
              rerender();
            },
          },
        }),
      );
    }
    if (original.builtin) {
      extra.push(
        h('button.btn', {
          text: 'Reset to default',
          on: {
            click: async () => {
              if (!(await confirmDialog({ title: `Reset ${original.name}?`, message: 'Your changes to this AI (prompt, permissions, behavior) will be replaced by the built-in defaults.', confirmText: 'Reset' }))) return;
              const res = await api.resetPersona(original.id);
              if (res?.error) return toast(res.error, 'error');
              ctx.state.settings = res;
              ctx.onChange('personas');
              rerender();
            },
          },
        }),
      );
    } else if (draft.id) {
      extra.push(
        h('button.btn.danger', {
          text: 'Delete',
          on: {
            click: async () => {
              if (!(await confirmDialog({ title: `Delete ${original.name}?`, message: 'This custom AI will be removed. Chats are kept.', confirmText: 'Delete', danger: true }))) return;
              const res = await api.deletePersona(original.id);
              if (res?.error) return toast(res.error, 'error');
              ctx.state.settings = res;
              selectedPersonaId = res.personaId;
              ctx.onChange('personas');
              rerender();
            },
          },
        }),
      );
    }
    return { title: 'AI Profiles', content: h('div.persona-layout', {}, listEl, editor), save, saveLabel: 'Save AI', extra };
  }

  // --------------------------------------------------------------- effort

  function effortPage(rerender) {
    const s = ctx.state.settings;
    const inputs = {};
    const rows = ctx.state.info.efforts.map((e) => {
      const lim = s.effortLimits[e.id] || e;
      const steps = h('input.input', { type: 'number', min: 1, max: 500, value: lim.maxSteps });
      const mins = h('input.input', { type: 'number', min: 1, max: 480, value: lim.maxMinutes });
      inputs[e.id] = { steps, mins };
      const behavior = [e.planRequired ? 'Plan required before edits' : 'Plan optional', e.verifyRetries ? `Verify/fix up to ${e.verifyRetries}×` : 'No forced verification', e.selfReview ? 'Final self-review' : null, e.think === 'on' ? 'Reasoning on*' : e.think === 'off' ? 'Reasoning off*' : 'Model default reasoning*'].filter(Boolean);
      return h('tr', {}, h('td', {}, h('div.lvl', { text: e.label }), h('div.desc', { text: e.summary })), h('td', {}, steps), h('td', {}, mins), h('td.desc', { text: behavior.join(' · ') }));
    });
    const content = h(
      'div',
      {},
      h(
        'div.info-box',
        { html: 'Effort is enforced by LocalAI, not just requested in the prompt:<ul><li><b>Steps</b> = model turns per task (each turn can run several tools). <b>Minutes</b> = wall-clock limit; time spent waiting for your approval does not count.</li><li>When a budget runs out, the AI must stop and summarize what is done and what remains — press <b>Continue</b> to keep going.</li><li>Higher levels block file edits until a plan exists, send the AI back to run tests when it changed code without verifying, and retry fixes when a check fails.</li><li>*Reasoning mode is only used when the model supports it (e.g. qwen3, deepseek-r1). Other models are never told to "think harder" — they get planning and verification instead.</li></ul>' },
      ),
      h('table.effort-table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Level' }), h('th', { text: 'Max steps' }), h('th', { text: 'Max minutes' }), h('th', { text: 'Behavior' }))), h('tbody', {}, rows)),
    );
    const save = async () => {
      const limits = {};
      for (const [id, { steps, mins }] of Object.entries(inputs)) limits[id] = { maxSteps: Number(steps.value), maxMinutes: Number(mins.value) };
      await ctx.saveSettings({ effortLimits: limits });
      toast('Effort limits saved', 'success', 1500);
      ctx.onChange('effort');
      rerender();
    };
    const reset = h('button.btn', {
      text: 'Reset to defaults',
      on: {
        click: async () => {
          const limits = {};
          for (const e of ctx.state.info.efforts) limits[e.id] = { maxSteps: e.maxSteps, maxMinutes: e.maxMinutes };
          await ctx.saveSettings({ effortLimits: limits });
          ctx.onChange('effort');
          rerender();
        },
      },
    });
    return { title: 'Effort', content, save, extra: [reset] };
  }

  // ----------------------------------------------------------- permissions

  function permissionsPage() {
    const s = ctx.state.settings;
    let safeMode = s.safeMode;
    let hideSecretEnv = s.hideSecretEnv;
    const timeout = h('input.input', { type: 'number', min: 5, max: 3600, value: s.commandTimeoutSec });
    const shells = [['auto', `Automatic (${ctx.state.info.defaultShell})`], ...ctx.state.info.shells.map((x) => [x.id, x.label])];
    const shell = select(shells, s.shell);
    const content = h(
      'div',
      {},
      h(
        'div.info-box',
        { html: '<b>Always enforced, for every AI:</b><ul><li>Files outside the selected project folder are never read or changed without your explicit approval.</li><li>Deleting files always asks for confirmation.</li><li>Potentially dangerous commands (deleting, git push/reset, system changes, downloads piped to a shell…) always ask, with the reason shown.</li><li>Every file change is backed up and can be undone from the chat.</li><li>.env files, keys and credentials need approval before the AI can read them; tokens and keys in tool output are masked.</li></ul>Per-AI permissions (file edits, commands, web) are set in <b>AI Profiles</b>.' },
      ),
      toggleRow('Safe mode', 'Ask before every file change, command and web request, overriding the AI permissions.', safeMode, (v) => (safeMode = v)),
      toggleRow('Hide secret environment variables from AI commands', 'Variables like *_API_KEY, *_TOKEN, *_SECRET and passwords are removed from the environment of commands the AI runs.', hideSecretEnv, (v) => (hideSecretEnv = v)),
      h('div.grid-2', {}, field('Command timeout (seconds)', timeout, 'Commands running longer are stopped (servers and watch modes never finish).'), field('Shell', shell, 'Used for AI commands and the terminal panel.')),
      h('div.help', { text: `Chats, settings and backups are stored in: ${ctx.state.info.userData}` }),
    );
    const save = async () => {
      await ctx.saveSettings({ safeMode, hideSecretEnv, commandTimeoutSec: Number(timeout.value), shell: shell.value });
      toast('Permissions saved', 'success', 1500);
      ctx.onChange('permissions');
    };
    return { title: 'Permissions & Safety', content, save };
  }

  // ---------------------------------------------------------------- modal

  const PAGES = [
    ['general', 'General', 'sliders', generalPage],
    ['personas', 'AI Profiles', 'sparkles', personasPage],
    ['effort', 'Effort', 'gauge', effortPage],
    ['permissions', 'Permissions & Safety', 'lock', permissionsPage],
  ];

  function open(tab = 'general') {
    let current = PAGES.some((p) => p[0] === tab) ? tab : 'general';
    const nav = h('div.modal-nav', {}, h('h2', { text: 'Settings' }));
    const body = h('div.modal-body');
    const box = h('div.modal', {}, nav, body);
    const render = () => {
      nav.querySelectorAll('.nav-item').forEach((n) => n.remove());
      for (const [id, label, ic] of PAGES) {
        nav.append(h('button.nav-item' + (id === current ? '.active' : ''), { html: icon(ic) + label, on: { click: () => ((current = id), render()) } }));
      }
      const page = PAGES.find((p) => p[0] === current)[3](render);
      body.innerHTML = '';
      body.append(
        h('div.modal-head', {}, h('h3', { text: page.title }), h('button.icon-btn', { html: icon('x'), title: 'Close', on: { click: () => close() } })),
        h('div.modal-content', {}, page.content),
        h('div.modal-foot', {}, ...(page.extra || []), h('div.spacer'), h('button.btn', { text: 'Close', on: { click: () => close() } }), h('button.btn.primary', { text: page.saveLabel || 'Save', on: { click: page.save } })),
      );
    };
    const close = modal(box);
    render();
  }

  function init(c) {
    ctx = c;
  }

  LA.settings = { init, open };
})();
