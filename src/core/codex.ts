/**
 * Dual Merge Codex, master whitepaper §6.1. Numerical exploration only.
 * Defaults are illustrative; only the beta baseline is taken from the paper.
 * Adaptive Dormand–Prince 5(4) never evaluates outside the positive orthant,
 * clamps no state, and contains a run if its numerical/domain budget is reached.
 */
export type CodexParameters = {
  V: number; P: number; D: number; R: number; M: number; S: number;
  alpha: number; W: number; beta1: number; beta2: number; beta3: number; beta4: number;
};
export type SimulationSettings = { initialK: number; initialT: number; duration: number; tolerance: number };
export type Sample = { t: number; K: number; T: number; phi: number; dK: number; dT: number };
export type SimulationResult = {
  parameters: CodexParameters;
  settings: SimulationSettings;
  samples: Sample[];
  status: 'completed' | 'contained';
  reason: string;
  acceptedSteps: number;
  rejectedSteps: number;
  modelVersion: string;
};

export const DEFAULT_PARAMETERS: Readonly<CodexParameters> = Object.freeze({
  V: 1.2, P: 10, D: 0.1, R: 0.2, M: 0.15, S: 0.3,
  alpha: 0.1, W: 1, beta1: 1.5, beta2: 3, beta3: 1.5, beta4: 7,
});
export const DEFAULT_SETTINGS: Readonly<SimulationSettings> = Object.freeze({
  initialK: 2, initialT: 0.5, duration: 30, tolerance: 1e-6,
});

const MODEL_VERSION = 'dual-merge-codex/1.0.0-dormand-prince-54';
const MAX_EVALUATIONS = 100_000;
const MAX_ATTEMPTS = 20_000;
const OUTPUT_INTERVALS = 400;
const MAX_STATE = 1e9;
const MAX_INITIAL_STATE = 1e6;
const parameterKeys = ['V', 'P', 'D', 'R', 'M', 'S', 'alpha', 'W', 'beta1', 'beta2', 'beta3', 'beta4'] as const;
const positiveKeys = new Set<keyof CodexParameters>(['P', 'D', 'S', 'W']);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Hard numeric/domain errors only; model-regime warnings are separate. */
export function validateCodexParameters(parameters: CodexParameters): string[] {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return ['Parameters must be an object.'];
  const errors: string[] = [];
  for (const key of parameterKeys) {
    const value = parameters[key];
    const maximum = key === 'P' || key === 'W' ? 1e6 : 1e4;
    if (!isFiniteNumber(value)) errors.push(`${key} must be a finite number.`);
    else if (positiveKeys.has(key) ? value <= 0 || value > maximum : value < 0 || value > maximum) {
      errors.push(`${key} must be ${positiveKeys.has(key) ? 'greater than zero' : 'nonnegative'} and at most ${maximum}.`);
    }
  }
  return errors;
}

export function parameterWarnings(parameters: CodexParameters): string[] {
  assertParameters(parameters);
  const warnings: string[] = [];
  if (parameters.V <= parameters.D) warnings.push('V ≤ D: the paper’s necessary growth condition for a positive Harmony equilibrium is not satisfied.');
  if (parameters.beta4 < parameters.beta1 + parameters.beta2 + parameters.beta3) {
    warnings.push('beta4 < beta1 + beta2 + beta3: the paper’s proposed control-weight condition is not satisfied.');
  }
  if (parameters.alpha === 0) warnings.push('alpha = 0: this is the uncontrolled base system; control injection is disabled.');
  if (parameters.M === 0 || parameters.R === 0) warnings.push('A zero coupling parameter makes the paper’s interior base-equilibrium formulas degenerate.');
  warnings.push('Numerical trajectories and local Jacobians do not establish a global stability or deployment-safety proof.');
  return warnings;
}

function assertParameters(parameters: CodexParameters): void {
  const errors = validateCodexParameters(parameters);
  if (errors.length) throw new RangeError(errors.join(' '));
}
function assertSettings(settings: SimulationSettings): void {
  if (!settings || typeof settings !== 'object') throw new RangeError('Simulation settings must be an object.');
  for (const key of ['initialK', 'initialT'] as const) {
    if (!isFiniteNumber(settings[key]) || settings[key] <= 0 || settings[key] > MAX_INITIAL_STATE) {
      throw new RangeError(`${key} must be greater than zero and at most ${MAX_INITIAL_STATE}.`);
    }
  }
  if (!isFiniteNumber(settings.duration) || settings.duration < 0.01 || settings.duration > 1000) {
    throw new RangeError('Duration must be between 0.01 and 1000 model time units.');
  }
  if (!isFiniteNumber(settings.tolerance) || settings.tolerance < 1e-10 || settings.tolerance > 1e-3) {
    throw new RangeError('Tolerance must be between 1e-10 and 1e-3.');
  }
}

