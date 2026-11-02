import { describe, expect, it } from 'vitest';
import {
  authorizeSharing,
  effectiveSharing,
  freshSharing,
  idleBudget,
  revokeSharing,
  setSharingOption,
  type ShareSession,
  type SharingOption,
} from './sharing';

const now = 1_800_000_000_000;

describe('sharing authorization', () => {
  it('starts off, without an active window or dependent modes', () => {
    expect(freshSharing()).toEqual({
      enabled: false,
      expiresAt: null,
      percent: 15,
      autoManage: false,
      turbo: false,
      loadBalance: false,
    });
    expect(freshSharing()).not.toBe(freshSharing());
    expect(idleBudget(100, freshSharing(), false, now)).toBe(0);
  });

  it('creates only the explicit window and requested idle-resource ceiling', () => {
    const session = authorizeSharing(30, 10, now);
    expect(session).toEqual({
      enabled: true,
      expiresAt: now + 30 * 60_000,
      percent: 10,
      autoManage: false,
      turbo: false,
      loadBalance: false,
    });
    expect(authorizeSharing(60, 15, now).expiresAt).toBe(now + 3_600_000);
  });

  it.each([0, -1, 61, NaN, Infinity, -Infinity])('rejects invalid window %s', minutes => {
    expect(() => authorizeSharing(minutes, 15, now)).toThrow(RangeError);
  });

  it.each([0, -1, 15.01, 100, NaN, Infinity, -Infinity])('rejects invalid share ceiling %s', percent => {
    expect(() => authorizeSharing(15, percent, now)).toThrow(RangeError);
  });

  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid authorization time %s', time => {
    expect(() => authorizeSharing(15, 15, time)).toThrow(RangeError);
  });

  it('turns every mode off at the exact expiry and revokes explicitly', () => {
    let session = authorizeSharing(1, 15, now);
    for (const option of ['autoManage', 'turbo', 'loadBalance'] as const) {
      session = setSharingOption(session, option, true, now);
    }
    expect(effectiveSharing(session, now + 59_999).enabled).toBe(true);
    expect(effectiveSharing(session, now + 60_000)).toEqual(freshSharing());
    expect(effectiveSharing(session, now + 60_001)).toEqual(freshSharing());
    expect(revokeSharing()).toEqual(freshSharing());
  });

  it.each(['autoManage', 'turbo', 'loadBalance'] as const)(
    '%s requires an active, explicitly authorized window',
    option => {
      expect(() => setSharingOption(freshSharing(), option, true, now)).toThrow(/authorized share window/);
      const session = authorizeSharing(1, 15, now);
      expect(() => setSharingOption(session, option, true, now + 60_000)).toThrow(/authorized share window/);
      expect(setSharingOption(session, option, false, now + 60_000)).toEqual(freshSharing());
      expect(setSharingOption(session, option, true, now)[option]).toBe(true);
      expect(session[option]).toBe(false);
    },
  );

  it('fails closed for malformed or stale authorization', () => {
    const session = authorizeSharing(1, 15, now);
    for (const invalid of [
      null,
      undefined,
      { ...session, enabled: 'yes' },
      { ...session, expiresAt: null },
      { ...session, expiresAt: Infinity },
      { ...session, expiresAt: now + 3_600_001 },
      { ...session, percent: 16 },
      { ...session, percent: '15' },
      { ...session, autoManage: 'true' },
      { ...session, turbo: undefined },
      { ...session, loadBalance: 1 },
    ]) {
      expect(effectiveSharing(invalid as ShareSession, now)).toEqual(freshSharing());
      expect(idleBudget(100, invalid as ShareSession, false, now)).toBe(0);
    }
    expect(effectiveSharing(session, NaN)).toEqual(freshSharing());
    expect(effectiveSharing(session, -1)).toEqual(freshSharing());
  });

  it('rejects unrecognized options and non-boolean mode changes', () => {
    const session = authorizeSharing(1, 15, now);
    expect(() => setSharingOption(session, 'enabled' as SharingOption, true, now)).toThrow(TypeError);
    expect(() => setSharingOption(session, 'turbo', 'yes' as unknown as boolean, now)).toThrow(TypeError);
  });
});

describe('current idle-resource budget', () => {
  it('uses only currently idle resources and shrinks as idle capacity falls', () => {
    const session = authorizeSharing(15, 15, now);
    expect(idleBudget(80, session, false, now)).toBe(12);
    expect(idleBudget(20, session, false, now)).toBe(3);
    expect(idleBudget(0, session, false, now)).toBe(0);
  });

  it('yields immediately to foreground activity and after the window expires', () => {
    const session = authorizeSharing(1, 15, now);
    expect(idleBudget(100, session, true, now)).toBe(0);
    expect(idleBudget(100, session, false, now + 60_000)).toBe(0);
  });

  it('keeps TURBO and AUTO MANAGE under the same idle ceiling', () => {
    let session = authorizeSharing(15, 7, now);
    session = setSharingOption(session, 'turbo', true, now);
    session = setSharingOption(session, 'autoManage', true, now);
    session = setSharingOption(session, 'loadBalance', true, now);
    expect(idleBudget(200, session, false, now)).toBeCloseTo(14);
  });

  it.each([-1, NaN, Infinity, -Infinity])('never produces a budget from invalid idle capacity %s', idle => {
    expect(idleBudget(idle, authorizeSharing(1, 15, now), false, now)).toBe(0);
  });

  it('fails closed without a known boolean foreground state', () => {
    expect(idleBudget(100, authorizeSharing(1, 15, now), undefined as unknown as boolean, now)).toBe(0);
  });

  it('computes a finite bounded budget for very large resource quantities', () => {
    const budget = idleBudget(Number.MAX_VALUE, authorizeSharing(1, 15, now), false, now);
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeLessThanOrEqual(Number.MAX_VALUE * 0.15);
  });
});
