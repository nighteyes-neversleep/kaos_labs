import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlNode, discover, installNode, matchesOwnedArguments, validateOllamaURL } from './discover.mjs';
import { diagnose } from './diagnose.mjs';

const execute = promisify(execFile);
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fakeRoster = () => ({ schema: 'omi.node-roster/1', host: { name: 'station' }, tools: [{ id: 'codex', installed: true }, { id: 'ollama', installed: true }], resourceSharing: 'off' });
const dependencies = { findExecutable: async name => name === 'git' ? '/usr/bin/git' : null, discover: async () => fakeRoster() };
const fixtureStation = `import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function loadStationConfig(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }
if (process.argv[1] === fileURLToPath(import.meta.url)) { setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(0)); }
`;
async function fixture(t) {
  const directory = await fs.mkdtemp(join(os.tmpdir(), 'omi-node-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'kit'); await fs.mkdir(join(root, 'node'), { recursive: true, mode: 0o700 }); await fs.mkdir(join(root, 'relay'), { mode: 0o700 });
  for (const name of ['install.sh', 'nodectl.sh', 'discover.mjs', 'diagnose.sh', 'diagnose.mjs', 'README.md']) await fs.copyFile(join(sourceRoot, 'node', name), join(root, 'node', name));
  for (const name of ['git-worker.mjs', 'advisory.mjs', 'mailroom.mjs']) await fs.writeFile(join(root, 'relay', name), 'export {};\n');
  await fs.writeFile(join(root, 'relay', 'station.mjs'), fixtureStation);
  return { directory, root, prefix: join(directory, 'private-node'), options: { sourceRoot: root, prefix: join(directory, 'private-node'), allowTemporaryPrefix: true } };
}
async function readJSON(path) { return JSON.parse(await fs.readFile(path, 'utf8')); }

test('inventory uses bounded version/status calls, never claims authentication or leaks raw command output', async () => {
  const calls = [];
  const roster = await discover({ reportedNoMachineLicenses: 5, reportedNoMachineEdition: 'Enterprise Desktop', reportedNoMachineValidThrough: '2027-10-22' }, {
    findExecutable: async name => ['claude', 'nxserver', 'systemctl'].includes(name) ? '/bin/' + name : null,
    existingExecutable: async path => path === '/bin/nxserver',
    runFile: async (file, args) => { calls.push([file, args]); return { ok: true, stdout: file.endsWith('systemctl') ? 'active\n' : file.endsWith('nxserver') ? 'NoMachine Enterprise Desktop 9.4.2 secret=PRIVATE' : 'Claude 2.1.0 token=PRIVATE' }; },
    fetch: async () => assert.fail('Default discovery must not make HTTP requests'),
  });
  assert.equal(roster.tools.find(tool => tool.id === 'claude').version, '2.1.0');
  assert.equal(roster.tools.find(tool => tool.id === 'claude').authentication, 'not-checked');
  assert.ok(roster.tools.every(tool => tool.connected === false));
  assert.equal(roster.noMachine.components[0].edition, 'Enterprise Desktop');
  assert.equal(roster.noMachine.serviceStatus, 'active');
  assert.equal(roster.noMachine.ownerReportedLicenseCount, 5);
  assert.equal(roster.noMachine.licenseVerification, 'not-performed');
  assert.equal(roster.localModels.status, 'not-requested');
  assert.equal(JSON.stringify(roster).includes('PRIVATE'), false);
  assert.deepEqual(calls.map(value => value[1]), [['--version'], ['--version'], ['is-active', 'nxserver.service']]);
});

test('explicit Ollama inventory permits loopback GET only and refuses remote or credential-bearing URLs', async () => {
  for (const url of ['https://example.com', 'http://127.0.0.1:11434/api/tags', 'http://user:password@localhost:11434', 'http://localhost:11434?token=x', 'file:///etc/passwd']) assert.throws(() => validateOllamaURL(url), /loopback/);
  const calls = [];
  const roster = await discover({ ollamaURL: 'http://127.0.0.1:11434' }, {
    findExecutable: async () => null, existingExecutable: async () => false,
    fetch: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ models: [{ name: 'deepseek-r1:8b' }, { name: 'deepseek-r1:8b' }, { name: 'bad\nname' }] }), { headers: { 'content-type': 'application/json' } }); },
  });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags'); assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(roster.localModels.models, ['deepseek-r1:8b']); assert.equal(roster.localModels.inferenceVerified, false);
});

