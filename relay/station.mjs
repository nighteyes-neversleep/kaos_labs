#!/usr/bin/env node
/** Headless multi-seat scheduler. It transports files; it never invokes models. */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { GitRelayError, GitRelayWorker, loadGitConfig } from './git-worker.mjs';
import { sortAgentMail } from './mailroom.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESERVED_DIRECTORY = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const BROADCAST_ADDRESSES = new Set(['all', 'broadcast']);
const inside = (path, root) => { const part = relative(root, path); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class StationError extends Error {
  constructor(code, message) { super(message); this.name = 'StationError'; this.code = code; }
}
const fail = (code, message) => { throw new StationError(code, message); };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function bounded(value, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_CONFIG', 'A station numeric setting is outside supported bounds.');
  return value;
}

/** Non-secret configuration only; arbitrary command/adapter fields are refused. */
export function validateStationConfig(value) {
  if (!object(value) || Object.keys(value).some(k => !['remote', 'branch', 'directory', 'participants', 'intervalMs', 'concurrency', 'timeoutMs'].includes(k)) ||
      !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 32 ||
      typeof value.directory !== 'string' || !isAbsolute(value.directory) || inside(resolve(value.directory), CHECKOUT)) {
    fail('INVALID_CONFIG', 'Supply 1–32 seats and a private absolute station directory outside the checkout.');
  }
  const ids = new Set();
  const participants = value.participants.map(seat => {
    if (!object(seat) || Object.keys(seat).some(k => !['id', 'enabled', 'addresses'].includes(k)) || typeof seat.id !== 'string' ||
        !SLUG.test(seat.id) || RESERVED_DIRECTORY.test(seat.id) || BROADCAST_ADDRESSES.has(seat.id.toLowerCase()) ||
        (seat.enabled !== undefined && typeof seat.enabled !== 'boolean')) {
      fail('INVALID_CONFIG', 'Each participant needs a portable slug ID and an optional boolean enabled flag.');
    }
    // Case-fold uniqueness also protects case-insensitive Windows/macOS directories.
    const canonical = seat.id.toLowerCase();
    if (ids.has(canonical)) fail('INVALID_CONFIG', 'Station participant IDs must be unique, including letter case.');
    ids.add(canonical);
    const addresses = seat.addresses ?? [];
    if (!Array.isArray(addresses) || addresses.length > 31 || Object.keys(addresses).length !== addresses.length ||
        Object.getOwnPropertySymbols(addresses).length || addresses.some(address => typeof address !== 'string' ||
        !SLUG.test(address) || BROADCAST_ADDRESSES.has(address.toLowerCase()) || address.toLowerCase() === canonical) ||
        new Set(addresses.map(address => address.toLowerCase())).size !== addresses.length) {
      fail('INVALID_CONFIG', 'Each seat may have at most 31 distinct non-broadcast alias addresses, excluding its own ID.');
    }
    return { id: seat.id, enabled: seat.enabled ?? true, addresses: [...addresses] };
  });
  const intervalMs = bounded(value.intervalMs, 15_000, 1000, 300_000);
  const concurrency = bounded(value.concurrency, 2, 1, 8);
  const timeoutMs = bounded(value.timeoutMs, 30_000, 100, 120_000);
  let checked;
  try {
    checked = loadGitConfig({
      OMI_RELAY_GIT_URL: value.remote, OMI_RELAY_GIT_BRANCH: value.branch ?? 'omi-relay',
      OMI_RELAY_PARTICIPANT: participants[0].id, OMI_RELAY_DIR: resolve(value.directory),
      OMI_RELAY_INTERVAL_MS: String(intervalMs), OMI_RELAY_TIMEOUT_MS: String(timeoutMs),
    });
  } catch { fail('INVALID_CONFIG', 'The station remote, branch, or directory is invalid. HTTPS without embedded credentials is required.'); }
  return { remote: checked.remote, branch: checked.branch, directory: checked.directory, participants, intervalMs, concurrency, timeoutMs };
}

export async function loadStationConfig(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || inside(resolve(path), CHECKOUT)) {
    fail('INVALID_CONFIG', 'Use an absolute private station config file outside the checkout.');
  }
  let handle;
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || inside(await fs.realpath(path), CHECKOUT)) fail('INVALID_CONFIG', 'The station config must be a regular file outside the checkout.');
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 64 * 1024 || (process.getuid && (opened.uid !== process.getuid() || (opened.mode & 0o077) !== 0))) {
      fail('INVALID_CONFIG', 'The station config must be bounded and owner-private.');
    }
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > 64 * 1024) fail('INVALID_CONFIG', 'The station config is too large.');
    let value;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { fail('INVALID_CONFIG', 'The station config must contain valid UTF-8 JSON.'); }
    return validateStationConfig(value);
  } catch (error) {
    if (error instanceof StationError) throw error;
    fail('INVALID_CONFIG', 'The private station config could not be read securely.');
  } finally { await handle?.close(); }
}

