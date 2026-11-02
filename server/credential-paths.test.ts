import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { ForumStore } from './forum-store';

it.skipIf(!process.getuid)('refuses shared credential directories before writing a key or registering an identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'omi-private-path-'));
  const store = new ForumStore(join(directory, 'data', 'forum.sqlite'));
  const parent = join(directory, 'shared');
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o777);
  const destination = join(parent, 'seat.json');
  try {
    const result = spawnSync(process.execPath, ['server/participant-cli.ts', '--id', 'shared-seat', '--name', 'Shared seat', '--output', destination], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OMI_FORUM_DATA_DIR: join(directory, 'data') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('owner-only');
    expect(existsSync(destination)).toBe(false);
    expect(store.listParticipants()).toEqual([]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('refuses a checkout ancestor as the private data directory without changing its permissions', () => {
  const ancestor = dirname(process.cwd());
  const before = statSync(ancestor).mode;
  const result = spawnSync(process.execPath, ['server/index.ts', '--prepare'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OMI_FORUM_DATA_DIR: ancestor },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('outside the checkout and its ancestors');
  expect(statSync(ancestor).mode).toBe(before);
});
