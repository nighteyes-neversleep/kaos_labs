#!/usr/bin/env node
/** Queue validated coordination data. This module never contacts or executes an agent. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const KINDS = new Set(['plan', 'assignment', 'progress', 'blocker', 'result', 'ack']);
const FIELDS = new Set(['protocol', 'id', 'kind', 'from', 'to', 'taskId', 'summary', 'details', 'createdAt', 'requiresAck']);
const MAX_BODY = 12_000;
const FILE_LIMIT = 256 * 1024;
const BAD_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slug = value => typeof value === 'string' && SLUG.test(value);
const inside = (path, root) => {
  const suffix = relative(root, path);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
};

export class AdvisoryError extends Error {
  constructor(code, message) { super(message); this.name = 'AdvisoryError'; this.code = code; }
}
const fail = (code, message) => { throw new AdvisoryError(code, message); };

function credentialKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['token', 'apikey', 'password', 'pin', 'secret', 'privatekey', 'authorization', 'credentials'].includes(normalized)
    || normalized.endsWith('token') || normalized.includes('apikey') || normalized.includes('password')
    || normalized.includes('privatekey') || normalized.endsWith('secret');
}

/** Copies JSON values without coercion, getters, prototypes, or caller mutation. */
function detailsSnapshot(value) {
  const active = new Set();
  let nodes = 0;
  function copy(item, depth) {
    if (++nodes > 4096 || depth > 24) fail('DETAIL_LIMIT', 'Advisory details exceed the supported structural limit.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('INVALID_DETAILS', 'Details must contain finite JSON numbers.');
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > MAX_BODY || BAD_CONTROLS.test(item)) fail('INVALID_DETAILS', 'A detail string is invalid or too long.');
      return item;
    }
    if (typeof item !== 'object') fail('INVALID_DETAILS', 'Details must contain only JSON data.');
    if (active.has(item)) fail('INVALID_DETAILS', 'Details cannot contain cycles.');
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Object.getOwnPropertySymbols(item).length) fail('INVALID_DETAILS', 'Detail arrays cannot contain extra fields.');
      result = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_DETAILS', 'Detail arrays cannot contain holes or getters.');
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) {
        fail('INVALID_DETAILS', 'Details must use plain JSON objects.');
      }
      const pairs = [];
      for (const key of Object.keys(item).sort()) {
        if (key.length > 200 || BAD_CONTROLS.test(key)) fail('INVALID_DETAILS', 'A detail key is invalid or too long.');
        if (credentialKey(key)) fail('CREDENTIAL_FIELD', 'Credential-shaped fields are not allowed in advisories.');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_DETAILS', 'Details cannot use getters or setters.');
        pairs.push([key, copy(descriptor.value, depth + 1)]);
      }
      result = Object.fromEntries(pairs);
    }
    active.delete(item);
    return result;
  }
  return copy(value, 0);
}

