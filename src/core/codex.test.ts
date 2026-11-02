import { describe, expect, it } from 'vitest';
import {
  analyzeState, codexDerivative, DEFAULT_PARAMETERS, DEFAULT_SETTINGS, parameterWarnings,
  simulateCodex, validateCodexParameters, type CodexParameters,
} from './codex';

const parameters = (changes: Partial<CodexParameters> = {}): CodexParameters => ({ ...DEFAULT_PARAMETERS, ...changes });

describe('Dual Merge Codex exact equations', () => {
  it('matches both ODEs and every control-injection term', () => {
    const p = parameters();
    const K = 3; const T = 2;
    const phi = p.beta1 * K / p.P + p.beta2 * p.W / (1 + p.W) + p.beta3 * T / (1 + T) - p.beta4 * p.R * T / (1 + K);
    const actual = codexDerivative(p, K, T);
    expect(actual.phi).toBeCloseTo(phi, 14);
    expect(actual.dK).toBeCloseTo(p.V * K * (1 - K / p.P) - p.R * K * T - p.D * K, 14);
    expect(actual.dT).toBeCloseTo(p.M * K * T - p.S * T - p.D * T + p.alpha * phi, 14);
  });

  it('has the exact positive interior equilibrium for the uncontrolled base system', () => {
    const p = parameters({ alpha: 0 });
    const K = (p.S + p.D) / p.M;
    const T = (p.V * (1 - K / p.P) - p.D) / p.R;
    expect(K).toBeGreaterThan(0);
    expect(T).toBeGreaterThan(0);
    expect(analyzeState(p, K, T).residual).toBeLessThan(1e-14);
    const result = simulateCodex(p, { ...DEFAULT_SETTINGS, initialK: K, initialT: T });
    expect(result.status).toBe('completed');
    for (const sample of result.samples) {
      expect(sample.K).toBeCloseTo(K, 11);
      expect(sample.T).toBeCloseTo(T, 11);
    }
  });

  it('uses the full arbitrary-state Jacobian and matches centered finite differences', () => {
    const p = parameters();
    const K = 1.7; const T = 0.8; const epsilon = 1e-5;
    const analysis = analyzeState(p, K, T);
    const plusK = codexDerivative(p, K + epsilon, T);
    const minusK = codexDerivative(p, K - epsilon, T);
    const plusT = codexDerivative(p, K, T + epsilon);
    const minusT = codexDerivative(p, K, T - epsilon);
    expect(analysis.jacobian[0][0]).toBeCloseTo((plusK.dK - minusK.dK) / (2 * epsilon), 8);
    expect(analysis.jacobian[1][0]).toBeCloseTo((plusK.dT - minusK.dT) / (2 * epsilon), 8);
    expect(analysis.jacobian[0][1]).toBeCloseTo((plusT.dK - minusT.dK) / (2 * epsilon), 8);
    expect(analysis.jacobian[1][1]).toBeCloseTo((plusT.dT - minusT.dT) / (2 * epsilon), 8);
    expect(analysis.jacobian[0][0]).not.toBeCloseTo(-p.V * K / p.P, 4);
    expect(analysis.trace).toBe(analysis.jacobian[0][0] + analysis.jacobian[1][1]);
    expect(analysis.residual).toBeGreaterThan(0);
  });

  it('separates hard-invalid inputs from conditional-model warnings', () => {
    expect(validateCodexParameters(parameters())).toEqual([]);
    const p = parameters({ V: 0, alpha: 0, beta4: 1 });
    expect(validateCodexParameters(p)).toEqual([]);
    expect(parameterWarnings(p).join(' ')).toContain('V ≤ D');
    expect(parameterWarnings(p).join(' ')).toContain('beta4 <');
    expect(parameterWarnings(p).join(' ')).toContain('uncontrolled');
    for (const invalid of [parameters({ P: 0 }), parameters({ D: 0 }), parameters({ W: 0 }), parameters({ M: -1 }), parameters({ beta1: NaN }), parameters({ V: Infinity }), parameters({ R: 1e5 })]) {
      expect(validateCodexParameters(invalid).length).toBeGreaterThan(0);
      expect(() => simulateCodex(invalid, DEFAULT_SETTINGS)).toThrow(RangeError);
    }
  });
});

