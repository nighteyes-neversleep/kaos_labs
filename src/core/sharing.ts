/**
 * A local, explicit authorization window. This module never measures or consumes
 * CPU, GPU, storage, bandwidth, or peer resources.
 */
export type ShareSession = {
  enabled: boolean;
  expiresAt: number | null;
  percent: number;
  autoManage: boolean;
  turbo: boolean;
  loadBalance: boolean;
};

export type SharingOption = 'autoManage' | 'turbo' | 'loadBalance';

const MAX_IDLE_SHARE_PERCENT = 15;
const MAX_WINDOW_MINUTES = 60;
const MINUTE_MS = 60_000;
const options: readonly SharingOption[] = ['autoManage', 'turbo', 'loadBalance'];

function validTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function validPercent(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_IDLE_SHARE_PERCENT;
}

/** Each new session requires fresh authorization. Sharing is always off initially. */
export const freshSharing = (): ShareSession => ({
  enabled: false,
  expiresAt: null,
  percent: MAX_IDLE_SHARE_PERCENT,
  autoManage: false,
  turbo: false,
  loadBalance: false,
});

/** Only an explicit user action should call this function. */
export function authorizeSharing(
  minutes: number,
  percent: number,
  now = Date.now(),
): ShareSession {
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_WINDOW_MINUTES) {
    throw new RangeError('Choose a share window greater than 0 and at most 60 minutes.');
  }
  if (!validPercent(percent)) {
    throw new RangeError('Choose more than 0 and at most 15% of currently idle resources.');
  }
  const expiresAt = now + minutes * MINUTE_MS;
  if (!validTime(now) || !validTime(expiresAt) || expiresAt <= now) {
    throw new RangeError('A valid current time and share expiry are required.');
  }
  return { ...freshSharing(), enabled: true, expiresAt, percent };
}

/** Revocation also removes every dependent sharing mode and the old expiry. */
export function revokeSharing(): ShareSession {
  return freshSharing();
}

/**
 * Recheck this at the point of use. Stale or malformed authorization fails closed;
 * an earlier UI state is never proof that sharing is still authorized.
 */
export function effectiveSharing(session: ShareSession, now = Date.now()): ShareSession {
  if (
    !session ||
    typeof session !== 'object' ||
    session.enabled !== true ||
    !validTime(now) ||
    typeof session.expiresAt !== 'number' ||
    !validTime(session.expiresAt) ||
    session.expiresAt <= now ||
    session.expiresAt - now > MAX_WINDOW_MINUTES * MINUTE_MS ||
    !validPercent(session.percent) ||
    typeof session.autoManage !== 'boolean' ||
    typeof session.turbo !== 'boolean' ||
    typeof session.loadBalance !== 'boolean'
  ) {
    return freshSharing();
  }
  return { ...session };
}

export function setSharingOption(
  session: ShareSession,
  option: SharingOption,
  enabled: boolean,
  now = Date.now(),
): ShareSession {
  if (!options.includes(option) || typeof enabled !== 'boolean') {
    throw new TypeError('A valid sharing option and boolean value are required.');
  }
  const current = effectiveSharing(session, now);
  if (enabled && !current.enabled) {
    throw new Error('Enable an authorized share window before enabling this mode.');
  }
  return { ...current, [option]: enabled };
}

/**
 * Maximum permitted amount from a supplied CURRENTLY IDLE resource quantity.
 * Foreground activity immediately yields the entire budget. This is a policy
 * calculation, not a resource allocator or a claim that sharing is running.
 */
export function idleBudget(
  idle: number,
  session: ShareSession,
  foregroundActive: boolean,
  now = Date.now(),
): number {
  if (!Number.isFinite(idle) || idle <= 0 || foregroundActive !== false) {
    return 0;
  }
  const current = effectiveSharing(session, now);
  return current.enabled ? idle * (current.percent / 100) : 0;
}
