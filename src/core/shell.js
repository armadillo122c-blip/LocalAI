'use strict';

// Runs shell commands for the agent and the terminal panel.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const { stripAnsi } = require('./util');
const { filterSecretEnv } = require('./safety');

const SHELLS = {
  cmd: { label: 'Command Prompt (cmd.exe)', platforms: ['win32'] },
  powershell: { label: 'Windows PowerShell', platforms: ['win32'] },
  pwsh: { label: 'PowerShell 7 (pwsh)', platforms: ['win32', 'darwin', 'linux'] },
  bash: { label: 'bash', platforms: ['win32', 'darwin', 'linux'] },
  zsh: { label: 'zsh', platforms: ['darwin', 'linux'] },
  sh: { label: 'sh', platforms: ['darwin', 'linux'] },
};

function defaultShell(platform = process.platform) {
  if (platform === 'win32') return 'cmd';
  if (platform === 'darwin') return fs.existsSync('/bin/zsh') ? 'zsh' : 'bash';
  return fs.existsSync('/bin/bash') ? 'bash' : 'sh';
}

function resolveShellName(setting, platform = process.platform) {
  if (!setting || setting === 'auto' || !SHELLS[setting] || !SHELLS[setting].platforms.includes(platform)) {
    return defaultShell(platform);
  }
  return setting;
}

function shellDescription(name, platform = process.platform) {
  const n = resolveShellName(name, platform);
  if (n === 'cmd') return 'Windows cmd.exe (use Windows commands like dir, type, copy; chain with &&)';
  if (n === 'powershell') return 'Windows PowerShell 5.1 (chain commands with ; — && is not supported)';
  if (n === 'pwsh') return 'PowerShell 7';
  return n;
}

function buildInvocation(shellName, command) {
  const ps = (exe) => ({
    file: exe,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}`,
    ],
  });
  switch (shellName) {
    case 'cmd':
      return {
        file: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`],
        windowsVerbatimArguments: true,
      };
    case 'powershell':
      return ps('powershell.exe');
    case 'pwsh':
      return ps('pwsh');
    case 'zsh':
      return { file: '/bin/zsh', args: ['-c', command] };
    case 'sh':
      return { file: '/bin/sh', args: ['-c', command] };
    case 'bash':
    default:
      return { file: process.platform === 'win32' ? 'bash.exe' : 'bash', args: ['-c', command] };
  }
}

function commandEnv({ hideSecrets = true } = {}) {
  const base = hideSecrets ? filterSecretEnv(process.env) : { ...process.env };
  return {
    ...base,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  };
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 1500).unref();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Run a command. Returns a promise of
 * { code, output, timedOut, aborted, durationMs }.
 * `onData(text)` receives output as it arrives (stdout and stderr merged).
 */
function runCommand(command, { cwd, shell, timeoutMs = 120000, signal, onData, hideSecrets = true, maxBuffer = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const shellName = resolveShellName(shell);
    const inv = buildInvocation(shellName, command);
    let output = '';
    let dropped = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    let child;
    try {
      child = spawn(inv.file, inv.args, {
        cwd,
        env: commandEnv({ hideSecrets }),
        windowsHide: true,
        windowsVerbatimArguments: !!inv.windowsVerbatimArguments,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve({ code: -1, output: `Failed to start shell: ${err.message}`, timedOut: false, aborted: false, durationMs: 0 });
      return;
    }

    const push = (text) => {
      text = stripAnsi(text).replace(/\r(?!\n)/g, '\n');
      if (!text) return;
      output += text;
      if (output.length > maxBuffer) {
        // keep the head and the most recent output
        const keepHead = 20000;
        dropped += output.length - maxBuffer;
        output = output.slice(0, keepHead) + output.slice(output.length - (maxBuffer - keepHead));
      }
      onData?.(text);
    };
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    child.stdout.on('data', (d) => push(outDec.write(d)));
    child.stderr.on('data', (d) => push(errDec.write(d)));

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs) : null;
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      push(outDec.end() + errDec.end() + extra);
      if (dropped) output = `[${dropped} characters of output were dropped]\n` + output;
      resolve({ code, output, timedOut, aborted, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      const hint = err.code === 'ENOENT' ? ` (shell "${inv.file}" was not found — pick another shell in Settings)` : '';
      finish(-1, `\nFailed to run command: ${err.message}${hint}\n`);
    });
    child.on('close', (code, sig) => finish(code ?? (sig ? 1 : 0)));
  });
}

module.exports = { runCommand, killTree, resolveShellName, shellDescription, defaultShell, SHELLS };
