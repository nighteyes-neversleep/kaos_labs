#!/usr/bin/env node
/** Addressed local working mail. Message bodies remain data, never commands. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdvisory } from './advisory.mjs';
import { validateGitMessage } from './git-worker.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESERVED = new Set(['all', 'broadcast']);
const DESTINATIONS = ['inbox', 'broadcast', 'unaddressed', 'quarantine'];
const FILE_LIMIT = 256 * 1024;
const own = value => typeof value === 'string' && SLUG.test(value) && !RESERVED.has(value.toLowerCase());
const inside = (path, root) => { const value = relative(root, path); return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export class MailroomError extends Error {
  constructor(code, message) { super(message); this.name = 'MailroomError'; this.code = code; }
}
const fail = (code, message) => { throw new MailroomError(code, message); };

function identity(participantId, addresses) {
  if (!own(participantId) || !Array.isArray(addresses) || addresses.length > 31 || addresses.some(value => !own(value))) {
    fail('INVALID_CONFIG', 'Use a participant ID and at most 31 aliases; all/broadcast are reserved destinations.');
  }
  const values = [participantId, ...addresses];
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) fail('INVALID_CONFIG', 'Mail addresses must be distinct.');
  return values.sort();
}
async function privateDirectory(path, create = false) {
  if (create) await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const metadata = await fs.lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.getuid && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0))) {
    fail('UNSAFE_DIRECTORY', 'Mail directories must be real and owner-private.');
  }
  return fs.realpath(path);
}
async function syncDirectory(path) {
  let handle;
  try { handle = await fs.open(path, 'r'); await handle.sync(); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'EISDIR'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}
async function readPrivate(path, optional = false) {
  let metadata;
  try { metadata = await fs.lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > FILE_LIMIT || (process.getuid && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0))) {
    fail('UNSAFE_FILE', 'Mail files must be bounded owner-private regular files.');
  }
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > FILE_LIMIT || (process.getuid && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))) fail('UNSAFE_FILE', 'Mail file changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length > FILE_LIMIT) fail('UNSAFE_FILE', 'Mail file is too large.');
    return bytes;
  } finally { await handle.close(); }
}
function parse(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_STATE', 'A mail state file contains invalid UTF-8 JSON.'); }
}
async function immutableWrite(path, bytes) {
  const existing = await readPrivate(path, true);
  if (existing) {
    if (!existing.equals(bytes)) fail('MAIL_CONTENT_CHANGED', 'An existing mail file differs from its immutable source.');
    return false;
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    // A private sorter lock serializes writers. The destination is rechecked
    // immediately before rename so an unexpected local file is never replaced.
    const changed = await readPrivate(path, true);
    if (changed) {
      if (!changed.equals(bytes)) fail('MAIL_CONTENT_CHANGED', 'A mail destination changed before its durable commit.');
      return false;
    }
    await fs.rename(temporary, path);
    await syncDirectory(dirname(path));
    return true;
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function acquireLock(mail) {
  const path = resolve(mail, 'sorting.lock');
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(path, 'wx', 0o600);
      try { await handle.writeFile(json({ pid: process.pid, nonce })); await handle.sync(); }
      catch (error) { await fs.unlink(path).catch(() => {}); throw error; }
      finally { await handle.close(); }
      return async () => {
        const bytes = await readPrivate(path, true);
        if (!bytes) return;
        if (parse(bytes).nonce !== nonce) fail('MAIL_LOCK_CHANGED', 'The mail sorting lock changed unexpectedly.');
        await fs.unlink(path); await syncDirectory(mail);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previousBytes;
      try { previousBytes = await readPrivate(path); }
      catch (probe) { if (probe.code === 'ENOENT') continue; throw probe; }
      const previous = parse(previousBytes);
      if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1) fail('MAIL_LOCKED', 'A malformed mail sorting lock requires review.');
      try { process.kill(previous.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH') { await fs.unlink(path); await syncDirectory(mail); continue; }
      }
      fail('MAIL_LOCKED', 'Another sorter owns this agent mailroom.');
    }
  }
  fail('MAIL_LOCKED', 'The mailroom could not be locked.');
}
function classify(message, addresses) {
  let payload;
  try { payload = JSON.parse(message.body); } catch { return { classification: 'unaddressed', reason: 'NO_ADDRESSING_PROTOCOL' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.protocol !== 'omi-advisory/1') return { classification: 'unaddressed', reason: 'NO_ADDRESSING_PROTOCOL' };
  let advisory;
  try { advisory = validateAdvisory(payload); }
  catch { return { classification: 'quarantine', reason: 'INVALID_ADVISORY' }; }
  if (advisory.to.some(value => RESERVED.has(value.toLowerCase()))) return { classification: 'broadcast', reason: 'EXPLICIT_BROADCAST' };
  if (advisory.to.some(value => addresses.includes(value))) return { classification: 'inbox', reason: 'EXPLICIT_RECIPIENT' };
  return { classification: 'not-for-me', reason: 'OTHER_RECIPIENT' };
}

/**
 * Sort immutable transport envelopes into one local seat's working mail. Shared
 * repository readers can still read raw transport: this is routing, not secrecy.
 */
