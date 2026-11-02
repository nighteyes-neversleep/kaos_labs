import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AdvisoryError, enqueueAdvisory, validateAdvisory } from './advisory.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = resolve(ROOT, 'relay/advisory.mjs');
const packet = changes => ({
  protocol: 'omi-advisory/1', id: 'dot-plan-001', kind: 'assignment', from: 'dot', to: ['gemini', 'claude'],
  taskId: 'QA-001', summary: 'Review relay recovery and report reproducible findings.',
  details: { source: { revision: 'example-revision', paths: ['relay/git-worker.mjs'] }, checks: ['crash recovery', 'duplicate delivery'] },
  createdAt: '2026-11-02T20:00:00.000Z', requiresAck: true, ...changes,
});
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'omi-advisory-'));
  const outbox = join(directory, 'outbox');
  await fs.mkdir(outbox, { mode: 0o700 });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, outbox };
}
const hash = id => createHash('sha256').update(id).digest('hex');
const queuePath = (outbox, id) => join(outbox, `advisory-${hash(id)}.json`);
const errorCode = code => error => error instanceof AdvisoryError && error.code === code;

test('validation produces a canonical independent JSON snapshot', () => {
  const value = packet({ details: { z: [1, false, null], a: { second: 2, first: 1 } }, summary: '  Readable status.  ' });
  const actual = validateAdvisory(value);
  assert.equal(actual.summary, 'Readable status.');
  assert.deepEqual(Object.keys(actual.details), ['a', 'z']);
  assert.deepEqual(Object.keys(actual.details.a), ['first', 'second']);
  value.details.a.first = 999;
  value.to.push('muse');
  assert.equal(actual.details.a.first, 1);
  assert.deepEqual(actual.to, ['gemini', 'claude']);
  assert.equal(validateAdvisory(packet({ kind: 'ack', details: null })).kind, 'ack');
});

test('schema refuses invalid roles, identities, recipients, dates, unknown fields and missing fields', () => {
  const invalid = [
    null, [], packet({ protocol: 'unverified-protocol' }), packet({ kind: 'execute' }), packet({ id: 123 }),
    packet({ from: '../operator' }), packet({ to: [] }), packet({ to: ['muse', 'MUSE'] }), packet({ to: [12] }),
    packet({ to: new Array(1) }), packet({ to: Array.from({ length: 33 }, (_, i) => `seat-${i}`) }),
    packet({ taskId: 'x'.repeat(101) }), packet({ summary: ' ' }), packet({ summary: 'x'.repeat(601) }),
    packet({ createdAt: '2026-11-02' }), packet({ createdAt: 'not-a-date' }), packet({ requiresAck: 'yes' }), packet({ extra: true }),
  ];
  for (const value of invalid) assert.throws(() => validateAdvisory(value), AdvisoryError);
  const absent = packet(); delete absent.details;
  assert.throws(() => validateAdvisory(absent), AdvisoryError);
  let read = false;
  const getter = packet(); Object.defineProperty(getter, 'summary', { enumerable: true, get() { read = true; return 'No'; } });
  assert.throws(() => validateAdvisory(getter), AdvisoryError);
  assert.equal(read, false);
});

test('common credential-shaped keys are refused at every nesting level without inspecting values', () => {
  for (const field of ['token', 'apiKey', 'password', 'PIN', 'secret', 'privateKey', 'access_token', 'refreshToken', 'client-secret', 'Authorization']) {
    assert.throws(() => validateAdvisory(packet({ details: { nested: [{ [field]: 'synthetic-value-never-log' }] } })), errorCode('CREDENTIAL_FIELD'));
  }
  assert.throws(() => validateAdvisory(packet({ token: 'synthetic-value-never-log' })), errorCode('CREDENTIAL_FIELD'));
  // A key heuristic cannot discover a credential hidden in free text; do not
  // claim that it can. Legitimate descriptions about token handling remain text.
  assert.equal(validateAdvisory(packet({ details: { note: 'Review how credentials are handled.' } })).details.note, 'Review how credentials are handled.');
});

