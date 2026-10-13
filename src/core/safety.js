'use strict';

// Safety helpers: project path sandboxing, sensitive-file detection,
// risky-command analysis and secret redaction.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- paths

function realpathSafe(p) {
  // Resolve symlinks of the deepest existing ancestor, then re-append the rest.
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Resolve a path given by the model against the project root.
 * Returns { abs, rel, inside }. `inside` is false for anything that escapes the
 * project folder, including via symlinks.
 */
function resolveProjectPath(root, input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('A path is required.');
  let p = input.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(require('os').homedir(), p.slice(1));
  }
  if (!root) {
    const abs = path.resolve(p);
    return { abs, rel: abs, inside: false };
  }
  let abs = path.resolve(root, p);
  const realRoot = realpathSafe(root);
  let inside = isInside(realRoot, realpathSafe(abs));
  // Small models often write "/src/app.js" when they mean "src/app.js".
  // If that absolute path does not exist, treat it as project-relative.
  if (!inside && /^[\\/](?![\\/])/.test(p) && !fs.existsSync(abs)) {
    const candidate = path.resolve(root, p.replace(/^[\\/]+/, ''));
    if (isInside(realRoot, realpathSafe(candidate))) {
      abs = candidate;
      inside = true;
    }
  }
  const rel = inside ? toPosix(path.relative(realRoot, realpathSafe(abs))) || '.' : abs;
  return { abs, rel, inside };
}

// ------------------------------------------------------ sensitive files

const SENSITIVE_FILE_PATTERNS = [
  /^\.env$/i,
  /^\.env\.(?!example$|sample$|template$|dist$|defaults$).+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|gpg|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /^credentials(\.json|\.ya?ml)?$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /service[-_]?account.*\.json$/i,
];
const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

function isSensitivePath(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => SENSITIVE_DIRS.has(d.toLowerCase()))) return true;
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(name));
}

// Writes into version-control internals are never routine.
function isProtectedPath(rel) {
  return String(rel).split(/[\\/]+/).some((seg) => seg.toLowerCase() === '.git');
}

// ------------------------------------------------------ command analysis

const DELETE_CMDS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'remove-item', 'ri', 'rimraf', 'trash', 'deltree']);
const SYSTEM_CMDS = new Map(Object.entries({
  format: 'Formats a disk',
  fdisk: 'Changes disk partitions',
  diskpart: 'Changes disk partitions',
  dd: 'Writes raw data to disks or files',
  shutdown: 'Shuts down or restarts the computer',
  reboot: 'Restarts the computer',
  halt: 'Stops the computer',
  poweroff: 'Powers off the computer',
  bcdedit: 'Changes boot configuration',
  reg: 'Edits the Windows registry',
  regedit: 'Edits the Windows registry',
  sc: 'Changes Windows services',
  net: 'Changes users, shares or services',
  netsh: 'Changes network configuration',
  takeown: 'Changes file ownership',
  icacls: 'Changes file permissions',
  cacls: 'Changes file permissions',
  attrib: 'Changes file attributes',
  chmod: 'Changes file permissions',
  chown: 'Changes file ownership',
  chgrp: 'Changes file ownership',
  sudo: 'Runs with administrator privileges',
  su: 'Switches user',
  doas: 'Runs with administrator privileges',
  runas: 'Runs as another user',
  'set-executionpolicy': 'Changes PowerShell security policy',
  'stop-process': 'Kills processes',
  kill: 'Kills processes',
  pkill: 'Kills processes',
  killall: 'Kills processes',
  taskkill: 'Kills processes',
  schtasks: 'Changes scheduled tasks',
  crontab: 'Changes scheduled tasks',
  setx: 'Changes environment variables permanently',
  wmic: 'Runs system management commands',
  cipher: 'Can wipe disk data',
  vssadmin: 'Changes shadow copies/backups',
  wevtutil: 'Changes system event logs',
  launchctl: 'Changes system services',
  systemctl: 'Changes system services',
  service: 'Changes system services',
  mount: 'Mounts file systems',
  umount: 'Unmounts file systems',
  useradd: 'Changes user accounts',
  userdel: 'Changes user accounts',
  passwd: 'Changes passwords',
  'invoke-expression': 'Executes dynamically built code',
  iex: 'Executes dynamically built code',
}));
const ENV_DUMP_CMDS = new Set(['env', 'printenv']);
const SHELL_WRAPPERS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash', 'sh', 'zsh', 'start', 'call', 'nohup', 'time', 'npx', 'exec']);

