import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadStationConfig, StationSupervisor, validateStationConfig } from './station.mjs';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'omi-station-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    config: {
      remote: 'https://github.com/nighteyes-neversleep/kaos_labs.git', branch: 'omi-relay', directory: join(root, 'station'),
      participants: [{ id: 'deepseek', enabled: true }, { id: 'claude', enabled: true }], intervalMs: 15000, concurrency: 2, ...extra,
    },
  };
}

test('strict configuration rejects duplicate/path IDs, unsafe remotes, excessive seats and concurrency', async t => {
  const { config } = await fixture(t);
  assert.equal(validateStationConfig(config).timeoutMs, 30000);
  assert.equal(validateStationConfig({ ...config, concurrency: undefined }).concurrency, 2);
  for (const participants of [
    [{ id: 'same' }, { id: 'same' }], [{ id: 'Seat' }, { id: 'seat' }], [{ id: '../escape' }], [{ id: 'CON' }],
    [{ id: 123 }], [{ id: 'valid', enabled: 'yes' }], [], Array.from({ length: 33 }, (_, n) => ({ id: `seat-${n}` })),
    [{ id: 'valid', command: 'never execute' }],
  ]) assert.throws(() => validateStationConfig({ ...config, participants }), { code: 'INVALID_CONFIG' });
  for (const remote of ['http://github.com/owner/repo', 'https://user:secret@github.com/owner/repo', '/tmp/repo.git']) {
    assert.throws(() => validateStationConfig({ ...config, remote }), { code: 'INVALID_CONFIG' });
  }
  for (const concurrency of [0, 9, NaN, 1.5]) assert.throws(() => validateStationConfig({ ...config, concurrency }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateStationConfig({ ...config, directory: resolve('relay/private') }), { code: 'INVALID_CONFIG' });
  assert.throws(() => validateStationConfig({ ...config, modelCommand: 'never execute' }), { code: 'INVALID_CONFIG' });
});

test('config loader accepts owner-private UTF-8 JSON and refuses symlinks/shared files', async t => {
  const { root, config } = await fixture(t); const path = join(root, 'station.json');
  await fs.writeFile(path, '\uFEFF' + JSON.stringify(config), { mode: 0o600 });
  assert.equal((await loadStationConfig(path)).participants.length, 2);
  if (process.getuid) {
    await fs.chmod(path, 0o644);
    await assert.rejects(loadStationConfig(path), { code: 'INVALID_CONFIG' });
    await fs.chmod(path, 0o600);
  }
  const link = join(root, 'station-link.json'); await fs.symlink(path, link);
  await assert.rejects(loadStationConfig(link), { code: 'INVALID_CONFIG' });
  await fs.writeFile(path, '{invalid'); await assert.rejects(loadStationConfig(path), { code: 'INVALID_CONFIG' });
});

test('scheduler bounds concurrency while every enabled seat completes exactly one cycle', async t => {
  const { config } = await fixture(t, { participants: Array.from({ length: 7 }, (_, n) => ({ id: `seat-${n}`, enabled: true })), concurrency: 2 });
  let active = 0; let peak = 0; const calls = new Map();
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}),
    log: () => {},
    workerFactory: seat => ({ runOnce: async () => {
      active++; peak = Math.max(peak, active); calls.set(seat.participantId, (calls.get(seat.participantId) || 0) + 1);
      await delay(10); active--; return { received: 1, sent: 0, rejected: 0 };
    } }),
  });
  const result = await supervisor.runOnce();
  assert.equal(peak, 2); assert.equal(active, 0); assert.equal(result.completed, 7); assert.equal(result.failed, 0);
  assert.equal(calls.size, 7); for (const value of calls.values()) assert.equal(value, 1);
});

