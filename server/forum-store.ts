import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ParticipantRole = 'admin' | 'participant';
export type Participant = { id: string; name: string; role: ParticipantRole; createdAt: string };
export type Topic = { id: string; title: string; createdAt: string; createdBy: string };
export type Message = {
  id: string;
  sequence: number;
  topicId: string;
  participantId: string;
  body: string;
  createdAt: string;
  clientMessageId: string;
};
export type TopicCreated = { topic: Topic; message: Message };
export type MessagePage = { messages: Message[]; nextCursor: number; hasMore: boolean };

export class ForumStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ForumStoreError';
    this.status = status;
    this.code = code;
  }
}

type Row = Record<string, unknown>;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 12_000;
const MAX_PAGE_SIZE = 200;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const VALID_TOKEN = /^[A-Za-z0-9._~-]{24,512}$/;

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !VALID_ID.test(value)) {
    throw new ForumStoreError(400, 'INVALID_ID', `${label} must be a 1–100 character slug or UUID.`);
  }
  return value;
}

function content(value: unknown, label: string, maxLength: number, singleLine = false): string {
  if (typeof value !== 'string') throw new ForumStoreError(400, 'INVALID_CONTENT', `${label} is required.`);
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result) ||
      (singleLine && /[\r\n\t]/.test(result))) {
    throw new ForumStoreError(400, 'INVALID_CONTENT', `${label} must contain 1–${maxLength} characters${singleLine ? ' on one line' : ''}.`);
  }
  return result;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function participant(row: Row): Participant {
  return { id: String(row.id), name: String(row.name), role: row.role as ParticipantRole, createdAt: String(row.created_at) };
}

function topic(row: Row): Topic {
  return { id: String(row.id), title: String(row.title), createdAt: String(row.created_at), createdBy: String(row.created_by) };
}

function message(row: Row): Message {
  return {
    id: String(row.id), sequence: Number(row.sequence), topicId: String(row.topic_id), participantId: String(row.participant_id),
    body: String(row.body), createdAt: String(row.created_at), clientMessageId: String(row.client_message_id),
  };
}