test('details reject lossy/non-JSON data, getters, cycles and excessive structure', () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), cycle, [undefined], new Array(2)]) {
    assert.throws(() => validateAdvisory(packet({ details: value })), AdvisoryError);
  }
  let read = false;
  const getter = []; Object.defineProperty(getter, '0', { enumerable: true, get() { read = true; return 1; } });
  assert.throws(() => validateAdvisory(packet({ details: getter })), AdvisoryError);
  assert.equal(read, false);
  let deep = null; for (let i = 0; i < 30; i++) deep = { next: deep };
  assert.throws(() => validateAdvisory(packet({ details: deep })), errorCode('DETAIL_LIMIT'));
  assert.throws(() => validateAdvisory(packet({ details: Array(4096).fill(0) })), errorCode('DETAIL_LIMIT'));
});

test('the serialized transport body is bounded even when individual strings fit', () => {
  assert.throws(() => validateAdvisory(packet({ details: { first: 'x'.repeat(6000), second: 'y'.repeat(6000) } })), errorCode('BODY_TOO_LARGE'));
  assert.throws(() => validateAdvisory(packet({ details: { code: 'x'.repeat(12_001) } })), AdvisoryError);
});

test('queue creates the existing transport envelope with private durable files and no temporary residue', async t => {
  const { outbox } = await fixture(t);
  const value = packet();
  const result = await enqueueAdvisory(outbox, value);
  assert.equal(result.status, 'queued');
  assert.equal(result.id, value.id);
  const envelope = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.deepEqual(Object.keys(envelope), ['topicId', 'body', 'clientMessageId']);
  assert.equal(envelope.topicId, 'coordination-advisory');
  assert.equal(envelope.clientMessageId, value.id);
  assert.deepEqual(JSON.parse(envelope.body), validateAdvisory(value));
  assert.equal(envelope.body.length <= 12_000, true);
  if (process.platform !== 'win32') assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(outbox), [result.path.split(/[\\/]/).at(-1)]);
});

test('equivalent requeue is idempotent; changed content under the same ID cannot overwrite it', async t => {
  const { outbox } = await fixture(t);
  const original = packet({ details: { z: 1, a: 2 } });
  const first = await enqueueAdvisory(outbox, original);
  const bytes = await fs.readFile(first.path, 'utf8');
  const again = await enqueueAdvisory(outbox, packet({ details: { a: 2, z: 1 } }));
  assert.equal(again.status, 'already-queued');
  await assert.rejects(enqueueAdvisory(outbox, packet({ summary: 'Different work.' })), errorCode('ID_CONFLICT'));
  assert.equal(await fs.readFile(first.path, 'utf8'), bytes);
  assert.equal((await fs.readdir(outbox)).length, 1);
});

test('snapshot is captured before awaits and transport requeue retains the stable request ID', async t => {
  const { outbox } = await fixture(t);
  const value = packet({ details: { state: 'before' } });
  const pending = enqueueAdvisory(outbox, value);
  value.details.state = 'after';
  const result = await pending;
  const first = JSON.parse(await fs.readFile(result.path, 'utf8'));
  assert.equal(JSON.parse(first.body).details.state, 'before');
  await fs.unlink(result.path); // Represents a relay that acknowledged/archived it.
  const requeued = await enqueueAdvisory(outbox, packet({ details: { state: 'before' } }));
  assert.equal(requeued.status, 'queued');
  assert.equal(JSON.parse(await fs.readFile(requeued.path, 'utf8')).clientMessageId, value.id);
});

test('existing manual-producer filenames share stable request-ID protection', async t => {
  const { outbox } = await fixture(t);
  const value = packet();
  const manual = join(outbox, 'manually-queued.json');
  await fs.writeFile(manual, JSON.stringify({ topicId: 'coordination-advisory', body: JSON.stringify(validateAdvisory(value)), clientMessageId: value.id }), { mode: 0o600 });
  assert.deepEqual(await enqueueAdvisory(outbox, value), { status: 'already-queued', id: value.id, path: manual });
  await assert.rejects(enqueueAdvisory(outbox, packet({ summary: 'Changed request.' })), errorCode('ID_CONFLICT'));
  assert.deepEqual(await fs.readdir(outbox), ['manually-queued.json']);
});

