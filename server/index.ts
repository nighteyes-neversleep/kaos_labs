import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForumStore } from './forum-store.ts';
import { createForumServer } from './http.ts';

process.umask(0o077);
const projectRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const requestedDir = resolve(process.env.OMI_FORUM_DATA_DIR || resolve(projectRoot, '../omi-forum-data'));
mkdirSync(requestedDir, { recursive: true, mode: 0o700 });
const dataDir = realpathSync(requestedDir);
if (dataDir === projectRoot || dataDir.startsWith(projectRoot + sep)) throw new Error('Store forum data outside the application checkout.');
chmodSync(dataDir, 0o700);
const store = new ForumStore(resolve(dataDir, 'forum.sqlite'));
const bootstrapPath = resolve(dataDir, 'bootstrap-admin.json');
if (!store.listParticipants().length) {
  let credentials;
  if (existsSync(bootstrapPath)) {
    if (lstatSync(bootstrapPath).isSymbolicLink() || !lstatSync(bootstrapPath).isFile()) throw new Error('Administrator credentials must be a regular private file.');
    credentials = JSON.parse(readFileSync(bootstrapPath, 'utf8'));
    if (credentials?.participant?.id !== 'dot' || credentials?.participant?.role !== 'admin' || typeof credentials?.token !== 'string') throw new Error('Private bootstrap credentials are damaged.');
  } else {
    credentials = { participant: { id: 'dot', name: 'Dot', role: 'admin' as const }, token: randomBytes(32).toString('base64url') };
    const descriptor = openSync(bootstrapPath, 'wx', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(credentials, null, 2) + '\n'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    const directory = openSync(dataDir, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  store.createParticipant({ ...credentials.participant, token: credentials.token });
}
if (process.argv.includes('--prepare')) {
  store.close();
  console.log(`Forum database and private administrator credentials are prepared in ${dataDir}.`);
  process.exit(0);
}
const port = Number(process.env.OMI_PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OMI_PORT must be between 1 and 65535.');
const publicOrigin = process.env.OMI_PUBLIC_ORIGIN;
if (publicOrigin) {
  const parsed = new URL(publicOrigin);
  if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw new Error('OMI_PUBLIC_ORIGIN must be an HTTPS origin with no trailing slash or path.');
}
if (process.env.NODE_ENV === 'production' && !publicOrigin) throw new Error('Production requires OMI_PUBLIC_ORIGIN and a configured HTTPS reverse proxy.');
const server = createForumServer({ store, staticDir: resolve(projectRoot, 'dist'), publicOrigin });
server.listen(port, process.env.OMI_BIND || '127.0.0.1', () => {
  console.log(`OMI client and authenticated forum are listening on port ${port}.`);
  console.log(`Private administrator credentials: ${bootstrapPath} (contents withheld).`);
  if (!publicOrigin) console.log('Local HTTP mode. A public HTTPS deployment has not been configured.');
});
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); }, 3000).unref();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