function splitSegments(command) {
  // Split on shell separators: && || ; | & newline. Quotes are respected loosely.
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      // keep "2>&1" and ">&" redirections intact
      if (ch === '&' && (command[i - 1] === '>' || command[i + 1] === '1' || command[i + 1] === '2')) {
        current += ch;
        continue;
      }
      if (current.trim()) segments.push(current.trim());
      current = '';
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function baseCommand(token) {
  if (!token) return '';
  const name = token.split(/[\\/]/).pop().toLowerCase();
  return name.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

const ABS_PATH_RE = /(?:^|[\s"'=(])((?:[a-zA-Z]:[\\/]|\\\\|~[\\/]|\/)[^\s"'|&;<>()]*)/g;

/**
 * Analyze a shell command and return { risky, reasons[] }.
 * Risky commands always need explicit user confirmation.
 */
function analyzeCommand(command, { projectRoot, cwd } = {}) {
  const reasons = new Set();
  const cmd = String(command || '');

  for (const segment of splitSegments(cmd)) {
    let tokens = tokenize(segment);
    // skip leading env assignments (FOO=bar cmd) and wrappers
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    let base = baseCommand(tokens[0]);
    let guard = 0;
    while (SHELL_WRAPPERS.has(base) && tokens.length > 1 && guard++ < 3) {
      tokens = tokens.slice(1);
      while (tokens.length && /^[-/]/.test(tokens[0])) tokens = tokens.slice(1); // flags like /c, -Command
      base = baseCommand(tokens[0]);
    }
    if (!base) continue;
    const args = tokens.slice(1).map((t) => t.toLowerCase());

    if (DELETE_CMDS.has(base)) reasons.add('Deletes files or folders');
    if (base.startsWith('mkfs')) reasons.add('Formats a disk');
    if (SYSTEM_CMDS.has(base)) reasons.add(SYSTEM_CMDS.get(base));
    if (ENV_DUMP_CMDS.has(base) || (base === 'set' && args.length === 0)) reasons.add('May print secret environment variables');
    if (['get-childitem', 'gci', 'dir', 'ls'].includes(base) && args.some((a) => a.startsWith('env:'))) {
      reasons.add('May print secret environment variables');
    }
    if (base === 'git') {
      const sub = args.find((a) => !a.startsWith('-')) || '';
      if (['push', 'clean', 'rebase', 'filter-branch', 'rm', 'restore', 'update-ref', 'reflog'].includes(sub)) {
        reasons.add(`git ${sub} can discard or publish work`);
      }
      if (sub === 'reset' && args.includes('--hard')) reasons.add('git reset --hard discards changes');
      if (sub === 'checkout' && (args.includes('--') || args.includes('.') || args.includes('-f'))) reasons.add('git checkout can discard changes');
      if (sub === 'branch' && (args.includes('-d') || args.includes('--delete'))) reasons.add('Deletes a git branch');
      if (sub === 'stash' && (args.includes('drop') || args.includes('clear'))) reasons.add('Deletes stashed changes');
      if (sub === 'commit' && args.includes('--amend')) reasons.add('Rewrites git history');
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(base)) {
      if (args.some((a) => ['publish', 'unpublish', 'deprecate', 'owner', 'token', 'login', 'adduser'].includes(a))) reasons.add('Publishes or changes registry/account state');
      if (args.some((a) => ['-g', '--global', 'global'].includes(a))) reasons.add('Installs or removes global packages');
    }
    if (['pip', 'pip3'].includes(base) && args.includes('uninstall')) reasons.add('Uninstalls Python packages');
    if (base === 'cargo' && args.includes('publish')) reasons.add('Publishes a package');
    if (base === 'twine' && args.includes('upload')) reasons.add('Publishes a package');
    if (base === 'docker' && args.some((a) => ['push', 'rm', 'rmi', 'prune', 'kill'].includes(a))) reasons.add('Changes or publishes Docker resources');
    if (base === 'gh') reasons.add('Acts on your GitHub account');
    if (['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'].includes(base) && args.some((a) => ['-x', '--request', '-method', '--data', '-d', '-t', '--upload-file', '-f', '--form'].includes(a))) {
      reasons.add('Sends data over the network');
    }
  }

  // Whole-command patterns (catch nested shells and pipes).
  if (/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i.test(cmd) || /\|\s*(iex|invoke-expression)\b/i.test(cmd)) {
    reasons.add('Downloads and executes a script');
  }
  if (/-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i.test(cmd)) reasons.add('Runs an encoded (hidden) command');
  if (/\b(rm\s+-[a-z]*[rf]|remove-item\b|rmdir\s+\/s|rd\s+\/s|del\s+\/[sqf])/i.test(cmd)) reasons.add('Deletes files or folders');
  if (/(^|[^>2&])>(?!>|&|\s*(nul|\$null|\/dev\/null)\b)\s*[^\s&|]/i.test(cmd.replace(/"[^"]*"|'[^']*'/g, '""'))) {
    reasons.add('Overwrites a file using output redirection');
  }
  if (/%(userprofile|appdata|localappdata|systemroot|windir|programfiles|programdata|homepath|homedrive)%|\$env:(userprofile|appdata|localappdata|systemroot|windir|programfiles|programdata|homepath)\b|\$\{?home\}?(?![a-z])/i.test(cmd)) {
    reasons.add('Uses a path outside the project');
  }

  // Paths that point outside the project folder.
  if (projectRoot) {
    const base = cwd || projectRoot;
    const realRoot = realpathSafe(projectRoot);
    const isWin = process.platform === 'win32';
    let m;
    ABS_PATH_RE.lastIndex = 0;
    while ((m = ABS_PATH_RE.exec(cmd))) {
      const raw = m[1];
      if (/^\/(dev\/null|dev\/stdout|dev\/stderr)$/.test(raw)) continue;
      if (isWin && /^\/[a-z?]+:?$/i.test(raw)) continue; // cmd switches like /s /q /c /pid
      const abs = raw.startsWith('~') ? path.join(require('os').homedir(), raw.slice(2)) : path.resolve(base, raw);
      if (!isInside(realRoot, realpathSafe(abs))) {
        reasons.add(`Uses a path outside the project: ${raw}`);
        break;
      }
    }
    const DOTDOT_RE = /(?:^|[\s"'=(])((?:\.\.(?:[\\/]|(?=[\s"')]|$)))[^\s"'|&;<>()]*)/g;
    while ((m = DOTDOT_RE.exec(cmd))) {
      if (!isInside(realRoot, realpathSafe(path.resolve(base, m[1])))) {
        reasons.add(`Uses a path outside the project: ${m[1]}`);
        break;
      }
    }
  }

  return { risky: reasons.size > 0, reasons: [...reasons] };
}

// ---------------------------------------------------------- redaction

const TOKEN_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED GITLAB TOKEN]'],
  [/\bsk-(?:proj-|ant-(?:api\d\d-)?)?[A-Za-z0-9_-]{24,}\b/g, '[REDACTED API KEY]'],
  [/\b(sk|rk|pk)_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED STRIPE KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED NPM TOKEN]'],
  [/\bhf_[A-Za-z0-9]{30,}\b/g, '[REDACTED HF TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
];

// Lines like `export API_TOKEN=abc` (env dumps, .env files) in command output.
const ENV_SECRET_LINE = /^(\s*(?:export\s+|set\s+|\$env:)?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)[A-Za-z0-9_]*\s*[=:]\s*)(\S.*)$/gim;

const REDACTION_MARK = '[REDACTED';

/**
 * Mask secrets. `strict` also masks NAME=value lines that look like secret
 * environment variables (used for command output, not for source files).
 */
function redactSecrets(text, { strict = false } = {}) {
  let out = String(text ?? '');
  for (const [re, label] of TOKEN_PATTERNS) out = out.replace(re, label);
  if (strict) out = out.replace(ENV_SECRET_LINE, (_, key) => `${key}[REDACTED]`);
  return out;
}

const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;
const ENV_ALLOWLIST = new Set(['GIT_ASKPASS', 'SSH_AUTH_SOCK', 'TOKENIZERS_PARALLELISM']);

function filterSecretEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAME.test(k) && !ENV_ALLOWLIST.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  realpathSafe,
  isInside,
  toPosix,
  resolveProjectPath,
  isSensitivePath,
  isProtectedPath,
  analyzeCommand,
  splitSegments,
  redactSecrets,
  filterSecretEnv,
  REDACTION_MARK,
};
