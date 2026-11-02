import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import capsuleSchema from '../../omi-client/capsules/schema.json';

export type Audience = { mode: 'private' | 'selected' | 'family'; allowed_ids?: string[]; expires_at?: string | null };
export type PrivacyArea = 'location' | 'presence' | 'timeline' | 'media' | 'messages' | 'travel';
export type Capsule = {
  capsule_id: string;
  owner_id: string;
  version: string;
  identity: {
    auth_methods: Array<'passkey' | 'pin' | 'voice_template' | 'camera_template' | 'reliance_watch'>;
    raw_biometrics_retained: false;
    voice_template_ref?: string | null;
    camera_template_ref?: string | null;
    preferred_language?: string;
    accessibility_profile_ref?: string | null;
  };
  privacy: Record<PrivacyArea, Audience>;
  services: Array<{ app_id: string; enabled: boolean; profile?: string | null }>;
  travel?: {
    travel_partner_ids?: string[];
    trip_only_location_share?: boolean;
    arrival_flags?: boolean;
    regional_emergency_profile?: boolean;
    translation_enabled?: boolean;
  };
  emergency: {
    enabled: boolean;
    contacts: string[];
    location_share_on_sos: boolean;
    medical_summary_ref?: string | null;
    allow_regional_emergency_relay?: boolean;
  };
  sharing: {
    enabled: boolean;
    max_idle_share_percent: number;
    load_balance: boolean;
    share_window?: string | null;
    auto_manage?: boolean;
    turbo_manual?: boolean;
    resource_types?: Array<'cpu' | 'vgpu' | 'storage' | 'bandwidth'>;
  };
};

export type VaultData = { capsule: Capsule; displayName: string; appData: Record<string, unknown> };
export const VAULT_STORAGE_KEY = 'omi.personal-capsule.v1';
export const PIN_MIN_LENGTH = 8;
const ITERATIONS = 310_000;
const MAX_PLAINTEXT_BYTES = 1_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const authenticatedContext = encoder.encode('OMI Personal Capsule Vault v1');
const keySalts = new WeakMap<CryptoKey, Uint8Array<ArrayBuffer>>();
let saveQueue = Promise.resolve();
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateCapsule = ajv.compile<Capsule>(capsuleSchema);

type Envelope = {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

function storage(): Storage {
  try {
    if (!globalThis.localStorage) throw new Error();
    return globalThis.localStorage;
  } catch {
    throw new Error('This browser does not allow local capsule storage.');
  }
}

function requireCrypto(): void {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Capsule encryption requires a secure browser connection (HTTPS or localhost).');
  }
}

function validatePin(pin: string): void {
  if (!/^\d{8,64}$/.test(pin)) throw new Error('Use a PIN containing 8 to 64 digits.');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid capsule encoding.');
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function readEnvelope(): Envelope {
  const raw = storage().getItem(VAULT_STORAGE_KEY);
  if (!raw || raw.length > 1_400_000) throw new Error('Capsule data is missing or damaged.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Capsule data is damaged.'); }
  const value = parsed as Partial<Envelope> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== 1 || value.kdf !== 'PBKDF2-SHA256' || value.iterations !== ITERATIONS ||
      typeof value.salt !== 'string' || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') {
    throw new Error('Capsule format is unsupported or damaged.');
  }
  const salt = base64ToBytes(value.salt);
  const iv = base64ToBytes(value.iv);
  const ciphertext = base64ToBytes(value.ciphertext);
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
    throw new Error('Capsule data is damaged.');
  }
  return value as Envelope;
}

function validateData(value: unknown): asserts value is VaultData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capsule data.');
  const data = value as VaultData;
  const keys = Object.keys(data).sort().join(',');
  if (keys !== 'appData,capsule,displayName' || typeof data.displayName !== 'string' ||
      !data.displayName.trim() || data.displayName.length > 80 ||
      !data.appData || typeof data.appData !== 'object' || Array.isArray(data.appData) ||
      !validateCapsule(data.capsule)) {
    throw new Error('Capsule data does not match the OMI Personal Capsule schema.');
  }
}

async function deriveKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  requireCrypto();
  const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  keySalts.set(key, salt);
  return key;
}