type State = readonly [number, number];
type Derivative = { dK: number; dT: number; phi: number };
function stateProblem(K: number, T: number): string | null {
  if (!Number.isFinite(K) || !Number.isFinite(T)) return 'non-finite state';
  if (K <= 0 || T <= 0) return 'positive-orthant boundary';
  if (K > MAX_STATE || T > MAX_STATE) return 'numerical magnitude boundary (1e9)';
  return null;
}
function derivative(parameters: CodexParameters, K: number, T: number): Derivative {
  const { V, P, R, D, M, S, alpha, W, beta1, beta2, beta3, beta4 } = parameters;
  const phi = beta1 * (K / P) + beta2 * (W / (1 + W)) + beta3 * (T / (1 + T)) - beta4 * (R * T / (1 + K));
  const dK = V * K * (1 - K / P) - R * K * T - D * K;
  const dT = M * K * T - S * T - D * T + alpha * phi;
  return { dK, dT, phi };
}

/** Exact §6.1 right-hand side, with explicit positive-domain validation. */
export function codexDerivative(parameters: CodexParameters, K: number, T: number): Derivative {
  assertParameters(parameters);
  const problem = stateProblem(K, T);
  if (problem) throw new RangeError(`Cannot evaluate the Codex outside its domain: ${problem}.`);
  const result = derivative(parameters, K, T);
  if (!Object.values(result).every(Number.isFinite)) throw new RangeError('The Codex derivative is non-finite.');
  return result;
}

/** Full arbitrary-point Jacobian. This does not assert the point is an equilibrium. */
export function analyzeState(parameters: CodexParameters, K: number, T: number): {
  jacobian: number[][]; trace: number; determinant: number; residual: number;
} {
  const rhs = codexDerivative(parameters, K, T);
  const { V, P, R, D, M, S, alpha, beta1, beta3, beta4 } = parameters;
  const j11 = V * (1 - 2 * K / P) - R * T - D;
  const j12 = -R * K;
  const j21 = M * T + alpha * (beta1 / P + beta4 * R * T / ((1 + K) ** 2));
  const j22 = M * K - S - D + alpha * (beta3 / ((1 + T) ** 2) - beta4 * R / (1 + K));
  return {
    jacobian: [[j11, j12], [j21, j22]],
    trace: j11 + j22,
    determinant: j11 * j22 - j12 * j21,
    residual: Math.hypot(rhs.dK, rhs.dT),
  };
}

/**
 * Dormand–Prince embedded RK5(4), adaptive relative/absolute error control.
 * Output times are fixed, but internal accepted/rejected steps are adaptive.
 * Relative tolerance = settings.tolerance; absolute tolerance = tolerance/1000.
 * W is held fixed for this experiment, not modeled as an endogenous variable.
 */
