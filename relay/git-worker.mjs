#!/usr/bin/env node
/** Repository-ACL mailbox transport. Message bodies are data, never commands. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'refs/remotes/omi-mailbox';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const validSlug = value => typeof value === 'string' && SLUG.test(value);
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FILE_LIMIT = 256 * 1024;
const key = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (path, root) => { const rel = relative(root, path); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
export class GitRelayError extends Error {
  constructor(code, message, exitCode) { super(message); this.name = 'GitRelayError'; this.code = code; this.exitCode = exitCode; }
}
const fail = (code, message) => { throw new GitRelayError(code, message); };
function remoteURL(value, allowLocal = false) {
  if (allowLocal && typeof value === 'string' && isAbsolute(value)) return resolve(value);
  let url; try { url = new URL(value); } catch { fail('INVALID_CONFIG', 'Supply an HTTPS Git repository URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    fail('INVALID_CONFIG', 'Git transport requires an HTTPS repository URL without embedded credentials.');
  }
  return url.href;
}
function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) fail('INVALID_CONFIG', 'A numeric relay setting is outside supported bounds.');
  return result;
}
export function loadGitConfig(env = process.env) {
  const branch = env.OMI_RELAY_GIT_BRANCH || 'omi-relay';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(p => p.startsWith('.') || p.endsWith('.lock'))) {
    fail('INVALID_CONFIG', 'Supply a valid mailbox branch name.');
  }
  if (!validSlug(env.OMI_RELAY_PARTICIPANT)) fail('INVALID_CONFIG', 'OMI_RELAY_PARTICIPANT must be a 1–100 character slug.');
  if (!env.OMI_RELAY_DIR || !isAbsolute(env.OMI_RELAY_DIR) || inside(resolve(env.OMI_RELAY_DIR), CHECKOUT)) {
    fail('INVALID_CONFIG', 'OMI_RELAY_DIR must be an absolute private directory outside the checkout.');
  }
  return {
    remote: remoteURL(env.OMI_RELAY_GIT_URL), branch, participantId: env.OMI_RELAY_PARTICIPANT,
    directory: resolve(env.OMI_RELAY_DIR),
    intervalMs: integer(env.OMI_RELAY_INTERVAL_MS, 5000, 500, 300_000),
    timeoutMs: integer(env.OMI_RELAY_TIMEOUT_MS, 30_000, 100, 120_000),
  };
}
function outgoing(value) {
  if (!object(value) || !validSlug(value.topicId) || !validSlug(value.clientMessageId) ||
      typeof value.body !== 'string' || !value.body.trim() || value.body.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.body) ||
      Object.keys(value).some(k => !['topicId', 'body', 'clientMessageId'].includes(k))) {
    fail('INVALID_OUTBOX', 'An outbox item must contain a valid topicId, body, and stable clientMessageId.');
  }
  return { topicId: value.topicId, body: value.body, clientMessageId: value.clientMessageId };
}
export function validateGitMessage(value) {
  if (!object(value) || value.version !== 1 || !UUID.test(value.id || '') || !validSlug(value.participantId) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
      Object.keys(value).some(k => !['version', 'id', 'participantId', 'topicId', 'body', 'createdAt', 'clientMessageId'].includes(k))) {
    fail('INVALID_MESSAGE', 'The mailbox contains an invalid message envelope.');
  }
  outgoing({ topicId: value.topicId, body: value.body, clientMessageId: value.clientMessageId });
  return value;
}
const sameRequest = (a, b) => a.topicId === b.topicId && a.body === b.body && a.clientMessageId === b.clientMessageId;
const writerKey = m => `${m.participantId}\0${m.clientMessageId}`;
async function readJSON(path, optional = false) {
  let stat; try { stat = await fs.lstat(path); } catch (e) { if (optional && e.code === 'ENOENT') return undefined; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_LIMIT) fail('INVALID_STATE', 'State must contain bounded regular files, without symbolic links.');
  const raw = await fs.readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > FILE_LIMIT) fail('INVALID_STATE', 'A state file is too large.');
  try { return JSON.parse(raw); } catch { fail('INVALID_STATE', 'A state file contains invalid JSON.'); }
}
async function syncDir(path) {
  let handle;
  try { handle = await fs.open(path, 'r'); await handle.sync(); }
  catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(e.code)) throw e; }
  finally { await handle?.close(); }
}
async function atomicJSON(path, value) {
  await readJSON(path, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, path); await syncDir(dirname(path)); }
  finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
function safeError(e) { return e instanceof GitRelayError ? e.code : 'LOCAL_IO_ERROR'; }

export class GitRelayWorker {
  constructor(config, { allowLocalRemoteForTests = false, log = event => console.log(JSON.stringify(event)) } = {}) {
    this.config = { ...config, remote: remoteURL(config.remote, allowLocalRemoteForTests) };
    if (!validSlug(config.participantId) || !config.branch || !isAbsolute(config.directory) || inside(resolve(config.directory), CHECKOUT)) {
      fail('INVALID_CONFIG', 'Invalid mailbox participant, branch, or external directory.');
    }
    this.log = log;
    this.cache = resolve(config.directory, 'git-cache.git');
    this.hooks = resolve(config.directory, 'hooks-disabled');
  }
  git(args, { input = '', env = {}, repository = true, maxBuffer = 4 * 1024 * 1024 } = {}) {
    const flags = ['--no-replace-objects', '-c', `core.hooksPath=${this.hooks}`, '-c', 'protocol.ext.allow=never', '-c', 'credential.interactive=never'];
    if (repository) flags.push(`--git-dir=${this.cache}`);
    return new Promise((accept, reject) => {
      const child = execFile('git', [...flags, ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, encoding: 'utf8', maxBuffer,
        timeout: this.config.timeoutMs ?? 30_000, windowsHide: true,
      }, (error, stdout) => {
        if (error) reject(new GitRelayError(error.killed ? 'GIT_TIMEOUT' : 'GIT_COMMAND_FAILED', 'The configured Git operation failed; credential values and Git diagnostics were withheld.', Number.isInteger(error.code) ? error.code : undefined));
        else accept(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async initialize() {
    const dir = this.config.directory;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || inside(await fs.realpath(dir), CHECKOUT) ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      fail('INVALID_STATE', 'Use an owner-only directory outside the checkout without symbolic links.');
    }
    for (const name of ['inbox', 'outbox', 'sent', 'pending', 'rejected', 'hooks-disabled']) {
      const path = resolve(dir, name);
      await fs.mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const item = await fs.lstat(path);
      if (!item.isDirectory() || item.isSymbolicLink()) fail('INVALID_STATE', 'Relay subdirectories must be real directories.');
    }
  }
  async lock() {
    const path = resolve(this.config.directory, 'worker.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(path, 'wx', 0o600);
        try { await handle.writeFile(json({ pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
        return () => fs.unlink(path);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const previous = await readJSON(path);
        if (!Number.isSafeInteger(previous?.pid) || previous.pid < 1) fail('LOCKED', 'An invalid worker lock requires review.');
        try { process.kill(previous.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(path); continue; } }
        fail('LOCKED', 'A worker already owns this mailbox directory.');
      }
    }
    fail('LOCKED', 'The mailbox directory could not be locked.');
  }
  async prepareCache() {
    await this.git(['check-ref-format', '--branch', this.config.branch], { repository: false });
    const binding = { version: 1, remote: this.config.remote, branch: this.config.branch, participantId: this.config.participantId };
    const path = resolve(this.config.directory, 'git-binding.json');
    const previous = await readJSON(path, true);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(binding)) fail('BINDING_CHANGED', 'Use a separate state directory for each remote, branch, and participant.');
    if (previous === undefined) await atomicJSON(path, binding);
    const stat = await fs.lstat(this.cache).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) await this.git(['init', '--bare', '--template=', this.cache], { repository: false });
    else if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_STATE', 'The Git cache must be a real private directory.');
    if ((await this.git(['rev-parse', '--is-bare-repository'])).trim() !== 'true') fail('INVALID_STATE', 'Only a dedicated bare cache is supported.');
  }
  async ancestor(before, after) {
    try { await this.git(['merge-base', '--is-ancestor', before, after]); return true; }
    catch (e) { if (e.exitCode === 1) return false; throw e; }
  }
  async snapshot() {
    await this.git(['fetch', '--no-tags', '--no-recurse-submodules', this.config.remote, `+refs/heads/${this.config.branch}:${REF}`]);
    const commit = (await this.git(['rev-parse', '--verify', `${REF}^{commit}`])).trim();
    if (!SHA.test(commit)) fail('INVALID_HISTORY', 'The mailbox returned an invalid commit.');
    const path = resolve(this.config.directory, 'git-cursor.json');
    const cursor = await readJSON(path, true);
    if (cursor !== undefined && (cursor?.version !== 1 || !SHA.test(cursor.commit || ''))) fail('INVALID_STATE', 'The persisted commit cursor is invalid and was not reset.');
    if (cursor && !(await this.ancestor(cursor.commit, commit))) fail('HISTORY_REWRITTEN', 'Mailbox ancestry changed; no cursor was advanced.');
    if (!cursor || cursor.commit !== commit) {
      // Examine every unseen commit, including merge parents; a later revert must
      // not hide an intermediate edit or deletion of an append-only message.
      const range = cursor ? `${cursor.commit}..${commit}` : commit;
      const forbidden = await this.git(['log', '--format=', '--name-only', '--no-renames', '--diff-filter=DMRTUXB', '-m', '-z', range, '--', 'messages/']);
      if (forbidden.trim()) fail('MESSAGE_CHANGED', 'Existing mailbox messages were changed or deleted.');
      if (cursor) {
        const changes = (await this.git(['diff-tree', '--no-commit-id', '--no-renames', '--name-status', '-r', '-z', cursor.commit, commit, '--', 'messages/'])).split('\0').filter(Boolean);
        for (let i = 0; i < changes.length; i += 2) if (changes[i] !== 'A') fail('MESSAGE_CHANGED', 'Existing mailbox messages were changed or deleted.');
      }
    }
    const rows = (await this.git(['ls-tree', '-r', '-z', '--long', commit, '--', 'messages/'])).split('\0').filter(Boolean);
    if (rows.length > 10_000) fail('MAILBOX_LIMIT', 'Mailbox history exceeds this worker’s bounded message limit.');
    const messages = new Map(); const writers = new Map(); let totalBytes = 0; let received = 0;
    for (const row of rows) {
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(row);
      if (!match || match[1] !== '100644' || !/^messages\/[a-f0-9-]+\.json$/.test(match[4]) || Number(match[3]) > FILE_LIMIT) fail('INVALID_MESSAGE', 'The mailbox message tree contains an invalid file.');
      totalBytes += Number(match[3]);
      if (totalBytes > 32 * 1024 * 1024) fail('MAILBOX_LIMIT', 'Mailbox messages exceed the supported byte limit.');
      let value; try { value = JSON.parse(await this.git(['cat-file', 'blob', match[2]], { maxBuffer: FILE_LIMIT })); } catch (e) { if (e instanceof GitRelayError) throw e; fail('INVALID_MESSAGE', 'A mailbox message contains invalid JSON.'); }
      validateGitMessage(value);
      if (match[4] !== `messages/${value.id}.json` || messages.has(value.id) || writers.has(writerKey(value))) fail('MESSAGE_CONFLICT', 'Mailbox message identity or writer request IDs are duplicated.');
      messages.set(value.id, value); writers.set(writerKey(value), value);
      const local = resolve(this.config.directory, 'inbox', `${value.id}.json`);
      const existing = await readJSON(local, true);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(value)) fail('MESSAGE_CHANGED', 'An existing inbox message changed contents.');
      if (existing === undefined) { await atomicJSON(local, value); received++; }
    }
    // Every inbox file and directory entry is durable before advancing the commit cursor.
    await atomicJSON(path, { version: 1, commit });
    return { commit, messages, writers, received };
  }
  async append(snapshot, message) {
    const index = resolve(this.config.directory, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: `OMI ${this.config.participantId}`, GIT_AUTHOR_EMAIL: `${this.config.participantId}@omi.invalid`, GIT_COMMITTER_NAME: `OMI ${this.config.participantId}`, GIT_COMMITTER_EMAIL: `${this.config.participantId}@omi.invalid` };
    try {
      const blob = (await this.git(['hash-object', '-w', '--stdin'], { input: json(message) })).trim();
      await this.git(['read-tree', snapshot.commit], { env });
      await this.git(['update-index', '--add', '--cacheinfo', '100644', blob, `messages/${message.id}.json`], { env });
      const tree = (await this.git(['write-tree'], { env })).trim();
      return (await this.git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', snapshot.commit], { env, input: `OMI mailbox append ${message.id}\n` })).trim();
    } finally {
      await fs.unlink(index).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await fs.unlink(`${index}.lock`).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  }
  async deliver(request, snapshot) {
    const stable = key(`${this.config.participantId}\0${request.clientMessageId}`);
    const pendingPath = resolve(this.config.directory, 'pending', `${stable}.json`);
    let message = await readJSON(pendingPath, true);
    if (message === undefined) {
      message = { version: 1, id: randomUUID(), participantId: this.config.participantId, ...request, createdAt: new Date().toISOString() };
      await atomicJSON(pendingPath, message);
    } else {
      validateGitMessage(message);
      if (message.participantId !== this.config.participantId || !sameRequest(message, request)) fail('OUTBOX_CONFLICT', 'A pending clientMessageId was reused for different content.');
    }
    let received = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = snapshot.writers.get(writerKey(message));
      if (existing) {
        if (!sameRequest(existing, request)) fail('OUTBOX_CONFLICT', 'A published clientMessageId was reused for different content.');
        return { snapshot, message: existing, received };
      }
      if (snapshot.messages.has(message.id)) fail('MESSAGE_CONFLICT', 'The pending message UUID already exists.');
      const commit = await this.append(snapshot, message);
      try { await this.git(['push', '--porcelain', this.config.remote, `${commit}:refs/heads/${this.config.branch}`]); }
      catch {
        const next = await this.snapshot(); received += next.received;
        if (next.commit === snapshot.commit) fail('GIT_PUSH_FAILED', 'The append was not accepted; no unchanged push retry was attempted.');
        if (!(await this.ancestor(snapshot.commit, next.commit))) fail('HISTORY_REWRITTEN', 'Mailbox history was replaced during a push.');
        snapshot = next;
        continue;
      }
      const next = await this.snapshot(); received += next.received;
      if (!(await this.ancestor(commit, next.commit))) fail('PUSH_UNCONFIRMED', 'The pushed message was not confirmed in mailbox ancestry.');
      snapshot = next;
    }
    const existing = snapshot.writers.get(writerKey(message));
    if (existing && sameRequest(existing, request)) return { snapshot, message: existing, received };
    fail('PUSH_CONTENTION', 'Concurrent writers exceeded the bounded append retry count; outbox retained.');
  }
  async runOnce() {
    await this.initialize(); const unlock = await this.lock();
    try {
      await this.prepareCache();
      let snapshot = await this.snapshot(); let received = snapshot.received; let sent = 0; let rejected = 0;
      const outbox = resolve(this.config.directory, 'outbox');
      const names = (await fs.readdir(outbox)).filter(n => n.endsWith('.json')).sort().slice(0, 100);
      for (const name of names) {
        const path = resolve(outbox, name); let request;
        try { request = outgoing(await readJSON(path)); }
        catch (e) {
          if (!(e instanceof GitRelayError) || !['INVALID_OUTBOX', 'INVALID_STATE'].includes(e.code)) throw e;
          const stat = await fs.lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_STATE', 'Outbox symlinks and special files are refused.');
          await fs.rename(path, resolve(this.config.directory, 'rejected', `${randomUUID()}.json`));
          await syncDir(outbox); await syncDir(resolve(this.config.directory, 'rejected')); rejected++; continue;
        }
        const result = await this.deliver(request, snapshot);
        snapshot = result.snapshot; received += result.received;
        const archive = resolve(this.config.directory, 'sent', `${key(`${this.config.participantId}\0${request.clientMessageId}`)}.json`);
        await atomicJSON(archive, { version: 1, message: result.message, commit: snapshot.commit });
        if (!sameRequest(outgoing(await readJSON(path)), request)) fail('OUTBOX_CHANGED', 'The outbox item changed during delivery and was retained.');
        await fs.unlink(path); await syncDir(outbox); sent++;
      }
      const result = { received, sent, rejected, commit: snapshot.commit };
      this.log({ event: 'git_relay_cycle', ...result }); return result;
    } finally { await unlock(); }
  }
  async run({ signal } = {}) {
    let failures = 0;
    while (!signal?.aborted) {
      let wait = this.config.intervalMs || 5000;
      try { await this.runOnce(); failures = 0; }
      catch (e) { failures = Math.min(failures + 1, 10); wait = Math.min(300_000, wait * 2 ** (failures - 1)); this.log({ event: 'git_relay_retry', code: safeError(e), retryInMs: wait }); }
      if (signal?.aborted) return;
      try { await delay(wait, undefined, { signal }); } catch (e) { if (!signal?.aborted) throw e; }
    }
  }
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node relay/git-worker.mjs [--once]\nConfigure OMI_RELAY_GIT_URL, OMI_RELAY_PARTICIPANT, OMI_RELAY_DIR; optional OMI_RELAY_GIT_BRANCH. Git handles authentication.'); return 0;
  }
  try {
    if (argv.some(a => a !== '--once') || argv.length > 1) fail('INVALID_CONFIG', 'Only --once and --help are supported.');
    process.umask(0o077); const worker = new GitRelayWorker(loadGitConfig(env));
    if (argv.includes('--once')) await worker.runOnce();
    else {
      const stop = new AbortController(); const abort = () => stop.abort();
      process.once('SIGINT', abort); process.once('SIGTERM', abort);
      try { await worker.run({ signal: stop.signal }); }
      finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
    }
    return 0;
  } catch (e) { console.error(JSON.stringify({ event: 'git_relay_stopped', code: safeError(e) })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
