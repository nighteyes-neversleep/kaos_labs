#!/usr/bin/env node
/** Real isolated mail transport; deterministic HTTP fixture, never a live model. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { enqueueAdvisory } from '../relay/advisory.mjs';
import { GitRelayWorker, validateGitMessage } from '../relay/git-worker.mjs';
import { sortAgentMail } from '../relay/mailroom.mjs';
import { ModelAdapter, validateAdapterConfig } from '../relay/model-adapter.mjs';
import { StationSupervisor } from '../relay/station.mjs';

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(CHECKOUT, 'test-results');
const SEATS = ['dot', 'deepseek', 'claude', 'gemini', 'muse'];
const MEMBERS = SEATS.slice(1);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

function git(args, { input = '', env = {}, cwd = CHECKOUT } = {}) {
  return new Promise((accept, reject) => {
    const child = execFile('git', args, {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 20_000,
    }, (error, stdout) => error ? reject(error) : accept(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** This exact public-source fingerprint is also checked by the bundle builder. */
async function sourceSnapshot() {
  const paths = [];
  async function walk(directory) {
    const entries = await fs.readdir(join(CHECKOUT, directory), { withFileTypes: true });
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.(?:mjs|sh)$/.test(entry.name)) paths.push(path);
    }
  }
  await walk('relay');
  await walk('node');
  paths.push('scripts/virtual-team-sim.mjs');
  paths.sort();
  const files = [];
  for (const path of paths) {
    const bytes = await fs.readFile(join(CHECKOUT, path));
    files.push({ path, sha256: sha256(bytes), bytes: bytes.length });
  }
  return {
    commit: await git(['rev-parse', 'HEAD']),
    dirty: Boolean(await git(['status', '--porcelain', '--untracked-files=normal'])),
    fingerprint: sha256(files.map(file => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join('')),
    files,
  };
}

async function jsonFiles(directory) {
  const entries = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort();
  return Promise.all(entries.map(async name => ({ name, value: JSON.parse(await fs.readFile(join(directory, name), 'utf8')) })));
}

async function seedRemote(root, remote) {
  await git(['init', '--bare', '--template=', remote]);
  const index = join(root, `seed-index-${randomUUID()}`);
  const env = {
    GIT_AUTHOR_NAME: 'OMI synthetic simulation', GIT_AUTHOR_EMAIL: 'simulation@example.invalid',
    GIT_COMMITTER_NAME: 'OMI synthetic simulation', GIT_COMMITTER_EMAIL: 'simulation@example.invalid',
    GIT_INDEX_FILE: index,
  };
  await git([`--git-dir=${remote}`, 'read-tree', '--empty'], { env });
  const blob = await git([`--git-dir=${remote}`, 'hash-object', '-w', '--stdin'], {
    input: 'Synthetic OMI mailbox fixture. No production agents, credentials, or messages.\n', env,
  });
  await git([`--git-dir=${remote}`, 'update-index', '--add', '--cacheinfo', '100644', blob, 'README.md'], { env });
  const tree = await git([`--git-dir=${remote}`, 'write-tree'], { env });
  const commit = await git([`--git-dir=${remote}`, '-c', 'commit.gpgSign=false', 'commit-tree', tree], {
    input: 'Seed synthetic OMI mailbox\n', env,
  });
  await git([`--git-dir=${remote}`, 'update-ref', 'refs/heads/omi-relay', commit]);
  await fs.unlink(index);
}

function advisory(id, to, kind, extra = {}) {
  return {
    protocol: 'omi-advisory/1', id, kind, from: 'dot', to,
    summary: `Synthetic simulation ${kind}: ${id}`,
    details: { scope: 'Inspect the selected public source and return a short draft. Execute no tools.' },
    createdAt: new Date().toISOString(), requiresAck: false, ...extra,
  };
}

