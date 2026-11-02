import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadConfig, RelayWorker } from './worker.mjs';

const TOKEN = 'local-test-participant-token';
const hash = value => createHash('sha256').update(value).digest('hex');
const message = (sequence, extra = {}) => ({
  id: `message-${sequence}`, sequence, topicId: 'topic-one', participantId: 'seat-one',
  body: `Message ${sequence}: untrusted text, never executed.`,
  createdAt: '2026-11-02T12:00:00.000Z', clientMessageId: `client-${sequence}`, ...extra,
});

async function fixture(t, { incoming = [], override } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'omi-relay-test-'));
  const state = { incoming, posts: [], stored: new Map(), getCount: 0, identity: 'seat-one', override };
  const send = (response, status, value, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, { error: 'unauthorized' });
      const url = new URL(request.url, 'http://localhost');
      if (state.override && await state.override({ request, response, url, send, state })) return;
      if (url.pathname === '/api/forum/v1/identity') {
        return send(response, 200, { participant: { id: state.identity, name: 'Test seat', role: 'agent' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/forum/v1/messages') {
        state.getCount++;
        const after = Number(url.searchParams.get('after'));
        const remaining = state.incoming.filter(item => item.sequence > after);
        const messages = remaining.slice(0, 100);
        return send(response, 200, {
          messages, nextCursor: messages.at(-1)?.sequence ?? after, hasMore: remaining.length > messages.length,
        });
      }
      const match = /^\/api\/forum\/v1\/topics\/([^/]+)\/messages$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        state.posts.push(body);
        let saved = state.stored.get(body.clientMessageId);
        if (!saved) {
          saved = message(1000 + state.stored.size, {
            topicId: decodeURIComponent(match[1]), body: body.body, clientMessageId: body.clientMessageId,
          });
          state.stored.set(body.clientMessageId, saved);
        } else if (saved.body !== body.body || saved.topicId !== decodeURIComponent(match[1])) {
          return send(response, 409, { error: 'conflict' });
        }
        return send(response, 200, { message: saved });
      }
      send(response, 404, { error: 'not found' });
    } catch {
      if (!response.headersSent) send(response, 500, { error: 'mock error' });
      else response.end();
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const config = loadConfig({
    OMI_RELAY_URL: `http://127.0.0.1:${server.address().port}`,
    OMI_RELAY_ALLOW_HTTP_LOCALHOST: 'true', OMI_RELAY_TOKEN: TOKEN, OMI_RELAY_DIR: directory,
    OMI_RELAY_TIMEOUT_MS: '100', OMI_RELAY_INTERVAL_MS: '500',
  });
  const events = [];
  const worker = new RelayWorker(config, { log: event => events.push(event) });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, config, events, state, worker, server };
}