export async function sortAgentMail({ seatDirectory, participantId, addresses = [] }) {
  const boundAddresses = identity(participantId, addresses);
  if (typeof seatDirectory !== 'string' || !isAbsolute(seatDirectory) || inside(resolve(seatDirectory), CHECKOUT)) fail('INVALID_CONFIG', 'Use a private absolute seat directory outside the checkout.');
  const seat = await privateDirectory(resolve(seatDirectory));
  if (inside(seat, await fs.realpath(CHECKOUT))) fail('INVALID_CONFIG', 'Seat data must remain outside the checkout.');
  const mail = resolve(seat, 'mail');
  await privateDirectory(mail, true);
  for (const name of [...DESTINATIONS, 'receipts']) await privateDirectory(resolve(mail, name), true);
  const unlock = await acquireLock(mail);
  try {
    const binding = { version: 1, participantId, addresses: boundAddresses };
    const bindingPath = resolve(mail, 'binding.json');
    const previousBinding = await readPrivate(bindingPath, true);
    if (previousBinding) {
      if (JSON.stringify(parse(previousBinding)) !== JSON.stringify(binding)) fail('MAIL_BINDING_CHANGED', 'The agent identity or address set changed; use an explicit reviewed migration.');
    } else await immutableWrite(bindingPath, json(binding));
    const report = { scanned: 0, delivered: 0, addressed: 0, broadcast: 0, unaddressed: 0, quarantined: 0, notForMe: 0, alreadySorted: 0, recoveredReceipts: 0 };
    const input = resolve(seat, 'inbox');
    try { await privateDirectory(input); }
    catch (error) { if (error.code === 'ENOENT') return report; throw error; }
    const names = (await fs.readdir(input)).filter(name => name.endsWith('.json')).sort();
    if (names.length > 10_000) fail('MAIL_LIMIT', 'Review an explicit mailbox archive before sorting more than 10,000 messages.');
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!UUID.test(id)) fail('INVALID_FILENAME', 'Transport inbox JSON filenames must be message UUIDs.');
      const bytes = await readPrivate(resolve(input, name));
      report.scanned++;
      const contentHash = digest(bytes);
      let route;
      try {
        const message = validateGitMessage(parse(bytes));
        if (message.id !== id) fail('INVALID_MESSAGE', 'Envelope ID differs from filename.');
        route = classify(message, boundAddresses);
      } catch {
        route = { classification: 'quarantine', reason: 'INVALID_ENVELOPE' };
      }
      const destination = route.classification === 'not-for-me' ? null : `${route.classification}/${name}`;
      const receiptPath = resolve(mail, 'receipts', name);
      const existingReceipt = await readPrivate(receiptPath, true);
      const expected = { version: 1, messageId: id, contentHash, classification: route.classification, reason: route.reason, destination };
      for (const folder of DESTINATIONS) {
        const other = `${folder}/${name}`;
        if (other !== destination && await readPrivate(resolve(mail, other), true)) fail('MAIL_ROUTE_CHANGED', 'A message is already present in a different working-mail folder.');
      }
      if (existingReceipt) {
        const receipt = parse(existingReceipt);
        if (JSON.stringify(receipt) !== JSON.stringify(expected)) fail('MAIL_RECEIPT_CHANGED', 'A sorted message, receipt, or route differs from the immutable source.');
        if (destination) {
          const delivered = await readPrivate(resolve(mail, destination), true);
          if (!delivered || !delivered.equals(bytes)) fail('MAIL_CONTENT_CHANGED', 'Delivered working mail is missing or changed.');
        }
        report.alreadySorted++;
        continue;
      }
      if (destination) {
        const created = await immutableWrite(resolve(mail, destination), bytes);
        if (created) {
          report.delivered++;
          report[{ inbox: 'addressed', broadcast: 'broadcast', unaddressed: 'unaddressed', quarantine: 'quarantined' }[route.classification]]++;
        } else report.recoveredReceipts++;
      } else report.notForMe++;
      // The delivered file is durable before this receipt records completion.
      await immutableWrite(receiptPath, json(expected));
    }
    return report;
  } finally { await unlock(); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log('Usage: node relay/mailroom.mjs --seat-dir /private/seat --participant seat-id [--address alias ...]'); return; }
  let seatDirectory; let participantId; const addresses = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--once') continue;
    if (!['--seat-dir', '--participant', '--address'].includes(name) || !argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_CONFIG', 'Supply seat-dir, participant, and optional address values.');
    const value = argv[++index];
    if (name === '--address') addresses.push(value);
    else if (name === '--seat-dir') { if (seatDirectory !== undefined) fail('INVALID_CONFIG', 'Duplicate seat-dir.'); seatDirectory = value; }
    else { if (participantId !== undefined) fail('INVALID_CONFIG', 'Duplicate participant.'); participantId = value; }
  }
  const report = await sortAgentMail({ seatDirectory, participantId, addresses });
  console.log(JSON.stringify({ event: 'agent_mail_sorted', participantId, ...report }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ event: 'agent_mail_error', code: error instanceof MailroomError ? error.code : 'LOCAL_IO_ERROR' })); process.exitCode = 1; });
}