async function providerFixture(trace) {
  const requests = [];
  const timers = new Set();
  const failures = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.ok(['/api/chat', '/v1/chat/completions'].includes(request.url));
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.stream, false);
      const seat = body.model.replace(/^simulation-/, '');
      assert.ok(MEMBERS.includes(seat));
      const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
      assert.equal(payload.assignment.taskId, `SIM-${seat.toUpperCase()}-001`);
      assert.equal(payload.sourceFiles.length, 1);
      assert.equal(payload.sourceFiles[0].path, 'relay/advisory.mjs');
      assert.ok(payload.sourceFiles[0].text.includes('validateAdvisory'));
      assert.ok(request.headers['idempotency-key']);
      const count = requests.filter(item => item.participantId === seat).length + 1;
      requests.push({ participantId: seat, attempt: count, taskId: payload.assignment.taskId, providerKind: request.url === '/api/chat' ? 'ollama' : 'openai-compatible' });
      trace('fixture_provider_request', { participantId: seat, attempt: count });
      // An actual aborted HTTP request exercises the adapter timeout and retry.
      const reply = () => {
        if (response.destroyed) return;
        const content = `SIMULATED ${seat} draft: source received. This deterministic fixture is not a live AI model and executed no tests.`;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(request.url === '/api/chat' ? { message: { content } } : { choices: [{ message: { content } }] }));
      };
      if (seat === 'gemini' && count === 1) {
        const timer = setTimeout(() => { timers.delete(timer); reply(); }, 500);
        timers.add(timer);
      } else reply();
    } catch (error) {
      failures.push(error.message);
      if (!response.destroyed) { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"invalid simulation request"}'); }
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests, failures, base,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    },
  };
}