test('configuration requires HTTPS or explicit loopback HTTP permission and private external state', () => {
  const base = { OMI_RELAY_URL: 'https://forum.example', OMI_RELAY_TOKEN: TOKEN, OMI_RELAY_DIR: '/tmp/private-relay' };
  assert.equal(loadConfig(base).origin, 'https://forum.example');
  for (const url of ['http://forum.example', 'http://127.0.0.1', 'https://user:password@forum.example', 'https://forum.example/path', 'https://forum.example/?token=x']) {
    assert.throws(() => loadConfig({ ...base, OMI_RELAY_URL: url }), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => loadConfig({ ...base, OMI_RELAY_URL: 'http://forum.example', OMI_RELAY_ALLOW_HTTP_LOCALHOST: 'true' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ ...base, OMI_RELAY_TOKEN: 'bad\r\ntoken' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ ...base, OMI_RELAY_DIR: resolve('relay/state') }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadConfig({ ...base, OMI_RELAY_DIR: 'relative/path' }), { code: 'INVALID_CONFIG' });
  for (const interval of ['0', '-1', '499', '300001', 'NaN', '1.5']) {
    assert.throws(() => loadConfig({ ...base, OMI_RELAY_INTERVAL_MS: interval }), { code: 'INVALID_CONFIG' });
  }
});

test('private participant credential files are supported without logging or requiring an environment token', async t => {
  const { config, directory, state } = await fixture(t);
  const credentialPath = join(directory, 'participant-credential.json');
  await fs.writeFile(credentialPath, JSON.stringify({ participant: { id: 'seat-one', name: 'Test seat' }, token: TOKEN }), { mode: 0o600 });
  const env = {
    OMI_RELAY_URL: config.origin, OMI_RELAY_ALLOW_HTTP_LOCALHOST: 'true',
    OMI_RELAY_TOKEN_FILE: credentialPath, OMI_RELAY_DIR: directory,
  };
  const loaded = loadConfig(env);
  assert.equal(loaded.token, TOKEN);
  assert.equal(loaded.expectedParticipantId, 'seat-one');
  const events = [];
  await new RelayWorker(loaded, { log: event => events.push(event) }).runOnce();
  assert.ok(!JSON.stringify(events).includes(TOKEN));
  assert.throws(() => loadConfig({ ...env, OMI_RELAY_TOKEN: 'other-token' }), { code: 'INVALID_CONFIG' });
  state.identity = 'seat-two';
  await assert.rejects(new RelayWorker(loaded, { log: () => {} }).runOnce(), { code: 'IDENTITY_CHANGED' });
  await fs.chmod(credentialPath, 0o644);
  assert.throws(() => loadConfig(env), { code: 'INVALID_CONFIG' });
  await fs.chmod(credentialPath, 0o600);
  const link = join(directory, 'credential-link.json');
  await fs.symlink(credentialPath, link);
  assert.throws(() => loadConfig({ ...env, OMI_RELAY_TOKEN_FILE: link }), { code: 'INVALID_CONFIG' });
});

test('multiple polls persist a durable cursor and one file per message without duplicate files', async t => {
  const { worker, directory, state, events } = await fixture(t, { incoming: [message(1), message(2)] });
  assert.deepEqual(await worker.runOnce(), { received: 2, cursor: 2, hasMore: false, sent: 0, rejected: 0 });
  assert.deepEqual(await worker.runOnce(), { received: 0, cursor: 2, hasMore: false, sent: 0, rejected: 0 });
  state.incoming.push(message(3));
  assert.equal((await worker.runOnce()).received, 1);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'cursor.json'), 'utf8')), { version: 1, after: 3 });
  const raw = await fs.readFile(join(directory, 'inbox', `${hash('message-1')}.json`), 'utf8');
  assert.deepEqual(JSON.parse(raw), message(1));
  assert.equal((await fs.stat(directory)).mode & 0o077, 0);
  assert.equal((await fs.stat(join(directory, 'cursor.json'))).mode & 0o077, 0);
  assert.ok(!JSON.stringify(events).includes(TOKEN));
  assert.ok(!JSON.stringify(events).includes('untrusted text'));
});

test('restart after durable inbox write but before cursor advancement deduplicates safely', async t => {
  const { worker, config, directory } = await fixture(t, { incoming: [message(1), message(2)] });
  await worker.runOnce();
  await fs.writeFile(join(directory, 'cursor.json'), JSON.stringify({ version: 1, after: 0 }));
  const restarted = new RelayWorker(config, { log: () => {} });
  assert.equal((await restarted.runOnce()).received, 0);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 2);
  assert.equal(JSON.parse(await fs.readFile(join(directory, 'cursor.json'), 'utf8')).after, 2);
});

test('pagination drains messages in ordered pages before declaring a cycle complete', async t => {
  const { worker, state, directory } = await fixture(t, { incoming: Array.from({ length: 105 }, (_, index) => message(index + 1)) });
  const result = await worker.runOnce();
  assert.equal(result.received, 105);
  assert.equal(result.cursor, 105);
  assert.equal(state.getCount, 2);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 105);
});