describe('bounded adaptive Dormand–Prince integration', () => {
  it('completes illustrative defaults with finite positive fixed-grid output including endpoints', () => {
    const result = simulateCodex(DEFAULT_PARAMETERS, DEFAULT_SETTINGS);
    expect(result.status).toBe('completed');
    expect(result.samples).toHaveLength(401);
    expect(result.samples[0].t).toBe(0);
    expect(result.samples.at(-1)?.t).toBe(DEFAULT_SETTINGS.duration);
    expect(result.samples.every(sample => sample.K > 0 && sample.T > 0 && Object.values(sample).every(Number.isFinite))).toBe(true);
    expect(result.samples.every((sample, i) => i === 0 || sample.t > result.samples[i - 1].t)).toBe(true);
    expect(result.acceptedSteps).toBeGreaterThanOrEqual(400);
    expect(result.reason).toContain('not a stability proof');
  });

  it('converges toward a tighter adaptive reference and actively rejects oversized trials', () => {
    const p = parameters({ V: 50, R: 1.5, M: 0.5, alpha: 0.03 });
    const s = { ...DEFAULT_SETTINGS, initialK: 8, initialT: 0.5, duration: 20 };
    const loose = simulateCodex(p, { ...s, tolerance: 1e-3 });
    const tight = simulateCodex(p, { ...s, tolerance: 1e-7 });
    const reference = simulateCodex(p, { ...s, tolerance: 1e-10 });
    expect([loose.status, tight.status, reference.status]).toEqual(['completed', 'completed', 'completed']);
    const error = (result: typeof loose) => Math.max(...result.samples.map((sample, index) => Math.hypot(sample.K - reference.samples[index].K, sample.T - reference.samples[index].T)));
    expect(error(tight)).toBeLessThan(error(loose));
    expect(error(tight)).toBeLessThan(1e-5);
    expect(tight.rejectedSteps).toBeGreaterThan(0);
    expect(reference.acceptedSteps).toBeGreaterThan(tight.acceptedSteps);
  });

  it('matches an analytic decoupled logistic/decay solution without control', () => {
    const p = parameters({ R: 0, M: 0, alpha: 0 });
    const s = { ...DEFAULT_SETTINGS, duration: 3, tolerance: 1e-9 };
    const result = simulateCodex(p, s);
    const last = result.samples.at(-1)!;
    const growth = p.V - p.D;
    const capacity = p.P * growth / p.V;
    const exactK = capacity / (1 + (capacity / s.initialK - 1) * Math.exp(-growth * s.duration));
    const exactT = s.initialT * Math.exp(-(p.S + p.D) * s.duration);
    expect(result.status).toBe('completed');
    expect(last.K).toBeCloseTo(exactK, 8);
    expect(last.T).toBeCloseTo(exactT, 9);
  });

  it('is deterministic and does not mutate caller settings or parameters', () => {
    const p = parameters(); const s = { ...DEFAULT_SETTINGS };
    const before = JSON.stringify({ p, s });
    const first = simulateCodex(p, s);
    const second = simulateCodex(p, s);
    expect(second).toEqual(first);
    expect(JSON.stringify({ p, s })).toBe(before);
    p.V = 9; s.duration = 50;
    expect(first.parameters.V).toBe(DEFAULT_PARAMETERS.V);
    expect(first.settings.duration).toBe(DEFAULT_SETTINGS.duration);
  });

  it('rejects invalid initial states, tolerances, and unreasonable horizons', () => {
    for (const s of [
      { ...DEFAULT_SETTINGS, initialK: 0 }, { ...DEFAULT_SETTINGS, initialT: -1 },
      { ...DEFAULT_SETTINGS, initialK: NaN }, { ...DEFAULT_SETTINGS, initialT: Infinity },
      { ...DEFAULT_SETTINGS, initialK: 1e7 }, { ...DEFAULT_SETTINGS, duration: 0 },
      { ...DEFAULT_SETTINGS, duration: 1001 }, { ...DEFAULT_SETTINGS, tolerance: 1e-15 },
    ]) expect(() => simulateCodex(DEFAULT_PARAMETERS, s)).toThrow(RangeError);
    expect(() => codexDerivative(DEFAULT_PARAMETERS, -1, 1)).toThrow(RangeError);
    expect(() => analyzeState(DEFAULT_PARAMETERS, 1, NaN)).toThrow(RangeError);
    // Positive finite inputs can still exceed floating-point representability.
    // Refuse them before any non-finite initial sample can reach JSON export.
    expect(() => simulateCodex(parameters({ P: Number.MIN_VALUE }), DEFAULT_SETTINGS)).toThrow(/Initial derivative is non-finite/);
  });

  it('exhausts a fixed derivative budget on a long stiff system instead of blocking indefinitely', () => {
    const result = simulateCodex(parameters({ V: 1e4, R: 0, M: 0, alpha: 0 }), { ...DEFAULT_SETTINGS, duration: 1000 });
    expect(result.status).toBe('contained');
    expect(result.reason).toContain('derivative budget exhausted');
    expect(result.acceptedSteps + result.rejectedSteps).toBeLessThanOrEqual(20_000);
    expect(result.samples.at(-1)!.t).toBeLessThan(1000);
    expect(result.samples.every(sample => sample.K > 0 && sample.T > 0 && Object.values(sample).every(Number.isFinite))).toBe(true);
  });

  it('contains an extreme stiff run with bounded work and preserves only valid states', () => {
    const p = parameters({ V: 1e4, P: 1e-9, M: 1e4 });
    const result = simulateCodex(p, { ...DEFAULT_SETTINGS, initialK: 1e6, initialT: 1e6, duration: 1000, tolerance: 1e-10 });
    expect(result.status).toBe('contained');
    expect(result.acceptedSteps + result.rejectedSteps).toBeLessThanOrEqual(20_000);
    expect(result.samples.length).toBeLessThanOrEqual(1000);
    expect(result.samples.every(sample => sample.K > 0 && sample.T > 0 && Object.values(sample).every(Number.isFinite))).toBe(true);
    expect(result.samples.at(-1)!.t).toBeLessThan(1000);
    expect(result.reason).toMatch(/budget|boundary|tolerance/);
  });
});