/** Returns a canonical, bounded snapshot suitable for the existing relay body. */
export function validateAdvisory(value) {
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_ADVISORY', 'An advisory must be a plain JSON object.');
  if (Object.getOwnPropertySymbols(value).length) fail('INVALID_ADVISORY', 'Advisories cannot contain symbol keys.');
  for (const key of Object.keys(value)) {
    if (credentialKey(key)) fail('CREDENTIAL_FIELD', 'Credential-shaped fields are not allowed in advisories.');
    if (!FIELDS.has(key)) fail('UNKNOWN_FIELD', 'The advisory contains an unsupported field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_ADVISORY', 'Advisories cannot use getters or setters.');
  }
  if (['protocol', 'id', 'kind', 'from', 'to', 'summary', 'details', 'createdAt', 'requiresAck'].some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_ADVISORY', 'The advisory is missing a required field.');
  }
  if (value.protocol !== 'omi-advisory/1') fail('INVALID_PROTOCOL', 'Use protocol omi-advisory/1.');
  if (!slug(value.id) || !slug(value.from) || !KINDS.has(value.kind)) fail('INVALID_ADVISORY', 'The advisory ID, sender, or kind is invalid.');
  const recipients = [];
  if (Array.isArray(value.to) && value.to.length >= 1 && value.to.length <= 32 && Object.keys(value.to).length === value.to.length && Object.getOwnPropertySymbols(value.to).length === 0) {
    for (let index = 0; index < value.to.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value.to, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !slug(descriptor.value)) fail('INVALID_RECIPIENTS', 'Supply 1–32 distinct recipient IDs.');
      recipients.push(descriptor.value);
    }
  }
  if (recipients.length < 1 || new Set(recipients.map(id => id.toLowerCase())).size !== recipients.length) {
    fail('INVALID_RECIPIENTS', 'Supply 1–32 distinct recipient IDs.');
  }
  if (Object.hasOwn(value, 'taskId') && !slug(value.taskId)) fail('INVALID_TASK', 'The optional taskId must be a 1–100 character slug.');
  if (typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 600 || BAD_CONTROLS.test(value.summary)) {
    fail('INVALID_SUMMARY', 'Supply a readable summary of 1–600 characters.');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    fail('INVALID_DATE', 'createdAt must be a canonical ISO timestamp.');
  }
  if (typeof value.requiresAck !== 'boolean' || !Object.hasOwn(value, 'details')) fail('INVALID_ADVISORY', 'Supply details and a boolean requiresAck.');
  const snapshot = {
    protocol: 'omi-advisory/1', id: value.id, kind: value.kind, from: value.from, to: recipients,
    ...(Object.hasOwn(value, 'taskId') ? { taskId: value.taskId } : {}),
    summary: value.summary.trim(), details: detailsSnapshot(value.details), createdAt: value.createdAt, requiresAck: value.requiresAck,
  };
  if (JSON.stringify(snapshot).length > MAX_BODY) fail('BODY_TOO_LARGE', 'The serialized advisory must not exceed 12,000 characters.');
  return snapshot;
}

async function privateOutbox(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(resolve(path), CHECKOUT)) fail('INVALID_OUTBOX', 'Use an absolute private outbox outside the checkout.');
  const lexical = resolve(path);
  let stat;
  try { stat = await fs.lstat(lexical); }
  catch { fail('INVALID_OUTBOX', 'The private outbox directory must already exist.'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_OUTBOX', 'The outbox must be a real directory, without a symbolic link.');
  const canonical = await fs.realpath(lexical);
  const root = await fs.realpath(CHECKOUT);
  if (inside(canonical, root) || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    fail('INVALID_OUTBOX', 'Use an owner-private outbox outside the checkout.');
  }
  return canonical;
}

async function readJSON(path, { optional = false, limit = FILE_LIMIT } = {}) {
  let stat;
  try { stat = await fs.lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail('INVALID_FILE', 'Advisory files must be bounded regular files without symbolic links.');
  let descriptor;
  try { descriptor = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  try {
    const opened = await descriptor.stat();
    if (!opened.isFile() || opened.size > limit) fail('INVALID_FILE', 'The advisory file changed or is too large.');
    const bytes = await descriptor.readFile();
    if (bytes.length > limit) fail('INVALID_FILE', 'The advisory file is too large.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID_JSON', 'The advisory file must contain valid UTF-8 JSON.'); }
  } finally { await descriptor.close(); }
}

async function syncDirectory(path) {
  let descriptor;
  try { descriptor = await fs.open(path, 'r'); await descriptor.sync(); }
  catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(error.code)) throw error; }
  finally { await descriptor?.close(); }
}

async function producerLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = await fs.open(path, 'wx', 0o600);
      try { await descriptor.writeFile(JSON.stringify({ version: 1, pid: process.pid })); await descriptor.sync(); }
      catch (error) { await descriptor.close(); await fs.unlink(path); throw error; }
      await descriptor.close();
      return async () => { await fs.unlink(path); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readJSON(path, { limit: 1024 });
      if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1) fail('QUEUE_BUSY', 'An invalid producer lock requires local review.');
      try { process.kill(previous.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH') { await fs.unlink(path); continue; }
      }
      fail('QUEUE_BUSY', 'Another producer owns this advisory ID; retry after it finishes.');
    }
  }
  fail('QUEUE_BUSY', 'The advisory producer lock could not be acquired.');
}

