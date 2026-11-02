import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { sortAgentMail } from './mailroom.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'omi-mailroom-'));
  const seatDirectory = join(root, 'seat');
  await fs.mkdir(seatDirectory, { mode: 0o700 });
  await fs.mkdir(join(seatDirectory, 'inbox'), { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, seatDirectory, participantId: 'claude-route66', addresses: ['claude'] };
}
function advisory(to, changes = {}) {
  return { protocol: 'omi-advisory/1', id: 'test-' + randomUUID(), kind: 'assignment', from: 'dot', to,
    summary: 'Review a local component.', details: { task: 'Read and report; no command execution.' }, createdAt: new Date().toISOString(), requiresAck: true, ...changes };
}
async function insert(config, payload, changes = {}) {
  const message = { version: 1, id: randomUUID(), participantId: 'dot', topicId: 'coordination-advisory',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload), createdAt: new Date().toISOString(), clientMessageId: randomUUID(), ...changes };
  const path = join(config.seatDirectory, 'inbox', message.id + '.json');
  const bytes = Buffer.from(JSON.stringify(message, null, 2) + '\n');
  await fs.writeFile(path, bytes, { mode: 0o600 });
  return { message, bytes, path, name: message.id + '.json' };
}
const mailPath = (config, folder, name) => join(config.seatDirectory, 'mail', folder, name);
async function exists(path) { try { await fs.lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

test('sorts addressed, alias, explicit broadcast, unaddressed and malformed advisory mail without changing raw transport', async t => {
  const config = await fixture(t);
  const direct = await insert(config, advisory(['claude-route66']));
  const alias = await insert(config, advisory(['claude']));
  const other = await insert(config, advisory(['deepseek']));
  const broadcast = await insert(config, advisory(['all']));
  const plain = await insert(config, 'An unaddressed legacy report.');
  const unknown = await insert(config, { protocol: 'future-protocol/1', to: ['claude'] });
  const malformed = await insert(config, advisory([]));
  const result = await sortAgentMail(config);
  assert.deepEqual(result, { scanned: 7, delivered: 6, addressed: 2, broadcast: 1, unaddressed: 2, quarantined: 1, notForMe: 1, alreadySorted: 0, recoveredReceipts: 0 });
  for (const [item, folder] of [[direct, 'inbox'], [alias, 'inbox'], [broadcast, 'broadcast'], [plain, 'unaddressed'], [unknown, 'unaddressed'], [malformed, 'quarantine']]) {
    assert.deepEqual(await fs.readFile(mailPath(config, folder, item.name)), item.bytes);
    assert.deepEqual(await fs.readFile(item.path), item.bytes);
  }
  for (const folder of ['inbox', 'broadcast', 'unaddressed', 'quarantine']) assert.equal(await exists(mailPath(config, folder, other.name)), false);
  assert.equal((await fs.readdir(join(config.seatDirectory, 'inbox'))).length, 7);
  assert.equal((await fs.readdir(mailPath(config, 'receipts', ''))).length, 7);
  assert.equal((await fs.stat(mailPath(config, 'inbox', direct.name))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(mailPath(config, 'inbox', ''))).mode & 0o777, 0o700);
  const second = await sortAgentMail(config);
  assert.equal(second.delivered, 0); assert.equal(second.alreadySorted, 7);
});

test('broadcast is explicit, has one destination, and own authored messages do not implicitly become addressed mail', async t => {
  const config = await fixture(t);
  const both = await insert(config, advisory(['claude', 'broadcast']), { participantId: config.participantId });
  const mine = await insert(config, advisory(['claude']), { participantId: config.participantId });
  const other = await insert(config, advisory(['deepseek']), { participantId: config.participantId });
  const plain = await insert(config, 'My unaddressed note.', { participantId: config.participantId });
  const result = await sortAgentMail(config);
  assert.equal(result.addressed, 1); assert.equal(result.broadcast, 1); assert.equal(result.notForMe, 1); assert.equal(result.unaddressed, 1);
  assert(await exists(mailPath(config, 'broadcast', both.name)));
  assert.equal(await exists(mailPath(config, 'inbox', both.name)), false);
  assert(await exists(mailPath(config, 'inbox', mine.name)));
  assert.equal(await exists(mailPath(config, 'inbox', other.name)), false);
  assert(await exists(mailPath(config, 'unaddressed', plain.name)));
});

test('malformed recognized recipient lists are quarantined rather than treated as broadcasts', async t => {
  const config = await fixture(t);
  for (const to of [[], '*', ['*'], ['claude', 'CLAUDE'], [123], ['../escape']]) await insert(config, advisory(to));
  const result = await sortAgentMail(config);
  assert.equal(result.quarantined, 6); assert.equal(result.broadcast, 0); assert.equal(result.addressed, 0);
});

test('invalid envelope data is retained as quarantine without being executed or rewritten', async t => {
  const config = await fixture(t);
  const item = await insert(config, 'process.exit(99); never run this.');
  const invalid = { ...item.message, id: randomUUID() };
  const bytes = Buffer.from(JSON.stringify(invalid));
  await fs.writeFile(item.path, bytes);
  const result = await sortAgentMail(config);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(await fs.readFile(mailPath(config, 'quarantine', item.name)), bytes);
  assert.deepEqual(await fs.readFile(item.path), bytes);
});

test('a durable copied file with a missing receipt recovers without a duplicate delivery file', async t => {
  const config = await fixture(t); const item = await insert(config, advisory(['claude']));
  await sortAgentMail(config);
  const destination = mailPath(config, 'inbox', item.name);
  const before = await fs.readFile(destination);
  await fs.unlink(mailPath(config, 'receipts', item.name));
  const result = await sortAgentMail(config);
  assert.equal(result.delivered, 0); assert.equal(result.recoveredReceipts, 1);
  assert.deepEqual(await fs.readFile(destination), before);
  assert.equal((await fs.readdir(mailPath(config, 'inbox', ''))).length, 1);
  assert(await exists(mailPath(config, 'receipts', item.name)));
});

test('raw source, delivered file, receipt and deletion tampering stop instead of silently redelivering', async t => {
  for (const change of ['source', 'destination', 'receipt', 'delete']) {
    await t.test(change, async sub => {
      const config = await fixture(sub); const item = await insert(config, advisory(['claude']));
      await sortAgentMail(config);
      if (change === 'source') await fs.writeFile(item.path, JSON.stringify({ ...item.message, body: 'Changed raw source.' }));
      if (change === 'destination') await fs.writeFile(mailPath(config, 'inbox', item.name), 'Changed copy.');
      if (change === 'receipt') {
        const receipt = JSON.parse(await fs.readFile(mailPath(config, 'receipts', item.name), 'utf8')); receipt.contentHash = '0'.repeat(64);
        await fs.writeFile(mailPath(config, 'receipts', item.name), JSON.stringify(receipt));
      }
      if (change === 'delete') await fs.unlink(mailPath(config, 'inbox', item.name));
      await assert.rejects(sortAgentMail(config), error => ['MAIL_ROUTE_CHANGED', 'MAIL_RECEIPT_CHANGED', 'MAIL_CONTENT_CHANGED'].includes(error.code));
    });
  }
});

test('identity and alias bindings are fixed and a changed alias cannot replay old mail under a new route', async t => {
  const config = await fixture(t); await insert(config, advisory(['deepseek']));
  await sortAgentMail(config);
  await assert.rejects(sortAgentMail({ ...config, addresses: ['deepseek'] }), { code: 'MAIL_BINDING_CHANGED' });
  await assert.rejects(sortAgentMail({ ...config, participantId: 'muse' }), { code: 'MAIL_BINDING_CHANGED' });
  for (const changes of [{ participantId: '../escape' }, { participantId: 'all' }, { addresses: ['broadcast'] }, { addresses: ['claude', 'CLAUDE'] }, { addresses: [config.participantId] }, { addresses: [123] }]) {
    await assert.rejects(sortAgentMail({ ...config, ...changes }), { code: 'INVALID_CONFIG' });
  }
  await assert.rejects(sortAgentMail({ ...config, seatDirectory: resolve('relay/private-seat') }), { code: 'INVALID_CONFIG' });
});

test('unsafe directories and symlink files are refused without changing their targets', async t => {
  const config = await fixture(t); const item = await insert(config, advisory(['claude']));
  const link = join(config.root, 'linked-seat'); await fs.symlink(config.seatDirectory, link);
  await assert.rejects(sortAgentMail({ ...config, seatDirectory: link }), { code: 'UNSAFE_DIRECTORY' });
  const original = join(config.root, 'original.json'); await fs.rename(item.path, original); await fs.symlink(original, item.path);
  await assert.rejects(sortAgentMail(config), { code: 'UNSAFE_FILE' });
  assert.deepEqual(await fs.readFile(original), item.bytes);
  if (process.getuid) {
    await fs.unlink(item.path); await fs.rename(original, item.path); await fs.chmod(config.seatDirectory, 0o755);
    await assert.rejects(sortAgentMail(config), { code: 'UNSAFE_DIRECTORY' });
    await fs.chmod(config.seatDirectory, 0o700);
  }
});

test('concurrent sorts create each working delivery only once and leave no live lock or temporary residue', async t => {
  const config = await fixture(t); await insert(config, advisory(['claude']));
  const results = await Promise.allSettled([sortAgentMail(config), sortAgentMail(config)]);
  const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  assert(fulfilled.length >= 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'MAIL_LOCKED');
  assert.equal(fulfilled.reduce((sum, report) => sum + report.delivered, 0), 1);
  assert.equal((await fs.readdir(mailPath(config, 'inbox', ''))).length, 1);
  assert.equal(await exists(join(config.seatDirectory, 'mail', 'sorting.lock')), false);
  for (const folder of ['inbox', 'broadcast', 'unaddressed', 'quarantine', 'receipts']) assert((await fs.readdir(mailPath(config, folder, ''))).every(name => name.endsWith('.json')));
});

test('a missing raw inbox is an empty first cycle, and old local locks can recover safely', async t => {
  const config = await fixture(t); await fs.rmdir(join(config.seatDirectory, 'inbox'));
  const empty = await sortAgentMail(config); assert.equal(empty.scanned, 0);
  const lock = join(config.seatDirectory, 'mail', 'sorting.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483647, nonce: 'terminated' }), { mode: 0o600 });
  assert.equal((await sortAgentMail(config)).scanned, 0);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'live' }), { mode: 0o600 });
  await assert.rejects(sortAgentMail(config), { code: 'MAIL_LOCKED' });
  assert(await exists(lock));
});

test('a copy in another route is detected rather than silently deleted or leaked into an agent inbox', async t => {
  const config = await fixture(t); const item = await insert(config, advisory(['deepseek']));
  await sortAgentMail(config);
  await fs.writeFile(mailPath(config, 'inbox', item.name), item.bytes, { mode: 0o600 });
  await assert.rejects(sortAgentMail(config), { code: 'MAIL_ROUTE_CHANGED' });
  assert(await exists(mailPath(config, 'inbox', item.name)));
});

test('CLI sorts actual mail and prints counts instead of message contents', async t => {
  const config = await fixture(t);
  const marker = 'PRIVATE-TEST-BODY-MARKER-NOT-A-CREDENTIAL';
  await insert(config, advisory(['claude'], { summary: marker }));
  const result = await execute(process.execPath, ['relay/mailroom.mjs', '--seat-dir', config.seatDirectory, '--participant', config.participantId, '--address', 'claude'], { cwd: resolve('.') });
  const report = JSON.parse(result.stdout);
  assert.equal(report.event, 'agent_mail_sorted'); assert.equal(report.addressed, 1);
  assert.equal((result.stdout + result.stderr).includes(marker), false);
});
