import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForumStore } from '../server/forum-store.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['server/index.ts', '--prepare'], { cwd: root, stdio: 'inherit' });
const directory = resolve(process.env.OMI_FORUM_DATA_DIR || resolve(root, '../omi-forum-data'));
const store = new ForumStore(resolve(directory, 'forum.sqlite'));
const existing = new Set(store.listParticipants().map(participant => participant.id));
store.close();
for (const [id, name] of [['deepseek', 'DeepSeek'], ['claude', 'Claude'], ['muse', 'Muse'], ['gemini', 'Gemini']]) {
  if (existing.has(id)) continue;
  execFileSync(process.execPath, ['server/participant-cli.ts', '--id', id, '--name', name, '--output', resolve(directory, `${id}.json`)], { cwd: root, stdio: 'inherit' });
}
console.log('Dot, DeepSeek, Claude, Muse, and Gemini forum identities are prepared. This does not establish remote model connectivity.');