test('concurrent conflicting producers never replace the winning advisory', async t => {
  const { outbox } = await fixture(t);
  const values = [packet({ summary: 'First candidate.' }), packet({ summary: 'Second candidate.' })];
  const results = await Promise.allSettled(values.map(value => enqueueAdvisory(outbox, value)));
  const winning = results.map((result, i) => ({ result, i })).filter(item => item.result.status === 'fulfilled');
  assert.equal(winning.length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert(['QUEUE_BUSY', 'ID_CONFLICT'].includes(failure.reason.code));
  const envelope = JSON.parse(await fs.readFile(winning[0].result.value.path, 'utf8'));
  assert.equal(JSON.parse(envelope.body).summary, values[winning[0].i].summary);
  assert.equal((await fs.readdir(outbox)).length, 1);
});

test('unsafe/private paths and symlink destinations are refused without modifying targets', async t => {
  const { directory, outbox } = await fixture(t);
  await assert.rejects(enqueueAdvisory('relative-path', packet()), errorCode('INVALID_OUTBOX'));
  await assert.rejects(enqueueAdvisory(ROOT, packet()), errorCode('INVALID_OUTBOX'));
  await assert.rejects(enqueueAdvisory(join(directory, 'absent'), packet()), errorCode('INVALID_OUTBOX'));
  const linked = join(directory, 'linked'); await fs.symlink(outbox, linked, 'dir');
  await assert.rejects(enqueueAdvisory(linked, packet()), errorCode('INVALID_OUTBOX'));
  if (process.platform !== 'win32') {
    await fs.chmod(outbox, 0o755);
    await assert.rejects(enqueueAdvisory(outbox, packet()), errorCode('INVALID_OUTBOX'));
    await fs.chmod(outbox, 0o700);
  }
  const target = join(directory, 'preserve.txt'); await fs.writeFile(target, 'preserve this fixture', { mode: 0o600 });
  await fs.symlink(target, queuePath(outbox, packet().id));
  await assert.rejects(enqueueAdvisory(outbox, packet()), errorCode('INVALID_FILE'));
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve this fixture');
});

test('an active producer lock is preserved and a terminated producer lock can recover', async t => {
  const { outbox } = await fixture(t);
  const lock = join(outbox, `.advisory-${hash(packet().id)}.lock`);
  await fs.writeFile(lock, JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600 });
  await assert.rejects(enqueueAdvisory(outbox, packet()), errorCode('QUEUE_BUSY'));
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid);
  await fs.writeFile(lock, JSON.stringify({ version: 1, pid: 2_147_483_647 }), { mode: 0o600 });
  assert.equal((await enqueueAdvisory(outbox, packet())).status, 'queued');
  assert.equal((await fs.readdir(outbox)).length, 1);
});

test('CLI queues a real input file and prints metadata only, without contents', async t => {
  const { directory, outbox } = await fixture(t);
  const input = join(directory, 'advisory.json');
  const value = packet({ summary: 'BODY-MUST-NOT-BE-LOGGED', details: { marker: 'PRIVATE-NOTE-MUST-NOT-BE-LOGGED' } });
  await fs.writeFile(input, JSON.stringify(value), { mode: 0o600 });
  const stdout = execFileSync(process.execPath, [CLI, '--outbox', outbox, '--file', input], { encoding: 'utf8' });
  const result = JSON.parse(stdout);
  assert.equal(result.event, 'advisory_queued');
  assert.equal(result.status, 'queued');
  assert.equal(result.id, value.id);
  assert(!stdout.includes(value.summary));
  assert(!stdout.includes(value.details.marker));
  assert.equal(JSON.parse(JSON.parse(await fs.readFile(result.path, 'utf8')).body).summary, value.summary);
});

test('CLI malformed JSON/UTF-8 and credential field errors fail without echoing input', async t => {
  const { directory, outbox } = await fixture(t);
  for (const [name, contents] of [
    ['broken', '{"summary":"PRIVATE-INPUT-DO-NOT-ECHO"'],
    ['utf8', Buffer.from([0xff])],
    ['credential', JSON.stringify(packet({ details: { apiKey: 'PRIVATE-INPUT-DO-NOT-ECHO' } }))],
  ]) {
    const input = join(directory, `${name}.json`);
    await fs.writeFile(input, contents, { mode: 0o600 });
    let failure;
    try { execFileSync(process.execPath, [CLI, '--outbox', outbox, '--file', input], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failure = error; }
    assert.equal(failure?.status, 1);
    assert.equal(JSON.parse(failure.stderr).event, 'advisory_error');
    assert(!String(failure.stderr).includes('PRIVATE-INPUT-DO-NOT-ECHO'));
  }
  assert.deepEqual(await fs.readdir(outbox), []);
});