test('dry run does not create a prefix; actual installation is private, disabled, independent of Git checkout', async t => {
  const setup = await fixture(t);
  const dry = await installNode({ ...setup.options, dryRun: true }, dependencies);
  assert.equal(dry.writesPerformed, false); assert.equal(dry.storageWarning, 'temporary-prefix-not-persistent');
  await assert.rejects(fs.access(setup.prefix), { code: 'ENOENT' });
  const installed = await installNode(setup.options, dependencies);
  assert.equal(installed.enabledByInstaller, 0); assert.equal(installed.stationConfigStatus, 'created-disabled');
  const config = await readJSON(installed.stationConfig);
  assert.deepEqual(config.participants, [{ id: 'codex-station', enabled: false }]);
  assert.equal((await fs.stat(setup.prefix)).mode & 0o077, 0);
  assert.equal((await fs.stat(installed.stationConfig)).mode & 0o077, 0);
  assert.equal((await controlNode('status', setup.prefix)).status, 'stopped');
  await assert.rejects(controlNode('start', setup.prefix), /All seats are disabled/);
  const wrapper = await execute('bash', [join(installed.runtimeRoot, 'node', 'nodectl.sh'), 'status', '--prefix', setup.prefix], { encoding: 'utf8', timeout: 10000 });
  assert.equal(JSON.parse(wrapper.stdout).status, 'stopped');
});

test('reinstall and version upgrade preserve config, queued work, old runtime, and roster history', async t => {
  const setup = await fixture(t);
  const first = await installNode(setup.options, dependencies);
  const config = await readJSON(first.stationConfig); config.participants[0].addresses = ['qa'];
  const exact = JSON.stringify(config) + '\n'; await fs.writeFile(first.stationConfig, exact, { mode: 0o600 });
  const queue = join(setup.prefix, 'state', 'waiting-message.json'); await fs.writeFile(queue, '{"id":"waiting"}', { mode: 0o600 });
  await fs.appendFile(join(setup.root, 'relay', 'station.mjs'), '\n// upgraded fixture\n');
  const second = await installNode(setup.options, dependencies);
  assert.notEqual(first.runtimeHash, second.runtimeHash); assert.equal(second.stationConfigStatus, 'preserved-existing');
  assert.equal(await fs.readFile(first.stationConfig, 'utf8'), exact); assert.equal(await fs.readFile(queue, 'utf8'), '{"id":"waiting"}');
  assert.equal((await fs.stat(first.runtimeRoot)).isDirectory(), true); assert.equal((await fs.readdir(join(setup.prefix, 'rosters'))).length, 2);
});

test('installer rejects unsafe storage, duplicate/reserved seats, old Node, and missing Git', async t => {
  const setup = await fixture(t);
  await assert.rejects(installNode({ ...setup.options, allowTemporaryPrefix: false }, dependencies), /persistent/);
  await assert.rejects(installNode({ ...setup.options, prefix: join(setup.root, 'inside') }, dependencies), /outside/);
  for (const agents of [['Muse', 'muse'], ['CON'], ['all'], ['bad/name']]) await assert.rejects(installNode({ ...setup.options, agents }, dependencies), /portable agent IDs/);
  await assert.rejects(installNode({ ...setup.options, nodeVersion: '18.0.0' }, dependencies), /Node 20/);
  await assert.rejects(installNode(setup.options, { ...dependencies, findExecutable: async () => null }), /Git is required/);
  await fs.mkdir(setup.prefix, { mode: 0o755 }); await fs.chmod(setup.prefix, 0o755);
  await assert.rejects(installNode(setup.options, dependencies), /owner-only/);
});

