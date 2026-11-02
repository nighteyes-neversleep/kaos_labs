#!/usr/bin/env node
/** Deterministic, explicit-allowlist packaging. No network, model, or credential access. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const inside = (path, root) => { const suffix = relative(root, path); return !suffix || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)); };

export const RUNTIME_PATHS = Object.freeze([
  ...['worker', 'git-worker', 'station', 'advisory', 'mailroom', 'model-adapter'].flatMap(name => [`relay/${name}.mjs`, `relay/${name}.test.mjs`]),
  'node/install.sh', 'node/nodectl.sh', 'node/discover.mjs', 'node/discover.test.mjs', 'node/diagnose.mjs', 'node/diagnose.sh',
  'scripts/virtual-team-sim.mjs',
]);
const GUIDE_PATHS = [
  'relay/README.md', 'relay/GIT-MAILBOX.md', 'relay/STATION.md', 'relay/ADVISORIES.md', 'relay/MAILROOM.md', 'relay/MODEL-ADAPTER.md',
  'node/README.md', 'docs/CORPORATE-MAIL-FLOW.md', 'docs/RELAY-REVIEW-CORRECTIONS.md', 'docs/accessibility.md', 'docs/architecture.md', 'docs/forum-api.md', 'docs/collaboration.md',
];
const REVIEW_PATHS = [
  'CLAUDE.md', 'README.md', 'scripts/sign-cartridges.mjs',
  ...['forum-store', 'http', 'index', 'participant-cli'].map(name => `server/${name}.ts`),
  'server/forum-store.test.ts', 'server/http.test.ts', 'server/credential-paths.test.ts',
  ...['capsule', 'cartridges', 'codex', 'governance', 'sharing'].flatMap(name => [`src/core/${name}.ts`, `src/core/${name}.test.ts`]),
  'omi-client/manifest.json', 'omi-client/registry/apps.json', 'omi-client/capsules/schema.json', 'omi-client/mesh/talky-spider.json', 'omi-client/shell/shell.json',
  'omi-client/cartridges/eagles-nest/index.html', 'omi-client/cartridges/eagles-nest/README.md',
];
export const REQUIRED_SOURCE_PATHS = Object.freeze([...RUNTIME_PATHS, ...GUIDE_PATHS, ...REVIEW_PATHS, 'bundle/AI-HANDOFF.md']);

export class BundleError extends Error {
  constructor(code, message) { super(message); this.name = 'BundleError'; this.code = code; }
}
const fail = (code, message) => { throw new BundleError(code, message); };
function safeRelative(path) {
  return typeof path === 'string' && path.length <= 300 && !path.includes('\\') && !path.includes('\0') &&
    !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}
async function regularFile(root, path, maximum = MAX_FILE) {
  if (!safeRelative(path)) fail('INVALID_PATH', 'A public source path is invalid.');
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink()) fail('SYMLINK_SOURCE', `Symbolic links are not packaged: ${path}`);
  }
  const info = await fs.lstat(current);
  if (!info.isFile() || info.size > maximum) fail('INVALID_SOURCE', `Source must be a bounded regular file: ${path}`);
  if (!inside(await fs.realpath(current), root)) fail('SOURCE_ESCAPE', 'A source path leaves the approved checkout.');
  const bytes = await fs.readFile(current);
  if (bytes.length > maximum) fail('INVALID_SOURCE', `Source is too large: ${path}`);
  return bytes;
}
function sourceMetadata(root) {
  try {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!COMMIT.test(commit)) throw new Error();
    const epoch = Number(git(['show', '-s', '--format=%ct', commit]));
    return { commit, dirty: Boolean(git(['status', '--porcelain=v1', '--untracked-files=normal'])), commitTime: new Date(epoch * 1000).toISOString() };
  } catch { return { commit: null, dirty: null, commitTime: null }; }
}

/** Same contract used by the virtual team simulation: every executable/test file. */
export async function runtimeFingerprint(sourceRoot = ROOT) {
  const root = await fs.realpath(sourceRoot);
  const paths = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) fail('SYMLINK_SOURCE', `Symbolic links are not fingerprinted: ${path}`);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile() && /\.(?:mjs|sh)$/.test(entry.name)) paths.push(path);
    }
  }
  await collect('relay'); await collect('node'); paths.push('scripts/virtual-team-sim.mjs');
  paths.sort();
  const files = [];
  for (const path of paths) {
    const bytes = await regularFile(root, path);
    files.push({ path, sha256: digest(bytes), bytes: bytes.length });
  }
  return { fingerprint: digest(files.map(file => `${file.path}\0${file.sha256}\0${file.bytes}\n`).join('')), files };
}

