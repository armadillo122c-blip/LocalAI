'use strict';

// End-to-end test: launches the real Electron app against the mock Ollama server
// and drives the main workflow with Playwright.
//
//   npm i -D playwright      (once; uses the Electron binary from node_modules)
//   npm run test:e2e         (on Linux without a display: xvfb-run npm run test:e2e)
//
// Screenshots are written to test-results/ (or $SCREENSHOT_DIR).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { startMockOllama } = require('../mock-ollama');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const { execSync } = require('child_process');
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.env.SCREENSHOT_DIR || path.join(ROOT, 'test-results');

async function main() {
  const { _electron: electron } = loadPlaywright();
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await startMockOllama({ delayMs: 12 });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'localai-e2e-data-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-project-'));
  fs.writeFileSync(path.join(project, 'math.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(project, 'test.js'), "const { add } = require('./math');\nif (add(2, 2) !== 4) { console.error('FAIL: add(2,2) = ' + add(2, 2)); process.exit(1); }\nconsole.log('PASS: add works');\n");
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo-project', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2));
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ ollamaUrl: mock.url, model: 'mock-coder:7b', lastProject: project, recentProjects: [project] }, null, 2),
  );

  const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['--no-sandbox', ROOT],
    env: { ...process.env, LOCALAI_USER_DATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.setViewportSize({ width: 1360, height: 860 }).catch(() => {});
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const step = (msg) => console.log(`• ${msg}`);

  try {
    await page.waitForSelector('.status-dot.ok', { timeout: 15000 });
    step('connected to mock Ollama');
    await page.waitForSelector('.welcome');
    await shot('01-welcome');

    // persona picker
    await page.click('#personaSelector');
    await page.waitForSelector('.popover .pop-item');
    await page.waitForTimeout(250);
    const personaNames = await page.$$eval('.popover .pi-name', (els) => els.map((e) => e.textContent));
    for (const n of ['Nexus Code', 'BlockSmith', 'BugZero', 'Architect X', 'Sentinel', 'FlashCode', 'DeepTrace', 'Overdrive', 'UltraCode']) {
      assert.ok(personaNames.some((x) => x.startsWith(n)), `persona ${n} listed`);
    }
    await shot('02-persona-picker');
    await page.click('.popover .pop-item:has-text("BugZero")');
    await page.waitForSelector('#personaSelector:has-text("BugZero")');
    step('switched persona to BugZero');

    // effort picker
    await page.click('#effortSelector');
    await page.waitForSelector('.popover .pop-item:has-text("Maximum")');
    await page.waitForTimeout(250);
    await shot('03-effort-picker');
    await page.click('.popover .pop-item:has-text("High")');
    await page.waitForSelector('#effortSelector:has-text("High")');
    step('effort set to High');

    // run a debugging task
    await page.fill('#input', 'Fix the bug: npm test fails');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.approval-box', { timeout: 20000 });
    step('approval requested for edit');
    await shot('04-approval-diff');
    await page.click('.approval-box .btn.primary');
    await page.waitForSelector('#sendBtn:not(.stop)', { timeout: 30000 });
    await page.waitForTimeout(300);
    const fixed = fs.readFileSync(path.join(project, 'math.js'), 'utf8');
    assert.match(fixed, /a \+ b/, 'math.js fixed');
    const runs = await page.$$eval('.tool .t-name', (els) => els.map((e) => e.textContent));
    assert.ok(runs.includes('Run') && runs.includes('Edit'), runs.join(','));
    step('bug fixed and verified');
    await shot('05-task-done');

    // terminal + undo
    await page.click('#terminalToggle');
    await page.fill('#terminalInput', 'node test.js');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.terminal-output .exit-ok', { timeout: 10000 });
    await shot('06-terminal');
    await page.click('.tool:has(.t-name:text("Edit")) button:has-text("Undo")');
    await page.waitForSelector('.tool-badge.undone');
    assert.match(fs.readFileSync(path.join(project, 'math.js'), 'utf8'), /a - b/, 'undo restored file');
    step('undo restored the original file');

    // UltraCode defaults to Maximum
    await page.click('#personaSelector');
    await page.click('.popover .pop-item:has-text("UltraCode")');
    await page.waitForSelector('#effortSelector:has-text("Maximum")');
    step('UltraCode defaults to Maximum effort');

    // stop button
    await page.click('#newChatBtn');
    await page.fill('#input', 'Do something slow');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sendBtn.stop');
    await page.waitForTimeout(500);
    await shot('07-streaming');
    await page.click('#sendBtn.stop');
    await page.waitForSelector('.notice:has-text("Stopped.")', { timeout: 10000 });
    step('stop button cancelled the task');

    // settings
    await page.click('#settingsBtn');
    await page.waitForSelector('.modal', { timeout: 5000 });
    await shot('08-settings');
    await page.click('.nav-item:has-text("AI Profiles")');
    await page.waitForSelector('.persona-editor');
    await shot('09-personas');
    // create a custom persona
    await page.click('.modal button:has-text("New AI")');
    await page.fill('.persona-editor .field:has(label:text("Name")) input', 'TestBot');
    await page.fill('.persona-editor textarea[rows="12"]', 'You are TestBot, a testing assistant.');
    await page.click('.modal-foot .btn.primary');
    await page.waitForSelector('.persona-row:has-text("TestBot")');
    step('custom persona created');
    await page.click('.nav-item:has-text("Effort")');
    await page.waitForSelector('.effort-table');
    await shot('10-effort-settings');
    await page.click('.nav-item:has-text("Permissions")');
    await shot('11-permissions');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal', { state: 'detached' });
    await page.click('#personaSelector');
    await page.waitForSelector('.popover .pop-item:has-text("TestBot")');
    await page.keyboard.press('Escape');
    step('custom persona appears in the AI picker');

    // light theme renders
    await page.evaluate(async () => {
      await window.api.saveSettings({ theme: 'light' });
      document.documentElement.dataset.theme = 'light';
    });
    await page.click('.list-item:has-text("Fix the bug")');
    await page.waitForSelector('.tool');
    await shot('12-light-theme');
    await page.evaluate(async () => {
      await window.api.saveSettings({ theme: 'dark' });
      document.documentElement.dataset.theme = 'dark';
    });

    // Ollama down → helpful banner
    await mock.close();
    await page.evaluate(() => window.LA.app.refreshOllama({ quiet: false }));
    await page.waitForSelector('.banner.error', { timeout: 10000 });
    await shot('13-ollama-down');
    step('shows a helpful error when Ollama is down');

    assert.deepEqual(errors.filter((e) => !/Notification/.test(e)), [], 'no renderer errors');
    console.log(`\nE2E passed. Screenshots: ${SHOTS}`);
  } catch (err) {
    await shot('failure').catch(() => {});
    console.error('Renderer errors:', errors);
    throw err;
  } finally {
    await app.close().catch(() => {});
    await mock.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
