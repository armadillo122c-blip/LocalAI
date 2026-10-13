'use strict';

// update_plan: lets the agent show (and keep updating) a checklist of steps in the UI.

const STATUSES = new Set(['pending', 'in_progress', 'done']);

function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['done', 'complete', 'completed', 'finished', 'x', 'true'].includes(v)) return 'done';
  if (['in_progress', 'doing', 'active', 'current', 'working', 'started'].includes(v)) return 'in_progress';
  return 'pending';
}

// Accepts the many shapes small models produce: arrays of strings/objects, or a text list.
function normalizePlan(args) {
  let raw = args.steps ?? args.plan ?? args.tasks ?? args.items ?? args.todo ?? [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(raw)) raw = [raw];
  const steps = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const m = item.match(/^\s*(?:[-*]|\d+[.)])?\s*(\[( |x|~)\])?\s*(.+)$/i);
      const mark = m?.[2]?.toLowerCase();
      steps.push({ text: (m?.[3] || item).trim(), status: mark === 'x' ? 'done' : mark === '~' ? 'in_progress' : 'pending' });
    } else if (item && typeof item === 'object') {
      const text = item.step ?? item.text ?? item.title ?? item.task ?? item.description ?? item.name ?? '';
      if (String(text).trim()) steps.push({ text: String(text).trim(), status: normalizeStatus(item.status ?? (item.done ? 'done' : 'pending')) });
    }
  }
  return steps.slice(0, 20);
}

const updatePlanTool = {
  name: 'update_plan',
  category: 'plan',
  description:
    'Create or update your step-by-step plan for the current task. Call it at the start of multi-step work and again whenever a step changes status. Each step has a status: pending, in_progress or done.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'The full plan, in order',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Short description of the step' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  summarize: (a) => {
    const steps = normalizePlan(a);
    return `${steps.filter((s) => s.status === 'done').length}/${steps.length} done`;
  },
  async run(args, ctx) {
    const steps = normalizePlan(args);
    if (!steps.length) return { ok: false, output: 'The plan is empty. Pass steps as a list like [{"step": "Read the code", "status": "in_progress"}].' };
    ctx.setPlan(steps);
    const done = steps.filter((s) => s.status === 'done').length;
    const next = steps.find((s) => s.status !== 'done');
    return {
      ok: true,
      output: `Plan updated (${done}/${steps.length} done).${next ? ` Next: ${next.text}` : ' All steps done — verify and summarize.'}`,
      display: { plan: steps },
    };
  },
};

module.exports = { updatePlanTool, normalizePlan, STATUSES };