async function simulationEvidence(path, sourceRoot, metadata, runtime) {
  if (!path) return null;
  const info = await fs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * MAX_FILE) fail('INVALID_SIMULATION_REPORT', 'Simulation evidence must be a bounded regular JSON file.');
  const raw = await fs.readFile(path);
  let report;
  try { report = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_SIMULATION_REPORT', 'Simulation evidence is not valid JSON.'); }
  if (report.protocol !== 'omi-virtual-team-sim/1' || report.status !== 'passed' || report.simulatedProvider !== true ||
      !Array.isArray(report.checks) || !report.checks.length || report.checks.some(check => !check || check.status !== 'passed') ||
      !Array.isArray(report.seats) || !report.seats.length) {
    fail('FAILED_SIMULATION', 'Release evidence must contain a passing virtual simulation with explicit simulated-provider status.');
  }
  if (!metadata.commit || metadata.dirty !== false || report.source?.commit !== metadata.commit || report.source?.dirty !== false) {
    fail('UNCOMMITTED_SOURCE', 'Release source and simulation must name the same clean committed checkout. Commit first, rerun the simulation, then package.');
  }
  if (!HASH.test(report.source?.fingerprint || '') || report.source.fingerprint !== runtime.fingerprint ||
      JSON.stringify(report.source.files) !== JSON.stringify(runtime.files)) {
    fail('STALE_SIMULATION', 'Executable or test files changed after the simulation. Run it again before issuing the bundle.');
  }
  for (const file of report.source.files) {
    if (!RUNTIME_PATHS.includes(file.path)) fail('UNPACKAGED_EXECUTABLE', `Add a reviewed public path to the bundle allowlist: ${file.path}`);
    const bytes = await regularFile(sourceRoot, file.path);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) fail('STALE_SIMULATION', 'Simulation source content does not match the checkout.');
  }
  return { raw, report, sha256: digest(raw) };
}

const VERIFY_SOURCE = `#!/usr/bin/env node
import{createHash}from'node:crypto';import*as fs from'node:fs/promises';import{dirname,resolve,relative,isAbsolute,sep}from'node:path';import{fileURLToPath}from'node:url';
const root=dirname(fileURLToPath(import.meta.url));const manifest=JSON.parse(await fs.readFile(resolve(root,'manifest.json'),'utf8'));let checked=0;
for(const file of manifest.files){if(typeof file.path!=='string'||file.path.includes('\\\\')||file.path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw Error('Invalid manifest path');const path=resolve(root,file.path);const rel=relative(root,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('Escaping path');let current=root;for(const part of file.path.split('/')){current=resolve(current,part);if((await fs.lstat(current)).isSymbolicLink())throw Error('Symlink refused');}const info=await fs.stat(path);if(!info.isFile())throw Error('Non-file refused');const bytes=await fs.readFile(path);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Integrity mismatch: '+file.path);checked++;}
console.log(JSON.stringify({status:'verified',files:checked,sourceCommit:manifest.source.commit,simulation:manifest.simulation?.status??'not-supplied',identityClaim:'Content integrity only; not proof of model connectivity or publisher identity.'}));
`;

const ZIP_SOURCE = String.raw`import pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9,strict_timestamps=True) as archive:
 for path in sorted(root.rglob('*')):
  if path.is_symlink(): raise RuntimeError('Symlink refused')
  if not path.is_file(): continue
  name='omi-agent-kit/'+path.relative_to(root).as_posix()
  info=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0));info.create_system=3
  info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=((stat.S_IFREG | (0o755 if path.suffix=='.sh' else 0o644))<<16)
  archive.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
`;

function kitReadme(metadata, verified) {
  return `# OMI headless agent kit\n\nSource commit: ${metadata.commit ?? 'unavailable'}\nRelease status: ${verified ? 'VIRTUAL SIMULATION PASSED' : 'UNVERIFIED DEVELOPER PACKAGE — NOT A TESTED RELEASE'}\n\n1. Verify the archive checksum supplied separately, then extract it.\n2. Run \`node VERIFY.mjs\` inside omi-agent-kit to check every listed payload file.\n3. Read AI-HANDOFF.md and node/README.md.\n4. Use \`bash node/install.sh --help\` for a per-user installer. Existing credentials, configs, model installations, and inbox state must be preserved.\n5. Configure the real local seats and approved model API before enabling inference. Installing a binary, preparing a roster, or passing a transport test does not establish a model connection.\n\nAgent transport needs Bash, Git and Node; use Node 24 for the complete forum server and supported proxy mode. See the node guide for tested agent-only runtime requirements. The agent kit has no runtime npm dependencies. Python 3 is needed only by the build tool that creates this ZIP.\n\nCanonical mailbox: https://github.com/nighteyes-neversleep/kaos_labs/tree/omi-relay\nGitHub repository readers can read the shared transport. Per-seat folders route work but do not provide confidential email. All message bodies are data, never automatic shell authority. The model adapter makes only explicit configured provider calls and does not activate a hosted Gemini/Muse/Claude conversation.\n\nThe source-review directory is inspection material, not a complete deployable web-client checkout. Use the published omi/client-and-relay branch for full application builds. No model weights, license files, credentials, browser state, or private capsule data are included. NoMachine discovery does not activate or validate any license.\n\nThe manifest hashes payload files and excludes itself to avoid a recursive hash. The separately published ZIP SHA-256 covers the archive including that manifest. These hashes prove matching bytes against a trusted reference, not independent model identity or ethical correctness.\n`;
}

