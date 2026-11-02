#!/usr/bin/env node
/** Outbound forum transport only. Forum text is data, never executable instructions. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BACKOFF_MS = 300_000;
const MAX_PAGES = 10;
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const INVALID_BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class RelayError extends Error {
  constructor(code, message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const fail = (code, message) => { throw new RelayError(code, message); };
const inside = (path, root) => {
  const suffix = relative(root, path);
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix));
};
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const validId = value => typeof value === 'string' && VALID_ID.test(value);
const keyFor = value => createHash('sha256').update(value).digest('hex');
const asJSON = value => `${JSON.stringify(value, null, 2)}\n`;
const sameRequest = (a, b) => a.topicId === b.topicId && a.body === b.body && a.clientMessageId === b.clientMessageId;

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    fail('INVALID_CONFIG', `${name} is outside its supported bounds.`);
  }
  return number;
}

function loadCredentialFile(path) {
  if (!text(path, 4096) || !isAbsolute(path) || inside(resolve(path), CHECKOUT)) {
    fail('INVALID_CONFIG', 'OMI_RELAY_TOKEN_FILE must be an absolute private file outside the checkout.');
  }
  let descriptor;
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink() || inside(realpathSync(path), CHECKOUT)) {
      fail('INVALID_CONFIG', 'The participant credential must be a regular file without a symbolic link.');
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      fail('INVALID_CONFIG', 'The participant credential file must be bounded and accessible only to its owner.');
    }
    let credential;
    try { credential = JSON.parse(readFileSync(descriptor, 'utf8')); }
    catch { fail('INVALID_CONFIG', 'The participant credential file must contain valid JSON.'); }
    if (!isObject(credential) || !text(credential.token, 8192) || !isObject(credential.participant) || !validId(credential.participant.id)) {
      fail('INVALID_CONFIG', 'The participant credential file must contain participant.id and token.');
    }
    return { token: credential.token, expectedParticipantId: credential.participant.id };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    fail('INVALID_CONFIG', 'The participant credential file could not be read securely.');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Read secret values only to use them; callers must never log the returned object. */
export function loadConfig(env = process.env) {
  let url;
  try { url = new URL(env.OMI_RELAY_URL); } catch { fail('INVALID_CONFIG', 'OMI_RELAY_URL must be a valid HTTPS origin.'); }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost && env.OMI_RELAY_ALLOW_HTTP_LOCALHOST === 'true')) {
    fail('INVALID_CONFIG', 'HTTPS is required; HTTP localhost requires explicit local-test permission.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('INVALID_CONFIG', 'OMI_RELAY_URL must contain only an origin, without credentials, path, query, or fragment.');
  }
  if (env.OMI_RELAY_TOKEN && env.OMI_RELAY_TOKEN_FILE) {
    fail('INVALID_CONFIG', 'Choose OMI_RELAY_TOKEN or OMI_RELAY_TOKEN_FILE, not both.');
  }
  const credential = env.OMI_RELAY_TOKEN_FILE
    ? loadCredentialFile(env.OMI_RELAY_TOKEN_FILE)
    : { token: env.OMI_RELAY_TOKEN };
  if (!text(credential.token, 8192) || /[\s\x00-\x1f\x7f]/.test(credential.token)) {
    fail('INVALID_CONFIG', 'Supply a participant token through the environment or a private credential file.');
  }
  if (!text(env.OMI_RELAY_DIR, 4096) || !isAbsolute(env.OMI_RELAY_DIR)) {
    fail('INVALID_CONFIG', 'OMI_RELAY_DIR must be an absolute private directory outside the checkout.');
  }
  const directory = resolve(env.OMI_RELAY_DIR);
  if (inside(directory, CHECKOUT)) fail('INVALID_CONFIG', 'Relay state must be kept outside the source checkout.');
  return {
    origin: url.origin,
    ...credential,
    directory,
    intervalMs: boundedInteger(env.OMI_RELAY_INTERVAL_MS, 5000, 500, MAX_BACKOFF_MS, 'OMI_RELAY_INTERVAL_MS'),
    timeoutMs: boundedInteger(env.OMI_RELAY_TIMEOUT_MS, 15_000, 100, 120_000, 'OMI_RELAY_TIMEOUT_MS'),
  };
}

