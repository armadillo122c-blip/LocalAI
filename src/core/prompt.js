'use strict';

// Builds the system prompt: base agent rules + persona + effort + environment.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shellDescription } = require('./shell');
const { IGNORED_DIRS } = require('./tools/files');

const STACK_MARKERS = [
  ['package.json', 'Node.js / JavaScript'],
  ['tsconfig.json', 'TypeScript'],
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['setup.py', 'Python'],
  ['Cargo.toml', 'Rust'],
  ['go.mod', 'Go'],
  ['pom.xml', 'Java (Maven)'],
  ['build.gradle', 'Java/Kotlin (Gradle)'],
  ['build.gradle.kts', 'Kotlin/Java (Gradle)'],
  ['CMakeLists.txt', 'C/C++ (CMake)'],
  ['Makefile', 'Make'],
  ['composer.json', 'PHP'],
  ['Gemfile', 'Ruby'],
  ['pubspec.yaml', 'Dart/Flutter'],
  ['fabric.mod.json', 'Minecraft Fabric mod'],
  ['plugin.yml', 'Minecraft Bukkit/Paper plugin'],
  ['Dockerfile', 'Docker'],
];

/** Short project overview (top-level files, detected stack, npm scripts). */
function projectSummary(root) {
  if (!root) return '';
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return '';
  }
  const names = entries
    .filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name)))
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
  const fileSet = new Set(entries.map((e) => e.name));
  const stack = [...new Set(STACK_MARKERS.filter(([f]) => fileSet.has(f)).map(([, s]) => s))];
  if (entries.some((e) => /\.(sln|csproj)$/.test(e.name))) stack.push('.NET');
  if (entries.some((e) => /\.sk$/.test(e.name))) stack.push('Skript');
  const lines = [];
  lines.push(`Top-level entries: ${names.slice(0, 50).join(', ')}${names.length > 50 ? ` … (+${names.length - 50} more)` : ''}${names.length ? '' : '(empty folder)'}`);
  if (stack.length) lines.push(`Detected stack: ${stack.join(', ')}`);
  if (fileSet.has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const scripts = Object.entries(pkg.scripts || {}).slice(0, 12);
      if (scripts.length) lines.push(`npm scripts: ${scripts.map(([k, v]) => `${k} = ${String(v).slice(0, 60)}`).join('; ')}`);
    } catch {
      /* ignore */
    }
  }
  if (fileSet.has('gradlew.bat') || fileSet.has('gradlew')) lines.push('Gradle wrapper present (use gradlew.bat on Windows).');
  return lines.join('\n');
}

function osName() {
  switch (process.platform) {
    case 'win32':
      return `Windows (${os.release()})`;
    case 'darwin':
      return 'macOS';
    default:
      return 'Linux';
  }
}

const TEXT_TOOL_PROTOCOL = (tools) => `
# Tool use
You can use these tools:
${tools.map((t) => `- ${t.name}: ${t.description}\n  arguments: ${JSON.stringify(t.parameters.properties || {})}`).join('\n')}

To call a tool, reply with a tool call block in exactly this format (valid JSON):
<tool_call>
{"name": "read_file", "arguments": {"path": "src/main.py"}}
</tool_call>
You may write a short sentence before it. After each tool call, wait: the result will arrive in a <tool_result> message. Never invent tool results. When the task is finished, reply normally without any tool call.`;

/**
 * @param {object} o
 * @param {object} o.persona
 * @param {object} o.effort       resolved effort level
 * @param {string|null} o.root   project folder
 * @param {object[]} o.tools     available tool objects
 * @param {'native'|'text'} o.toolMode
 * @param {object} o.settings
 */