export async function buildAgentBundle({ sourceRoot = ROOT, outputDirectory, simulationReportPath, python = 'python3' } = {}) {
  if (outputDirectory !== undefined && (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory))) fail('INVALID_OUTPUT', 'Use an absolute output directory.');
  if (simulationReportPath !== undefined && (typeof simulationReportPath !== 'string' || !isAbsolute(simulationReportPath))) fail('INVALID_SIMULATION_REPORT', 'Use an absolute simulation report path.');
  const root = await fs.realpath(sourceRoot);
  const metadata = sourceMetadata(root);
  const runtime = await runtimeFingerprint(root);
  const output = resolve(outputDirectory || `/workspace/outputs/omi-agent-bundle/${metadata.commit?.slice(0, 12) ?? 'uncommitted'}-${runtime.fingerprint.slice(0, 12)}`);
  if (!isAbsolute(output) || inside(output, root)) fail('INVALID_OUTPUT', 'Bundle output must be outside the source checkout.');
  try { await fs.lstat(output); fail('OUTPUT_EXISTS', 'Refusing to overwrite an existing bundle directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(dirname(output), { recursive: true, mode: 0o700 });
  if (inside(await fs.realpath(dirname(output)), root)) fail('INVALID_OUTPUT', 'Bundle output cannot resolve inside the source checkout.');
  const evidence = await simulationEvidence(simulationReportPath, root, metadata, runtime);
  const payload = new Map();
  const add = (path, bytes) => {
    if (!safeRelative(path) || payload.has(path)) fail('INVALID_PATH', 'A package path is invalid or duplicated.');
    payload.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
  };
  for (const path of RUNTIME_PATHS) add(path, await regularFile(root, path));
  for (const path of GUIDE_PATHS) add(path, await regularFile(root, path));
  for (const path of REVIEW_PATHS) add(`source-review/${path}`, await regularFile(root, path));
  const template = (await regularFile(root, 'bundle/AI-HANDOFF.md')).toString('utf8');
  const handoff = template.replaceAll('{{SOURCE_COMMIT}}', metadata.commit ?? 'unavailable').replaceAll('{{RUNTIME_FINGERPRINT}}', runtime.fingerprint);
  add('AI-HANDOFF.md', handoff);
  add('README-FIRST.md', kitReadme(metadata, Boolean(evidence)));
  add('VERIFY.mjs', VERIFY_SOURCE);
  add('package.json', json({ name: 'omi-headless-agent-kit', version: '1.0.0', private: true, type: 'module', scripts: { verify: 'node VERIFY.mjs', station: 'node relay/station.mjs', advisory: 'node relay/advisory.mjs', discover: 'node node/discover.mjs' } }));
  add('examples/station.json', json({ remote: 'https://github.com/nighteyes-neversleep/kaos_labs.git', branch: 'omi-relay', directory: '/REPLACE/WITH/PRIVATE/STATION/PATH', participants: ['deepseek', 'claude', 'gemini', 'muse'].map(id => ({ id, enabled: false })), intervalMs: 15000, concurrency: 2, timeoutMs: 30000 }));
  if (evidence) add('evidence/simulation-report.json', evidence.raw);
  let total = 0;
  for (const bytes of payload.values()) { total += bytes.length; if (total > MAX_TOTAL) fail('PACKAGE_TOO_LARGE', 'The public package exceeds its size budget.'); }
  const sourceSections = [handoff, '\nSOURCE PACK — EXACT PUBLIC FILE CONTENTS\n'];
  for (const [path, bytes] of [...payload].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/\.(?:mjs|ts|sh|json|md|html)$/.test(path) || path.startsWith('evidence/') || path === 'AI-HANDOFF.md') continue;
    sourceSections.push(`\n===== BEGIN FILE ${path} | SHA256 ${digest(bytes)} | BYTES ${bytes.length} =====\n${bytes.toString('utf8')}\n===== END FILE ${path} =====\n`);
  }
  const sourcePack = sourceSections.join('');
  add('OMI_ALL_AI_HANDOFF.txt', sourcePack);
  total += Buffer.byteLength(sourcePack);
  if (total > MAX_TOTAL) fail('PACKAGE_TOO_LARGE', 'The public package and standalone source handoff exceed their size budget.');
  const currentRuntime = await runtimeFingerprint(root);
  const currentMetadata = sourceMetadata(root);
  if (currentRuntime.fingerprint !== runtime.fingerprint || JSON.stringify(currentMetadata) !== JSON.stringify(metadata)) fail('SOURCE_CHANGED', 'Source changed while packaging. Run the build again from stable source.');
  const entries = [...payload].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes), mode: path.endsWith('.sh') ? '0755' : '0644' }));
  const manifest = {
    protocol: 'omi-agent-bundle/1', source: { ...metadata, runtimeFingerprint: runtime.fingerprint },
    readiness: evidence ? 'virtual-simulation-passed' : 'unverified-developer-package',
    requirements: { agentRuntime: 'See node/README.md; Node 24 recommended', fullForumRuntime: 'Node >=24', tools: ['Bash', 'Git'], buildOnly: ['Python 3'] },
    simulation: evidence ? { status: evidence.report.status, simulatedProvider: true, reportSha256: evidence.sha256, sourceFingerprint: runtime.fingerprint, checks: evidence.report.checks.length, seats: evidence.report.seats.length } : null,
    connectionStatus: 'No remote AI connection, license activation or public HTTPS deployment is asserted by this bundle.',
    files: entries,
  };
  const stage = `${output}.building-${randomUUID()}`;
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    const kit = resolve(stage, 'kit'); await fs.mkdir(kit, { mode: 0o755 });
    for (const [path, bytes] of payload) {
      const destination = resolve(kit, path); await fs.mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await fs.writeFile(destination, bytes, { mode: path.endsWith('.sh') ? 0o755 : 0o644, flag: 'wx' });
      await fs.chmod(destination, path.endsWith('.sh') ? 0o755 : 0o644);
    }
    const manifestBytes = Buffer.from(json(manifest));
    await fs.writeFile(resolve(kit, 'manifest.json'), manifestBytes, { mode: 0o644, flag: 'wx' });
    await fs.chmod(resolve(kit, 'manifest.json'), 0o644);
    execFileSync(process.execPath, [resolve(kit, 'VERIFY.mjs')], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const archive = resolve(stage, 'omi-agent-kit.zip');
    execFileSync(python, ['-c', ZIP_SOURCE, kit, archive], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const archiveBytes = await fs.readFile(archive); const archiveHash = digest(archiveBytes);
    await fs.writeFile(resolve(stage, 'omi-agent-kit.zip.sha256'), `${archiveHash}  omi-agent-kit.zip\n`, { mode: 0o644, flag: 'wx' });
    await fs.writeFile(resolve(stage, 'manifest.json'), manifestBytes, { mode: 0o644, flag: 'wx' });
    await fs.writeFile(resolve(stage, 'manifest.json.sha256'), `${digest(manifestBytes)}  manifest.json\n`, { mode: 0o644, flag: 'wx' });
    await fs.writeFile(resolve(stage, 'OMI_ALL_AI_HANDOFF.txt'), sourcePack, { mode: 0o644, flag: 'wx' });
    if (evidence && JSON.stringify(sourceMetadata(root)) !== JSON.stringify(metadata)) fail('SOURCE_CHANGED', 'Release source changed while packaging. Rerun the simulation and build.');
    await fs.rename(stage, output);
    return { status: 'built', outputDirectory: output, archive: resolve(output, 'omi-agent-kit.zip'), archiveSha256: archiveHash, manifest: resolve(output, 'manifest.json'), handoff: resolve(output, 'OMI_ALL_AI_HANDOFF.txt'), kitDirectory: resolve(output, 'kit'), files: entries.length, readiness: manifest.readiness, sourceCommit: metadata.commit };
  } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--help') { console.log('Usage: node bundle/build.mjs --output /absolute/output [--simulation-report /absolute/passed-report.json]\nCommit source, run the virtual simulation, then supply its report for a tested release.'); return; }
    if (!['--output', '--simulation-report'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--')) fail('INVALID_ARGUMENT', 'Use --output and optional --simulation-report.');
    const value = args[++index]; if (!isAbsolute(value)) fail('INVALID_ARGUMENT', 'Use absolute build paths.');
    options[name === '--output' ? 'outputDirectory' : 'simulationReportPath'] = value;
  }
  console.log(json(await buildAgentBundle(options)).trim());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(json({ status: 'failed', code: error instanceof BundleError ? error.code : 'BUILD_FAILED', message: error instanceof BundleError ? error.message : 'Bundle build failed; source or tool diagnostics are withheld.' }).trim()); process.exitCode = 1; });
