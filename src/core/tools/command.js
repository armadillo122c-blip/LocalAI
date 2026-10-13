'use strict';

// run_command: execute a shell command in the project folder.

const { runCommand, resolveShellName } = require('../shell');
const { analyzeCommand, redactSecrets } = require('../safety');
const { headTail } = require('../util');

const runCommandTool = {
  name: 'run_command',
  category: 'command',
  description:
    'Run a shell command in the project folder (build, test, run scripts, git status, install packages). ' +
    'Output and exit code are returned. Commands must not wait for input; long-running servers and watch modes will be stopped at the timeout.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      cwd: { type: 'string', description: 'Working folder relative to the project root. Default: project root' },
      timeout_seconds: { type: 'integer', description: 'Maximum run time in seconds (default from settings)' },
    },
    required: ['command'],
  },
  summarize: (a) => a.command,
  async run(args, ctx) {
    const command = String(args.command || args.cmd || '').trim();
    if (!command) return { ok: false, output: 'command is required' };
    if (!ctx.root) return { ok: false, output: 'No project folder is open, so commands are disabled.' };

    let cwd = ctx.root;
    const notes = [];
    if (args.cwd && args.cwd !== '.') {
      const target = ctx.resolve(args.cwd);
      if (!target.inside) notes.push(`Runs in a folder outside the project: ${target.abs}`);
      cwd = target.abs;
    }
    const risk = analyzeCommand(command, { projectRoot: ctx.root, cwd });
    const reasons = [...notes, ...risk.reasons];
    const risky = reasons.length > 0;
    const mode = ctx.permissions.commands; // 'ask' | 'risky' | 'auto'
    const needsApproval = risky || mode === 'ask' || ctx.forceApproval;
    if (needsApproval) {
      const res = await ctx.approve({
        kind: risky ? 'danger' : 'command',
        category: 'command',
        title: risky ? 'Run a potentially dangerous command?' : 'Run this command?',
        command,
        cwd: ctx.relative(cwd),
        reasons,
        blanket: !risky,
      });
      if (!res.approved) {
        return {
          ok: false,
          rejected: true,
          output: 'The user rejected this command.' + (res.feedback ? ` User feedback: ${res.feedback}` : ' Do not run it again; try another approach or ask the user.'),
        };
      }
    }

    const defaultTimeout = (ctx.settings.commandTimeoutSec || 120) * 1000;
    const requested = parseInt(args.timeout_seconds, 10);
    const timeoutMs = requested > 0 ? Math.min(requested * 1000, Math.max(defaultTimeout, 600000)) : defaultTimeout;

    ctx.terminal?.({ type: 'start', source: 'ai', command, cwd });
    const result = await runCommand(command, {
      cwd,
      shell: ctx.settings.shell,
      timeoutMs,
      signal: ctx.signal,
      hideSecrets: ctx.settings.hideSecretEnv !== false,
      onData: (text) => {
        const safe = redactSecrets(text, { strict: true });
        ctx.onOutput?.(safe);
        ctx.terminal?.({ type: 'data', text: safe });
      },
    });
    ctx.terminal?.({ type: 'exit', code: result.code, timedOut: result.timedOut, aborted: result.aborted });

    const output = redactSecrets(result.output, { strict: true }).trim();
    let status = `Exit code: ${result.code}`;
    if (result.timedOut) status = `Command timed out after ${Math.round(timeoutMs / 1000)}s and was stopped. (If it is a server or watch mode, don't start it; run a one-off build/test instead.)`;
    if (result.aborted) status = 'Command was cancelled by the user.';
    const body = output ? headTail(output, ctx.limits.outputChars, 0.25) : '(no output)';
    return {
      ok: result.code === 0 && !result.timedOut && !result.aborted,
      command: true,
      exitCode: result.code,
      output: `${status}\n${body}`,
      display: { exitCode: result.code, timedOut: result.timedOut, durationMs: result.durationMs, shell: resolveShellName(ctx.settings.shell) },
    };
  },
};

module.exports = { runCommandTool };