test('seat directories and identity bindings stay separate and survive supervisor restart', async t => {
  const { config } = await fixture(t); const seen = [];
  const factory = seat => {
    seen.push(seat);
    return { runOnce: async () => {
      const marker = join(seat.directory, 'adapter-state.json');
      let previous = 0; try { previous = JSON.parse(await fs.readFile(marker, 'utf8')).count; } catch {}
      await fs.writeFile(marker, JSON.stringify({ count: previous + 1 }), { mode: 0o600 });
      return { received: 0, sent: 0, rejected: 0 };
    } };
  };
  await new StationSupervisor(config, { mailSorter: async () => ({}), workerFactory: factory, log: () => {} }).runOnce();
  await new StationSupervisor(config, { mailSorter: async () => ({}), workerFactory: factory, log: () => {} }).runOnce();
  for (const id of ['deepseek', 'claude']) {
    assert.equal(JSON.parse(await fs.readFile(join(config.directory, id, 'adapter-state.json'), 'utf8')).count, 2);
    const seat = seen.find(value => value.participantId === id);
    assert.equal(seat.directory, join(config.directory, id)); assert.equal(seat.remote, config.remote); assert.equal(seat.branch, 'omi-relay');
  }
  assert.notEqual(seen[0].directory, seen[1].directory);
});

test('disabled seats are not instantiated and do not create state directories', async t => {
  const { config } = await fixture(t, { participants: [{ id: 'active', enabled: true }, { id: 'disabled', enabled: false }] });
  const started = [];
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}), log: () => {}, workerFactory: seat => {
    started.push(seat.participantId); return { runOnce: async () => ({}) };
  } });
  const result = await supervisor.runOnce();
  assert.deepEqual(started, ['active']); assert.equal(result.disabled, 1); assert.equal(result.completed, 1);
  await assert.rejects(fs.stat(join(config.directory, 'disabled')), { code: 'ENOENT' });
});

test('one failed seat does not stop others, backs off across cycles, and recovers', async t => {
  const { config } = await fixture(t); let now = 1_000_000; const calls = { deepseek: 0, claude: 0 }; const logs = [];
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}),
    now: () => now, log: event => logs.push(event),
    workerFactory: seat => ({ runOnce: async () => {
      calls[seat.participantId]++;
      if (seat.participantId === 'deepseek' && calls.deepseek <= 2) throw new Error('secret token and private body must never be printed');
      return { received: 0, sent: 1, rejected: 0 };
    } }),
  });
  let result = await supervisor.runOnce(); assert.equal(result.failed, 1); assert.equal(result.completed, 1);
  result = await supervisor.runOnce(); assert.equal(result.backoff, 1); assert.equal(calls.deepseek, 1); assert.equal(calls.claude, 2);
  now += 15000; result = await supervisor.runOnce(); assert.equal(result.failed, 1);
  assert.equal(result.participants.find(p => p.participantId === 'deepseek').retryInMs, 30000);
  now += 15000; result = await supervisor.runOnce(); assert.equal(result.backoff, 1);
  now += 15000; result = await supervisor.runOnce(); assert.equal(result.completed, 2);
  assert.equal(calls.deepseek, 3); assert.ok(!JSON.stringify(logs).includes('secret token'));
});

test('transport logs forward only sanitized IDs, counts, and status', async t => {
  const { config } = await fixture(t); const logs = [];
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}),
    log: event => logs.push(event),
    workerFactory: (seat, options) => ({ runOnce: async () => {
      options.log({ event: 'git_relay_cycle', received: 2, sent: 'private payload', rejected: -1, body: 'secret message', token: 'secret token', commit: 'not forwarded' });
      options.log({ event: 'secret event', body: 'secret message' });
      return { received: 2, sent: NaN, rejected: -1, privateData: 'secret message' };
    } }),
  });
  const result = await supervisor.runOnce(); assert.equal(result.completed, 2);
  const output = JSON.stringify(logs); assert.ok(!output.includes('secret')); assert.ok(!output.includes('not forwarded')); assert.ok(!output.includes('private payload'));
  const transport = logs.find(log => log.event === 'station_transport'); assert.equal(transport.sent, 0); assert.equal(transport.rejected, 0);
});

test('abort stops scheduling queued seats while allowing an active cycle to finish safely', async t => {
  const { config } = await fixture(t, { concurrency: 1, participants: [{ id: 'first' }, { id: 'second' }, { id: 'third' }] });
  const stop = new AbortController(); const calls = [];
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}),
    log: () => {}, workerFactory: seat => ({ runOnce: async () => { calls.push(seat.participantId); stop.abort(); return {}; } }),
  });
  const result = await supervisor.runOnce({ signal: stop.signal });
  assert.deepEqual(calls, ['first']); assert.equal(result.completed, 1); assert.equal(result.stopped, 2);
});