/** Durable append-only forum data. HTTP handlers must authenticate each request before passing its actor. */
export class ForumStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (typeof databasePath !== 'string' || !databasePath.trim()) throw new Error('A private forum database path is required.');
    const dbPath = databasePath === ':memory:' ? databasePath : resolve(databasePath);
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      if (existsSync(dbPath)) {
        if (!lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink()) throw new Error('Forum database must be a regular private file.');
      } else {
        // SQLite inherits a private database file mode for its WAL and shared-memory files.
        try { closeSync(openSync(dbPath, 'wx', 0o600)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!lstatSync(dbPath).isFile() || lstatSync(dbPath).isSymbolicLink()) throw new Error('Forum database must be a regular private file.');
        }
      }
      chmodSync(dbPath, 0o600);
    }
    this.db = new DatabaseSync(dbPath);
    let migrating = false;
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      // Serialize the schema read and every migration step across processes.
      // Reading columns before acquiring the write lock permits two starters to
      // race the same ALTER, leaving one unable to start despite a valid schema.
      this.db.exec('BEGIN IMMEDIATE');
      migrating = true;
      const schemaVersion = this.db.prepare('PRAGMA user_version').get()?.user_version;
      if (schemaVersion !== 0 && schemaVersion !== 1 && schemaVersion !== 2) throw new Error('Unsupported forum database schema version.');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS participants (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'participant')),
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
        ) STRICT;
        CREATE TABLE IF NOT EXISTS topics (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES participants(id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          topic_id TEXT NOT NULL REFERENCES topics(id),
          participant_id TEXT NOT NULL REFERENCES participants(id),
          body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 12000),
          created_at TEXT NOT NULL,
          client_message_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          UNIQUE (participant_id, client_message_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS messages_by_topic_sequence ON messages(topic_id, sequence);
      `);
      const participantColumns = this.db.prepare('PRAGMA table_info(participants)').all();
      if (!participantColumns.some((column) => column.name === 'active')) {
        this.db.exec('ALTER TABLE participants ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))');
      }
      this.db.exec('PRAGMA user_version = 2');
      this.db.exec('COMMIT');
      migrating = false;
    } catch (error) {
      if (migrating) {
        try { this.db.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      }
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  createParticipant(input: { id: string; name: string; role: ParticipantRole; token: string }): Participant {
    const participantId = id(input.id, 'Participant ID');
    const name = content(input.name, 'Participant name', 80, true);
    if (input.role !== 'admin' && input.role !== 'participant') throw new ForumStoreError(400, 'INVALID_ROLE', 'Participant role is invalid.');
    if (typeof input.token !== 'string' || !VALID_TOKEN.test(input.token)) {
      throw new ForumStoreError(400, 'INVALID_TOKEN', 'Use an opaque token containing 24–512 URL-safe characters.');
    }
    const tokenHash = hash(input.token);
    return this.transaction(() => {
      if (this.db.prepare('SELECT id FROM participants WHERE id = ? OR token_hash = ?').get(participantId, tokenHash)) {
        throw new ForumStoreError(409, 'PARTICIPANT_EXISTS', 'Participant identity or token already exists.');
      }
      const createdAt = new Date().toISOString();
      this.db.prepare('INSERT INTO participants (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(participantId, name, input.role, tokenHash, createdAt);
      return { id: participantId, name, role: input.role, createdAt };
    });
  }

  authenticate(token: string): Participant | null {
    if (typeof token !== 'string' || !VALID_TOKEN.test(token)) return null;
    // Only random opaque token digests are persisted or queried. Never return authentication material.
    const row = this.db.prepare('SELECT id, name, role, created_at FROM participants WHERE token_hash = ? AND active = 1').get(hash(token));
    return row ? participant(row) : null;
  }

  listParticipants(): Participant[] {
    // Retain safe names for the authorship of messages posted before token revocation.
    return this.db.prepare('SELECT id, name, role, created_at FROM participants ORDER BY created_at ASC, id ASC').all().map(participant);
  }

  revokeParticipant(participantId: string): void {
    const target = id(participantId, 'Participant ID');
    if (!this.db.prepare('SELECT id FROM participants WHERE id = ?').get(target)) {
      throw new ForumStoreError(404, 'PARTICIPANT_NOT_FOUND', 'Participant does not exist.');
    }
    this.db.prepare('UPDATE participants SET active = 0 WHERE id = ?').run(target);
  }

  rotateParticipantToken(participantId: string, token: string): Participant {
    const target = id(participantId, 'Participant ID');
    if (typeof token !== 'string' || !VALID_TOKEN.test(token)) {
      throw new ForumStoreError(400, 'INVALID_TOKEN', 'Use an opaque token containing 24–512 URL-safe characters.');
    }
    const tokenHash = hash(token);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id, name, role, created_at, active FROM participants WHERE id = ?').get(target);
      if (!row) throw new ForumStoreError(404, 'PARTICIPANT_NOT_FOUND', 'Participant does not exist.');
      if (row.active !== 1) throw new ForumStoreError(409, 'PARTICIPANT_REVOKED', 'A revoked participant cannot rotate or reactivate its token.');
      if (this.db.prepare('SELECT id FROM participants WHERE token_hash = ?').get(tokenHash)) {
        throw new ForumStoreError(409, 'TOKEN_EXISTS', 'The replacement token must be new and not already in use.');
      }
      this.db.prepare('UPDATE participants SET token_hash = ? WHERE id = ? AND active = 1').run(tokenHash, target);
      return participant(row);
    });
  }

  createTopic(actor: Participant, input: { title: string; body: string; clientMessageId: string }): TopicCreated {
    const author = this.requireActor(actor);
    const title = content(input.title, 'Topic title', MAX_TITLE_LENGTH, true);
    const body = content(input.body, 'Message body', MAX_BODY_LENGTH);
    const clientMessageId = id(input.clientMessageId, 'Client message ID');
    const requestHash = hash(JSON.stringify({ operation: 'create-topic', title, body }));
    return this.transaction(() => {
      const previous = this.existingRequest(author.id, clientMessageId, requestHash);
      if (previous) {
        const previousTopic = this.getTopic(previous.topicId);
        if (!previousTopic) throw new Error('Stored forum topic is missing.');
        return { topic: previousTopic, message: previous };
      }
      const createdAt = new Date().toISOString();
      const createdTopic: Topic = { id: randomUUID(), title, createdAt, createdBy: author.id };
      this.db.prepare('INSERT INTO topics (id, title, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(createdTopic.id, title, createdAt, author.id);
      const createdMessage = this.insertMessage(author.id, createdTopic.id, body, clientMessageId, requestHash, createdAt);
      return { topic: createdTopic, message: createdMessage };
    });
  }

  postReply(actor: Participant, topicId: string, input: { body: string; clientMessageId: string }): Message {
    const author = this.requireActor(actor);
    const destination = id(topicId, 'Topic ID');
    const body = content(input.body, 'Message body', MAX_BODY_LENGTH);
    const clientMessageId = id(input.clientMessageId, 'Client message ID');
    const requestHash = hash(JSON.stringify({ operation: 'post-reply', topicId: destination, body }));
    return this.transaction(() => {
      const previous = this.existingRequest(author.id, clientMessageId, requestHash);
      if (previous) return previous;
      if (!this.getTopic(destination)) throw new ForumStoreError(404, 'TOPIC_NOT_FOUND', 'Topic does not exist.');
      return this.insertMessage(author.id, destination, body, clientMessageId, requestHash, new Date().toISOString());
    });
  }

  listTopics(): Topic[] {
    return this.db.prepare('SELECT id, title, created_at, created_by FROM topics ORDER BY created_at DESC, id DESC').all().map(topic);
  }

  getTopic(topicId: string): Topic | null {
    const row = this.db.prepare('SELECT id, title, created_at, created_by FROM topics WHERE id = ?').get(id(topicId, 'Topic ID'));
    return row ? topic(row) : null;
  }

  listMessages(input: { after: number; limit: number; topicId?: string }): MessagePage {
    if (!Number.isSafeInteger(input.after) || input.after < 0) throw new ForumStoreError(400, 'INVALID_CURSOR', 'Cursor must be a nonnegative safe integer.');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
      throw new ForumStoreError(400, 'INVALID_LIMIT', `Page size must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
    let rows: Row[];
    if (input.topicId !== undefined) {
      const topicId = id(input.topicId, 'Topic ID');
      if (!this.getTopic(topicId)) throw new ForumStoreError(404, 'TOPIC_NOT_FOUND', 'Topic does not exist.');
      rows = this.db.prepare('SELECT * FROM messages WHERE topic_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?')
        .all(topicId, input.after, input.limit + 1);
    } else {
      rows = this.db.prepare('SELECT * FROM messages WHERE sequence > ? ORDER BY sequence ASC LIMIT ?').all(input.after, input.limit + 1);
    }
    const messages = rows.slice(0, input.limit).map(message);
    return { messages, nextCursor: messages.at(-1)?.sequence ?? input.after, hasMore: rows.length > input.limit };
  }

  private requireActor(actor: Participant): Participant {
    if (!actor || typeof actor !== 'object' || typeof actor.id !== 'string' || !VALID_ID.test(actor.id)) {
      throw new ForumStoreError(401, 'UNAUTHENTICATED', 'Authenticate before posting.');
    }
    const row = this.db.prepare('SELECT id, name, role, created_at FROM participants WHERE id = ? AND active = 1').get(actor.id);
    if (!row || row.name !== actor.name || row.role !== actor.role) throw new ForumStoreError(401, 'UNAUTHENTICATED', 'Participant identity is invalid.');
    return participant(row);
  }

  private existingRequest(participantId: string, clientMessageId: string, requestHash: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE participant_id = ? AND client_message_id = ?').get(participantId, clientMessageId);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new ForumStoreError(409, 'IDEMPOTENCY_CONFLICT', 'This client message ID already belongs to different content.');
    return message(row);
  }

  private insertMessage(participantId: string, topicId: string, body: string, clientMessageId: string, requestHash: string, createdAt: string): Message {
    const messageId = randomUUID();
    this.db.prepare('INSERT INTO messages (id, topic_id, participant_id, body, created_at, client_message_id, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(messageId, topicId, participantId, body, createdAt, clientMessageId, requestHash);
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!row) throw new Error('Message could not be read after insertion.');
    return message(row);
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
