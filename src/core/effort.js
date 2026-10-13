'use strict';

// Effort levels. Effort is enforced by the agent loop, not just by prompting:
//  - maxSteps / maxMinutes: hard budgets for model turns and wall-clock time
//  - planRequired: file changes are blocked until the agent has written a plan
//  - verifyRetries: how many times the agent is sent back to verify / fix
//    when it tries to finish with unverified or failing changes
//  - selfReview: one extra pass to review the full diff before finishing
//  - think: reasoning mode for models that support it (never faked otherwise)

const EFFORT_LEVELS = [
  {
    id: 'instant',
    label: 'Instant',
    summary: 'Minimal planning, quick answers, tiny changes',
    maxSteps: 4,
    maxMinutes: 3,
    planRequired: false,
    verifyRetries: 0,
    selfReview: false,
    think: 'off',
    prompt: `Effort level: INSTANT. Answer immediately and briefly. Use at most one or two tool calls, and only if essential. Make the smallest change that solves the request. Skip planning and testing.`,
  },
  {
    id: 'low',
    label: 'Low',
    summary: 'Simple tasks with minimal analysis',
    maxSteps: 10,
    maxMinutes: 6,
    planRequired: false,
    verifyRetries: 0,
    selfReview: false,
    think: 'off',
    prompt: `Effort level: LOW. Keep it quick: look only at the files you need, make focused changes, and run a quick check only if it is cheap. Keep answers short.`,
  },
  {
    id: 'medium',
    label: 'Medium',
    summary: 'Balanced planning, coding and testing',
    maxSteps: 24,
    maxMinutes: 15,
    planRequired: false,
    verifyRetries: 1,
    selfReview: false,
    think: 'default',
    prompt: `Effort level: MEDIUM. Balance speed and care. Read the relevant files before editing. For tasks with several steps, write a short plan with update_plan. After changing code, run the relevant test, build or program once and fix any problems you find.`,
  },
  {
    id: 'high',
    label: 'High',
    summary: 'Thorough analysis, multi-file changes, debugging and testing',
    maxSteps: 45,
    maxMinutes: 30,
    planRequired: true,
    verifyRetries: 2,
    selfReview: false,
    think: 'on',
    prompt: `Effort level: HIGH. Be thorough. Investigate the relevant code (read related files, search for usages) before changing anything. Start every non-trivial task with update_plan and keep the plan updated. Handle edge cases and multi-file changes carefully. Verify with tests, a build or by running the program; if anything fails, analyze the error, fix the root cause and run it again until it passes.`,
  },
  {
    id: 'max',
    label: 'Maximum',
    summary: 'Deepest analysis, extensive planning, iterative testing and retries',
    maxSteps: 90,
    maxMinutes: 60,
    planRequired: true,
    verifyRetries: 4,
    selfReview: true,
    think: 'on',
    prompt: `Effort level: MAXIMUM. Correctness matters more than speed. Explore the codebase deeply and understand its conventions before acting. Write a detailed plan with update_plan, then work through it step by step, updating it as you go. Fix root causes; consider edge cases, error handling and performance. Verify every change by running tests, builds or the program; when a check fails, diagnose it, fix it and repeat. If an approach fails twice, step back and try a different one. Before finishing, review all of your changes for mistakes. Never claim success without verification — state exactly what was verified and what was not.`,
  },
];

const EFFORT_IDS = EFFORT_LEVELS.map((e) => e.id);
const DEFAULT_EFFORT = 'medium';

function defaultEffortLimits() {
  const out = {};
  for (const e of EFFORT_LEVELS) out[e.id] = { maxSteps: e.maxSteps, maxMinutes: e.maxMinutes };
  return out;
}

/** Effort definition merged with the user's configured limits. */
function resolveEffort(id, limits = {}) {
  const base = EFFORT_LEVELS.find((e) => e.id === id) || EFFORT_LEVELS.find((e) => e.id === DEFAULT_EFFORT);
  const user = limits[base.id] || {};
  const clamp = (v, min, max, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.min(Math.max(Math.round(Number(v)), min), max) : d);
  return {
    ...base,
    maxSteps: clamp(user.maxSteps, 1, 500, base.maxSteps),
    maxMinutes: clamp(user.maxMinutes, 1, 480, base.maxMinutes),
  };
}

/**
 * Reasoning ("thinking") flag for the Ollama request. Returns undefined when the
 * parameter should not be sent (model has no reasoning mode, or use model default).
 */
function thinkParam(effort, modelInfo) {
  if (!modelInfo?.thinking) return undefined;
  if (effort.think === 'on') return true;
  if (effort.think === 'off') return false;
  return undefined;
}

module.exports = { EFFORT_LEVELS, EFFORT_IDS, DEFAULT_EFFORT, defaultEffortLimits, resolveEffort, thinkParam };