test('runOnce has no implicit repeat loop and overlapping cycles are refused', async t => {
  const { config } = await fixture(t); let calls = 0; let finish;
  const gate = new Promise(resolveGate => { finish = resolveGate; });
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}), log: () => {}, workerFactory: () => ({ runOnce: async () => { calls++; await gate; return {}; } }) });
  const running = supervisor.runOnce();
  await assert.rejects(supervisor.runOnce(), { code: 'CYCLE_ACTIVE' });
  finish(); await running; await delay(10); assert.equal(calls, 2);
});

test('continuous loop exits when its wait is aborted without starting another round', async t => {
  const { config } = await fixture(t); const stop = new AbortController(); let calls = 0; let waits = 0;
  const supervisor = new StationSupervisor(config, { mailSorter: async () => ({}),
    log: () => {}, workerFactory: () => ({ runOnce: async () => { calls++; return {}; } }),
    wait: async (milliseconds, signal) => { waits++; assert.equal(milliseconds, 15000); assert.equal(signal, stop.signal); stop.abort(); throw new Error('aborted'); },
  });
  await supervisor.run({ signal: stop.signal }); assert.equal(calls, 2); assert.equal(waits, 1);
});

test('seat aliases are bounded distinct routing labels; shared aliases represent distribution copies', async t => {
  const { config } = await fixture(t);
  const participants = [
    { id: 'claude-route66', addresses: ['claude', 'reviewers'] },
    { id: 'gemini-cloud', addresses: ['gemini', 'reviewers'] },
  ];
  const checked = validateStationConfig({ ...config, participants });
  assert.deepEqual(checked.participants[0].addresses, ['claude', 'reviewers']);
  assert.deepEqual(checked.participants[1].addresses, ['gemini', 'reviewers']);
  participants[0].addresses.push('later-change');
  assert.deepEqual(checked.participants[0].addresses, ['claude', 'reviewers']);
  assert.deepEqual(validateStationConfig(config).participants[0].addresses, []);
  const invalid = [
    [{ id: 'all' }], [{ id: 'BROADCAST' }],
    [{ id: 'seat', addresses: 'not-an-array' }], [{ id: 'seat', addresses: ['seat'] }],
    [{ id: 'seat', addresses: ['ALIAS', 'alias'] }], [{ id: 'seat', addresses: ['all'] }],
    [{ id: 'seat', addresses: ['broadcast'] }], [{ id: 'seat', addresses: ['../other'] }],
    [{ id: 'seat', addresses: [null] }], [{ id: 'seat', addresses: Array.from({ length: 32 }, (_, i) => `alias-${i}`) }],
    [{ id: 'seat', addresses: new Array(1) }],
  ];
  for (const seats of invalid) assert.throws(() => validateStationConfig({ ...config, participants: seats }), { code: 'INVALID_CONFIG' });
});

test('a successful transport cycle sorts its own seat before reporting completion and only logs numeric mail counts', async t => {
  const { config } = await fixture(t, { participants: [{ id: 'claude-route66', addresses: ['claude'] }] });
  const order = []; const inputs = []; const logs = [];
  const supervisor = new StationSupervisor(config, {
    log: event => logs.push(event),
    workerFactory: worker => ({ runOnce: async () => {
      order.push('transport');
      await fs.writeFile(join(worker.directory, 'transport-finished'), 'ready', { mode: 0o600 });
      return { received: 2 };
    } }),
    mailSorter: async input => {
      order.push('sort'); inputs.push(input);
      assert.equal(await fs.readFile(join(input.seatDirectory, 'transport-finished'), 'utf8'), 'ready');
      return { scanned: 2, delivered: 1, addressed: 1, broadcast: 'private body', rejected: 'private data', notForMe: -1, body: 'never log payload' };
    },
  });
  const result = await supervisor.runOnce();
  assert.deepEqual(order, ['transport', 'sort']);
  assert.deepEqual(inputs, [{ seatDirectory: join(config.directory, 'claude-route66'), participantId: 'claude-route66', addresses: ['claude'] }]);
  assert.equal(result.completed, 1);
  assert.equal(result.participants[0].mail.addressed, 1);
  assert.equal(result.participants[0].mail.broadcast, 0);
  assert.equal(result.participants[0].mail.notForMe, 0);
  assert.ok(!JSON.stringify(logs).includes('private'));
  assert.ok(!JSON.stringify(logs).includes('never log'));
  assert.equal(logs.findIndex(event => event.event === 'station_mailroom') < logs.findIndex(event => event.event === 'station_seat'), true);
});