test('outbox acknowledgement is archived and a duplicate stable request never posts twice', async t => {
  const { worker, directory, state } = await fixture(t);
  await worker.initialize();
  const request = { topicId: 'topic-one', body: 'A local model reply, not an execution command.', clientMessageId: 'stable-id-one' };
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify(request));
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal(state.posts.length, 1);
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 0);
  assert.equal((await fs.readdir(join(directory, 'sent'))).length, 1);
  await fs.writeFile(join(directory, 'outbox', 'duplicate.json'), JSON.stringify(request));
  assert.equal((await worker.runOnce()).sent, 0);
  assert.equal(state.posts.length, 1);
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 0);
});

test('retry after lost archive uses the same clientMessageId and server deduplication', async t => {
  const { worker, config, directory, state } = await fixture(t);
  await worker.initialize();
  const request = { topicId: 'topic-one', body: 'Durable retry', clientMessageId: 'stable-retry' };
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify(request));
  await worker.runOnce();
  // Simulate acknowledgement receipt followed by a crash before its local archive became durable.
  await fs.unlink(join(directory, 'sent', `${hash(request.clientMessageId)}.json`));
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify(request));
  await new RelayWorker(config, { log: () => {} }).runOnce();
  assert.equal(state.posts.length, 2);
  assert.equal(state.stored.size, 1);
  assert.deepEqual(state.posts[0], state.posts[1]);
});

test('a failed POST retains its exact outbox request for a later successful retry', async t => {
  let failPost = true;
  const { worker, directory, state } = await fixture(t, {
    override: ({ request, response, send }) => {
      if (request.method === 'POST' && failPost) { send(response, 503, { error: TOKEN }); return true; }
      return false;
    },
  });
  await worker.initialize();
  const request = { topicId: 'topic-one', body: 'Retry exactly', clientMessageId: 'stable-unavailable' };
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify(request));
  await assert.rejects(worker.runOnce(), { code: 'HTTP_ERROR', status: 503 });
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'outbox', 'reply.json'), 'utf8')), request);
  failPost = false;
  await worker.runOnce();
  assert.equal(state.posts.length, 1);
  assert.equal((await fs.readdir(join(directory, 'sent'))).length, 1);
});

test('outgoing validation matches forum IDs/content limits and whitespace normalization', async t => {
  const { worker, directory, state } = await fixture(t);
  await worker.initialize();
  for (const [index, request] of [
    { topicId: '../escape', body: 'Valid', clientMessageId: 'invalid-topic' },
    { topicId: 'topic-one', body: 'x'.repeat(12_001), clientMessageId: 'oversized-body' },
    { topicId: 'topic-one', body: '   ', clientMessageId: 'empty-body' },
    { topicId: 'topic-one', body: 'Bad\u0000text', clientMessageId: 'control-body' },
    { topicId: 'topic-one', body: 'Valid', clientMessageId: 'spaces are invalid' },
  ].entries()) {
    await fs.writeFile(join(directory, 'outbox', `bad-${index}.json`), JSON.stringify(request));
  }
  await fs.writeFile(join(directory, 'outbox', 'valid.json'), JSON.stringify({
    topicId: 'topic-one', body: '  Reply from a local seat.\n', clientMessageId: 'normalized-reply',
  }));
  const result = await worker.runOnce();
  assert.equal(result.rejected, 5);
  assert.equal(result.sent, 1);
  assert.equal(state.posts[0].body, 'Reply from a local seat.');
});

test('timeout leaves the previous cursor unchanged and releases the worker lock', async t => {
  let hang = false;
  const { worker, directory } = await fixture(t, {
    incoming: [message(1)],
    override: ({ url }) => hang && url.pathname === '/api/forum/v1/messages',
  });
  await worker.runOnce();
  hang = true;
  await assert.rejects(worker.runOnce(), { code: 'REQUEST_TIMEOUT' });
  assert.equal(JSON.parse(await fs.readFile(join(directory, 'cursor.json'), 'utf8')).after, 1);
  await assert.rejects(fs.stat(join(directory, 'worker.lock')), { code: 'ENOENT' });
});