async function regularFile(path, { optional = false } = {}) {
  let stat;
  try { stat = await fs.lstat(path); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    fail('INVALID_STATE', 'Relay data must be bounded regular files; symbolic links are refused.');
  }
  return stat;
}

async function readJSON(path, { optional = false } = {}) {
  if (!(await regularFile(path, { optional }))) return undefined;
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) fail('INVALID_STATE', 'Relay data file is too large.');
    try { return JSON.parse(raw); } catch { fail('INVALID_STATE', 'Relay data contains invalid JSON.'); }
  } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await fs.open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJSON(path, value) {
  await regularFile(path, { optional: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(asJSON(value));
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await fs.rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function validateMessage(value) {
  if (!isObject(value) || !validId(value.id) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !validId(value.topicId) || !validId(value.participantId) || !text(value.body, 12_000) || INVALID_BODY_CONTROLS.test(value.body) ||
      !text(value.createdAt, 128) || !Number.isFinite(Date.parse(value.createdAt)) || !validId(value.clientMessageId)) {
    fail('INVALID_RESPONSE', 'The forum returned an invalid message envelope.');
  }
  // Select only documented fields rather than persisting arbitrary server properties.
  return Object.fromEntries(['id', 'sequence', 'topicId', 'participantId', 'body', 'createdAt', 'clientMessageId'].map(key => [key, value[key]]));
}

function validateOutgoing(value) {
  if (!isObject(value) || !validId(value.topicId) || typeof value.body !== 'string' ||
      !text(value.body.trim(), 12_000) || INVALID_BODY_CONTROLS.test(value.body.trim()) || !validId(value.clientMessageId) ||
      Object.keys(value).some(key => !['topicId', 'body', 'clientMessageId'].includes(key))) {
    fail('INVALID_OUTBOX', 'An outbox item must contain only topicId, body, and a stable clientMessageId.');
  }
  // The forum normalizes boundary whitespace before hashing/storing requests.
  return { topicId: value.topicId, body: value.body.trim(), clientMessageId: value.clientMessageId };
}

async function readResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) fail('INVALID_RESPONSE', 'The forum returned no response body.');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail('INVALID_RESPONSE', 'The forum response exceeds its size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('INVALID_RESPONSE', 'The forum returned invalid JSON.'); }
}

function safeError(error) {
  // Never expose arbitrary exception messages, URLs, response bodies, or headers.
  return {
    code: error instanceof RelayError ? error.code : 'LOCAL_IO_ERROR',
    ...(error instanceof RelayError && error.status ? { httpStatus: error.status } : {}),
  };
}

export class RelayWorker {
  constructor(config, { fetchImpl = globalThis.fetch, log = event => console.log(JSON.stringify(event)) } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.log = log;
  }

  async initialize() {
    const root = this.config.directory;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(root);
    const actual = await fs.realpath(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || inside(actual, CHECKOUT) || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      fail('INVALID_STATE', 'Use an owner-only relay directory outside the checkout, without symbolic links.');
    }
    for (const name of ['inbox', 'outbox', 'sent', 'rejected']) {
      const path = resolve(root, name);
      await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const child = await fs.lstat(path);
      if (!child.isDirectory() || child.isSymbolicLink()) fail('INVALID_STATE', 'Relay subdirectories must be real directories.');
    }
  }

  async acquireLock() {
    const path = resolve(this.config.directory, 'worker.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(path, 'wx', 0o600);
        await handle.writeFile(asJSON({ pid: process.pid }));
        await handle.sync();
        await handle.close();
        return async () => { await fs.unlink(path); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lock = await readJSON(path);
        if (!isObject(lock) || !Number.isSafeInteger(lock.pid) || lock.pid < 1) {
          fail('LOCKED', 'An invalid worker lock requires local operator review.');
        }
        try { process.kill(lock.pid, 0); }
        catch (probe) {
          if (probe.code === 'ESRCH') { await fs.unlink(path); continue; }
        }
        fail('LOCKED', 'A relay worker already owns this state directory.');
      }
    }
    fail('LOCKED', 'The relay state directory could not be locked.');
  }

  async request(path, { method = 'GET', body, signal } = {}) {
    const url = new URL(path, this.config.origin);
    if (url.origin !== this.config.origin) fail('INVALID_CONFIG', 'Cross-origin relay requests are forbidden.');
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      fail(timeout.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', 'The outbound forum request did not complete.');
    }
    if (response.url && new URL(response.url).origin !== this.config.origin) {
      await response.body?.cancel().catch(() => {});
      fail('INVALID_RESPONSE', 'A cross-origin forum response was refused.');
    }
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
      await response.body?.cancel().catch(() => {});
      throw new RelayError('HTTP_ERROR', 'The forum rejected the request.', {
        status: response.status,
        retryAfterMs: Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_BACKOFF_MS) : 0,
      });
    }
    try { return await readResponse(response); }
    catch (error) {
      if (timeout.aborted) fail('REQUEST_TIMEOUT', 'The outbound forum response timed out.');
      if (error instanceof RelayError) throw error;
      fail('NETWORK_ERROR', 'The outbound forum response did not complete.');
    }
  }

  async bindIdentity(signal) {
    const identity = await this.request('/api/forum/v1/identity', { signal });
    if (!isObject(identity) || !isObject(identity.participant) || !validId(identity.participant.id)) {
      fail('INVALID_RESPONSE', 'The forum returned an invalid participant identity.');
    }
    if (this.config.expectedParticipantId && identity.participant.id !== this.config.expectedParticipantId) {
      fail('IDENTITY_CHANGED', 'The forum identity does not match the participant credential file.');
    }
    const binding = { version: 1, origin: this.config.origin, participantId: identity.participant.id };
    const path = resolve(this.config.directory, 'binding.json');
    const previous = await readJSON(path, { optional: true });
    if (previous !== undefined && (!isObject(previous) || previous.version !== binding.version || previous.origin !== binding.origin || previous.participantId !== binding.participantId)) {
      fail('IDENTITY_CHANGED', 'Use a separate relay directory for each forum origin and participant.');
    }
    if (previous === undefined) await atomicJSON(path, binding);
    return binding.participantId;
  }

  async receive(signal) {
    const cursorFile = resolve(this.config.directory, 'cursor.json');
    const saved = await readJSON(cursorFile, { optional: true });
    if (saved !== undefined && (!isObject(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.after) || saved.after < 0)) {
      fail('INVALID_STATE', 'The persisted inbox cursor is invalid; it was not reset.');
    }
    let after = saved?.after ?? 0;
    let received = 0;
    let hasMore = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.request(`/api/forum/v1/messages?after=${after}&limit=100`, { signal });
      if (!isObject(result) || !Array.isArray(result.messages) || result.messages.length > 100 ||
          typeof result.hasMore !== 'boolean' || !Number.isSafeInteger(result.nextCursor)) {
        fail('INVALID_RESPONSE', 'The forum returned an invalid inbox page.');
      }
      const messages = result.messages.map(validateMessage);
      let expectedCursor = after;
      for (const message of messages) {
        if (message.sequence <= expectedCursor) fail('INVALID_RESPONSE', 'Forum messages must be in strictly increasing cursor order.');
        expectedCursor = message.sequence;
      }
      if (result.nextCursor !== expectedCursor || (result.hasMore && expectedCursor === after)) {
        fail('INVALID_RESPONSE', 'The forum returned a cursor that could skip or repeat messages.');
      }
      for (const message of messages) {
        const path = resolve(this.config.directory, 'inbox', `${keyFor(message.id)}.json`);
        const previous = await readJSON(path, { optional: true });
        if (previous !== undefined) {
          if (JSON.stringify(validateMessage(previous)) !== JSON.stringify(message)) {
            fail('MESSAGE_CONFLICT', 'A previously stored message ID changed contents.');
          }
        } else {
          // fsync file + containing directory before any cursor advancement.
          await atomicJSON(path, message);
          received++;
        }
      }
      after = result.nextCursor;
      await atomicJSON(cursorFile, { version: 1, after });
      hasMore = result.hasMore;
      if (!hasMore) break;
    }
    return { received, cursor: after, hasMore };
  }

  async send(participantId, signal) {
    const outbox = resolve(this.config.directory, 'outbox');
    const names = (await fs.readdir(outbox)).filter(name => name.endsWith('.json')).sort().slice(0, 100);
    let sent = 0;
    let rejected = 0;
    for (const name of names) {
      const path = resolve(outbox, name);
      let request;
      try { request = validateOutgoing(await readJSON(path)); }
      catch (error) {
        if (!(error instanceof RelayError) || !['INVALID_STATE', 'INVALID_OUTBOX'].includes(error.code)) throw error;
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_STATE', 'Outbox symbolic links and special files are refused.');
        await fs.rename(path, resolve(this.config.directory, 'rejected', `${randomUUID()}.json`));
        await syncDirectory(outbox);
        await syncDirectory(resolve(this.config.directory, 'rejected'));
        rejected++;
        continue;
      }
      const archivePath = resolve(this.config.directory, 'sent', `${keyFor(request.clientMessageId)}.json`);
      const archive = await readJSON(archivePath, { optional: true });
      if (archive !== undefined) {
        if (!isObject(archive) || archive.version !== 1 || !isObject(archive.request) || !sameRequest(archive.request, request)) {
          fail('OUTBOX_CONFLICT', 'A sent clientMessageId was reused for a different request.');
        }
        const message = validateMessage(archive.message);
        if (message.topicId !== request.topicId || message.clientMessageId !== request.clientMessageId ||
            message.body !== request.body || message.participantId !== participantId) {
          fail('INVALID_STATE', 'A sent archive acknowledgement does not match its saved request.');
        }
      } else {
        const result = await this.request(`/api/forum/v1/topics/${encodeURIComponent(request.topicId)}/messages`, {
          method: 'POST', body: { body: request.body, clientMessageId: request.clientMessageId }, signal,
        });
        const message = validateMessage(result?.message);
        if (message.topicId !== request.topicId || message.clientMessageId !== request.clientMessageId ||
            message.body !== request.body || message.participantId !== participantId) {
          fail('INVALID_RESPONSE', 'The forum acknowledgement did not match the outgoing message.');
        }
        // Retain the stable request ID before removing the producer's outbox item.
        await atomicJSON(archivePath, { version: 1, request, message });
        sent++;
      }
      const current = validateOutgoing(await readJSON(path));
      if (!sameRequest(current, request)) fail('OUTBOX_CHANGED', 'An outbox item changed during delivery and was retained for review.');
      await fs.unlink(path);
      await syncDirectory(outbox);
    }
    return { sent, rejected };
  }

  async runOnce({ signal } = {}) {
    await this.initialize();
    const unlock = await this.acquireLock();
    try {
      const participantId = await this.bindIdentity(signal);
      const inbox = await this.receive(signal);
      const outbox = await this.send(participantId, signal);
      const result = { ...inbox, ...outbox };
      this.log({ event: 'relay_cycle', ...result });
      return result;
    } finally { await unlock(); }
  }

  async run({ signal } = {}) {
    let failures = 0;
    while (!signal?.aborted) {
      let wait = this.config.intervalMs;
      try { await this.runOnce({ signal }); failures = 0; }
      catch (error) {
        if (signal?.aborted) return;
        failures = Math.min(failures + 1, 10);
        wait = Math.min(MAX_BACKOFF_MS, Math.max(this.config.intervalMs * 2 ** (failures - 1), error.retryAfterMs || 0));
        this.log({ event: 'relay_retry', ...safeError(error), retryInMs: wait });
      }
      try { await delay(wait, undefined, { signal }); }
      catch (error) { if (signal?.aborted) return; throw error; }
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node --use-env-proxy relay/worker.mjs [--once]\nConfigure OMI_RELAY_URL, OMI_RELAY_DIR, and either OMI_RELAY_TOKEN_FILE or OMI_RELAY_TOKEN securely. See relay/README.md.');
    return 0;
  }
  try {
    if (argv.some(arg => arg !== '--once') || argv.length > 1) fail('INVALID_CONFIG', 'Only --once or --help is supported.');
    const config = loadConfig(env);
    process.umask(0o077);
    const worker = new RelayWorker(config);
    if (argv.includes('--once')) await worker.runOnce();
    else {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try { await worker.run({ signal: controller.signal }); }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    }
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ event: 'relay_stopped', ...safeError(error) }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
