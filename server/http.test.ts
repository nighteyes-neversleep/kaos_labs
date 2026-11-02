import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ForumStore, type Message, type TopicCreated } from './forum-store';
import { createForumServer, type ForumServerOptions } from './http';

const API = '/api/forum/v1';
let directory: string;
let store: ForumStore;
let server: Server;
let base: string;
let adminToken: string;
let memberToken: string;
let otherToken: string;
let staticDir: string;

async function closeServer() {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function startServer(overrides: Partial<ForumServerOptions> = {}) {
  await closeServer();
  server = createForumServer({ store, staticDir, rateLimit: { requests: 1000, failures: 1000 }, ...overrides });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'omi-forum-http-'));
  staticDir = join(directory, 'public');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>OMI public client</title>');
  writeFileSync(join(staticDir, 'client.js'), 'console.log("public client");');
  store = new ForumStore(join(directory, 'private', 'forum.sqlite'));
  adminToken = randomBytes(32).toString('base64url');
  memberToken = randomBytes(32).toString('base64url');
  otherToken = randomBytes(32).toString('base64url');
  store.createParticipant({ id: 'admin', name: 'Administrator', role: 'admin', token: adminToken });
  store.createParticipant({ id: 'member', name: 'Member', role: 'participant', token: memberToken });
  store.createParticipant({ id: 'other', name: 'Other member', role: 'participant', token: otherToken });
  await startServer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeServer();
  store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function call(path: string, token: string | null = memberToken, method = 'GET', value?: unknown) {
  return fetch(`${base}${API}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

async function createTopic(clientMessageId = 'topic-1', token = memberToken): Promise<TopicCreated> {
  const response = await call('/topics', token, 'POST', { title: 'Shared development', body: 'A real stored message.', clientMessageId });
  expect(response.status).toBe(201);
  return response.json() as Promise<TopicCreated>;
}

function rawGet(path: string, headers: string[] = []) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const target = new URL(base);
    const request = httpRequest({ hostname: target.hostname, port: target.port, path, headers: ['Host', target.host, ...headers] }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', value => { body += value; });
      response.on('end', () => resolve({ status: response.statusCode!, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('authenticated shared forum HTTP boundary', () => {
  it('keeps health public and requires bearer authentication for every forum resource', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'omi-forum' });
    for (const path of ['/identity', '/participants', '/topics', '/messages', '/not-a-route']) {
      expect((await call(path, null)).status).toBe(401);
    }
    const identity = await call('/identity');
    expect(identity.status).toBe(200);
    expect(identity.headers.get('cache-control')).toBe('no-store');
    expect(identity.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await identity.json()).toMatchObject({ participant: { id: 'member', role: 'participant' } });
  });

  it('rejects query/cookie credentials, invalid tokens, and ambiguous Authorization headers', async () => {
    expect((await call(`/identity?token=${memberToken}`, null)).status).toBe(400);
    const cookie = await fetch(`${base}${API}/identity`, { headers: { Cookie: `omiToken=${memberToken}` } });
    expect(cookie.status).toBe(401);
    expect((await call('/identity', randomBytes(32).toString('base64url'))).status).toBe(401);
    const duplicate = await rawGet(`${API}/identity`, ['Authorization', `Bearer ${memberToken}`, 'Authorization', `Bearer ${otherToken}`]);
    expect(duplicate.status).toBe(401);
    expect(duplicate.body).not.toContain(memberToken);
    expect(duplicate.body).not.toContain(otherToken);
  });

  it('enforces administrator identity provisioning and never returns stored credentials', async () => {
    const input = { id: 'new-worker', name: 'New worker', role: 'participant' };
    expect((await call('/participants', memberToken, 'POST', input)).status).toBe(403);
    const created = await call('/participants', adminToken, 'POST', input);
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const result = await created.json() as { participant: { id: string }; token: string };
    expect(result.participant.id).toBe(input.id);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await call('/identity', result.token)).status).toBe(200);
    const listing = await call('/participants', adminToken);
    const text = await listing.text();
    for (const token of [result.token, adminToken, memberToken, otherToken]) expect(text).not.toContain(token);
    expect(text).not.toContain('token_hash');
  });

  it('attributes messages from authentication and refuses forged identity fields', async () => {
    const created = await createTopic();
    expect(created.message.participantId).toBe('member');
    const forged = await call(`/topics/${created.topic.id}/messages`, memberToken, 'POST', { body: 'Forged author', clientMessageId: 'forged', participantId: 'admin' });
    expect(forged.status).toBe(400);
    const response = await call(`/topics/${created.topic.id}/messages`, otherToken, 'POST', { body: 'Independent author', clientMessageId: 'reply' });
    expect(response.status).toBe(201);
    const reply = await response.json() as { message: Message };
    expect(reply.message.participantId).toBe('other');
    expect(reply.message.id).not.toBe(created.message.id);
  });

  it('preserves author-scoped idempotency and rejects changed retry payloads', async () => {
    const first = await createTopic('same-client-id');
    expect(await createTopic('same-client-id')).toEqual(first);
    expect((await call('/topics', memberToken, 'POST', { title: 'Changed', body: first.message.body, clientMessageId: 'same-client-id' })).status).toBe(409);
    const secondAuthor = await createTopic('same-client-id', otherToken);
    expect(secondAuthor.message.id).not.toBe(first.message.id);
    expect((await call(`/topics/${first.topic.id}/messages`, memberToken, 'POST', { body: first.message.body, clientMessageId: 'same-client-id' })).status).toBe(409);
    expect(store.listTopics()).toHaveLength(2);
    expect(store.listMessages({ after: 0, limit: 100 }).messages).toHaveLength(2);
  });

  it('provides global monotone cursor pages without gaps or duplicates', async () => {
    const first = await createTopic('first-topic');
    await createTopic('second-topic');
    for (let index = 0; index < 4; index++) {
      expect((await call(`/topics/${first.topic.id}/messages`, otherToken, 'POST', { body: `Reply ${index}`, clientMessageId: `reply-${index}` })).status).toBe(201);
    }
    const collected: Message[] = [];
    let cursor = 0;
    while (true) {
      const response = await call(`/messages?after=${cursor}&limit=2`);
      expect(response.status).toBe(200);
      const page = await response.json() as { messages: Message[]; nextCursor: number; hasMore: boolean };
      collected.push(...page.messages);
      expect(page.nextCursor).toBeGreaterThanOrEqual(cursor);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(collected.map(message => message.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(collected.map(message => message.id)).size).toBe(6);
    const empty = await call(`/messages?after=${cursor}`);
    expect(await empty.json()).toEqual({ messages: [], nextCursor: cursor, hasMore: false });
    for (const query of ['after=-1', 'after=1.5', 'after=9007199254740992', 'limit=0', 'limit=201', 'after=0&after=2', 'callback=steal']) {
      expect((await call(`/messages?${query}`)).status).toBe(400);
    }
  });

  it('rejects cross-origin browser requests and provides no wildcard CORS policy', async () => {
    const denied = await fetch(`${base}${API}/identity`, { headers: { Authorization: `Bearer ${memberToken}`, Origin: 'https://unrelated.example' } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const sameOrigin = await fetch(`${base}${API}/identity`, { headers: { Authorization: `Bearer ${memberToken}`, Origin: base } });
    expect(sameOrigin.status).toBe(200);
    const preflight = await fetch(`${base}${API}/topics`, { method: 'OPTIONS', headers: { Origin: 'https://unrelated.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('bounds body parsing and accepts only valid UTF-8 JSON objects', async () => {
    const url = `${base}${API}/topics`;
    const authorization = { Authorization: `Bearer ${memberToken}` };
    const cases: [string, string, number][] = [
      ['text/plain', '{}', 415],
      ['application/json', '{"title":', 400],
      ['application/json', '[]', 400],
      ['application/json', 'null', 400],
      ['application/json', JSON.stringify({ title: 'Large', body: 'x'.repeat(70_000), clientMessageId: 'too-large' }), 413],
    ];
    for (const [type, body, status] of cases) {
      const response = await fetch(url, { method: 'POST', headers: { ...authorization, 'Content-Type': type }, body });
      expect(response.status).toBe(status);
    }
    const compressed = await fetch(url, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: '{}' });
    expect(compressed.status).toBe(415);
    const invalidUtf8 = await fetch(url, { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) });
    expect(invalidUtf8.status).toBe(400);
    expect(store.listTopics()).toHaveLength(0);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('rate limits failed authentication using the socket address rather than spoofable forwarded headers', async () => {
    await startServer({ rateLimit: { requests: 100, failures: 2, windowMs: 60_000 } });
    const request = (forwarded: string) => fetch(`${base}${API}/identity`, { headers: { 'X-Forwarded-For': forwarded } });
    expect((await request('192.0.2.1')).status).toBe(401);
    expect((await request('192.0.2.2')).status).toBe(401);
    const limited = await request('192.0.2.3');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('applies revocation immediately while retaining prior authorship', async () => {
    const created = await createTopic();
    expect((await call('/participants/member/revoke', otherToken, 'POST', {})).status).toBe(403);
    expect((await call('/participants/member/revoke', adminToken, 'POST', {})).status).toBe(200);
    expect((await call('/identity', memberToken)).status).toBe(401);
    expect((await call(`/topics/${created.topic.id}/messages`, memberToken, 'POST', { body: 'Stale credentials', clientMessageId: 'after-revoke' })).status).toBe(401);
    const identities = await call('/participants', otherToken);
    expect(await identities.json()).toMatchObject({ participants: expect.arrayContaining([expect.objectContaining({ id: 'member', name: 'Member' })]) });
    expect(store.listMessages({ after: 0, limit: 100 }).messages[0].participantId).toBe('member');
  });

  it('requires an administrator to rotate credentials and invalidates the old token immediately', async () => {
    const created = await createTopic();
    expect((await call('/participants/member/rotate', otherToken, 'POST', {})).status).toBe(403);
    const response = await call('/participants/member/rotate', adminToken, 'POST', {});
    expect(response.status).toBe(200);
    const value = await response.json() as { participant: { id: string }; token: string };
    expect(value.participant.id).toBe('member');
    expect(value.token).not.toBe(memberToken);
    expect((await call('/identity', memberToken)).status).toBe(401);
    expect((await call('/identity', value.token)).status).toBe(200);
    expect(store.listMessages({ after: 0, limit: 100 }).messages[0].topicId).toBe(created.topic.id);
    expect((await call('/participants/member/revoke', adminToken, 'POST', {})).status).toBe(200);
    expect((await call('/participants/member/rotate', adminToken, 'POST', {})).status).toBe(409);
  });

  it('rechecks administrator authorization after a slow body before issuing a credential', async () => {
    let authenticated!: () => void;
    const observed = new Promise<void>(resolve => { authenticated = resolve; });
    const original = store.authenticate.bind(store);
    vi.spyOn(store, 'authenticate').mockImplementation(token => {
      const actor = original(token);
      if (token === adminToken) authenticated();
      return actor;
    });
    const value = JSON.stringify({ id: 'must-not-exist', name: 'Unapproved worker', role: 'admin' });
    const target = new URL(base);
    let request!: ReturnType<typeof httpRequest>;
    const result = new Promise<number>((resolve, reject) => {
      request = httpRequest({ hostname: target.hostname, port: target.port, path: `${API}/participants`, method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(value) } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode!));
      });
      request.on('error', reject);
      request.write(value.slice(0, 1));
    });
    await observed;
    store.revokeParticipant('admin');
    request.end(value.slice(1));
    expect(await result).toBe(401);
    expect(store.listParticipants().some(actor => actor.id === 'must-not-exist')).toBe(false);
  });

  it('serves only compiled public assets and refuses traversal, hidden files, and escaping symlinks', async () => {
    const secret = 'PRIVATE-TEST-MARKER-NOT-A-CREDENTIAL';
    const privateFile = join(directory, 'private', 'private.txt');
    writeFileSync(privateFile, secret);
    writeFileSync(join(staticDir, '.hidden'), secret);
    symlinkSync(privateFile, join(staticDir, 'escape.txt'));
    const client = await fetch(`${base}/client.js`);
    expect(client.status).toBe(200);
    expect(client.headers.get('content-type')).toContain('javascript');
    const head = await fetch(`${base}/client.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const path of ['/.hidden', '/%2e%2e%2fprivate%2fprivate.txt', '/%2e%2e%5cprivate%5cprivate.txt', '/escape.txt', '/.omi-dev/cartridge-signing-key.pem']) {
      const response = await rawGet(path);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(secret);
    }
    const shell = await fetch(`${base}/`);
    expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
