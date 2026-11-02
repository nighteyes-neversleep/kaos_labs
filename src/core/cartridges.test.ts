import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyCartridge, validCartridgeData } from './cartridges';

const bundle = JSON.parse(readFileSync('public/cartridges/eagles-nest.bundle.json', 'utf8'));
describe('signed cartridge boundary', () => {
  it('verifies locally signed Eagle’s Nest and its restrictions', async () => {
    const mounted = await verifyCartridge(bundle, 'eagles-nest');
    expect(mounted.html).toContain("connect-src 'none'");
    expect(mounted.appId).toBe('eagles-nest');
  });
  it('rejects a modified payload before rendering', async () => {
    const modified = { ...bundle, payload: Buffer.from(Buffer.from(bundle.payload, 'base64').toString() + ' ').toString('base64') };
    await expect(verifyCartridge(modified, 'eagles-nest')).rejects.toThrow(/Signature/);
  });
  it('rejects unsigned content and unavailable registrations', async () => {
    await expect(verifyCartridge({ payload: bundle.payload }, 'eagles-nest')).rejects.toThrow();
    await expect(verifyCartridge(bundle, 'corvid')).rejects.toThrow(/no installed/);
  });
  it('bounds namespaced cartridge data and rejects malformed values', () => {
    const entry = { id: '1', title: 'Family plan', body: 'Private', kind: 'note', done: false, createdAt: new Date().toISOString() };
    expect(validCartridgeData({ version: 1, entries: [entry] })).toBe(true);
    expect(validCartridgeData({ version: 1, entries: [entry, entry] })).toBe(false);
    expect(validCartridgeData({ version: 1, entries: [{ ...entry, body: 'x'.repeat(801) }] })).toBe(false);
    expect(validCartridgeData({ version: 1, entries: [{ ...entry, capsule: {} }] })).toBe(false);
    expect(validCartridgeData({ version: 1, entries: [entry], __omiGovernance: [] })).toBe(false);
  });
});