function encodeData(data: VaultData): Uint8Array<ArrayBuffer> {
  validateData(data);
  const bytes = encoder.encode(JSON.stringify(data));
  if (bytes.length > MAX_PLAINTEXT_BYTES) throw new Error('Your capsule is full. Remove some local app data before saving.');
  return bytes;
}

async function encryptAndStore(bytes: Uint8Array<ArrayBuffer>, key: CryptoKey, salt: Uint8Array<ArrayBuffer>, creating = false): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: authenticatedContext }, key, bytes);
  const envelope: Envelope = {
    version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
    salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
  // Encryption is asynchronous; recheck ownership immediately before committing the write.
  if (creating) {
    if (hasVault()) throw new Error('A capsule already exists. Unlock it to continue.');
  } else if (readEnvelope().salt !== bytesToBase64(salt)) {
    throw new Error('The capsule changed in another tab. Unlock it again before saving.');
  }
  try { storage().setItem(VAULT_STORAGE_KEY, JSON.stringify(envelope)); }
  catch { throw new Error('Could not save the capsule. Browser storage may be full or unavailable.'); }
}

export function hasVault(): boolean {
  return storage().getItem(VAULT_STORAGE_KEY) !== null;
}

export async function createVault(displayName: string, pin: string): Promise<{ data: VaultData; key: CryptoKey }> {
  requireCrypto();
  validatePin(pin);
  if (hasVault()) throw new Error('A capsule already exists. Unlock it to continue.');
  const name = displayName.trim();
  if (!name || name.length > 80) throw new Error('Enter a name between 1 and 80 characters.');
  const data: VaultData = {
    displayName: name,
    appData: {},
    capsule: {
      capsule_id: crypto.randomUUID(), owner_id: crypto.randomUUID(), version: '0.1.0',
      identity: { auth_methods: ['pin'], raw_biometrics_retained: false, preferred_language: 'en' },
      privacy: {
        location: { mode: 'private' }, presence: { mode: 'private' }, timeline: { mode: 'private' },
        media: { mode: 'private' }, messages: { mode: 'private' }, travel: { mode: 'private' },
      },
      services: [],
      emergency: { enabled: false, contacts: [], location_share_on_sos: false },
      sharing: {
        enabled: false, max_idle_share_percent: 15, load_balance: false, share_window: null,
        auto_manage: false, turbo_manual: false, resource_types: [],
      },
    },
  };
  const bytes = encodeData(data);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  // Do not replace a capsule created by another tab while key derivation was running.
  if (hasVault()) throw new Error('A capsule already exists. Unlock it to continue.');
  await encryptAndStore(bytes, key, salt, true);
  return { data, key };
}

export async function unlockVault(pin: string): Promise<{ data: VaultData; key: CryptoKey }> {
  requireCrypto();
  validatePin(pin);
  const envelope = readEnvelope();
  const key = await deriveKey(pin, base64ToBytes(envelope.salt));
  let data: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.iv), additionalData: authenticatedContext },
      key, base64ToBytes(envelope.ciphertext),
    );
    data = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Could not unlock the capsule. Check your PIN; the saved data may also be damaged.');
  }
  validateData(data);
  // Authorization belongs to the current session. Never resume a saved share window.
  data.capsule.sharing = {
    ...data.capsule.sharing, enabled: false, load_balance: false, share_window: null,
    auto_manage: false, turbo_manual: false,
  };
  return { data, key };
}

export async function saveVault(data: VaultData, key: CryptoKey): Promise<void> {
  requireCrypto();
  const salt = keySalts.get(key);
  if (!salt) throw new Error('Unlock your capsule again before saving.');
  // Capture this specific edit before awaiting other queued writes.
  const bytes = encodeData(data);
  const operation = saveQueue.then(async () => {
    const current = readEnvelope();
    if (current.salt !== bytesToBase64(salt)) throw new Error('The capsule changed in another tab. Unlock it again before saving.');
    await encryptAndStore(bytes, key, salt);
  });
  saveQueue = operation.catch(() => undefined);
  return operation;
}

export function removeVault(): void {
  storage().removeItem(VAULT_STORAGE_KEY);
}
