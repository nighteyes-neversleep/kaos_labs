#!/usr/bin/env node
/** Read-only local inventory and private per-user node installation. No model is started by discovery. */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_NAMES = ['claude', 'codex', 'gemini', 'deepseek', 'ollama', 'lms', 'aider', 'opencode'];
const PROVIDERS = new Set(['ollama', 'lms']);
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const RESERVED = /^(?:all|broadcast|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const HASH = /^[a-f0-9]{64}$/;
const inside = (path, root) => { const suffix = relative(root, path); return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const fail = message => { throw new Error(message); };

async function runFile(file, args, timeoutMs = 2000) {
  return new Promise(resolveResult => execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024, windowsHide: true }, (error, stdout) => {
    resolveResult({ ok: !error, timedOut: !!error?.killed, stdout: typeof stdout === 'string' ? stdout : '' });
  }));
}
export async function findExecutable(name, { env = process.env, platform = process.platform } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  const separator = platform === 'win32' ? ';' : delimiter;
  const extensions = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const folder of (env.PATH || '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = platform === 'win32' ? win32.join(folder, name + extension.toLowerCase()) : join(folder, name);
      try { const stat = await fs.stat(candidate); await fs.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK); if (stat.isFile()) return candidate; } catch {}
    }
  }
  return null;
}
function observedVersion(output) {
  const match = output.match(/\b(?:v)?(\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?:[-+][A-Za-z0-9.-]{1,40})?)\b/);
  return match?.[1] ?? null;
}
function observedEdition(output) {
  const editions = ['Enterprise Desktop', 'Enterprise Terminal Server', 'Enterprise Cloud Server', 'Enterprise Workstation', 'Small Business Server', 'Terminal Server', 'Workstation'];
  return editions.find(edition => output.toLowerCase().includes(edition.toLowerCase())) ?? 'unknown';
}
function noMachinePaths(platform, env) {
  if (platform === 'win32') return [win32.join(env.ProgramFiles || 'C:\\Program Files', 'NoMachine', 'bin', 'nxserver.exe'), win32.join(env.ProgramFiles || 'C:\\Program Files', 'NoMachine', 'bin', 'nxplayer.exe')];
  if (platform === 'darwin') return ['/Applications/NoMachine.app/Contents/Frameworks/bin/nxserver', '/Applications/NoMachine.app/Contents/MacOS/nxplayer'];
  return ['/usr/NX/bin/nxserver', '/usr/NX/bin/nxplayer'];
}
async function existingExecutable(path) { try { const stat = await fs.stat(path); await fs.access(path, constants.X_OK); return stat.isFile(); } catch { return false; } }

export function validateOllamaURL(value) {
  let url; try { url = new URL(value); } catch { fail('Ollama discovery requires an explicit loopback HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    fail('Ollama discovery only accepts a loopback origin, without credentials, query, or path.');
  }
  return new URL('/api/tags', url).href;
}
async function ollamaModels(value, fetcher) {
  const url = validateOllamaURL(value);
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(2000) });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return { status: 'unavailable', models: [] };
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.byteLength; if (size > 256 * 1024) fail('Model inventory response too large.'); chunks.push(Buffer.from(chunk)); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.models) || data.models.length > 256) return { status: 'invalid-response', models: [] };
    const names = data.models.map(model => model?.name).filter(name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name));
    return { status: 'inventory-read', models: [...new Set(names)].sort(), inferenceVerified: false };
  } catch { return { status: 'unavailable', models: [], inferenceVerified: false }; }
}

