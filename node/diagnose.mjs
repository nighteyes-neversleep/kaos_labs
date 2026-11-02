#!/usr/bin/env node
/** Metadata-only persistence diagnostics. No restarts, network requests, or journal dumps. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const types = new Map([[0x794c7630, 'overlay'], [0x01021994, 'tmpfs'], [0x858458f6, 'ramfs'], [0xef53, 'ext'], [0x9123683e, 'btrfs'], [0x58465342, 'xfs'], [0x2fc12fc1, 'zfs']]);
const privateStat = stat => stat.isDirectory() && !stat.isSymbolicLink() && (!process.getuid || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0));
async function readSmall(path) {
  try { const stat = await fs.stat(path); if (stat.size > 8192) return null; return (await fs.readFile(path, 'utf8')).slice(0, 8192).trim(); } catch { return null; }
}
async function volume(label, path) {
  try {
    const stat = await fs.stat(path, { bigint: true }); const disk = await fs.statfs(path, { bigint: true });
    const type = types.get(Number(disk.type) >>> 0) || 'other';
    return { label, present: true, device: String(stat.dev), inode: String(stat.ino), filesystem: type, filesystemType: Number(disk.type) >>> 0, availableBytes: String(disk.bavail * disk.bsize), freeInodes: String(disk.ffree), temporaryFilesystem: ['tmpfs', 'ramfs'].includes(type), overlayFilesystem: type === 'overlay' };
  } catch (error) { return { label, present: false, observation: error.code === 'ENOENT' ? 'not-found' : 'unavailable' }; }
}
async function serviceState() {
  if (process.platform !== 'linux') return 'not-checked';
  return new Promise(resolveResult => execFile('systemctl', ['is-active', 'nxserver.service'], { timeout: 2000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true }, (_error, stdout) => {
    const status = stdout?.trim(); resolveResult(['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(status) ? status : 'unknown');
  }));
}
async function privateJSON(path, optional = false) {
  let handle;
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) throw new Error('Diagnostic state must use owner-private regular files.');
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}
async function atomicWrite(path, data, exclusive = false) {
  if (!exclusive) await privateJSON(path, true);
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { if (exclusive) await fs.link(temporary, path); else await fs.rename(temporary, path); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function diagnose(options = {}, dependencies = {}) {
  if (options.prefix && !isAbsolute(options.prefix)) throw new Error('Use an absolute node prefix.');
  if (options.record && !options.prefix) throw new Error('--record requires an existing private --prefix.');
  const home = await fs.realpath(options.home || os.homedir()).catch(() => options.home || os.homedir());
  const prefix = options.prefix ? resolve(options.prefix) : null;
  const boot = dependencies.bootId !== undefined ? dependencies.bootId : process.platform === 'linux' ? await readSmall('/proc/sys/kernel/random/boot_id') : null;
  const volumes = await Promise.all([volume('root', '/'), volume('home', home), ...(prefix ? [volume('node-prefix', prefix)] : [])]);
  const identity = { uid: process.getuid ? process.getuid() : null, hostFingerprint: hash(os.hostname()), homeFingerprint: hash(home), bootFingerprint: boot ? hash(boot) : null };
  const observed = { schema: 'omi.node-diagnostic/1', observedAt: new Date().toISOString(), identity, uptimeSeconds: Math.floor(os.uptime()), volumes, noMachine: { serviceStatus: await (dependencies.serviceState || serviceState)(), licenseVerification: 'not-performed', connectionVerification: 'not-performed' }, persistence: { status: 'not-recorded', writesPerformed: false }, interpretation: 'Different session, user, mount, or boot can resemble lost files. Metadata alone does not prove deletion.' };
  if (!options.record) return observed;
  const prefixStat = await fs.lstat(prefix);
  if (!privateStat(prefixStat) || await fs.realpath(prefix) !== prefix) throw new Error('Recording requires an existing real owner-private node prefix.');
  const state = join(prefix, 'state');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  if (!privateStat(await fs.lstat(state))) throw new Error('Diagnostic state directory must be owner-private.');
  const directory = join(state, 'diagnostics');
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!privateStat(await fs.lstat(directory))) throw new Error('Diagnostic directory must be owner-private.');
  const canaryPath = join(directory, 'canary.json'); const previousPath = join(directory, 'last-observation.json');
  const previous = await privateJSON(previousPath, true);
  let canary = await privateJSON(canaryPath, true);
  const canaryPresentBeforeRun = canary !== undefined;
  if (!canary) { canary = { schema: 'omi.persistence-canary/1', id: randomUUID(), createdAt: observed.observedAt }; await atomicWrite(canaryPath, canary, true); }
  if (canary.schema !== 'omi.persistence-canary/1' || typeof canary.id !== 'string') throw new Error('Diagnostic canary format is invalid.');
  const current = { schema: 'omi.persistence-observation/1', observedAt: observed.observedAt, identity, home: volumes.find(value => value.label === 'home'), prefix: volumes.find(value => value.label === 'node-prefix'), canaryFingerprint: hash(canary.id) };
  const same = (field, key) => previous ? previous[field]?.[key] === current[field]?.[key] : null;
  observed.persistence = { status: previous ? 'compared-with-previous-run' : 'baseline-recorded', writesPerformed: true, canaryPresentBeforeRun, canaryMatchesPrevious: previous ? previous.canaryFingerprint === current.canaryFingerprint : null, sameBoot: same('identity', 'bootFingerprint'), sameUser: same('identity', 'uid'), sameHome: same('identity', 'homeFingerprint'), sameHomeInode: same('home', 'inode'), samePrefixDevice: same('prefix', 'device'), samePrefixInode: same('prefix', 'inode'), previousObservationAt: previous?.observedAt ?? null };
  await atomicWrite(previousPath, current);
  return observed;
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === '--record') options.record = true;
      else if (argv[index] === '--prefix' && argv[index + 1]) options.prefix = argv[++index];
      else if (argv[index] === '--help') { console.log('Read-only: bash node/diagnose.sh [--prefix /private/omi-node]\nOptional persistence baseline/comparison: add --record. No network, restart, deletion, environment, journal, or license reads.'); return 0; }
      else throw new Error('Supported diagnostic arguments: --prefix /absolute/path, --record, --help.');
    }
    console.log(JSON.stringify(await diagnose(options), null, 2)); return 0;
  } catch (error) { console.error(JSON.stringify({ event: 'node-diagnostic-failed', message: error.message })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