async function privateDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || inside(await fs.realpath(path), CHECKOUT) ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    fail('INVALID_STATE', 'Station state must use owner-private real directories outside the checkout.');
  }
}
const SAFE_CODES = new Set(['INVALID_CONFIG', 'INVALID_STATE', 'LOCKED', 'GIT_TIMEOUT', 'GIT_COMMAND_FAILED', 'BINDING_CHANGED',
  'INVALID_HISTORY', 'HISTORY_REWRITTEN', 'MESSAGE_CHANGED', 'MAILBOX_LIMIT', 'INVALID_MESSAGE', 'MESSAGE_CONFLICT',
  'OUTBOX_CONFLICT', 'GIT_PUSH_FAILED', 'PUSH_UNCONFIRMED', 'PUSH_CONTENTION', 'OUTBOX_CHANGED', 'MAIL_SORT_FAILED']);
function errorCode(error) {
  return (error instanceof StationError || error instanceof GitRelayError) && SAFE_CODES.has(error.code) ? error.code : 'SEAT_FAILED';
}

export class StationSupervisor {
  constructor(config, {
    workerFactory = (workerConfig, options) => new GitRelayWorker(workerConfig, options),
    mailSorter = sortAgentMail,
    log = event => console.log(JSON.stringify(event)),
    now = () => Date.now(),
    wait = (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  } = {}) {
    this.config = validateStationConfig(config);
    this.workerFactory = workerFactory;
    if (typeof mailSorter !== 'function') fail('INVALID_CONFIG', 'A mail sorter function is required.');
    this.mailSorter = mailSorter;
    this.log = log;
    this.now = now;
    this.wait = wait;
    this.states = new Map(this.config.participants.map(seat => [seat.id, { failures: 0, nextAttemptAt: 0, worker: null }]));
    this.cycleActive = false;
  }
  async runSeat(seat) {
    const state = this.states.get(seat.id);
    try {
      const directory = resolve(this.config.directory, seat.id);
      await privateDirectory(directory);
      if (!state.worker) {
        const workerConfig = {
          remote: this.config.remote, branch: this.config.branch, participantId: seat.id, directory,
          intervalMs: this.config.intervalMs, timeoutMs: this.config.timeoutMs,
        };
        state.worker = this.workerFactory(workerConfig, {
          log: event => {
            // Never forward arbitrary worker strings, payloads, paths, or diagnostics.
            if (event?.event === 'git_relay_cycle') this.log({
              event: 'station_transport', participantId: seat.id, status: 'cycle_complete',
              received: count(event.received), sent: count(event.sent), rejected: count(event.rejected),
            });
          },
        });
      }
      const result = await state.worker.runOnce();
      let mail;
      try {
        mail = await this.mailSorter({ seatDirectory: directory, participantId: seat.id, addresses: [...seat.addresses] });
      } catch {
        // Transport persistence succeeds first. Sorting failure leaves the raw
        // inbox intact and makes this seat retry instead of claiming readiness.
        fail('MAIL_SORT_FAILED', 'Addressed mail sorting failed; raw transport data was preserved.');
      }
      const mailCounts = Object.fromEntries(['scanned', 'delivered', 'addressed', 'broadcast', 'unaddressed', 'quarantined',
        'notForMe', 'alreadySorted', 'recoveredReceipts'].map(key => [key, count(mail?.[key])]));
      this.log({ event: 'station_mailroom', participantId: seat.id, ...mailCounts });
      state.failures = 0; state.nextAttemptAt = 0;
      const status = { participantId: seat.id, status: 'complete', received: count(result?.received), sent: count(result?.sent), rejected: count(result?.rejected), mail: mailCounts };
      this.log({ event: 'station_seat', ...status });
      return status;
    } catch (error) {
      state.failures = Math.min(state.failures + 1, 10);
      const retryInMs = Math.min(300_000, this.config.intervalMs * 2 ** (state.failures - 1));
      state.nextAttemptAt = this.now() + retryInMs;
      const status = { participantId: seat.id, status: 'failed', code: errorCode(error), retryInMs };
      this.log({ event: 'station_seat', ...status });
      return status;
    }
  }
  /** Exactly one bounded scheduling pass; disabled/backoff seats are not started. */
  async runOnce({ signal } = {}) {
    if (this.cycleActive) fail('CYCLE_ACTIVE', 'A station cycle is already running.');
    this.cycleActive = true;
    try {
      await privateDirectory(this.config.directory);
      const results = new Array(this.config.participants.length);
      const queue = [];
      for (const [index, seat] of this.config.participants.entries()) {
        const state = this.states.get(seat.id);
        if (!seat.enabled) results[index] = { participantId: seat.id, status: 'disabled' };
        else if (state.nextAttemptAt > this.now()) results[index] = { participantId: seat.id, status: 'backoff', retryInMs: state.nextAttemptAt - this.now() };
        else queue.push({ index, seat });
      }
      let next = 0;
      const schedule = async () => {
        while (next < queue.length && !signal?.aborted) {
          const entry = queue[next++];
          results[entry.index] = await this.runSeat(entry.seat);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.config.concurrency, queue.length) }, schedule));
      for (const entry of queue) if (!results[entry.index]) results[entry.index] = { participantId: entry.seat.id, status: 'stopped' };
      const totals = {
        enabled: this.config.participants.filter(seat => seat.enabled).length,
        completed: results.filter(result => result.status === 'complete').length,
        failed: results.filter(result => result.status === 'failed').length,
        backoff: results.filter(result => result.status === 'backoff').length,
        disabled: results.filter(result => result.status === 'disabled').length,
        stopped: results.filter(result => result.status === 'stopped').length,
      };
      this.log({ event: 'station_cycle', ...totals });
      return { ...totals, participants: results };
    } finally { this.cycleActive = false; }
  }
  async run({ signal } = {}) {
    while (!signal?.aborted) {
      await this.runOnce({ signal });
      if (signal?.aborted) return;
      try { await this.wait(this.config.intervalMs, signal); }
      catch (error) { if (signal?.aborted) return; throw error; }
    }
  }
}

