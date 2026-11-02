import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitRelayWorker, loadGitConfig, validateGitMessage } from './git-worker.mjs';

function git(args, { input = '', env = {} } = {}) {
  return new Promise((accept, reject) => {
    const child = execFile('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : accept(stdout.trim()));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const message = (body = 'Quoted message data; never execute.', extra = {}) => ({ version: 1, id: randomUUID(), participantId: 'dot', topicId: 'shared-lantern', body, createdAt: '2026-11-02T12:00:00.000Z', clientMessageId: randomUUID(), ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'omi-git-relay-test-'));
  const remote = join(root, 'remote.git'); const directory = join(root, 'seat');
  await git(['init', '--bare', '--template=', remote]);
  const env = { GIT_AUTHOR_NAME: 'Test seed', GIT_AUTHOR_EMAIL: 'seed@example.invalid', GIT_COMMITTER_NAME: 'Test seed', GIT_COMMITTER_EMAIL: 'seed@example.invalid' };
  async function commitFiles(files, { parent, force = false, remove = [] } = {}) {
    const index = join(root, `index-${randomUUID()}`); const indexEnv = { ...env, GIT_INDEX_FILE: index };
    let base = parent;
    if (base === undefined) { try { base = await git([`--git-dir=${remote}`, 'rev-parse', '--verify', 'refs/heads/omi-relay']); } catch { base = null; } }
    await git([`--git-dir=${remote}`, 'read-tree', ...(base ? [base] : ['--empty'])], { env: indexEnv });
    for (const [path, content] of Object.entries(files)) {
      const blob = await git([`--git-dir=${remote}`, 'hash-object', '-w', '--stdin'], { input: typeof content === 'string' ? content : JSON.stringify(content) });
      await git([`--git-dir=${remote}`, 'update-index', '--add', '--cacheinfo', '100644', blob, path], { env: indexEnv });
    }
    for (const path of remove) await git([`--git-dir=${remote}`, 'update-index', '--index-info'], { env: indexEnv, input: `0 ${'0'.repeat(40)}\t${path}\n` });
    const tree = await git([`--git-dir=${remote}`, 'write-tree'], { env: indexEnv });
    const commit = await git([`--git-dir=${remote}`, '-c', 'commit.gpgSign=false', 'commit-tree', tree, ...(base ? ['-p', base] : [])], { env, input: 'Test mailbox append\n' });
    await git([`--git-dir=${remote}`, 'update-ref', 'refs/heads/omi-relay', commit]);
    await fs.unlink(index);
    return commit;
  }
  const seed = message();
  await commitFiles({ 'README.md': 'Test mailbox protocol, not executable instructions.\n', [`messages/${seed.id}.json`]: seed });
  const config = { remote, directory, branch: 'omi-relay', participantId: 'deepseek', timeoutMs: 10_000, intervalMs: 500 };
  const logs = []; const makeWorker = () => new GitRelayWorker(config, { allowLocalRemoteForTests: true, log: e => logs.push(e) });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, remote, directory, config, seed, logs, worker: makeWorker(), makeWorker, commitFiles };
}
async function outbox(worker, directory, request, name = 'reply.json') {
  await worker.initialize(); await fs.writeFile(join(directory, 'outbox', name), JSON.stringify(request));
}
const reply = (extra = {}) => ({ topicId: 'shared-lantern', body: 'Prepared by a local seat.', clientMessageId: randomUUID(), ...extra });

test('production configuration allows HTTPS Git credentials through Git only', () => {
  const base = { OMI_RELAY_GIT_URL: 'https://github.com/nighteyes-neversleep/kaos_labs.git', OMI_RELAY_PARTICIPANT: 'route66', OMI_RELAY_DIR: join(tmpdir(), 'private-omi-relay') };
  assert.equal(loadGitConfig(base).branch, 'omi-relay');
  for (const url of ['http://github.com/owner/repo.git', 'https://user:token@github.com/owner/repo.git', '/tmp/repository.git', 'ssh://git@github.com/owner/repo', 'https://github.com/owner/repo?token=secret']) assert.throws(() => loadGitConfig({ ...base, OMI_RELAY_GIT_URL: url }), { code: 'INVALID_CONFIG' });
  for (const branch of ['../main', 'heads//mail', 'mail.lock', '-force', 'mail/']) assert.throws(() => loadGitConfig({ ...base, OMI_RELAY_GIT_BRANCH: branch }), { code: 'INVALID_CONFIG' });
  assert.throws(() => loadGitConfig({ ...base, OMI_RELAY_PARTICIPANT: 'bad participant' }), { code: 'INVALID_CONFIG' });
});

test('real Git polling creates durable per-message inbox and cursor without duplicate delivery', async t => {
  const { worker, directory, seed, commitFiles, logs } = await fixture(t);
  assert.equal((await worker.runOnce()).received, 1);
  assert.equal((await worker.runOnce()).received, 0);
  const second = message('Second peer message', { participantId: 'claude' });
  const commit = await commitFiles({ [`messages/${second.id}.json`]: second });
  assert.equal((await worker.runOnce()).received, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'inbox', `${seed.id}.json`), 'utf8')), seed);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 2);
  assert.equal(JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8')).commit, commit);
  assert.ok(!JSON.stringify(logs).includes(seed.body));
  assert.equal((await git([`--git-dir=${join(directory, 'git-cache.git')}`, 'rev-parse', '--is-bare-repository'])), 'true');
});