/** Only fixed --version and local service-status commands; raw command output is never returned. */
export async function discover(options = {}, dependencies = {}) {
  const locate = dependencies.findExecutable || (name => findExecutable(name));
  const runner = dependencies.runFile || runFile;
  const isExecutable = dependencies.existingExecutable || existingExecutable;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const extra = options.extraCommands || [];
  if (!Array.isArray(extra) || extra.length > 8 || extra.some(name => !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(name))) fail('Additional commands must be a bounded list of simple executable names.');
  if (options.reportedNoMachineLicenses !== undefined && (!Number.isSafeInteger(options.reportedNoMachineLicenses) || options.reportedNoMachineLicenses < 0 || options.reportedNoMachineLicenses > 1000)) fail('Reported license count is invalid.');
  const tools = [];
  for (const name of [...new Set([...TOOL_NAMES, ...extra])]) {
    const executable = await locate(name);
    if (!executable) { tools.push({ id: name, installed: false, version: null, observation: 'not-found-on-path', authentication: 'not-checked', connected: false }); continue; }
    const result = await runner(executable, ['--version']);
    tools.push({ id: name, installed: true, executable, version: observedVersion(result.stdout), observation: result.ok ? 'version-command-completed' : result.timedOut ? 'version-check-timeout' : 'version-unavailable', authentication: 'not-checked', connected: false });
  }
  const components = [];
  const seen = new Set();
  for (const path of [await locate('nxserver'), await locate('nxplayer'), ...noMachinePaths(platform, env)].filter(Boolean)) {
    if (seen.has(path) || !await isExecutable(path)) continue;
    seen.add(path);
    const result = await runner(path, ['--version']);
    components.push({ executable: path, component: /nxplayer/i.test(path) ? 'player' : 'server', version: observedVersion(result.stdout), edition: observedEdition(result.stdout), observation: result.ok ? 'version-command-completed' : 'version-unavailable' });
  }
  let serviceStatus = 'unknown';
  if (platform === 'linux' && components.some(component => component.component === 'server')) {
    const systemctl = await locate('systemctl');
    if (systemctl) { const status = await runner(systemctl, ['is-active', 'nxserver.service']); const value = status.stdout.trim(); if (['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(value)) serviceStatus = value; }
  }
  return {
    schema: 'omi.node-roster/1', observedAt: new Date().toISOString(), host: { name: options.hostname || os.hostname(), platform, nodeVersion: process.versions.node },
    tools,
    localModels: options.ollamaURL ? await ollamaModels(options.ollamaURL, dependencies.fetch || fetch) : { status: 'not-requested', models: [], inferenceVerified: false },
    noMachine: { installed: components.length > 0, components, serviceStatus, role: 'operator-access', licenseVerification: 'not-performed', ...(options.reportedNoMachineLicenses !== undefined ? { ownerReportedLicenseCount: options.reportedNoMachineLicenses } : {}), ...(options.reportedNoMachineEdition ? { ownerReportedEdition: String(options.reportedNoMachineEdition).slice(0, 100) } : {}), ...(options.reportedNoMachineValidThrough ? { ownerReportedValidThrough: String(options.reportedNoMachineValidThrough).slice(0, 40) } : {}) },
    resourceSharing: 'off', connectionVerification: 'not-performed',
  };
}

async function privateDirectory(path) {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) fail('Use an owner-only real directory for the node prefix and state.');
  return fs.realpath(path);
}
async function regularJSON(path, optional = false) {
  let stat; try { stat = await fs.lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) fail('Node metadata must use bounded owner-private regular files.');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}
async function syncDirectory(path) { const handle = await fs.open(path, 'r').catch(error => { if (process.platform === 'win32') return null; throw error; }); if (handle) { try { await handle.sync().catch(error => { if (process.platform !== 'win32') throw error; }); } finally { await handle.close(); } } }
async function writeJSON(path, value, exclusive = false) {
  if (!exclusive) await regularJSON(path, true);
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
  try { if (exclusive) { await fs.link(temporary, path); await fs.unlink(temporary); } else await fs.rename(temporary, path); await syncDirectory(dirname(path)); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function prefixPath(value, root) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('Supply --prefix with an absolute private path.');
  const path = resolve(value);
  if (inside(path, root) || inside(root, path)) fail('The node prefix must be outside the source checkout, not its ancestor.');
  return path;
}
function seatIds(roster, explicit) {
  const nodeName = roster.host.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 45) || 'node';
  const ids = explicit ?? roster.tools.filter(tool => tool.installed && !PROVIDERS.has(tool.id)).map(tool => `${tool.id}-${nodeName}`.slice(0, 100));
  if (!Array.isArray(ids) || ids.length > 32 || ids.some(id => !SLUG.test(id) || RESERVED.test(id)) || new Set(ids.map(id => id.toLowerCase())).size !== ids.length) fail('Supply at most 32 unique portable agent IDs.');
  return ids.length ? ids : [`unconfigured-${nodeName}`];
}
async function runtimeFiles(root) {
  const files = ['node/install.sh', 'node/nodectl.sh', 'node/discover.mjs', 'node/diagnose.sh', 'node/diagnose.mjs', 'node/README.md'];
  const names = await fs.readdir(join(root, 'relay'));
  for (const name of names.sort()) if ((name.endsWith('.mjs') && !name.endsWith('.test.mjs')) || name.endsWith('.md')) files.push('relay/' + name);
  const result = [];
  for (const name of files.sort()) {
    const path = join(root, name); const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('Runtime source must contain bounded regular files.');
    const bytes = await fs.readFile(path); result.push({ path: name, bytes, sha256: digest(bytes) });
  }
  for (const required of ['relay/station.mjs', 'relay/git-worker.mjs', 'relay/advisory.mjs', 'relay/mailroom.mjs']) if (!result.some(file => file.path === required)) fail('The bundle lacks a required relay module.');
  return result;
}

/** Installs code into immutable version directories; existing station config and queues are preserved. */
export async function installNode(options, dependencies = {}) {
  const root = await fs.realpath(options.sourceRoot || SOURCE_ROOT);
  const prefix = prefixPath(options.prefix, root);
  const temporaryPrefix = inside(prefix, '/tmp') || inside(prefix, '/var/tmp') || inside(prefix, '/run') || inside(prefix, '/dev/shm');
  if (temporaryPrefix && !options.allowTemporaryPrefix && !options.check && !options.dryRun) fail('Use a persistent home or data directory, not temporary storage. Simulations may explicitly pass --allow-temporary-prefix.');
  const nodeMajor = Number((options.nodeVersion || process.versions.node).split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) fail('Node 20 or newer is required for the agent kit; Node 24 is recommended and required for the SQLite forum.');
  const git = await (dependencies.findExecutable || findExecutable)('git');
  if (!git) fail('Git is required. On Ubuntu, install Git using the operating system package manager, then rerun.');
  const roster = await (dependencies.discover || discover)(options);
  const ids = seatIds(roster, options.agents);
  const source = await runtimeFiles(root);
  const runtimeHash = digest(JSON.stringify(source.map(file => [file.path, file.sha256])));
  if (options.check || options.dryRun) return { status: options.check ? 'check-complete' : 'dry-run', prefix, requiredNode: '20+', recommendedNode: '24+', gitAvailable: true, runtimeHash, candidateSeats: ids, storageWarning: temporaryPrefix ? 'temporary-prefix-not-persistent' : null, writesPerformed: false, roster };
  const canonical = await privateDirectory(prefix);
  if (inside(canonical, root) || inside(root, canonical)) fail('The resolved prefix overlaps the source checkout.');
  for (const name of ['runtime', 'state', 'rosters', 'logs']) await privateDirectory(join(canonical, name));
  const oldInstallation = await regularJSON(join(canonical, 'installation.json'), true);
  const oldProcess = await regularJSON(join(canonical, 'station-process.json'), true);
  if (oldInstallation && oldInstallation.runtimeHash !== runtimeHash && Number.isSafeInteger(oldProcess?.pid) && oldProcess.pid > 1 && processExists(oldProcess.pid)) fail('Stop the existing station with its current controller before installing a newer runtime. Existing state was preserved.');
  const versionDir = join(canonical, 'runtime', runtimeHash);
  let present = false;
  try { const stat = await fs.lstat(versionDir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Installed runtime path is unsafe.'); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = { schema: 'omi.node-runtime/1', runtimeHash, files: source.map(({ path, sha256 }) => ({ path, sha256 })) };
  if (present) {
    for (const file of source) { const target = join(versionDir, file.path); const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(target)) !== file.sha256) fail('Existing runtime integrity check failed.'); }
  } else {
    const staging = join(canonical, 'runtime', '.staging-' + randomUUID()); await privateDirectory(staging);
    try {
      for (const file of source) { await fs.mkdir(dirname(join(staging, file.path)), { recursive: true, mode: 0o700 }); await fs.writeFile(join(staging, file.path), file.bytes, { mode: file.path.endsWith('.sh') ? 0o700 : 0o600, flag: 'wx' }); }
      await writeJSON(join(staging, 'manifest.json'), manifest, true); await fs.rename(staging, versionDir); await syncDirectory(dirname(versionDir));
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  const stationPath = join(canonical, 'station.json');
  const existing = await regularJSON(stationPath, true);
  if (existing === undefined) {
    await writeJSON(stationPath, { remote: 'https://github.com/nighteyes-neversleep/kaos_labs.git', branch: 'omi-relay', directory: join(canonical, 'state', 'station'), participants: ids.map(id => ({ id, enabled: false })), intervalMs: 15000, concurrency: 2, timeoutMs: 30000 }, true);
  }
  const rosterPath = join(canonical, 'rosters', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID() + '.json');
  await writeJSON(rosterPath, roster, true);
  const installation = { schema: 'omi.node-installation/1', runtimeHash, runtimeRoot: versionDir, stationConfig: stationPath, rosterPath, installedAt: new Date().toISOString(), candidateSeats: ids, stationConfigStatus: existing === undefined ? 'created-disabled' : 'preserved-existing' };
  await writeJSON(join(canonical, 'installation.json'), installation);
  return { status: 'installed', prefix: canonical, runtimeHash, runtimeRoot: versionDir, stationConfig: stationPath, rosterPath, stationConfigStatus: installation.stationConfigStatus, enabledByInstaller: 0, resourceSharing: 'off' };
}

function processExists(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
export function parseProcessCommand(command) {
  // Parses the quoting used by Node's own spawn on POSIX/Windows ps output.
  const args = []; let current = ''; let quote = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote) { if (char === quote) quote = null; else current += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (current) { args.push(current); current = ''; } }
    else current += char;
  }
  if (current) args.push(current);
  return args;
}
async function processArguments(pid) {
  if (process.platform === 'linux') {
    try { return (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean); } catch { return null; }
  }
  const result = process.platform === 'win32'
    ? await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`])
    : await runFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  return result.ok ? parseProcessCommand(result.stdout.trim()) : null;
}
export function matchesOwnedArguments(args, expected) {
  if (!Array.isArray(args) || args.length !== 4 || args[2] !== '--config') return false;
  const norm = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return norm(args[0]) === norm(expected.node) && norm(args[1]) === norm(expected.script) && norm(args[3]) === norm(expected.config);
}
async function installed(prefix) {
  if (typeof prefix !== 'string' || !isAbsolute(prefix)) fail('Supply an absolute installed node prefix.');
  const path = resolve(prefix);
  const prefixStat = await fs.lstat(path);
  if (!prefixStat.isDirectory() || prefixStat.isSymbolicLink() || (process.getuid && (prefixStat.uid !== process.getuid() || (prefixStat.mode & 0o077) !== 0))) fail('The installed prefix must be an existing owner-private directory.');
  if (await fs.realpath(path) !== path) fail('Installed prefix parent links are not supported.');
  const data = await regularJSON(join(path, 'installation.json'));
  if (data?.schema !== 'omi.node-installation/1' || !HASH.test(data.runtimeHash || '') || data.runtimeRoot !== join(path, 'runtime', data.runtimeHash) || data.stationConfig !== join(path, 'station.json')) fail('Installed node metadata is invalid.');
  for (const directory of [join(path, 'runtime'), data.runtimeRoot, join(data.runtimeRoot, 'node'), join(data.runtimeRoot, 'relay')]) { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) fail('Runtime directories must be real and owner-private.'); }
  const manifest = await regularJSON(join(data.runtimeRoot, 'manifest.json'));
  if (manifest?.schema !== 'omi.node-runtime/1' || manifest.runtimeHash !== data.runtimeHash || !Array.isArray(manifest.files) || manifest.files.length > 256 || digest(JSON.stringify(manifest.files.map(file => [file.path, file.sha256]))) !== data.runtimeHash) fail('Runtime manifest is invalid.');
  if (!manifest.files.some(file => file.path === 'relay/station.mjs')) fail('The station runtime is missing.');
  for (const file of manifest.files) {
    if (!/^((?:relay|node)\/[A-Za-z0-9_.-]+)$/.test(file.path) || !HASH.test(file.sha256 || '')) fail('Runtime manifest path is invalid.');
    const target = join(data.runtimeRoot, file.path); const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(target)) !== file.sha256) fail('Installed runtime integrity check failed.');
  }
  return { prefix: path, data, expected: { node: process.execPath, script: join(data.runtimeRoot, 'relay', 'station.mjs'), config: data.stationConfig } };
}

function sameExpected(recorded, expected) { return recorded && recorded.node === expected.node && recorded.script === expected.script && recorded.config === expected.config; }

export async function controlNode(action, prefix) {
  if (!['status', 'start', 'stop'].includes(action)) fail('Choose status, start, or stop.');
  const setup = await installed(prefix);
  const pidPath = join(setup.prefix, 'station-process.json');
  let record = await regularJSON(pidPath, true);
  const existing = record && Number.isSafeInteger(record.pid) && record.pid > 1 && processExists(record.pid);
  if (existing && (!sameExpected(record.expected, setup.expected) || !matchesOwnedArguments(await processArguments(record.pid), setup.expected))) fail('The recorded PID is not this installed station; no signal was sent.');
  if (action === 'status') return { status: existing ? 'running' : 'stopped', pid: existing ? record.pid : null, connectionVerification: 'not-performed', stationConfig: setup.data.stationConfig };
  const lockPath = join(setup.prefix, 'node-control.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); await lock.writeFile(json({ pid: process.pid })); await lock.sync(); }
  catch { fail('Another node controller may be active. Inspect the private lock before retrying.'); }
  try {
    // Recheck within the mutation lock to avoid duplicate starts.
    record = await regularJSON(pidPath, true);
    const running = record && Number.isSafeInteger(record.pid) && record.pid > 1 && processExists(record.pid);
    if (running && (!sameExpected(record.expected, setup.expected) || !matchesOwnedArguments(await processArguments(record.pid), setup.expected))) fail('The recorded PID is not this installed station; no signal was sent.');
    if (action === 'stop') {
      if (!running) return { status: 'already-stopped', pid: null };
      process.kill(record.pid, 'SIGTERM');
      for (let i = 0; i < 40 && processExists(record.pid); i++) await delay(100);
      if (processExists(record.pid)) return { status: 'stop-requested', pid: record.pid, detail: 'Waiting for a bounded active Git operation; no forced kill was sent.' };
      await fs.unlink(pidPath); return { status: 'stopped', pid: record.pid };
    }
    if (running) return { status: 'already-running', pid: record.pid };
    const stationModule = await import(pathToFileURL(setup.expected.script).href);
    const config = await stationModule.loadStationConfig(setup.data.stationConfig);
    if (!config.participants.some(seat => seat.enabled)) fail('All seats are disabled. Configure actual adapters/identities and enable the chosen seats before starting.');
    const logPath = join(setup.prefix, 'logs', 'station.log');
    try { const logStat = await fs.lstat(logPath); if (!logStat.isFile() || logStat.isSymbolicLink() || (process.getuid && (logStat.uid !== process.getuid() || (logStat.mode & 0o077) !== 0))) fail('The station log must be owner-private.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const log = await fs.open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const child = spawn(process.execPath, [setup.expected.script, '--config', setup.expected.config], { detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true });
    await log.close();
    const earlyError = new Promise(resolveResult => { child.once('error', () => resolveResult(true)); child.once('exit', () => resolveResult(true)); });
    const died = await Promise.race([earlyError, delay(400).then(() => false)]);
    try {
      if (died || !child.pid || !matchesOwnedArguments(await processArguments(child.pid), setup.expected)) fail('The station did not start successfully; inspect its private log.');
      await writeJSON(pidPath, { schema: 'omi.node-process/1', pid: child.pid, expected: setup.expected, startedAt: new Date().toISOString() });
    } catch (error) {
      if (child.pid && matchesOwnedArguments(await processArguments(child.pid), setup.expected)) child.kill('SIGTERM');
      child.unref(); throw error;
    }
    child.unref();
    return { status: 'started', pid: child.pid, logPath, connectionVerification: 'not-performed' };
  } finally { await lock?.close(); await fs.unlink(lockPath).catch(() => {}); }
}

function options(argv) {
  const result = { extraCommands: [] };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--allow-temporary-prefix') result.allowTemporaryPrefix = true;
    else if (['--check', '--dry-run'].includes(name)) result[name === '--check' ? 'check' : 'dryRun'] = true;
    else if (['--prefix', '--agents', '--ollama-url', '--output', '--extra-command', '--reported-nomachine-licenses', '--reported-nomachine-edition', '--reported-nomachine-valid-through'].includes(name)) {
      const value = argv[++index]; if (!value || value.startsWith('--')) fail(`Missing value for ${name}.`);
      if (name === '--prefix') result.prefix = value;
      if (name === '--agents') result.agents = value.split(',').filter(Boolean);
      if (name === '--ollama-url') result.ollamaURL = value;
      if (name === '--output') result.output = value;
      if (name === '--extra-command') result.extraCommands.push(value);
      if (name === '--reported-nomachine-licenses') result.reportedNoMachineLicenses = Number(value);
      if (name === '--reported-nomachine-edition') result.reportedNoMachineEdition = value;
      if (name === '--reported-nomachine-valid-through') result.reportedNoMachineValidThrough = value;
    } else fail('Unsupported argument. Use --help for the supported node commands.');
  }
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.includes('--help')) {
      console.log('Inventory: node node/discover.mjs [--output /private/roster.json] [--ollama-url http://127.0.0.1:11434]\nInstall: bash node/install.sh --prefix /private/omi-node [--check|--dry-run] [--agents id,...]\nControl: bash node/nodectl.sh status|start|stop --prefix /private/omi-node\nDiscovery never logs in, starts models, reads licenses, or verifies remote seat connectivity.'); return 0;
    }
    if (argv[0] === '--control') { const action = argv[1]; const parsed = options(argv.slice(2)); console.log(json(await controlNode(action, parsed.prefix))); return 0; }
    const installing = argv[0] === '--install'; const parsed = options(installing ? argv.slice(1) : argv);
    const result = installing ? await installNode(parsed) : await discover(parsed);
    if (parsed.output) {
      if (!isAbsolute(parsed.output)) fail('Use an absolute private roster output path.');
      await privateDirectory(dirname(parsed.output)); await writeJSON(parsed.output, result, true);
      console.log(json({ status: 'inventory-written', path: parsed.output }));
    } else console.log(json(result));
    return 0;
  } catch (error) { console.error(JSON.stringify({ event: 'node-operation-failed', message: error instanceof Error ? error.message : 'Node operation failed.' })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
