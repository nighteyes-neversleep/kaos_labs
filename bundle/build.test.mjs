import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildAgentBundle, REQUIRED_SOURCE_PATHS, runtimeFingerprint } from './build.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, { committed = true } = {}) {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'omi-bundle-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const sourceRoot = join(temporary, 'source');
  await fs.mkdir(sourceRoot);
  for (const path of REQUIRED_SOURCE_PATHS) {
    const file = join(sourceRoot, path);
    await fs.mkdir(join(file, '..'), { recursive: true });
    const body = path === 'bundle/AI-HANDOFF.md' ? '# Fixture handoff\nCommit {{SOURCE_COMMIT}}; runtime {{RUNTIME_FINGERPRINT}}.\n' :
      path.endsWith('.sh') ? '#!/usr/bin/env bash\nprintf "%s\\n" "fixture"\n' :
      /\.(?:mjs|ts)$/.test(path) ? `// Public fixture: ${path}\nexport const fixture = true;\n` :
      path.endsWith('.json') ? '{"fixture":true}\n' : `Public fixture: ${path}\n`;
    await fs.writeFile(file, body);
  }
  await fs.writeFile(join(sourceRoot, '.env'), 'DO_NOT_PACKAGE_ENV_SECRET=private-fixture\n');
  await fs.writeFile(join(sourceRoot, 'credentials.json'), '{"secret":"DO_NOT_PACKAGE_CREDENTIAL"}\n');
  await fs.mkdir(join(sourceRoot, '.omi-dev'));
  await fs.writeFile(join(sourceRoot, '.omi-dev', 'private.txt'), 'DO_NOT_PACKAGE_PRIVATE_DATA');
  if (committed) {
    git(sourceRoot, 'init', '--quiet');
    git(sourceRoot, 'add', '.');
    git(sourceRoot, '-c', 'user.name=OMI fixture', '-c', 'user.email=omi-fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Public bundle fixture');
  }
  return { temporary, sourceRoot, output: name => join(temporary, name) };
}
async function passingReport(sourceRoot) {
  return {
    protocol: 'omi-virtual-team-sim/1', status: 'passed', simulatedProvider: true,
    checks: [{ name: 'fixture contract validation', status: 'passed' }],
    seats: [{ participantId: 'fixture-only' }],
    source: { commit: git(sourceRoot, 'rev-parse', 'HEAD'), dirty: false, ...await runtimeFingerprint(sourceRoot) },
  };
}
async function saveReport(temporary, report, name = 'simulation.json') {
  const path = join(temporary, name); await fs.writeFile(path, JSON.stringify(report, null, 2) + '\n'); return path;
}

test('build hashes every payload, preserves shell modes, and excludes private and unknown files', async t => {
  const { sourceRoot, output } = await fixture(t);
  const built = await buildAgentBundle({ sourceRoot, outputDirectory: output('release') });
  assert.equal(built.readiness, 'unverified-developer-package');
  const manifest = JSON.parse(await fs.readFile(built.manifest, 'utf8'));
  assert.equal(manifest.protocol, 'omi-agent-bundle/1');
  assert.equal(manifest.simulation, null);
  assert.equal(manifest.source.dirty, false);
  assert.ok(manifest.files.some(file => file.path === 'node/diagnose.mjs'));
  assert.ok(manifest.files.some(file => file.path === 'node/diagnose.sh'));
  assert.ok(manifest.files.some(file => file.path === 'source-review/server/http.ts'));
  for (const file of manifest.files) {
    const bytes = await fs.readFile(join(built.kitDirectory, file.path));
    assert.equal(file.bytes, bytes.length, file.path);
    assert.equal(file.sha256, sha256(bytes), file.path);
    assert.equal(file.mode, file.path.endsWith('.sh') ? '0755' : '0644');
    assert.equal((await fs.stat(join(built.kitDirectory, file.path))).mode & 0o777, Number.parseInt(file.mode, 8));
    assert.doesNotMatch(bytes.toString('utf8'), /DO_NOT_PACKAGE/);
  }
  assert.ok(!manifest.files.some(file => file.path === 'manifest.json' || /\.env|credentials\.json|\.omi-dev/.test(file.path)));
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [join(built.kitDirectory, 'VERIFY.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).status, 'verified');
  assert.equal(sha256(await fs.readFile(built.archive)), built.archiveSha256);
  assert.equal((await fs.readFile(built.archive + '.sha256', 'utf8')).trim(), `${built.archiveSha256}  omi-agent-kit.zip`);
  const handoff = await fs.readFile(built.handoff, 'utf8');
  assert.match(handoff, /BEGIN FILE relay\/git-worker\.mjs \| SHA256 [a-f0-9]{64}/);
  assert.match(handoff, /BEGIN FILE relay\/GIT-MAILBOX\.md/);
  assert.match(handoff, /BEGIN FILE source-review\/server\/http\.ts/);
  assert.doesNotMatch(handoff, /\{\{SOURCE_COMMIT\}\}|DO_NOT_PACKAGE/);
  const inspect = String.raw`import json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
 infos=archive.infolist()
 assert all(i.filename.startswith('omi-agent-kit/') and '..' not in i.filename.split('/') for i in infos)
 assert all(i.date_time==(1980,1,1,0,0,0) for i in infos)
 assert [i.filename for i in infos]==sorted(i.filename for i in infos)
 for i in infos:
  assert stat.S_IMODE(i.external_attr>>16)==(0o755 if i.filename.endswith('.sh') else 0o644)
 print(json.dumps({'files':len(infos),'manifest':json.loads(archive.read('omi-agent-kit/manifest.json'))}))
`;
  const zipped = JSON.parse(execFileSync('python3', ['-c', inspect, built.archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(zipped.files, manifest.files.length + 1);
  assert.deepEqual(zipped.manifest, manifest);
});

test('identical fixed source and evidence produce identical archives', async t => {
  const { sourceRoot, output } = await fixture(t);
  const first = await buildAgentBundle({ sourceRoot, outputDirectory: output('first') });
  const second = await buildAgentBundle({ sourceRoot, outputDirectory: output('second') });
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.deepEqual(await fs.readFile(first.archive), await fs.readFile(second.archive));
  assert.deepEqual(await fs.readFile(first.manifest), await fs.readFile(second.manifest));
});

test('only a same-commit clean passing simulation enables release status', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  const report = await passingReport(sourceRoot);
  const simulationReportPath = await saveReport(temporary, report);
  const built = await buildAgentBundle({ sourceRoot, outputDirectory: output('release'), simulationReportPath });
  assert.equal(built.readiness, 'virtual-simulation-passed');
  const manifest = JSON.parse(await fs.readFile(built.manifest, 'utf8'));
  assert.equal(manifest.simulation.simulatedProvider, true);
  assert.equal(manifest.simulation.reportSha256, sha256(await fs.readFile(simulationReportPath)));
  assert.deepEqual(await fs.readFile(join(built.kitDirectory, 'evidence/simulation-report.json')), await fs.readFile(simulationReportPath));
  assert.match(await fs.readFile(join(built.kitDirectory, 'README-FIRST.md'), 'utf8'), /VIRTUAL SIMULATION PASSED/);
});

test('failed, nonsimulated, empty, and stale reports cannot be issued', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  const report = await passingReport(sourceRoot);
  const cases = [
    ['failed', { ...report, status: 'failed' }, 'FAILED_SIMULATION'],
    ['not-simulated', { ...report, simulatedProvider: false }, 'FAILED_SIMULATION'],
    ['empty-checks', { ...report, checks: [] }, 'FAILED_SIMULATION'],
    ['failed-check', { ...report, checks: [{ name: 'bad', status: 'failed' }] }, 'FAILED_SIMULATION'],
    ['stale', { ...report, source: { ...report.source, fingerprint: '0'.repeat(64) } }, 'STALE_SIMULATION'],
    ['other-commit', { ...report, source: { ...report.source, commit: '0'.repeat(40) } }, 'UNCOMMITTED_SOURCE'],
  ];
  for (const [name, evidence, code] of cases) {
    const simulationReportPath = await saveReport(temporary, evidence, name + '.json');
    await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output(name), simulationReportPath }), { code });
    await assert.rejects(fs.stat(output(name)), { code: 'ENOENT' });
  }
});

