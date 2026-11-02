import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

if (!existsSync('dist/index.html')) throw new Error('Run npm run build before the browser checks.');
await mkdir('test-results', { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', data => { serverOutput += data; });
server.stderr.on('data', data => { serverOutput += data; });
const origin = 'http://127.0.0.1:4174';
let browser;
let page;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Preview server did not become ready');
  const executablePath = process.env.OMI_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  let outboundAttempts = 0;
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== origin) { outboundAttempts++; await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Your world. In your control.' }).waitFor();
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Create capsule', exact: true }).click();
  await page.getByLabel('What should we call you?').fill('OMI Browser Check');
  await page.getByLabel('Choose a PIN', { exact: true }).fill('8047261935');
  await page.getByLabel('Confirm your PIN').fill('8047261935');
  await page.getByRole('button', { name: 'Create my capsule' }).click();
  await page.locator('.profile-button').waitFor();
  const encrypted = await page.evaluate(() => localStorage.getItem('omi.personal-capsule.v1'));
  assert(encrypted && !encrypted.includes('OMI Browser Check') && !encrypted.includes('8047261935'));
  console.log('PASS: real capsule creation and encrypted local persistence');

  async function nav(name) { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: new RegExp('^' + name) }).click(); }
  async function openNest() {
    await nav('Applications');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByRole('button', { name: 'Allow & open' }).click();
  }
  await nav('Applications');
  await page.getByLabel('Find an application').fill('CORVID');
  assert.equal(await page.locator('.app-card').count(), 1);
  await page.getByLabel('Find an application').fill('');
  await openNest();
  const frame = page.frameLocator('iframe[title="Eagle’s Nest family board"]');
  await frame.getByLabel('Title', { exact: true }).fill('Integration private note');
  await frame.getByLabel('Details').fill('This stays in the encrypted capsule.');
  await frame.getByRole('button', { name: 'Add to the board' }).click();
  await frame.getByRole('heading', { name: 'Integration private note' }).waitFor();
  await frame.getByText('Saved in your Personal Capsule.', { exact: true }).waitFor();
  const child = page.frames().find(value => value.url() === 'about:srcdoc');
  assert(child);
  assert(await child.evaluate(() => { try { void parent.document.body; return false; } catch { return true; } }));
  assert(await child.evaluate(() => { try { void localStorage.length; return false; } catch { return true; } }));
  assert(await child.evaluate(async () => { try { await fetch('https://example.com/blocked'); return false; } catch { return true; } }));
  await child.evaluate(() => { location.href = 'https://example.com/blocked-navigation'; });
  await page.waitForTimeout(150);
  assert.equal(outboundAttempts, 0, 'Cartridge made an outbound network attempt');
  await page.getByRole('button', { name: 'Close cartridge' }).click();
  await page.getByRole('button', { name: 'Lock capsule', exact: true }).click();
  await page.getByRole('button', { name: 'Unlock capsule', exact: true }).click();
  await page.getByLabel('Your PIN', { exact: true }).fill('9999999999');
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock capsule', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not unlock' }).waitFor();
  await page.getByLabel('Your PIN', { exact: true }).fill('8047261935');
  await page.getByRole('dialog').getByRole('button', { name: 'Unlock capsule', exact: true }).click();
  await page.locator('.profile-button').waitFor();
  await openNest();
  await frame.getByRole('heading', { name: 'Integration private note' }).waitFor();
  await page.getByRole('button', { name: 'Close cartridge' }).click();
  console.log('PASS: signed cartridge, durable board data, wrong-PIN rejection, opaque-origin and network isolation');

  await nav('Resource sharing');
  assert(await page.getByRole('switch', { name: 'Load balancing' }).isDisabled());
  await page.getByRole('checkbox', { name: 'I authorize this bounded, local share window.' }).check();
  await page.getByRole('button', { name: 'Authorize window', exact: true }).click();
  await page.getByRole('switch', { name: 'Load balancing' }).check();
  await page.getByRole('button', { name: 'Revoke now' }).click();
  assert(await page.getByRole('switch', { name: 'Load balancing' }).isDisabled());
  console.log('PASS: sharing requires consent and dependent modes revoke together');

  await nav('Governance');
  await page.getByLabel('Action title').fill('Freeze an accountable local artifact');
  await page.getByLabel('Intended outcome').fill('Create a JSON record after local human review. No external action.');
  await page.getByLabel('Evidence & assumptions').fill('Synthetic integration-test proposal; no real-world deployment or safety claim.');
  await page.locator('#volatility').focus();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Evaluate proposal' }).click();
  await page.getByRole('heading', { name: 'eKernel containment is active' }).waitFor();
  assert(await page.getByRole('button', { name: 'Evaluate proposal' }).isDisabled());
  await page.getByLabel('Human clearance reason').fill('Human cleared this synthetic containment exercise; no external action exists.');
  await page.getByRole('button', { name: 'Record clearance & resume' }).click();
  await page.getByRole('heading', { name: 'eKernel containment is active' }).waitFor({ state: 'hidden' });
  await page.locator('#volatility').focus();
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: 'Evaluate proposal' }).click();
  await page.getByRole('heading', { name: 'Wise Quorum review' }).waitFor();
  for (const name of ['Marcus Aurelius', 'Gandhi', 'Sun Tzu', 'Socrates', 'Michelangelo', 'King Solomon']) {
    await page.getByLabel(`Your ${name} review`, { exact: true }).fill(`Recorded human test review from ${name}'s perspective; local artifact only.`);
    await page.getByRole('button', { name: 'Record perspective' }).click();
  }
  await page.getByRole('checkbox', { name: 'I authorize this local JSON artifact.' }).check();
  const artifactPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Authorize & create artifact' }).click();
  const artifactDownload = await artifactPromise;
  await artifactDownload.saveAs('test-results/omi-bundle.json');
  const artifact = JSON.parse(await readFile('test-results/omi-bundle.json', 'utf8'));
  assert.equal(artifact.Output_Summary.execution, 'local-json-artifact-only');
  assert.match(artifact.Integrity_Hash, /^[a-f0-9]{64}$/);
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const { Integrity_Hash, ...unsignedArtifact } = artifact;
  assert.equal(Integrity_Hash, createHash('sha256').update(canonical(unsignedArtifact)).digest('hex'));
  await nav('Canonization Chain');
  await page.getByText('Chain verified', { exact: true }).waitFor();
  const chainPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chain' }).click();
  await (await chainPromise).saveAs('test-results/chain.json');
  const chain = JSON.parse(await readFile('test-results/chain.json', 'utf8'));
  assert.deepEqual(chain.filter(entry => entry.event === 'quorum-review').map(entry => entry.detail.perspective), ['Marcus Aurelius','Gandhi','Sun Tzu','Socrates','Michelangelo','King Solomon']);
  assert(chain.findIndex(entry => entry.event === 'human-authorized') < chain.findIndex(entry => entry.event === 'artifact-created'));
  assert(chain.some(entry => entry.event === 'containment') && chain.some(entry => entry.event === 'containment-cleared'));
  console.log('PASS: containment latch, explicit clearance, fixed review order, authorization, audit-before-artifact and export');

  await nav('Codex laboratory');
  await page.getByLabel('Initial capacity K₀').fill('0');
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'initialK must be greater than zero' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Export JSON', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Reset defaults' }).click();
  await page.getByRole('button', { name: 'Run simulation', exact: true }).click();
  await page.getByRole('heading', { name: 'Trajectory complete.' }).waitFor();
  await page.locator('.codex-chart').waitFor();
  await page.getByText(/^Read sampled data/).waitFor();
  await page.screenshot({ path: 'test-results/codex-desktop.png', fullPage: true });
  const simulationPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  await (await simulationPromise).saveAs('test-results/codex-simulation.json');
  const simulation = JSON.parse(await readFile('test-results/codex-simulation.json', 'utf8'));
  assert.equal(simulation.status, 'completed');
  assert.equal(simulation.samples.length, 401);
  assert.equal(simulation.samples.at(-1).t, simulation.settings.duration);
  assert(Math.abs(simulation.samples.at(-1).K - 2.4215627519) < 1e-7);
  assert(Math.abs(simulation.samples.at(-1).T - 4.0569357273) < 1e-7);
  const csvPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await (await csvPromise).saveAs('test-results/codex-simulation.csv');
  const csv = await readFile('test-results/codex-simulation.csv', 'utf8');
  assert.equal(csv.split('\r\n').length, simulation.samples.length + 1);
  assert(csv.includes('modelVersion') && csv.includes('beta4') && csv.includes(simulation.auditHead));
  await nav('Canonization Chain');
  await page.getByText('Chain verified', { exact: true }).waitFor();
  const updatedChainPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chain' }).click();
  await (await updatedChainPromise).saveAs('test-results/chain-with-codex.json');
  const updatedChain = JSON.parse(await readFile('test-results/chain-with-codex.json', 'utf8'));
  const recordedSimulation = updatedChain.find(entry => entry.hash === simulation.auditHead);
  assert.equal(recordedSimulation.event, 'codex-simulation');
  assert.deepEqual(recordedSimulation.detail.result.samples, simulation.samples);
  console.log('PASS: Codex invalid-input rejection, simulation plots, independently checked endpoint, recorded data and reproducible JSON/CSV exports');

  await page.route('**/cartridges/eagles-nest.bundle.json', async route => {
    const response = await route.fetch();
    const bundle = await response.json();
    bundle.payload = Buffer.from(Buffer.from(bundle.payload, 'base64').toString() + ' ').toString('base64');
    await route.fulfill({ response, json: bundle });
  });
  await openNest();
  await page.getByRole('alert').filter({ hasText: 'Signature verification failed' }).waitFor();
  assert.equal(await page.locator('iframe').count(), 0);
  await page.getByRole('button', { name: 'Close cartridge' }).click();
  console.log('PASS: browser refuses modified signed cartridge before mounting');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await nav('Overview');
  await page.screenshot({ path: 'test-results/overview-mobile.png', fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout overflows horizontally');
  assert.deepEqual(errors, [], 'Browser runtime errors');
  assert.equal(outboundAttempts, 0);
  console.log('PASS: mobile navigation/layout and zero browser runtime errors');
} catch (error) {
  console.error(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: 'test-results/failure.png', fullPage: true }).catch(() => {});
    console.error('Visible failure state:', (await page.locator('body').innerText()).slice(-5000));
  }
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