test('a sorting failure keeps transport data, isolates the failed seat, and participates in retry backoff', async t => {
  const { config } = await fixture(t); let now = 1_000_000;
  const sorted = { deepseek: 0, claude: 0 }; const logs = [];
  const supervisor = new StationSupervisor(config, {
    now: () => now, log: event => logs.push(event),
    workerFactory: worker => ({ runOnce: async () => {
      await fs.writeFile(join(worker.directory, 'raw-data-preserved'), 'transport saved', { mode: 0o600 }); return {};
    } }),
    mailSorter: async ({ participantId }) => {
      sorted[participantId]++;
      if (participantId === 'deepseek' && sorted.deepseek === 1) throw new Error('private sorting input');
      return {};
    },
  });
  const first = await supervisor.runOnce();
  assert.equal(first.failed, 1); assert.equal(first.completed, 1);
  assert.equal(first.participants[0].code, 'MAIL_SORT_FAILED');
  assert.equal(await fs.readFile(join(config.directory, 'deepseek', 'raw-data-preserved'), 'utf8'), 'transport saved');
  const waiting = await supervisor.runOnce();
  assert.equal(waiting.backoff, 1); assert.equal(sorted.deepseek, 1); assert.equal(sorted.claude, 2);
  now += 15000;
  assert.equal((await supervisor.runOnce()).completed, 2);
  assert.ok(!JSON.stringify(logs).includes('private sorting input'));
});

test('transport failure does not start mail sorting', async t => {
  const { config } = await fixture(t, { participants: [{ id: 'one-seat' }] }); let sorts = 0;
  const supervisor = new StationSupervisor(config, {
    workerFactory: () => ({ runOnce: async () => { throw new Error('transport did not complete'); } }),
    mailSorter: async () => { sorts++; return {}; }, log: () => {},
  });
  assert.equal((await supervisor.runOnce()).failed, 1); assert.equal(sorts, 0);
});

test('the production default sorter delivers addressed advisories to working mail and leaves raw input unchanged', async t => {
  const { config } = await fixture(t, { participants: [{ id: 'claude-route66', addresses: ['claude'] }] });
  const id = randomUUID();
  const advisory = {
    protocol: 'omi-advisory/1', id: 'station-integration-test', kind: 'assignment', from: 'dot', to: ['claude'],
    taskId: 'QA-CLAUDE-001', summary: 'Review a bounded assigned task.', details: { target: 'test fixture' },
    createdAt: new Date().toISOString(), requiresAck: true,
  };
  const envelope = { version: 1, id, participantId: 'dot', topicId: 'coordination-advisory', body: JSON.stringify(advisory), createdAt: new Date().toISOString(), clientMessageId: 'default-sorter-fixture' };
  const raw = JSON.stringify(envelope, null, 2) + '\n';
  const supervisor = new StationSupervisor(config, {
    workerFactory: worker => ({ runOnce: async () => {
      await fs.mkdir(join(worker.directory, 'inbox'), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(worker.directory, 'inbox', `${id}.json`), raw, { mode: 0o600 }); return { received: 1 };
    } }), log: () => {},
  });
  const first = await supervisor.runOnce();
  assert.equal(first.completed, 1); assert.equal(first.participants[0].mail.addressed, 1);
  const directory = join(config.directory, 'claude-route66');
  assert.equal(await fs.readFile(join(directory, 'mail', 'inbox', `${id}.json`), 'utf8'), raw);
  assert.equal(await fs.readFile(join(directory, 'inbox', `${id}.json`), 'utf8'), raw);
  assert.equal((await supervisor.runOnce()).participants[0].mail.alreadySorted, 1);
  assert.equal((await fs.readdir(join(directory, 'mail', 'inbox'))).length, 1);
});
