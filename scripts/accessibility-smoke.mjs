import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

if (!existsSync('dist/index.html')) throw new Error('Run npm run build first.');
await mkdir('test-results', { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4178', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', data => { serverOutput += data; });
server.stderr.on('data', data => { serverOutput += data; });
const origin = 'http://127.0.0.1:4178';
const reports = [];
let browser;
let page;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`Preview exited: ${serverOutput}`);
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Preview did not start');
  const executablePath = process.env.OMI_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));

  async function audit(name) {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const summary = {
      name,
      violations: result.violations.map(rule => ({ id: rule.id, impact: rule.impact, description: rule.description, nodes: rule.nodes.map(node => ({ target: node.target, html: node.html, summary: node.failureSummary })) })),
      incomplete: result.incomplete.map(rule => ({ id: rule.id, nodes: rule.nodes.length })),
      passedRules: result.passes.length,
    };
    reports.push(summary);
    await writeFile('test-results/accessibility-audit.json', JSON.stringify(reports, null, 2));
    if (summary.violations.length) console.error(JSON.stringify(summary, null, 2));
    console.log(`${summary.violations.length ? 'FAIL' : 'PASS'}: accessibility audit — ${name}`);
  }
  async function focused(locator) { return locator.evaluate(element => element === document.activeElement); }
  async function activate(locator, key = 'Enter') { await locator.focus(); assert(await focused(locator)); await page.keyboard.press(key); }
  async function nav(name) {
    await activate(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: new RegExp('^' + name) }));
    const heading = page.locator('main h1').first();
    await heading.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('main h1, main'));
    assert((await page.title()).includes(name));
  }

  await page.goto(origin);
  await page.keyboard.press('Tab');
  assert(await focused(page.getByRole('link', { name: 'Skip to content' })));
  await page.keyboard.press('Enter');
  assert(await focused(page.getByRole('main')));
  await audit('overview, locked');
  await activate(page.getByRole('button', { name: 'Create capsule', exact: true }));
  const dialog = page.getByRole('dialog', { name: 'A space that is yours.' });
  await dialog.waitFor();
  assert(await focused(page.getByLabel('What should we call you?')));
  await page.keyboard.type('Accessible Operator');
  await page.keyboard.press('Tab');
  assert(await focused(page.getByLabel('Choose a PIN', { exact: true })));
  await page.keyboard.type('6328791405');
  await page.keyboard.press('Tab');
  await page.keyboard.type('6328791405');
  await audit('capsule creation dialog');
  // Tab must remain in the native modal instead of reaching the inert page.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    assert(await dialog.evaluate(element => element.contains(document.activeElement)));
  }
  await activate(dialog.getByRole('button', { name: 'Create my capsule' }));
  await page.locator('.profile-button').waitFor();
  await nav('Personal Capsule');
  await audit('capsule privacy and preferences');

  await nav('Shared forum');
  await audit('shared forum access form');
  await activate(page.getByRole('button', { name: 'Connect to forum', exact: true }));
  assert(await focused(page.getByLabel('Forum access token', { exact: true })));
  assert.equal(await page.getByLabel('Forum access token', { exact: true }).inputValue(), '');
  console.log('PASS: forum access form labels and empty-token validation remain keyboard accessible');

  await nav('Applications');
  await audit('application catalog');
  const openButton = page.getByRole('button', { name: 'Open', exact: true });
  await activate(openButton);
  await audit('cartridge consent dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Open');
  await activate(openButton);
  await activate(page.getByRole('button', { name: 'Allow & open' }));
  await page.getByRole('dialog', { name: 'Eagle’s Nest family board', exact: true }).waitFor();
  const board = page.frameLocator('iframe[title="Eagle’s Nest family board"]');
  await board.getByLabel('Title', { exact: true }).waitFor();
  await audit('mounted opaque cartridge and modal');
  await board.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.type('A keyboard-created private note');
  await page.keyboard.press('Enter');
  await board.getByRole('heading', { name: 'A keyboard-created private note' }).waitFor();
  await board.locator('#status').filter({ hasText: 'Saved in your Personal Capsule.' }).waitFor();
  await audit('cartridge after keyboard save');
  await board.getByLabel('Title', { exact: true }).focus();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  console.log('PASS: native dialogs trap Tab; Escape and cartridge Escape restore the workspace');

  await nav('Resource sharing');
  await audit('sharing controls, default off');
  await nav('Governance');
  await audit('governance input and gate descriptions');
  await page.getByLabel('Action title').fill('Accessible local review');
  await page.getByLabel('Intended outcome').fill('Record a local artifact using native keyboard controls.');
  await page.getByLabel('Evidence & assumptions').fill('Synthetic accessibility validation data; no external action.');
  await page.locator('#volatility').focus();
  await page.keyboard.press('End');
  await activate(page.getByRole('button', { name: 'Evaluate proposal' }));
  await page.getByRole('heading', { name: 'eKernel containment is active' }).waitFor();
  await audit('containment and human clearance');
  await page.getByLabel('Human clearance reason').fill('Human cleared this local accessibility exercise.');
  await activate(page.getByRole('button', { name: 'Record clearance & resume' }));
  await page.getByRole('heading', { name: 'eKernel containment is active' }).waitFor({ state: 'hidden' });
  await page.locator('#volatility').focus();
  await page.keyboard.press('Home');
  await activate(page.getByRole('button', { name: 'Evaluate proposal' }));
  await page.getByRole('heading', { name: 'Wise Quorum review' }).waitFor();
  await audit('ordered review, current step announced');
  await nav('Canonization Chain');
  await page.getByText('Chain verified', { exact: true }).waitFor();
  await audit('audit history');

  await nav('Codex laboratory');
  await audit('Codex input and help');
  await activate(page.getByRole('button', { name: 'Run simulation', exact: true }));
  const resultHeading = page.getByRole('heading', { name: 'Trajectory complete.' });
  await resultHeading.waitFor();
  assert(await focused(resultHeading));
  await activate(page.getByText(/^Read sampled data/));
  await page.getByRole('table', { name: 'Recorded Codex samples · model units · eight significant digits' }).waitFor();
  assert.equal(await page.locator('.codex-sample-table tbody tr').count(), 20);
  await activate(page.getByRole('button', { name: 'Next page' }));
  await page.getByRole('status').filter({ hasText: 'Showing samples 21–40 of 401' }).waitFor();
  assert(await focused(page.getByRole('button', { name: 'Next page' })));
  await audit('Codex result with equivalent paginated data table');
  console.log('PASS: numerical results have focus, live status and keyboard-readable equivalent data');

  await page.setViewportSize({ width: 390, height: 844 });
  await activate(page.getByRole('button', { name: 'Open navigation' }));
  const mobileNav = page.getByRole('dialog', { name: 'Workspace navigation' });
  await mobileNav.waitFor();
  await audit('mobile navigation dialog');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    assert(await mobileNav.evaluate(element => element.contains(document.activeElement)));
  }
  await page.keyboard.press('Escape');
  assert(await focused(page.getByRole('button', { name: 'Open navigation' })));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  console.log('PASS: mobile keyboard navigation, focus return and reflow');
  assert.deepEqual(runtimeErrors, []);
  const failures = reports.reduce((total, report) => total + report.violations.length, 0);
  assert.equal(failures, 0, `${failures} accessibility rule failures; see test-results/accessibility-audit.json`);
  console.log(`PASS: ${reports.length} audited states, no automatic WCAG A/AA rule violations. Human screen-reader validation remains a separate check.`);
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) console.error('Current visible state:', (await page.locator('body').innerText()).slice(-3000));
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
