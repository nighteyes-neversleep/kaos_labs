import registry from '../../omi-client/registry/apps.json';
import trust from '../generated/cartridge-trust.json';

export const registeredApps = registry.apps.map(app => ({ ...app, available: app.app_id === 'eagles-nest' }));
export type RegisteredApp = typeof registeredApps[number];
export type VerifiedCartridge = { appId: string; version: string; html: string; signer: string };

function bytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

export async function verifyCartridge(bundle: unknown, expectedAppId: string): Promise<VerifiedCartridge> {
  const app = registeredApps.find(app => app.app_id === expectedAppId && app.enabled && app.available);
  if (!app) throw new Error('This cartridge has no installed implementation.');
  if (!bundle || typeof bundle !== 'object') throw new Error('Invalid cartridge bundle.');
  const candidate = bundle as Record<string, unknown>;
  if (typeof candidate.payload !== 'string' || typeof candidate.signature !== 'string' || candidate.payload.length > 700_000 || candidate.signature.length > 128) {
    throw new Error('Invalid or oversized signed cartridge.');
  }
  const payload = bytes(candidate.payload);
  const key = await crypto.subtle.importKey('spki', bytes(trust.publicKey), { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, bytes(candidate.signature), payload)) {
    throw new Error('Signature verification failed. OMI refused to mount this cartridge.');
  }
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  if (!decoded || typeof decoded !== 'object') throw new Error('Invalid signed payload.');
  const content = decoded as Record<string, unknown>;
  if (content.appId !== expectedAppId || typeof content.version !== 'string' || typeof content.html !== 'string') {
    throw new Error('The signed cartridge identity does not match its registration.');
  }
  if (!content.html.includes('http-equiv="Content-Security-Policy"')) throw new Error('Cartridge network restrictions missing.');
  return { appId: expectedAppId, version: content.version, html: content.html, signer: trust.label };
}

export async function loadSignedCartridge(appId: string, signal?: AbortSignal): Promise<VerifiedCartridge> {
  if (!registeredApps.some(app => app.app_id === appId && app.available)) throw new Error('Cartridge source is not installed.');
  const response = await fetch(`/cartridges/${encodeURIComponent(appId)}.bundle.json`, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error('The signed cartridge bundle could not be loaded.');
  return verifyCartridge(await response.json(), appId);
}

export function validCartridgeData(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).sort().join(',') !== 'entries,version') return false;
  if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 50) return false;
  const ids = new Set<string>();
  return data.entries.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const note = entry as Record<string, unknown>;
    if (Object.keys(note).some(key => !['id', 'title', 'body', 'kind', 'done', 'createdAt'].includes(key))) return false;
    if (typeof note.id !== 'string' || !note.id || note.id.length > 100 || ids.has(note.id)) return false;
    ids.add(note.id);
    return typeof note.title === 'string' && note.title.length > 0 && note.title.length <= 80 &&
      typeof note.body === 'string' && note.body.length <= 800 && (note.kind === 'note' || note.kind === 'task') &&
      typeof note.done === 'boolean' && typeof note.createdAt === 'string' && note.createdAt.length <= 40 && Number.isFinite(Date.parse(note.createdAt));
  });
}
