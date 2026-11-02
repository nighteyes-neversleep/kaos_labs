import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVault, hasVault, removeVault, saveVault, unlockVault, VAULT_STORAGE_KEY } from './capsule';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

const PIN = '70439182';

describe('encrypted Personal Capsule vault', () => {
  it('creates a private capsule, saves app data, and decrypts it after locking', async () => {
    expect(hasVault()).toBe(false);
    const { data, key } = await createVault('River', PIN);
    expect(hasVault()).toBe(true);
    expect(data.capsule.sharing.enabled).toBe(false);
    expect(data.capsule.identity.raw_biometrics_retained).toBe(false);
    expect(Object.values(data.capsule.privacy).every((privacy) => privacy.mode === 'private')).toBe(true);
    data.appData['eagles-nest'] = { notes: ['Pick up groceries'] };
    await saveVault(data, key);
    const unlocked = await unlockVault(PIN);
    expect(unlocked.data).toEqual(data);
    expect(key.extractable).toBe(false);
    expect(unlocked.key.extractable).toBe(false);
  });

  it('stores no plaintext capsule, name, app content, or PIN and uses a fresh IV for every save', async () => {
    const { data, key } = await createVault('Sensitive family name', PIN);
    data.appData.family = { secret: 'Private pickup location' };
    await saveVault(data, key);
    const before = localStorage.getItem(VAULT_STORAGE_KEY)!;
    for (const secret of [PIN, data.displayName, data.capsule.owner_id, 'Private pickup location', 'appData', 'capsule_id']) {
      expect(before).not.toContain(secret);
    }
    await saveVault(data, key);
    const after = localStorage.getItem(VAULT_STORAGE_KEY)!;
    expect(JSON.parse(after).iv).not.toEqual(JSON.parse(before).iv);
    expect(JSON.parse(after).ciphertext).not.toEqual(JSON.parse(before).ciphertext);
  });

  it('rejects wrong PINs and modified ciphertext without revealing plaintext', async () => {
    await createVault('River', PIN);
    await expect(unlockVault('00000000')).rejects.toThrow('Could not unlock the capsule');
    const envelope = JSON.parse(localStorage.getItem(VAULT_STORAGE_KEY)!);
    envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope));
    await expect(unlockVault(PIN)).rejects.toThrow('Could not unlock the capsule');
  });

  it('requires fresh sharing authorization whenever the capsule is unlocked', async () => {
    const { data, key } = await createVault('River', PIN);
    data.capsule.sharing = {
      enabled: true, max_idle_share_percent: 10, load_balance: true,
      share_window: new Date(Date.now() + 60_000).toISOString(), auto_manage: true, turbo_manual: true,
    };
    await saveVault(data, key);
    const unlocked = await unlockVault(PIN);
    expect(unlocked.data.capsule.sharing).toEqual({
      enabled: false, max_idle_share_percent: 10, load_balance: false,
      share_window: null, auto_manage: false, turbo_manual: false,
    });
  });

  it('refuses invalid PINs, invalid capsule schemas, and accidental replacement', async () => {
    await expect(createVault('River', '1234')).rejects.toThrow('8 to 64 digits');
    await expect(createVault('River', 'abcdefgh')).rejects.toThrow('8 to 64 digits');
    await expect(createVault(' ', PIN)).rejects.toThrow('Enter a name');
    const { data, key } = await createVault('River', PIN);
    await expect(createVault('Other person', PIN)).rejects.toThrow('already exists');
    data.capsule.sharing.max_idle_share_percent = 16;
    await expect(saveVault(data, key)).rejects.toThrow('schema');
  });

  it('reports corrupt envelopes without overwriting them', async () => {
    localStorage.setItem(VAULT_STORAGE_KEY, '{broken');
    await expect(unlockVault(PIN)).rejects.toThrow('damaged');
    await expect(createVault('River', PIN)).rejects.toThrow('already exists');
    expect(localStorage.getItem(VAULT_STORAGE_KEY)).toBe('{broken');
  });

  it('rejects forged key-derivation settings before attempting to unlock', async () => {
    await createVault('River', PIN);
    const envelope = JSON.parse(localStorage.getItem(VAULT_STORAGE_KEY)!);
    envelope.iterations = 1;
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope));
    await expect(unlockVault(PIN)).rejects.toThrow('unsupported or damaged');
  });

  it('does not recreate a deleted capsule from a stale unlocked session', async () => {
    const { data, key } = await createVault('River', PIN);
    removeVault();
    expect(hasVault()).toBe(false);
    await expect(saveVault(data, key)).rejects.toThrow('missing or damaged');
    expect(hasVault()).toBe(false);
  });

  it('serializes overlapping saves so the latest requested edit persists', async () => {
    const { data, key } = await createVault('River', PIN);
    data.displayName = 'First edit';
    const first = saveVault(data, key);
    data.displayName = 'Latest edit';
    const second = saveVault(data, key);
    await Promise.all([first, second]);
    expect((await unlockVault(PIN)).data.displayName).toBe('Latest edit');
  });
});