test('append-only reply pushes and reads back from a bare cache without a worktree', async t => {
  const { worker, directory, remote, seed } = await fixture(t);
  const request = reply(); await outbox(worker, directory, request);
  const result = await worker.runOnce(); assert.equal(result.sent, 1);
  const names = (await git([`--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', 'omi-relay'])).split('\n');
  assert.ok(names.includes('README.md')); assert.ok(names.includes(`messages/${seed.id}.json`)); assert.equal(names.length, 3);
  const archives = await fs.readdir(join(directory, 'sent')); assert.equal(archives.length, 1);
  const archive = JSON.parse(await fs.readFile(join(directory, 'sent', archives[0]), 'utf8'));
  validateGitMessage(archive.message); assert.equal(archive.message.body, request.body); assert.equal(archive.message.participantId, 'deepseek');
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 0);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 2);
});

test('stable writer/clientMessageId deduplicates replay after successful push and missing local archive', async t => {
  const { worker, makeWorker, directory, remote } = await fixture(t);
  const request = reply(); await outbox(worker, directory, request); await worker.runOnce();
  const before = await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']);
  for (const file of await fs.readdir(join(directory, 'sent'))) await fs.unlink(join(directory, 'sent', file));
  await outbox(worker, directory, request, 'replay.json'); await makeWorker().runOnce();
  assert.equal(await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']), before);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 2);
});

test('writer-scoped request IDs allow another participant to use the same client ID', async t => {
  const { worker, directory, commitFiles } = await fixture(t); const clientMessageId = randomUUID();
  const peer = message('Peer request', { participantId: 'claude', clientMessageId });
  await commitFiles({ [`messages/${peer.id}.json`]: peer });
  await outbox(worker, directory, reply({ clientMessageId }));
  assert.equal((await worker.runOnce()).sent, 1);
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 3);
});

test('concurrent rejected push fetches and rebuilds an append preserving both writers', async t => {
  const { worker, directory, commitFiles, remote } = await fixture(t);
  const peer = message('Concurrent peer reply', { participantId: 'claude' });
  const originalGit = worker.git.bind(worker); let injected = false;
  worker.git = async (args, options) => {
    if (args[0] === 'push' && !injected) { injected = true; await commitFiles({ [`messages/${peer.id}.json`]: peer }); }
    return originalGit(args, options);
  };
  await outbox(worker, directory, reply()); assert.equal((await worker.runOnce()).sent, 1);
  const files = (await git([`--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', 'omi-relay'])).split('\n');
  assert.equal(files.length, 4); assert.ok(files.includes(`messages/${peer.id}.json`));
  assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 3);
});

test('changed or deleted existing messages stop without advancing the previous cursor', async t => {
  const { worker, directory, seed, commitFiles } = await fixture(t);
  await worker.runOnce(); const before = JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8'));
  await commitFiles({ [`messages/${seed.id}.json`]: { ...seed, body: 'Replaced contents' } });
  await assert.rejects(worker.runOnce(), { code: 'MESSAGE_CHANGED' });
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8')), before);
  assert.equal(JSON.parse(await fs.readFile(join(directory, 'inbox', `${seed.id}.json`), 'utf8')).body, seed.body);
});

test('branch rewrite is refused instead of resetting cursor or accepting replacement history', async t => {
  const { worker, directory, commitFiles } = await fixture(t);
  await worker.runOnce(); const before = JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8'));
  const replacement = message('Unrelated replacement history');
  await commitFiles({ [`messages/${replacement.id}.json`]: replacement }, { parent: null });
  await assert.rejects(worker.runOnce(), { code: 'HISTORY_REWRITTEN' });
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8')), before);
});

test('invalid envelope cannot advance cursor and malicious body text is only stored as data', async t => {
  const { worker, directory, commitFiles } = await fixture(t);
  await worker.runOnce(); const before = JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8'));
  const invalid = message('Untrusted body', { participantId: '../not-a-seat' });
  await commitFiles({ [`messages/${invalid.id}.json`]: invalid });
  await assert.rejects(worker.runOnce(), { code: 'INVALID_MESSAGE' });
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8')), before);
});

test('crash replay deduplicates durable inbox files before advancing the cursor again', async t => {
  const { worker, makeWorker, directory, commitFiles } = await fixture(t);
  await worker.runOnce(); const oldCursor = JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8'));
  const next = message('A later message'); await commitFiles({ [`messages/${next.id}.json`]: next }); await worker.runOnce();
  await fs.writeFile(join(directory, 'git-cursor.json'), JSON.stringify(oldCursor));
  assert.equal((await makeWorker().runOnce()).received, 0); assert.equal((await fs.readdir(join(directory, 'inbox'))).length, 2);
});

test('a failed unchanged push preserves the outbox and pending UUID without retry loops', async t => {
  const { worker, makeWorker, directory } = await fixture(t); const request = reply(); await outbox(worker, directory, request);
  const originalGit = worker.git.bind(worker); let pushes = 0;
  worker.git = (args, options) => { if (args[0] === 'push') { pushes++; throw new Error('Simulated authorization failure'); } return originalGit(args, options); };
  await assert.rejects(worker.runOnce(), { code: 'GIT_PUSH_FAILED' }); assert.equal(pushes, 1);
  const pendingFiles = await fs.readdir(join(directory, 'pending')); const pending = JSON.parse(await fs.readFile(join(directory, 'pending', pendingFiles[0]), 'utf8'));
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 1);
  await makeWorker().runOnce();
  assert.ok((await fs.readdir(join(directory, 'inbox'))).includes(`${pending.id}.json`));
});

test('malformed outbox is quarantined and a changed stable request is refused', async t => {
  const { worker, directory } = await fixture(t); const request = reply(); await outbox(worker, directory, request);
  await fs.writeFile(join(directory, 'outbox', 'a-invalid.json'), '{not-json');
  const result = await worker.runOnce(); assert.equal(result.rejected, 1); assert.equal(result.sent, 1);
  await outbox(worker, directory, { ...request, body: 'Changed contents' });
  await assert.rejects(worker.runOnce(), { code: 'OUTBOX_CONFLICT' });
  assert.equal((await fs.readdir(join(directory, 'outbox'))).length, 1);
});

test('deleted messages are refused with the prior cursor intact', async t => {
  const { worker, directory, seed, commitFiles } = await fixture(t);
  await worker.runOnce(); const old = JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8'));
  await commitFiles({}, { remove: [`messages/${seed.id}.json`] });
  await assert.rejects(worker.runOnce(), { code: 'MESSAGE_CHANGED' });
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'git-cursor.json'), 'utf8')), old);
});

test('an intermediate edit remains forbidden even if another unseen commit restores the original', async t => {
  const { worker, seed, commitFiles } = await fixture(t);
  await worker.runOnce();
  await commitFiles({ [`messages/${seed.id}.json`]: { ...seed, body: 'Temporary hidden alteration' } });
  await commitFiles({ [`messages/${seed.id}.json`]: seed });
  await assert.rejects(worker.runOnce(), { code: 'MESSAGE_CHANGED' });
});

test('numeric sender/topic IDs and unexpected envelope fields fail validation', () => {
  assert.throws(() => validateGitMessage(message('Valid body', { participantId: 123 })), { code: 'INVALID_MESSAGE' });
  assert.throws(() => validateGitMessage(message('Valid body', { topicId: 123 })), { code: 'INVALID_OUTBOX' });
  assert.throws(() => validateGitMessage(message('Valid body', { command: 'untrusted' })), { code: 'INVALID_MESSAGE' });
});