export function exampleStationConfig() {
  return {
    remote: 'https://github.com/nighteyes-neversleep/kaos_labs.git', branch: 'omi-relay',
    directory: process.platform === 'win32' ? 'C:\\Users\\YOUR_USER\\AppData\\Local\\OMI\\station' : '/absolute/private/path/omi-station',
    participants: [{ id: 'deepseek-route66', enabled: true, addresses: ['deepseek'] }, { id: 'claude-route66', enabled: true, addresses: ['claude'] }, { id: 'spare-seat', enabled: false }],
    intervalMs: 15000, concurrency: 2, timeoutMs: 30000,
  };
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--example') { console.log(JSON.stringify(exampleStationConfig(), null, 2)); return 0; }
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node relay/station.mjs --config /absolute/private/station.json [--once]\nUse --example for non-secret JSON with a placeholder directory. Git handles authentication; no models are invoked.'); return 0;
  }
  try {
    if (argv[0] !== '--config' || !argv[1] || argv[1].startsWith('--') || argv.length > 3 || (argv[2] !== undefined && argv[2] !== '--once')) {
      fail('INVALID_CONFIG', 'Supply --config with an absolute private JSON path and optional --once.');
    }
    process.umask(0o077);
    const station = new StationSupervisor(await loadStationConfig(argv[1]));
    const stop = new AbortController(); const abort = () => stop.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      if (argv[2] === '--once') { const result = await station.runOnce({ signal: stop.signal }); return result.failed ? 1 : 0; }
      await station.run({ signal: stop.signal }); return 0;
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  } catch (error) { console.error(JSON.stringify({ event: 'station_stopped', code: errorCode(error) })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