async function main() {
  if (process.argv.length !== 2) { console.error('Usage: node scripts/virtual-team-sim.mjs'); return 1; }
  const report = {
    protocol: 'omi-virtual-team-sim/1', status: 'failed', startedAt: new Date().toISOString(),
    simulatedProvider: true, liveModelsTested: false, productionMailboxUsed: false,
    scope: 'Five synthetic seats using production Git transport, station, advisory, mailroom, and model-adapter code; local bare Git and a deterministic loopback HTTP provider.',
    limitations: ['No live Claude, DeepSeek, Gemini, Muse, or Codex inference was tested.', 'No remote Station Node or Route66 installation was verified.', 'Per-seat sorting is routing for cooperating agents, not secrecy from shared repository readers.', 'Crash injection uses the adapter durable-result fault hook; no operating-system process was killed.'],
    checks: [], timeline: [], seats: [],
  };
  const trace = (event, fields = {}) => report.timeline.push({ sequence: report.timeline.length + 1, event, ...fields });
  let stage = 'initialization';
  async function check(name, verify) {
    stage = name;
    try { const details = await verify(); report.checks.push({ name, status: 'passed', ...(details ? { details } : {}) }); }
    catch (error) { report.checks.push({ name, status: 'failed', error: error.message }); throw error; }
  }
  let root;
  let fixture;
  let initialSource;
  try {
    initialSource = await sourceSnapshot();
    // State lives outside the checkout, is owner-private, and is deleted below.
    root = await fs.mkdtemp('/workspace/omi-virtual-sim-');
    await fs.chmod(root, 0o700);
    const remote = join(root, 'synthetic.git');
    await seedRemote(root, remote);
    const stationDirectory = join(root, 'station');
    const seatDirectory = id => join(stationDirectory, id);
    const alias = id => id === 'muse' ? ['qa-tracker'] : [];
    const makeStation = (directory = stationDirectory, unavailableSeat = null) => new StationSupervisor({
      // Station validates production HTTPS syntax; the test factory replaces it
      // with a local bare repo before any Git request is made.
      remote: 'https://simulation.invalid/omi/fixture.git', branch: 'omi-relay', directory,
      participants: SEATS.map(id => ({ id, enabled: true, addresses: alias(id) })),
      intervalMs: 1000, concurrency: 2, timeoutMs: 10_000,
    }, {
      workerFactory: (config, options) => new GitRelayWorker({ ...config, remote: config.participantId === unavailableSeat ? join(root, 'unavailable.git') : remote }, { ...options, allowLocalRemoteForTests: true }),
      mailSorter: sortAgentMail,
      // A deterministic scheduler clock makes the explicit backoff assertion
      // independent of host disk speed. Adapter timeouts still use real time.
      now: () => 1_700_000_000_000,
      log: event => trace(event.event, Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'event'))),
    });
    const station = makeStation();
    const cycle = async () => {
      const result = await station.runOnce();
      assert.equal(result.failed, 0, `Station failure: ${JSON.stringify(result.participants.filter(seat => seat.status !== 'complete'))}`);
      assert.equal(result.completed, 5);
      return result;
    };
    await check('five independent private seats initialize over real local Git', async () => {
      await cycle();
      for (const id of SEATS) assert.equal((await fs.stat(seatDirectory(id))).mode & 0o077, 0);
    });
    const originalDotCursor = await fs.readFile(join(seatDirectory('dot'), 'git-cursor.json'));
    await check('Dot queues four addressed assignments and one explicit broadcast', async () => {
      for (const id of MEMBERS) await enqueueAdvisory(join(seatDirectory('dot'), 'outbox'), advisory(`assignment-${id}`, [id === 'muse' ? 'qa-tracker' : id], 'assignment', { taskId: `SIM-${id.toUpperCase()}-001` }));
      await enqueueAdvisory(join(seatDirectory('dot'), 'outbox'), advisory('simulation-broadcast', ['all'], 'progress'));
      await enqueueAdvisory(join(seatDirectory('dot'), 'outbox'), advisory('dot-self-assignment', ['dot'], 'assignment', { taskId: 'SIM-DOT-SELF' }));
      for (const [name, body] of [
        ['legacy', 'Synthetic operator note without a routing protocol.'],
        ['malformed', JSON.stringify({ protocol: 'omi-advisory/1', kind: 'assignment', to: ['gemini'] })],
      ]) await fs.writeFile(join(seatDirectory('dot'), 'outbox', `${name}.json`), json({ topicId: 'simulation-fixture', clientMessageId: `simulation-${name}`, body }), { mode: 0o600 });
      await cycle(); await cycle();
    });
    const assignmentInputs = new Map();
    await check('mailrooms isolate directed work, deliver broadcast once, and quarantine malformed advisory', async () => {
      for (const id of SEATS) {
        const raw = await jsonFiles(join(seatDirectory(id), 'inbox'));
        assert.equal(raw.length, 8);
        for (const { value } of raw) validateGitMessage(value);
        const inbox = await jsonFiles(join(seatDirectory(id), 'mail/inbox'));
        assert.equal(inbox.length, 1);
        const input = inbox[0].value;
        const task = JSON.parse(input.body);
        assert.equal(task.id, id === 'dot' ? 'dot-self-assignment' : `assignment-${id}`);
        assignmentInputs.set(id, input);
        assert.equal((await jsonFiles(join(seatDirectory(id), 'mail/broadcast'))).length, 1);
        assert.equal((await jsonFiles(join(seatDirectory(id), 'mail/unaddressed'))).length, 1);
        assert.equal((await jsonFiles(join(seatDirectory(id), 'mail/quarantine'))).length, 1);
        const receipts = await jsonFiles(join(seatDirectory(id), 'mail/receipts'));
        assert.equal(receipts.filter(item => item.value.classification === 'not-for-me').length, 4);
      }
      return { sharedRawTransportCopiesPerSeat: 8, directedCopiesPerSeat: 1, routingIsNotAnAccessControlBoundary: true };
    });
    fixture = await providerFixture(trace);
    const makeAdapter = (id, hooks = {}) => new ModelAdapter(validateAdapterConfig({
      participantId: id, seatDirectory: seatDirectory(id), addresses: alias(id),
      provider: { kind: id === 'muse' ? 'openai-compatible' : 'ollama', url: fixture.base + (id === 'muse' ? '/v1/chat/completions' : '/api/chat'), model: `simulation-${id}` },
      sourceRoot: CHECKOUT, sourceFiles: ['relay/advisory.mjs'], timeoutMs: 150,
      maxResponseBytes: 1024 * 1024, maxAttempts: 3, intervalMs: 500,
    }), { ...hooks, log: event => trace(event.event, Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'event'))) });
    const initialAdapterResults = new Map();
    await check('actual HTTP provider calls carry only each assigned task and selected source', async () => {
      const runs = await Promise.all(MEMBERS.map(async id => {
        const hooks = id === 'claude' ? { afterPendingResult: () => { throw new Error('Synthetic crash after durable result, before outbox enqueue.'); } } : {};
        return [id, await makeAdapter(id, hooks).runOnce()];
      }));
      for (const [id, result] of runs) initialAdapterResults.set(id, result);
      assert.equal(fixture.requests.length, 4);
      assert.deepEqual(fixture.failures, []);
      assert.equal(initialAdapterResults.get('deepseek').queued, 1);
      assert.equal(initialAdapterResults.get('muse').queued, 1);
      assert.equal(initialAdapterResults.get('gemini').failed, 1);
      assert.equal(initialAdapterResults.get('gemini').queued, 0);
      assert.equal(initialAdapterResults.get('claude').failed, 1);
      assert.equal(initialAdapterResults.get('claude').queued, 0);
      assert.equal((await jsonFiles(join(seatDirectory('gemini'), 'outbox'))).length, 0);
    });
    await check('restart recovers durable Claude result without repeating provider inference', async () => {
      const requestsBefore = fixture.requests.length;
      const result = await makeAdapter('claude').runOnce();
      assert.equal(result.providerCalls, 0);
      assert.equal(result.queued, 1);
      assert.equal(fixture.requests.length, requestsBefore);
      assert.equal((await jsonFiles(join(seatDirectory('claude'), 'outbox'))).length, 1);
    });
    await check('lost adapter receipt reuses the stable pending result without duplicate outbox work', async () => {
      const requestsBefore = fixture.requests.length;
      await fs.unlink(join(seatDirectory('claude'), 'adapter/receipts', `${assignmentInputs.get('claude').id}.json`));
      const result = await makeAdapter('claude').runOnce();
      assert.equal(result.providerCalls, 0);
      assert.equal(result.queued, 1);
      assert.equal((await jsonFiles(join(seatDirectory('claude'), 'outbox'))).length, 1);
      assert.equal(fixture.requests.length, requestsBefore);
    });
    await check('concurrent Git writers preserve three successful replies while Gemini remains pending', async () => {
      const rounds = [await cycle(), await cycle()];
      assert.equal(rounds.reduce((sum, round) => sum + round.participants.reduce((n, seat) => n + seat.sent, 0), 0), 3);
      const replies = (await jsonFiles(join(seatDirectory('dot'), 'mail/inbox'))).filter(item => JSON.parse(item.value.body).kind === 'result');
      assert.equal(replies.length, 3);
      assert.deepEqual(replies.map(item => item.value.participantId).sort(), ['claude', 'deepseek', 'muse']);
      assert.equal((await jsonFiles(join(seatDirectory('gemini'), 'adapter/receipts'))).length, 0);
      const attempt = (await jsonFiles(join(seatDirectory('gemini'), 'adapter/attempts')))[0].value;
      assert.equal(attempt.count, 1);
      assert.equal(attempt.lastCode, 'PROVIDER_PENDING');
      return { actualConcurrentWriterLimit: 2, successfulRepliesBeforeFailedSeatRecovery: 3 };
    });
    await check('timed out provider task retries with bounded attempts and returns its fourth result', async () => {
      const adapter = makeAdapter('gemini');
      let result;
      for (let attempt = 0; attempt < 20; attempt++) {
        result = await adapter.runOnce();
        if (result.queued) break;
        assert.equal(result.blocked, 0); assert.equal(result.failed, 0);
        await delay(100);
      }
      assert.equal(result.queued, 1);
      assert.equal(fixture.requests.filter(request => request.participantId === 'gemini').length, 2);
      await cycle(); await cycle();
    });
    await check('Dot receives four correlated draft results with truthful unverified status', async () => {
      const replies = (await jsonFiles(join(seatDirectory('dot'), 'mail/inbox'))).filter(item => JSON.parse(item.value.body).kind === 'result');
      assert.equal(replies.length, 4);
      for (const { value: envelope } of replies) {
        const reply = JSON.parse(envelope.body);
        assert.equal(reply.from, envelope.participantId);
        assert.deepEqual(reply.to, ['dot']);
        assert.equal(reply.taskId, `SIM-${reply.from.toUpperCase()}-001`);
        assert.equal(reply.details.inReplyTo, assignmentInputs.get(reply.from).id);
        assert.equal(reply.details.status, 'model-output-unverified');
        assert.deepEqual(reply.details.checksExecutedByAdapter, []);
        assert.equal(reply.details.sourceFiles.length, 1);
        assert.ok(reply.details.output.startsWith('SIMULATED '));
        assert.equal(reply.requiresAck, false);
      }
      assert.deepEqual(fixture.failures, []);
    });
    await check('lost transport sent receipt replays the same identity without a new Git commit', async () => {
      const directory = seatDirectory('muse');
      const [{ name, value: archive }] = await jsonFiles(join(directory, 'sent'));
      const head = await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']);
      await fs.unlink(join(directory, 'sent', name));
      const { topicId, body, clientMessageId } = archive.message;
      await fs.writeFile(join(directory, 'outbox', 'replayed-result.json'), json({ topicId, body, clientMessageId }), { mode: 0o600 });
      await cycle();
      assert.equal(await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']), head);
      assert.equal((await jsonFiles(join(directory, 'sent'))).length, 1);
    });
    await check('cursor replay and completed adapter restarts create no extra provider calls or messages', async () => {
      const requestsBefore = fixture.requests.length;
      const head = await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']);
      await fs.writeFile(join(seatDirectory('dot'), 'git-cursor.json'), originalDotCursor, { mode: 0o600 });
      const restartedStation = makeStation();
      const cycleResult = await restartedStation.runOnce();
      assert.equal(cycleResult.failed, 0);
      const results = await Promise.all(SEATS.map(id => makeAdapter(id).runOnce()));
      for (const result of results) { assert.equal(result.providerCalls, 0); assert.equal(result.queued, 0); assert.equal(result.failed, 0); assert.equal(result.blocked, 0); }
      assert.equal(fixture.requests.length, requestsBefore);
      assert.equal(await git([`--git-dir=${remote}`, 'rev-parse', 'omi-relay']), head);
      for (const id of SEATS) {
        const raw = await jsonFiles(join(seatDirectory(id), 'inbox'));
        assert.equal(raw.length, 12);
        const initial = raw.find(item => item.value.id === assignmentInputs.get(id).id).value;
        assert.deepEqual(initial, assignmentInputs.get(id));
        assert.equal((await jsonFiles(join(seatDirectory(id), 'mail/broadcast'))).length, 1);
        const resultsForOthers = (await jsonFiles(join(seatDirectory(id), 'mail/inbox'))).filter(item => JSON.parse(item.value.body).kind === 'result');
        assert.equal(resultsForOthers.length, id === 'dot' ? 4 : 0);
      }
      const files = (await git([`--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', 'omi-relay'])).split('\n');
      assert.equal(files.filter(path => path.startsWith('messages/')).length, 12);
      assert.equal(new Set(files).size, files.length);
      assert.equal(fixture.requests.length, 5);
    });
    await check('one unavailable Git seat backs off while four other seats keep polling', async () => {
      const isolated = makeStation(join(root, 'failure-isolation-station'), 'gemini');
      const failedCycle = await isolated.runOnce();
      assert.equal(failedCycle.failed, 1); assert.equal(failedCycle.completed, 4);
      assert.equal(failedCycle.participants.find(seat => seat.participantId === 'gemini').status, 'failed');
      const nextCycle = await isolated.runOnce();
      assert.equal(nextCycle.backoff, 1); assert.equal(nextCycle.completed, 4);
      assert.equal(nextCycle.participants.find(seat => seat.participantId === 'gemini').status, 'backoff');
    });
    for (const id of SEATS) {
      const mail = {};
      for (const folder of ['inbox', 'broadcast', 'unaddressed', 'quarantine', 'receipts']) mail[folder] = (await jsonFiles(join(seatDirectory(id), 'mail', folder))).length;
      report.seats.push({
        participantId: id, synthetic: true, addresses: alias(id),
        rawReceived: (await jsonFiles(join(seatDirectory(id), 'inbox'))).length,
        sorted: mail, assignedTasks: id === 'dot' ? 0 : 1,
        providerRequests: fixture.requests.filter(request => request.participantId === id).length,
        successfulResults: id === 'dot' ? 0 : (await jsonFiles(join(seatDirectory(id), 'sent'))).length,
        receivedResults: id === 'dot' ? 4 : 0,
      });
    }
    report.provider = { type: 'deterministic-local-http-fixture', realInference: false, requests: fixture.requests, totalRequests: fixture.requests.length, successfulTaskResults: 4, injectedTimeouts: 1 };
    report.source = await sourceSnapshot();
    await check('public source fingerprint stayed unchanged throughout the simulation', async () => {
      assert.equal(report.source.fingerprint, initialSource.fingerprint, 'Public source changed while simulation ran; rerun after writers finish.');
      assert.equal(report.source.commit, initialSource.commit, 'HEAD changed while simulation ran; rerun after commit.');
    });
    report.status = 'passed';
  } catch (error) {
    if (!report.checks.some(check => check.status === 'failed')) report.checks.push({ name: stage, status: 'failed', error: error.message });
    report.failure = { stage, message: error.message, ...(error.code ? { code: error.code } : {}) };
    try { report.source = await sourceSnapshot(); } catch { /* Keep primary failure. */ }
  } finally {
    if (fixture) await fixture.close().catch(error => { report.status = 'failed'; report.checks.push({ name: 'fixture cleanup', status: 'failed', error: error.message }); });
    if (root) await fs.rm(root, { recursive: true, force: true }).catch(error => { report.status = 'failed'; report.checks.push({ name: 'private state cleanup', status: 'failed', error: error.message }); });
    report.finishedAt = new Date().toISOString();
    report.counts = { passed: report.checks.filter(check => check.status === 'passed').length, failed: report.checks.filter(check => check.status === 'failed').length };
    await fs.mkdir(OUTPUT, { recursive: true });
    await fs.writeFile(join(OUTPUT, 'simulation-report.json'), json(report));
    const summary = [
      `OMI virtual team simulation: ${report.status.toUpperCase()}`,
      `${report.counts.passed} checks passed; ${report.counts.failed} failed.`,
      'Five synthetic seats; real local Git transport and production mail/adapter code.',
      'Deterministic local HTTP provider: no live AI model or remote node was tested.',
      ...(report.provider ? [`${report.provider.successfulTaskResults} task results returned; ${report.provider.totalRequests} provider requests including one injected timeout.`] : []),
      ...report.checks.map(check => `${check.status === 'passed' ? 'PASS' : 'FAIL'} ${check.name}${check.error ? `: ${check.error}` : ''}`),
      ...(report.source ? [`Source commit: ${report.source.commit}`, `Source fingerprint: ${report.source.fingerprint}`, `Source working tree dirty: ${report.source.dirty}`] : []),
      'Limits: the report certifies this synthetic relay scenario, not live model availability or the complete OMI application.',
    ].join('\n') + '\n';
    await fs.writeFile(join(OUTPUT, 'simulation-summary.txt'), summary);
    console.log(summary);
    console.log(`Report: ${relative(CHECKOUT, join(OUTPUT, 'simulation-report.json'))}`);
  }
  return report.status === 'passed' ? 0 : 1;
}

process.exitCode = await main();
