import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForumStore, ForumStoreError, type Participant } from './forum-store';

let dir: string;
let path: string;
let store: ForumStore;
let alice: Participant;
let bob: Participant;
const ALICE_TOKEN = 'alice-secret-token-3e42b69cde';
const BOB_TOKEN = 'bob-secret-token-934ab93acda';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omi-forum-store-'));
  path = join(dir, 'private', 'forum.sqlite');
  store = new ForumStore(path);
  alice = store.createParticipant({ id: 'alice', name: 'Alice', role: 'admin', token: ALICE_TOKEN });
  bob = store.createParticipant({ id: 'route66', name: 'Route 66 worker', role: 'participant', token: BOB_TOKEN });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

function topic(clientMessageId = 'topic-1') {
  return store.createTopic(alice, { title: 'OMI development', body: 'What should we build next?', clientMessageId });
}

describe('durable authenticated forum store', () => {
  it('authenticates separate participant identities and never returns or persists raw tokens', () => {
    expect(store.authenticate(ALICE_TOKEN)).toEqual(alice);
    expect(store.authenticate(BOB_TOKEN)).toEqual(bob);
    const namesake = store.createParticipant({ id: 'alice-namesake', name: 'Alice', role: 'participant', token: 'namesake-token-c2be84d9637d' });
    expect(namesake.name).toBe(alice.name);
    expect(namesake.id).not.toBe(alice.id);
    expect(store.authenticate('namesake-token-c2be84d9637d')).toEqual(namesake);
    expect(store.authenticate('wrong-token-with-enough-characters')).toBeNull();
    expect(store.authenticate('')).toBeNull();
    expect(Object.keys(alice).sort()).toEqual(['createdAt', 'id', 'name', 'role']);
    expect(readFileSync(path).toString('latin1')).not.toContain(ALICE_TOKEN);
    // Closing checkpoints the WAL, so inspect the complete database as well.
    store.close();
    expect(readFileSync(path).toString('latin1')).not.toContain(ALICE_TOKEN);
    expect(readFileSync(path).toString('latin1')).not.toContain(BOB_TOKEN);
    store = new ForumStore(path);
    expect(store.authenticate(ALICE_TOKEN)?.name).toBe('Alice');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('starts without seeded conversations and persists a topic plus independent replies', () => {
    expect(store.listTopics()).toEqual([]);
    expect(store.listMessages({ after: 0, limit: 20 })).toEqual({ messages: [], nextCursor: 0, hasMore: false });
    const created = topic();
    const reply = store.postReply(bob, created.topic.id, { body: 'I can work on the local worker.', clientMessageId: 'reply-1' });
    expect(created.message.participantId).toBe(alice.id);
    expect(reply.participantId).toBe(bob.id);
    expect(reply.sequence).toBeGreaterThan(created.message.sequence);
    expect(reply.id).not.toBe(created.message.id);
    store.close();
    store = new ForumStore(path);
    expect(store.getTopic(created.topic.id)).toEqual(created.topic);
    expect(store.listMessages({ after: 0, limit: 20 }).messages).toEqual([created.message, reply]);
  });

  it('returns the original result for identical retries without new messages or topics', () => {
    const created = topic();
    expect(topic()).toEqual(created);
    const input = { body: 'Acknowledged', clientMessageId: 'reply-1' };
    const reply = store.postReply(bob, created.topic.id, input);
    expect(store.postReply(bob, created.topic.id, input)).toEqual(reply);
    expect(store.listTopics()).toHaveLength(1);
    expect(store.listMessages({ after: 0, limit: 20 }).messages).toHaveLength(2);
    // Idempotency keys are scoped to the author, so a separate participant may use the same client ID.
    const other = store.postReply(alice, created.topic.id, input);
    expect(other.id).not.toBe(reply.id);
  });

  it('rejects reused IDs with different payloads across create and reply operations', () => {
    const created = topic();
    const conflict = () => store.createTopic(alice, { title: 'Changed', body: created.message.body, clientMessageId: 'topic-1' });
    expect(conflict).toThrow(ForumStoreError);
    try { conflict(); } catch (error) { expect((error as ForumStoreError).status).toBe(409); }
    expect(() => store.postReply(alice, created.topic.id, { body: created.message.body, clientMessageId: 'topic-1' })).toThrow('different content');
    const otherTopic = topic('topic-2');
    store.postReply(bob, created.topic.id, { body: 'Same text', clientMessageId: 'reply-1' });
    expect(() => store.postReply(bob, otherTopic.topic.id, { body: 'Same text', clientMessageId: 'reply-1' })).toThrow('different content');
    expect(store.listTopics()).toHaveLength(2);
    expect(store.listMessages({ after: 0, limit: 20 }).messages).toHaveLength(3);
  });

  it('paginates a global monotone cursor without gaps, including messages appended between fetches', () => {
    const created = topic();
    const another = topic('topic-2');
    for (let n = 0; n < 8; n++) store.postReply(bob, n % 2 ? created.topic.id : another.topic.id, { body: `Reply ${n}`, clientMessageId: `reply-${n}` });
    const first = store.listMessages({ after: 0, limit: 3 });
    expect(first.hasMore).toBe(true);
    store.postReply(alice, created.topic.id, { body: 'Appended after the first fetch', clientMessageId: 'late-reply' });
    const messages = [...first.messages];
    let cursor = first.nextCursor;
    while (true) {
      const page = store.listMessages({ after: cursor, limit: 3 });
      messages.push(...page.messages);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(messages).toHaveLength(11);
    expect(new Set(messages.map((value) => value.id)).size).toBe(11);
    expect(messages.map((value) => value.sequence)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
    expect(store.listMessages({ after: cursor, limit: 3 })).toEqual({ messages: [], nextCursor: cursor, hasMore: false });
    const selected = store.listMessages({ after: 0, limit: 200, topicId: created.topic.id });
    expect(selected.messages.every((value) => value.topicId === created.topic.id)).toBe(true);
    expect(selected.messages).toHaveLength(6);
  });

  it('rejects invalid content, cursor arguments, missing topics, and invented actors', () => {
    expect(() => store.createTopic(alice, { title: 'x'.repeat(201), body: 'Hello', clientMessageId: 'valid' })).toThrow('Topic title');
    expect(() => store.createTopic(alice, { title: 'Valid', body: ' '.repeat(12), clientMessageId: 'valid' })).toThrow('Message body');
    expect(() => store.createTopic(alice, { title: 'Valid', body: 'x'.repeat(12_001), clientMessageId: 'valid' })).toThrow('Message body');
    expect(() => store.createTopic(alice, { title: 'Valid', body: 'Hello', clientMessageId: "bad';DROP" })).toThrow('Client message ID');
    const created = topic();
    expect(() => store.postReply(bob, 'does-not-exist', { body: 'Hi', clientMessageId: 'reply' })).toThrow('does not exist');
    expect(() => store.postReply({ ...bob, role: 'admin' }, created.topic.id, { body: 'Hi', clientMessageId: 'reply' })).toThrow('identity is invalid');
    expect(() => store.postReply({ ...bob, id: 'unknown' }, created.topic.id, { body: 'Hi', clientMessageId: 'reply' })).toThrow('identity is invalid');
    for (const after of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => store.listMessages({ after, limit: 20 })).toThrow('Cursor');
    for (const limit of [0, 201, NaN, 1.2]) expect(() => store.listMessages({ after: 0, limit })).toThrow('Page size');
    expect(store.listTopics()).toHaveLength(1);
  });

  it('revokes tokens and future posting while preserving authored messages and safe identities', () => {
    const created = topic();
    const reply = store.postReply(bob, created.topic.id, { body: 'Keep my authorship', clientMessageId: 'reply' });
    store.revokeParticipant(bob.id);
    store.revokeParticipant(bob.id); // Revocation is safe to repeat.
    expect(store.authenticate(BOB_TOKEN)).toBeNull();
    expect(store.authenticate(ALICE_TOKEN)).toEqual(alice);
    expect(() => store.postReply(bob, created.topic.id, { body: 'Stale actor', clientMessageId: 'after-revoke' })).toThrow('identity is invalid');
    expect(store.listParticipants()).toContainEqual(bob);
    expect(store.listMessages({ after: 0, limit: 20 }).messages).toContainEqual(reply);
    expect(() => store.revokeParticipant('unknown')).toThrow('does not exist');
    expect(JSON.stringify(store.listParticipants())).not.toContain(BOB_TOKEN);
  });

  it('rotates an active token without changing identity, authorship or message history', () => {
    const created = topic();
    const reply = store.postReply(bob, created.topic.id, { body: 'Before rotation', clientMessageId: 'before-rotation' });
    const replacement = 'new-route66-token-1785e9a14aa983';
    expect(store.rotateParticipantToken(bob.id, replacement)).toEqual(bob);
    expect(store.authenticate(BOB_TOKEN)).toBeNull();
    expect(store.authenticate(replacement)).toEqual(bob);
    expect(store.authenticate(ALICE_TOKEN)).toEqual(alice);
    expect(store.listMessages({ after: 0, limit: 20 }).messages).toContainEqual(reply);
    store.close();
    store = new ForumStore(path);
    expect(store.authenticate(replacement)).toEqual(bob);
    expect(store.authenticate(BOB_TOKEN)).toBeNull();
    expect(readFileSync(path).toString('latin1')).not.toContain(replacement);
  });

  it('does not reactivate revoked identities or replace tokens after failed rotation', () => {
    const unchanged = store.authenticate(BOB_TOKEN);
    for (const replacement of ['', 'too-short', ALICE_TOKEN, BOB_TOKEN]) {
      expect(() => store.rotateParticipantToken(bob.id, replacement)).toThrow(ForumStoreError);
      expect(store.authenticate(BOB_TOKEN)).toEqual(unchanged);
      expect(store.authenticate(ALICE_TOKEN)).toEqual(alice);
    }
    expect(() => store.rotateParticipantToken('missing', 'new-route66-token-1785e9a14aa983')).toThrow('does not exist');
    store.revokeParticipant(bob.id);
    expect(() => store.rotateParticipantToken(bob.id, 'new-route66-token-1785e9a14aa983')).toThrow('revoked');
    expect(store.authenticate('new-route66-token-1785e9a14aa983')).toBeNull();
    expect(store.authenticate(BOB_TOKEN)).toBeNull();
  });

  it('writes private CLI credentials before creation and rotates into a new durable file without printing keys', () => {
    const output = join(dir, 'created.json');
    const run = (...args: string[]) => spawnSync(process.execPath, ['server/participant-cli.ts', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OMI_FORUM_DATA_DIR: join(dir, 'private') },
    });
    const created = run('--id', 'cli-seat', '--name', 'CLI seat', '--output', output);
    expect(created.status, created.stderr).toBe(0);
    const initial = JSON.parse(readFileSync(output, 'utf8'));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(store.authenticate(initial.token)?.id).toBe('cli-seat');
    expect(created.stdout + created.stderr).not.toContain(initial.token);
    const rotatedOutput = join(dir, 'rotated.json');
    const rotated = run('--id', 'cli-seat', '--rotate', '--output', rotatedOutput);
    expect(rotated.status, rotated.stderr).toBe(0);
    const replacement = JSON.parse(readFileSync(rotatedOutput, 'utf8'));
    expect(store.authenticate(initial.token)).toBeNull();
    expect(store.authenticate(replacement.token)).toEqual({ ...replacement.participant });
    expect(rotated.stdout + rotated.stderr).not.toContain(replacement.token);
    expect(readFileSync(output, 'utf8')).toBe(JSON.stringify(initial, null, 2) + '\n');
    const repeated = run('--id', 'cli-seat', '--name', 'Duplicate', '--output', join(dir, 'duplicate.json'));
    expect(repeated.status).toBe(1);
    expect(existsSync(join(dir, 'duplicate.json'))).toBe(false);
    expect(store.authenticate(replacement.token)?.name).toBe('CLI seat');
  });

  it('keeps the database unchanged when a private CLI credential file cannot be written', () => {
    // Directory permissions create a real post-validation write failure. Root
    // bypasses mode bits, so use an existing read-only system directory there.
    const destination = process.getuid?.() === 0 ? '/proc/omi-credential-write-denied.json' : join(dir, 'locked', 'credential.json');
    if (process.getuid?.() !== 0) {
      mkdirSync(join(dir, 'locked'), { mode: 0o500 });
    }
    const failed = spawnSync(process.execPath, ['server/participant-cli.ts', '--id', 'failed-seat', '--name', 'Failed seat', '--output', destination], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OMI_FORUM_DATA_DIR: join(dir, 'private') },
    });
    if (process.getuid?.() !== 0) chmodSync(join(dir, 'locked'), 0o700);
    expect(failed.status).not.toBe(0);
    expect(store.listParticipants().some(participant => participant.id === 'failed-seat')).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it('retains private candidate credentials if database validation fails after writing', () => {
    const output = join(dir, 'unregistered.json');
    const failed = spawnSync(process.execPath, ['server/participant-cli.ts', '--id', 'invalid-seat', '--name', 'x'.repeat(81), '--output', output], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OMI_FORUM_DATA_DIR: join(dir, 'private') },
    });
    expect(failed.status).toBe(1);
    const candidate = JSON.parse(readFileSync(output, 'utf8'));
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(store.authenticate(candidate.token)).toBeNull();
    expect(failed.stderr).toContain('retained');
    expect(failed.stdout + failed.stderr).not.toContain(candidate.token);
    expect(store.listParticipants().some(participant => participant.id === 'invalid-seat')).toBe(false);
  });

  it('migrates a v1 database without losing participant identities or token access', () => {
    const legacyPath = join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`CREATE TABLE participants (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
    ) STRICT; PRAGMA user_version = 1;`);
    legacy.prepare('INSERT INTO participants (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('legacy', 'Legacy participant', 'participant', createHash('sha256').update(BOB_TOKEN).digest('hex'), '2026-01-01T00:00:00.000Z');
    legacy.close();
    const migrated = new ForumStore(legacyPath);
    try {
      const identity = migrated.authenticate(BOB_TOKEN)!;
      expect(identity.id).toBe('legacy');
      const created = migrated.createTopic(identity, { title: 'Retained access', body: 'Migration worked', clientMessageId: 'legacy-message' });
      expect(created.message.participantId).toBe('legacy');
      migrated.revokeParticipant(identity.id);
      expect(migrated.authenticate(BOB_TOKEN)).toBeNull();
    } finally { migrated.close(); }
    const inspect = new DatabaseSync(legacyPath);
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
    inspect.close();
  });

  it('uses bound parameters for content and rejects duplicate participant IDs or tokens', () => {
    const title = "Robert'); DROP TABLE topics; --";
    const created = store.createTopic(alice, { title, body: "<script>localStorage.clear()</script> ' OR '1'='1", clientMessageId: 'sql-test' });
    expect(store.getTopic(created.topic.id)?.title).toBe(title);
    expect(store.listMessages({ after: 0, limit: 20 }).messages[0].body).toContain('<script>');
    expect(() => store.createParticipant({ id: 'alice', name: 'Other Alice', role: 'participant', token: 'another-random-token-123456789' })).toThrow('already exists');
    expect(() => store.createParticipant({ id: 'other', name: 'Other', role: 'participant', token: BOB_TOKEN })).toThrow('already exists');
    expect(store.authenticate(BOB_TOKEN)).toEqual(bob);
  });
});
