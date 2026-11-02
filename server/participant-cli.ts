import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForumStore } from './forum-store.ts';

process.umask(0o077);
const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const position = args.indexOf(`--${name}`);
  return position >= 0 ? args[position + 1] : undefined;
}
const participantId = option('id');
if (!participantId) throw new Error('Supply --id participant-id, --name and --output; --id, --rotate and --output; or --id and --revoke.');
if (args.includes('--revoke') && args.includes('--rotate')) throw new Error('Choose revocation or rotation, not both.');
const dataDir = realpathSync(resolve(process.env.OMI_FORUM_DATA_DIR || resolve(root, '../omi-forum-data')));
if (dataDir === root || dataDir.startsWith(root + sep)) throw new Error('Keep forum data outside the checkout.');
const database = resolve(dataDir, 'forum.sqlite');
if (!existsSync(database)) throw new Error('Start the forum once to create its administrator and database.');
const store = new ForumStore(database);
let retainedCredential: string | undefined;
try {
  if (args.includes('--revoke')) {
    store.revokeParticipant(participantId);
    console.log(`Participant ${participantId} has been revoked. Historical messages were preserved.`);
  } else {
    const rotating = args.includes('--rotate');
    const existing = store.listParticipants().find(participant => participant.id === participantId);
    if (rotating && !existing) throw new Error('Participant does not exist.');
    if (!rotating && existing) throw new Error('Participant already exists; use --rotate with a new output file to replace its token.');
    const name = rotating ? existing!.name : option('name'); const output = option('output');
    if (!name || !output) throw new Error('Supply --name and --output for creation, or --rotate and --output for rotation.');
    const destination = resolve(output);
    if (existsSync(destination)) throw new Error('The output file already exists; refusing to replace credentials.');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    const parent = realpathSync(dirname(destination));
    if (parent === root || parent.startsWith(root + sep)) throw new Error('Write credentials outside the checkout and public assets.');
    const filename = resolve(parent, basename(destination));
    if (existsSync(filename)) throw new Error('The output file already exists; refusing to replace credentials.');
    const parentMetadata = lstatSync(parent);
    if (!parentMetadata.isDirectory() || (process.getuid && (parentMetadata.uid !== process.getuid() || (parentMetadata.mode & 0o077) !== 0))) {
      throw new Error('The credential output parent must be an owner-only private directory.');
    }
    const token = randomBytes(32).toString('base64url');
    const identity = existing ?? { id: participantId, name, role: args.includes('--admin') ? 'admin' as const : 'participant' as const };
    // Keep the only raw key durably before changing the database's accepted hash.
    // If registration later fails, retain this private candidate for diagnosis;
    // never undo a successfully rotated hash by losing its only credential file.
    const descriptor = openSync(filename, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify({ participant: identity, token }, null, 2) + '\n');
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    retainedCredential = filename;
    const directory = openSync(parent, 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
    const participant = rotating
      ? store.rotateParticipantToken(participantId, token)
      : store.createParticipant({ id: participantId, name, role: identity.role, token });
    console.log(`Participant ${participant.id} ${rotating ? 'token rotated' : 'created'}. Credentials saved privately to ${filename}; token withheld.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Participant operation failed.');
  if (retainedCredential) console.error(`Private candidate credentials were retained at ${retainedCredential}; token withheld. Check the operation result before using them.`);
  process.exitCode = 1;
} finally { store.close(); }