test('source edits after simulation stop release and are never relabeled tested', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  const simulationReportPath = await saveReport(temporary, await passingReport(sourceRoot));
  await fs.appendFile(join(sourceRoot, 'relay/worker.mjs'), '// changed since simulation\n');
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output('release'), simulationReportPath }), { code: 'UNCOMMITTED_SOURCE' });
  const developer = await buildAgentBundle({ sourceRoot, outputDirectory: output('developer') });
  assert.equal(developer.readiness, 'unverified-developer-package');
});

test('a simulation cannot cover a new executable absent from the reviewed package allowlist', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  await fs.writeFile(join(sourceRoot, 'relay/unknown-helper.mjs'), 'export {};\n');
  git(sourceRoot, 'add', 'relay/unknown-helper.mjs');
  git(sourceRoot, '-c', 'user.name=OMI fixture', '-c', 'user.email=omi-fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Extra runtime fixture');
  const simulationReportPath = await saveReport(temporary, await passingReport(sourceRoot));
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output('release'), simulationReportPath }), { code: 'UNPACKAGED_EXECUTABLE' });
});

test('selected source symlinks are rejected before any artifact is issued', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  const outside = join(temporary, 'private.mjs'); await fs.writeFile(outside, 'DO_NOT_PACKAGE_SYMLINK_TARGET');
  await fs.unlink(join(sourceRoot, 'relay/worker.mjs'));
  await fs.symlink(outside, join(sourceRoot, 'relay/worker.mjs'));
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output('release') }), { code: 'SYMLINK_SOURCE' });
  await assert.rejects(fs.stat(output('release')), { code: 'ENOENT' });
});

test('existing and unsafe output paths are refused without changing existing files', async t => {
  const { sourceRoot, output } = await fixture(t);
  await fs.mkdir(output('existing')); await fs.writeFile(output('existing/marker'), 'preserve');
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output('existing') }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await fs.readFile(output('existing/marker'), 'utf8'), 'preserve');
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: join(sourceRoot, 'artifacts') }), { code: 'INVALID_OUTPUT' });
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: 'relative-output' }), { code: 'INVALID_OUTPUT' });
});

test('packaging tool failure cleans staging artifacts and never creates a partial release', async t => {
  const { temporary, sourceRoot, output } = await fixture(t);
  await assert.rejects(buildAgentBundle({ sourceRoot, outputDirectory: output('release'), python: '/nonexistent/omi-python' }), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(temporary)).filter(name => name.startsWith('release')), []);
});

test('extracted verifier catches changed payload bytes', async t => {
  const { sourceRoot, output } = await fixture(t);
  const built = await buildAgentBundle({ sourceRoot, outputDirectory: output('release') });
  await fs.appendFile(join(built.kitDirectory, 'relay/worker.mjs'), '\n// corruption\n');
  assert.throws(() => execFileSync(process.execPath, [join(built.kitDirectory, 'VERIFY.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status !== 0 && String(error.stderr).includes('Integrity mismatch: relay/worker.mjs'));
});
