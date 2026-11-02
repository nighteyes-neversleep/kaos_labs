import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { ForumStore } from '../server/forum-store.ts';
import { createForumServer } from '../server/http.ts';

if (!existsSync('dist/index.html')) throw new Error('Run npm run build before the forum browser checks.');
await mkdir('test-results', { recursive: true });

// Synthetic identities and tokens exist only in this disposable test process.
// No real user database, credential file, external forum, or model is accessed.
const store = new ForumStore(':memory:');
const access = randomBytes(32).toString('base64url');
store.createParticipant({ id: 'test-ui', name: 'Forum Keyboard User', role: 'participant', token: access });
const other = store.createParticipant({ id: 'test-other', name: 'Other Participant', role: 'participant', token: randomBytes(32).toString('base64url') });
const server = createForumServer({ store, staticDir: resolve('dist'), rateLimit: { requests: 2000 } });
let browser;
let page;
const audits = [];
try {
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', accept);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.OMI_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));

  async function activate(locator) {
    await locator.focus();
    assert(await locator.evaluate(element => element === document.activeElement));
    await page.keyboard.press('Enter');
  }
  async function audit(name) {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    const report = {
      name,
      violations: result.violations.map(rule => ({ id: rule.id, impact: rule.impact, targets: rule.nodes.map(node => node.target) })),
      incomplete: result.incomplete.map(rule => ({ id: rule.id, nodes: rule.nodes.length })),
      passedRules: result.passes.length,
    };
    audits.push(report);
    await writeFile('test-results/forum-browser-audit.json', JSON.stringify(audits, null, 2));
    assert.deepEqual(report.violations, [], `Automatic accessibility failures in ${name}`);
  }
  async function refresh() {
    await activate(page.getByRole('button', { name: 'Refresh forum', exact: true }));
    await page.waitForFunction(() => {
      const button = document.querySelector('.forum-refresh button');
      return button && !button.disabled;
    });
  }

  await page.goto(origin);
  await activate(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Shared forum/ }));
  await page.getByRole('heading', { name: 'Shared forum', exact: true }).waitFor();
  await audit('forum token login without a Personal Capsule');
  await page.getByLabel('Forum access token', { exact: true }).fill(access);
  await activate(page.getByRole('button', { name: 'Connect to forum', exact: true }));
  await page.getByText('Forum Keyboard User', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.equal(await context.cookies().then(cookies => cookies.length), 0);
  await audit('authenticated empty forum');
  console.log('PASS: real API identity, separate forum authentication, and no persistent browser token storage');

  await activate(page.getByRole('button', { name: 'New topic', exact: true }));
  assert(await page.getByLabel('Topic title', { exact: true }).evaluate(element => element === document.activeElement));
  await page.getByLabel('Topic title', { exact: true }).fill('An authenticated conversation');
  await page.getByLabel('First message', { exact: true }).fill('The first server-backed test message.');
  await activate(page.getByRole('button', { name: 'Create topic', exact: true }));
  await page.getByRole('heading', { name: 'An authenticated conversation', exact: true }).waitFor();
  await page.locator('.forum-message-body').filter({ hasText: 'The first server-backed test message.' }).waitFor();
  const topic = store.listTopics()[0];
  assert(topic);
  assert.equal(store.listMessages({ after: 0, limit: 200, topicId: topic.id }).messages[0].participantId, 'test-ui');
  store.postReply(other, topic.id, { body: 'An unseen reply from another participant.', clientMessageId: randomUUID() });

  let loseAcknowledgement = true;
  const attempts = [];
  await page.route('**/api/forum/v1/topics/*/messages', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON().clientMessageId);
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      // Commit at the real server, then lose its response as a network failure.
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  const reply = page.getByLabel('Reply to An authenticated conversation', { exact: true });
  await reply.fill('A retry-safe reply.');
  await activate(page.getByRole('button', { name: 'Post reply', exact: true }));
  await page.getByRole('alert').waitFor();
  assert.equal(await reply.inputValue(), 'A retry-safe reply.');
  await activate(page.getByRole('button', { name: 'Post reply', exact: true }));
  await page.locator('.forum-message-body').filter({ hasText: 'A retry-safe reply.' }).waitFor();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(store.listMessages({ after: 0, limit: 200, topicId: topic.id }).messages.length, 3);
  await refresh();
  await page.locator('.forum-message-body').filter({ hasText: 'An unseen reply from another participant.' }).waitFor();
  assert.equal(await page.locator('.forum-message').count(), 3);
  await refresh();
  assert.equal(await page.locator('.forum-message').count(), 3);
  await page.locator('.forum-message h3').filter({ hasText: 'Other Participant' }).waitFor();
  console.log('PASS: acknowledged topic creation, lost-response retries, stable IDs, attribution and unseen-message cursor safety');

  for (let index = 0; index < 105; index++) {
    store.postReply(other, topic.id, { body: `Historical message ${index + 1}`, clientMessageId: randomUUID() });
  }
  await refresh();
  await page.getByRole('button', { name: 'Load next 100 messages', exact: true }).waitFor();
  assert.equal(await page.locator('.forum-message').count(), 103);
  await activate(page.getByRole('button', { name: 'Load next 100 messages', exact: true }));
  await page.locator('.forum-message-body').filter({ hasText: 'Historical message 105' }).waitFor();
  assert.equal(await page.locator('.forum-message').count(), 108);
  await refresh();
  assert.equal(await page.locator('.forum-message').count(), 108);
  await audit('populated and paginated forum thread');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.workspace')).marginLeft === '0px');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Forum overflows the mobile viewport');
  await audit('mobile forum thread');
  console.log('PASS: 100-record pagination through 108 messages, duplicate-free refresh, accessible thread and mobile reflow');

  store.revokeParticipant('test-ui');
  await activate(page.getByRole('button', { name: 'Refresh forum', exact: true }));
  await page.getByLabel('Forum access token', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Forum access token', { exact: true }).inputValue(), '');
  assert.equal(await page.locator('.forum-message').count(), 0);
  await page.route('**/api/forum/v1/identity', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html>Backend missing</html>' }));
  await page.getByLabel('Forum access token', { exact: true }).fill(access);
  await activate(page.getByRole('button', { name: 'Connect to forum', exact: true }));
  await page.getByRole('alert').filter({ hasText: 'Forum service is not running' }).waitFor();
  assert.deepEqual(runtimeErrors, []);
  console.log('PASS: revocation clears the session, non-JSON backends produce an honest error, and no browser runtime errors');
  console.log(`PASS: ${audits.length} automatic WCAG A/AA audit states. This does not substitute for human screen-reader testing.`);
} catch (error) {
  console.error(error);
  // Do not dump input values, request headers, or test credentials on failure.
  if (page && !page.isClosed()) console.error('Visible forum state:', (await page.locator('body').innerText()).slice(-4000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(accept => server.close(accept));
  }
  store.close();
}