function capabilities(can) {
  const abilities = [];
  if (can('read_file')) abilities.push('read files and folders');
  if (can('write_file')) abilities.push('create, edit, move and delete files and folders');
  if (can('run_command')) abilities.push('run terminal commands and programs');
  if (can('web_search') || can('fetch_url')) abilities.push('search the web and read web pages');
  if (!abilities.length) return '';
  return `# Your capabilities
You are not a plain chatbot. LocalAI gives you real tools that act on the user's computer: you can ${abilities.join(', ')}.
When the user asks for something that needs these abilities, call the tool and do it. Never say that you "can't access files", "can't create folders" or "don't have internet access" — you can. If an action is rejected by the user or a tool reports an error, say exactly that instead.
The user may send new messages while you are working; they show up as normal user messages. Read them and adjust what you are doing.`;
}

function buildSystemPrompt({ persona, effort, root, tools, toolMode, settings, homeDir = '', knownFolders = {} }) {
  const names = new Set(tools.map((t) => t.name));
  const can = (n) => names.has(n);
  const parts = [];

  parts.push(persona.systemPrompt.trim());
  const caps = capabilities(can);
  if (caps) parts.push(caps);

  const folders = Object.entries(knownFolders)
    .filter(([, p]) => p)
    .map(([name, p]) => `${name}: ${p}`)
    .join('; ');
  const env = [
    '# Environment',
    `- You are running locally on the user's computer through LocalAI (Ollama).`,
    `- OS: ${osName()}`,
    root
      ? `- Project folder: ${root} (relative paths resolve here)`
      : homeDir
        ? `- No project folder is open. Relative paths resolve to the user's home folder: ${homeDir}. Your tools still work; LocalAI asks the user to approve each file access and command, so just call the tool.`
        : '- No project folder is open.',
    folders ? `- User folders: ${folders}` : null,
    can('run_command') ? `- Shell for run_command: ${shellDescription(settings.shell)}` : null,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
  ].filter(Boolean);
  parts.push(env.join('\n'));

  if (root) {
    const summary = projectSummary(root);
    if (summary) parts.push('# Project overview\n' + summary);
  }

  if (tools.length) {
    const rules = ['# How to work'];
    rules.push('- Use tools to look at real files; never guess file contents, paths or command results.');
    if (can('read_file')) rules.push('- Explore with list_files, search_files and read_file before changing code. Read a file before editing it.');
    if (can('edit_file')) rules.push('- Change files with edit_file (exact, targeted replacements) or write_file (new files or full rewrites). Never paste whole files into chat instead of writing them.');
    else if (root) rules.push('- You cannot modify files with this AI profile. Describe changes instead.');
    if (can('run_command')) {
      rules.push(`- Use run_command to build, test and run code. Commands must be non-interactive (e.g. npm init -y, --yes flags) and finish on their own: never start dev servers or watch modes. Timeout: ${settings.commandTimeoutSec || 120}s.`);
    } else if (root) {
      rules.push('- You cannot run commands with this AI profile. Tell the user which command to run instead.');
    }
    if (can('update_plan')) rules.push('- For multi-step tasks, track progress with update_plan.');
    if (can('web_search')) rules.push('- Use web_search to find current information, documentation or downloads, then fetch_url to read a result.');
    else if (can('fetch_url')) rules.push('- Use fetch_url to read official documentation or GitHub files when you need facts you do not have.');
    if (root) rules.push('- Work inside the project folder; LocalAI asks the user before anything outside it.');
    rules.push('- Do not read or print secrets (.env files, keys, tokens) unless the user asks.');
    rules.push('- If the user rejects an action, do not repeat it; choose another approach or ask.');
    rules.push('- When done, give a brief summary of what you changed and how you verified it. Do not claim something works unless you verified it.');
    parts.push(rules.join('\n'));
  }

  const budget = `You have a budget of ${effort.maxSteps} steps (model turns) and ${effort.maxMinutes} minutes for each task.`;
  parts.push(`# Effort\n${effort.prompt}\n${budget}`);

  parts.push('# Output\nBe concise. Use Markdown. Put code in fenced code blocks with a language tag.');

  if (toolMode === 'text' && tools.length) parts.push(TEXT_TOOL_PROTOCOL(tools));

  return parts.join('\n\n');
}

module.exports = { buildSystemPrompt, projectSummary };