/** Queueing is local; only the existing relay can acknowledge remote delivery. */
export async function enqueueAdvisory(outbox, value) {
  const advisory = validateAdvisory(value);
  const body = JSON.stringify(advisory);
  const envelope = { topicId: 'coordination-advisory', body, clientMessageId: advisory.id };
  const directory = await privateOutbox(outbox);
  const hash = createHash('sha256').update(advisory.id, 'utf8').digest('hex');
  const path = resolve(directory, `advisory-${hash}.json`);
  const unlock = await producerLock(resolve(directory, `.advisory-${hash}.lock`));
  let temporary;
  try {
    const files = await fs.readdir(directory);
    if (files.length > 10_000) fail('QUEUE_LIMIT', 'The outbox exceeds the advisory queue inspection limit.');
    const candidates = [path, ...files.filter(name => name.endsWith('.json') && resolve(directory, name) !== path).sort().map(name => resolve(directory, name))];
    let inspectedBytes = 0;
    for (const candidate of candidates) {
      let existing;
      try {
        const stat = await fs.lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) continue;
        inspectedBytes += stat.size;
        if (inspectedBytes > 32 * 1024 * 1024) fail('QUEUE_LIMIT', 'The outbox exceeds the advisory byte inspection limit.');
        existing = await readJSON(candidate, { optional: true });
      } catch (error) {
        // Other producers may leave bad items for the relay to quarantine. Do
        // not execute, follow, replace, or let those items block an unrelated ID.
        if (candidate !== path && error instanceof AdvisoryError && ['INVALID_FILE', 'INVALID_JSON'].includes(error.code)) continue;
        throw error;
      }
      if (existing === undefined || (candidate !== path && existing?.clientMessageId !== advisory.id)) continue;
      if (!isObject(existing) || Object.keys(existing).sort().join(',') !== 'body,clientMessageId,topicId'
          || existing.topicId !== envelope.topicId || existing.clientMessageId !== envelope.clientMessageId || existing.body !== envelope.body) {
        fail('ID_CONFLICT', 'This advisory ID is already queued with different content.');
      }
      return { status: 'already-queued', id: advisory.id, path: candidate };
    }
    temporary = resolve(directory, `.advisory-${hash}.${randomUUID()}.tmp`);
    const descriptor = await fs.open(temporary, 'wx', 0o600);
    try { await descriptor.writeFile(JSON.stringify(envelope, null, 2) + '\n'); await descriptor.sync(); }
    finally { await descriptor.close(); }
    await fs.rename(temporary, path);
    temporary = undefined;
    await syncDirectory(directory);
    return { status: 'queued', id: advisory.id, path };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlock();
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      console.log('Usage: node relay/advisory.mjs --outbox /private/seat/outbox --file /private/advisory.json');
      return 0;
    }
    const options = new Map();
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index]; const value = argv[index + 1];
      if (!['--outbox', '--file'].includes(name) || options.has(name) || !value || value.startsWith('--')) fail('INVALID_ARGUMENTS', 'Supply --outbox and --file once each.');
      options.set(name, value);
    }
    if (options.size !== 2) fail('INVALID_ARGUMENTS', 'Supply --outbox and --file.');
    const advisory = await readJSON(resolve(options.get('--file')));
    const result = await enqueueAdvisory(options.get('--outbox'), advisory);
    console.log(JSON.stringify({ event: 'advisory_queued', ...result }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ event: 'advisory_error', code: error instanceof AdvisoryError ? error.code : 'LOCAL_IO_ERROR', message: error instanceof AdvisoryError ? error.message : 'The advisory could not be queued.' }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