export function simulateCodex(parameters: CodexParameters, settings: SimulationSettings): SimulationResult {
  assertParameters(parameters);
  assertSettings(settings);
  const p = { ...parameters };
  const s = { ...settings };
  const samples: Sample[] = [];
  let t = 0;
  let state: State = [s.initialK, s.initialT];
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let evaluations = 0;
  let h = Math.min(s.duration / OUTPUT_INTERVALS, 0.01);
  let outputIndex = 1;
  let lastProblem = 'requested error tolerance';
  const evaluate = (candidate: State): Derivative => {
    if (evaluations >= MAX_EVALUATIONS) throw new Error('Derivative evaluation budget exhausted.');
    evaluations++;
    return derivative(p, candidate[0], candidate[1]);
  };
  let currentDerivative = evaluate(state);
  if (!Object.values(currentDerivative).every(Number.isFinite)) {
    throw new RangeError('Initial derivative is non-finite; the supplied parameters and state exceed the numerical range.');
  }
  const record = () => samples.push({ t, K: state[0], T: state[1], ...currentDerivative });
  const finish = (status: SimulationResult['status'], reason: string): SimulationResult => {
    // Include the final accepted state on an interrupted output interval.
    if (samples.at(-1)?.t !== t) record();
    return { parameters: p, settings: s, samples, status, reason, acceptedSteps, rejectedSteps, modelVersion: MODEL_VERSION };
  };
  record();

  // Each stage is checked BEFORE derivative evaluation. A rejected stage changes
  // only h; it never changes the accepted state or clips it to an allowed value.
  const combine = (step: number, terms: readonly (readonly [number, Derivative])[]): State => [
    state[0] + step * terms.reduce((sum, [weight, rhs]) => sum + weight * rhs.dK, 0),
    state[1] + step * terms.reduce((sum, [weight, rhs]) => sum + weight * rhs.dT, 0),
  ];
  const tryStage = (candidate: State): Derivative | null => {
    const problem = stateProblem(candidate[0], candidate[1]);
    if (problem) { lastProblem = problem; return null; }
    const result = evaluate(candidate);
    if (!Object.values(result).every(Number.isFinite)) { lastProblem = 'non-finite derivative'; return null; }
    return result;
  };

  while (outputIndex <= OUTPUT_INTERVALS) {
    if (acceptedSteps + rejectedSteps >= MAX_ATTEMPTS) return finish('contained', 'Adaptive solver step budget exhausted; partial trajectory retained.');
    // Reserve the six new derivative evaluations needed for a full RK trial.
    // The first stage is cached from the last accepted step (FSAL property).
    if (evaluations + 6 > MAX_EVALUATIONS) return finish('contained', 'Adaptive solver derivative budget exhausted; partial trajectory retained.');
    const target = outputIndex === OUTPUT_INTERVALS ? s.duration : s.duration * outputIndex / OUTPUT_INTERVALS;
    const remaining = target - t;
    const boundarySlack = Number.EPSILON * Math.max(1, Math.abs(target)) * 16;
    const step = h >= remaining - boundarySlack ? remaining : h;
    const minimumStep = Math.max(1e-14, Number.EPSILON * Math.max(1, Math.abs(t)) * 16);
    if (!Number.isFinite(step) || step < minimumStep || t + step === t) {
      return finish('contained', `Adaptive step cannot be reduced safely near the ${lastProblem}; no state was clamped.`);
    }
    const k1 = currentDerivative;
    const k2 = tryStage(combine(step, [[1 / 5, k1]]));
    const k3 = k2 && tryStage(combine(step, [[3 / 40, k1], [9 / 40, k2]]));
    const k4 = k3 && tryStage(combine(step, [[44 / 45, k1], [-56 / 15, k2!], [32 / 9, k3]]));
    const k5 = k4 && tryStage(combine(step, [[19372 / 6561, k1], [-25360 / 2187, k2!], [64448 / 6561, k3!], [-212 / 729, k4]]));
    const k6 = k5 && tryStage(combine(step, [[9017 / 3168, k1], [-355 / 33, k2!], [46732 / 5247, k3!], [49 / 176, k4!], [-5103 / 18656, k5]]));
    const fifth = k6 && combine(step, [[35 / 384, k1], [500 / 1113, k3!], [125 / 192, k4!], [-2187 / 6784, k5!], [11 / 84, k6]]);
    const k7 = fifth && tryStage(fifth);
    if (!k7 || !fifth) {
      rejectedSteps++;
      h = step * 0.2;
      continue;
    }
    const fourth = combine(step, [[5179 / 57600, k1], [7571 / 16695, k3!], [393 / 640, k4!], [-92097 / 339200, k5!], [187 / 2100, k6!], [1 / 40, k7]]);
    const absoluteTolerance = s.tolerance / 1000;
    const error = Math.max(
      Math.abs(fifth[0] - fourth[0]) / (absoluteTolerance + s.tolerance * Math.max(Math.abs(state[0]), Math.abs(fifth[0]))),
      Math.abs(fifth[1] - fourth[1]) / (absoluteTolerance + s.tolerance * Math.max(Math.abs(state[1]), Math.abs(fifth[1]))),
    );
    if (!Number.isFinite(error) || error > 1) {
      rejectedSteps++;
      lastProblem = 'requested error tolerance';
      h = step * (Number.isFinite(error) ? Math.max(0.1, Math.min(0.5, 0.9 * error ** -0.2)) : 0.1);
      continue;
    }
    state = fifth;
    currentDerivative = k7;
    // A boundary-limited step mathematically ends at target; assign that same
    // time exactly to avoid spurious machine-precision tail steps.
    t = step === remaining ? target : t + step;
    acceptedSteps++;
    h = step * (error === 0 ? 5 : Math.max(0.2, Math.min(5, 0.9 * error ** -0.2)));
    if (t === target) {
      record();
      outputIndex++;
    }
  }
  return finish('completed', 'Requested horizon completed with adaptive error control. W was fixed; this numerical trajectory is not a stability proof.');
}