test('controller performs actual owned child lifecycle, rejects foreign PID, and refuses runtime tampering', async t => {
  const setup = await fixture(t); const installed = await installNode(setup.options, dependencies);
  const config = await readJSON(installed.stationConfig); config.participants[0].enabled = true; await fs.writeFile(installed.stationConfig, JSON.stringify(config), { mode: 0o600 });
  const started = await controlNode('start', setup.prefix);
  t.after(async () => { try { process.kill(started.pid, 'SIGTERM'); } catch {} });
  assert.equal(started.status, 'started'); assert.equal((await controlNode('status', setup.prefix)).status, 'running');
  assert.equal((await controlNode('start', setup.prefix)).status, 'already-running');
  await fs.appendFile(join(setup.root, 'relay', 'station.mjs'), '\n// cannot upgrade live\n');
  await assert.rejects(installNode(setup.options, dependencies), /Stop the existing station/);
  assert.equal((await controlNode('stop', setup.prefix)).status, 'stopped');
  assert.equal((await controlNode('status', setup.prefix)).status, 'stopped');
  const processPath = join(setup.prefix, 'station-process.json');
  await fs.writeFile(processPath, JSON.stringify({ pid: process.pid, expected: { node: process.execPath, script: process.argv[1], config: 'unrelated' } }), { mode: 0o600 });
  await assert.rejects(controlNode('stop', setup.prefix), /no signal was sent/);
  await fs.unlink(processPath);
  await fs.appendFile(join(installed.runtimeRoot, 'relay', 'station.mjs'), '// tamper');
  await assert.rejects(controlNode('start', setup.prefix), /integrity check failed/);
});

test('owned process argument comparison requires exact executable, script, and config', () => {
  const expected = { node: '/usr/bin/node', script: '/private/runtime/station.mjs', config: '/private/station.json' };
  assert.equal(matchesOwnedArguments(['/usr/bin/node', expected.script, '--config', expected.config], expected), true);
  for (const args of [['node', expected.script, '--config', expected.config], ['/usr/bin/node', '/other/station.mjs', '--config', expected.config], ['/usr/bin/node', expected.script, '--config', expected.config, '--extra']]) assert.equal(matchesOwnedArguments(args, expected), false);
});

test('diagnostics default is read-only, optional canary compares boots/home/state without deleting files', async t => {
  const setup = await fixture(t); await fs.mkdir(setup.prefix, { mode: 0o700 });
  const deps = { bootId: 'boot-one', serviceState: async () => 'active' };
  const before = await diagnose({ prefix: setup.prefix, home: setup.directory }, deps);
  assert.equal(before.persistence.writesPerformed, false); assert.deepEqual(await fs.readdir(setup.prefix), []);
  assert.equal(before.noMachine.licenseVerification, 'not-performed'); assert.equal(JSON.stringify(before).includes(setup.directory), false);
  const baseline = await diagnose({ prefix: setup.prefix, home: setup.directory, record: true }, deps);
  assert.equal(baseline.persistence.status, 'baseline-recorded');
  const again = await diagnose({ prefix: setup.prefix, home: setup.directory, record: true }, deps);
  assert.equal(again.persistence.canaryMatchesPrevious, true); assert.equal(again.persistence.sameBoot, true); assert.equal(again.persistence.sameHomeInode, true);
  const rebooted = await diagnose({ prefix: setup.prefix, home: setup.directory, record: true }, { ...deps, bootId: 'boot-two' });
  assert.equal(rebooted.persistence.sameBoot, false); assert.equal(rebooted.persistence.canaryMatchesPrevious, true);
  await fs.rename(join(setup.prefix, 'state', 'diagnostics', 'canary.json'), join(setup.prefix, 'state', 'diagnostics', 'saved-canary.json'));
  const replaced = await diagnose({ prefix: setup.prefix, home: setup.directory, record: true }, deps);
  assert.equal(replaced.persistence.canaryPresentBeforeRun, false); assert.equal(replaced.persistence.canaryMatchesPrevious, false);
  assert.equal((await fs.stat(join(setup.prefix, 'state', 'diagnostics', 'saved-canary.json'))).isFile(), true);
});