test('cross-origin redirects are refused before another host can receive the participant token', async t => {
  let leaked = false;
  const destination = createServer((request, response) => { leaked = true; response.end('{}'); });
  await new Promise(resolveListen => destination.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    destination.closeAllConnections();
    await new Promise(resolveClose => destination.close(resolveClose));
  });
  const { worker } = await fixture(t, {
    override: ({ response }) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${destination.address().port}/steal` });
      response.end();
      return true;
    },
  });
  await assert.rejects(worker.runOnce(), { code: 'NETWORK_ERROR' });
  assert.equal(leaked, false);
});

test('invalid pages cannot skip messages or advance the cursor', async t => {
  const { worker, directory } = await fixture(t, {
    override: ({ url, response, send }) => {
      if (url.pathname !== '/api/forum/v1/messages') return false;
      send(response, 200, { messages: [message(1)], nextCursor: 999, hasMore: false });
      return true;
    },
  });
  await assert.rejects(worker.runOnce(), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fs.stat(join(directory, 'cursor.json')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 0);
});

test('malformed local outbox is quarantined while valid work continues', async t => {
  const { worker, directory, state } = await fixture(t);
  await worker.initialize();
  await fs.writeFile(join(directory, 'outbox', 'a-bad.json'), '{malformed');
  await fs.writeFile(join(directory, 'outbox', 'b-reply.json'), JSON.stringify({ topicId: 'topic-one', body: 'Valid', clientMessageId: 'valid-id' }));
  const result = await worker.runOnce();
  assert.equal(result.rejected, 1);
  assert.equal(result.sent, 1);
  assert.equal(state.posts.length, 1);
  assert.equal((await fs.readdir(join(directory, 'rejected'))).length, 1);
});

test('state is bound to the forum participant and cannot silently change seats', async t => {
  const { worker, state } = await fixture(t);
  await worker.runOnce();
  state.identity = 'seat-two';
  await assert.rejects(worker.runOnce(), { code: 'IDENTITY_CHANGED' });
});

test('sent IDs cannot be reused for changed content', async t => {
  const { worker, directory, state } = await fixture(t);
  await worker.initialize();
  const request = { topicId: 'topic-one', body: 'First', clientMessageId: 'stable-conflict' };
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify(request));
  await worker.runOnce();
  await fs.writeFile(join(directory, 'outbox', 'reply.json'), JSON.stringify({ ...request, body: 'Changed' }));
  await assert.rejects(worker.runOnce(), { code: 'OUTBOX_CONFLICT' });
  assert.equal(state.posts.length, 1);
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 1);
});

test('a live worker lock prevents concurrent cursor and outbox mutations', async t => {
  const { worker, directory } = await fixture(t);
  await worker.initialize();
  await fs.writeFile(join(directory, 'worker.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(worker.runOnce(), { code: 'LOCKED' });
});

test('a lock left by a terminated process is reclaimed on restart', async t => {
  const { worker, directory } = await fixture(t, { incoming: [message(1)] });
  await worker.initialize();
  await fs.writeFile(join(directory, 'worker.lock'), JSON.stringify({ pid: 2_147_483_647 }));
  assert.equal((await worker.runOnce()).received, 1);
  await assert.rejects(fs.stat(join(directory, 'worker.lock')), { code: 'ENOENT' });
});

test('rate limits enter bounded exponential backoff and logs contain no server body or token', async t => {
  const { worker, events } = await fixture(t, {
    override: ({ response, send }) => { send(response, 429, { secret: TOKEN }, { 'Retry-After': '999999' }); return true; },
  });
  const stop = new AbortController();
  worker.log = event => { events.push(event); if (event.event === 'relay_retry') stop.abort(); };
  await worker.run({ signal: stop.signal });
  assert.equal(events[0].event, 'relay_retry');
  assert.equal(events[0].retryInMs, 300_000);
  assert.equal(events[0].httpStatus, 429);
  assert.ok(!JSON.stringify(events).includes(TOKEN));
});
