/**
 * Local OMI governance workbench, informed by the master whitepaper chapters 3–5.
 * These provisional numeric thresholds are implementation policy, not validated
 * WACV measurements, an alignment proof, or certification of real-world safety.
 * The only executable target is a separately authorized local sandbox artifact.
 */
export type Proposal = {
  id: string;
  title: string;
  intent: string;
  volatility: number;
  harmProbability: number;
  harmSeverity: number;
  reversible: boolean;
  evidence: string;
  operator: string;
};

export type Decision = {
  proposal: Proposal;
  region: 'safe' | 'warn' | 'guard' | 'red';
  wacv: number;
  tauMs: number;
  outcome: 'review' | 'contained' | 'abstain';
  reasons: string[];
  trace: string[];
  createdAt: string;
};

export const LOCAL_POLICY = Object.freeze({
  posture: 'Provisional local policy; not validated scientific thresholds',
  warnAt: 0.25,
  guardAt: 0.5,
  containAt: 0.75,
  harmGuardAt: 0.2,
  harmContainAt: 0.5,
  minimumLatencyMs: 250,
  latencyRangeMs: 4750,
});

export const QUORUM = Object.freeze([
  Object.freeze({ name: 'Marcus Aurelius', perspective: 'Stoic discipline, long-term thinking, personal accountability' }),
  Object.freeze({ name: 'Gandhi', perspective: 'Nonviolence, moral courage, equity of consequence' }),
  Object.freeze({ name: 'Sun Tzu', perspective: 'Strategic clarity, resource economy, adversarial awareness' }),
  Object.freeze({ name: 'Socrates', perspective: 'Epistemic humility, rigorous questioning, examined assumptions' }),
  Object.freeze({ name: 'Michelangelo', perspective: 'Creative integrity, craft, the cost of excellence' }),
  Object.freeze({ name: 'King Solomon', perspective: 'Final arbiter after the five-voice review; wisdom, equity, and sovereign judgment' }),
]);

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const fieldLimits = { id: 128, title: 200, intent: 4000, evidence: 8000, operator: 200 } as const;

export function evaluateProposal(input: Proposal): Decision {
  const record = input && typeof input === 'object' ? input as Partial<Proposal> : {};
  const invalid: string[] = [];
  const text = {} as Pick<Proposal, keyof typeof fieldLimits>;
  for (const [key, maximum] of Object.entries(fieldLimits) as [keyof typeof fieldLimits, number][]) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
      invalid.push(`${key} must be nonempty text of at most ${maximum} characters`);
      text[key] = typeof value === 'string' ? value.trim().slice(0, maximum) : '';
    } else {
      text[key] = value.trim();
    }
  }
  for (const key of ['volatility', 'harmProbability', 'harmSeverity'] as const) {
    if (!isUnit(record[key])) invalid.push(`${key} must be a finite number from 0 to 1`);
  }
  if (typeof record.reversible !== 'boolean') invalid.push('reversible must be a boolean');

  // Snapshot primitives so later edits to the form cannot rewrite this decision.
  const proposal: Proposal = {
    ...text,
    volatility: isUnit(record.volatility) ? record.volatility : 1,
    harmProbability: isUnit(record.harmProbability) ? record.harmProbability : 1,
    harmSeverity: isUnit(record.harmSeverity) ? record.harmSeverity : 1,
    reversible: record.reversible === true,
  };
  const wacv = proposal.volatility;
  const tauMs = LOCAL_POLICY.minimumLatencyMs + Math.ceil(wacv * LOCAL_POLICY.latencyRangeMs);
  const createdAt = new Date().toISOString();
  if (invalid.length) {
    // Incomplete evidence must never hide an independently supplied critical
    // risk signal or turn a containment event into an ordinary abstention.
    const criticalSignal = (isUnit(record.volatility) && record.volatility >= LOCAL_POLICY.containAt)
      || (isUnit(record.harmProbability) && isUnit(record.harmSeverity)
        && record.harmProbability * record.harmSeverity >= LOCAL_POLICY.harmContainAt);
    return {
      proposal, region: 'red', wacv, tauMs, outcome: criticalSignal ? 'contained' : 'abstain', createdAt,
      reasons: criticalSignal ? [...invalid, 'A supplied critical risk signal requires containment even when other fields are invalid.'] : invalid,
      trace: ['Pandora: incomplete or invalid proposal rejected.', criticalSignal
        ? 'eKernel: critical risk contained; human clearance and a corrected proposal are required.'
        : 'eKernel: promotion blocked; correct the proposal before review.'],
    };
  }

  const harm = proposal.harmProbability * proposal.harmSeverity;
  let region: Decision['region'] = wacv >= LOCAL_POLICY.containAt ? 'red'
    : wacv >= LOCAL_POLICY.guardAt ? 'guard'
      : wacv >= LOCAL_POLICY.warnAt ? 'warn' : 'safe';
  const reasons: string[] = [];
  if (harm >= LOCAL_POLICY.harmContainAt) {
    region = 'red';
    reasons.push('Jiminy Cricket: estimated downstream harm reaches the local containment threshold.');
  } else if (harm >= LOCAL_POLICY.harmGuardAt && region !== 'red') {
    region = 'guard';
    reasons.push('Jiminy Cricket: estimated downstream harm requires restricted review.');
  }
  if (!proposal.reversible) {
    if (region === 'safe' || region === 'warn') region = 'guard';
    reasons.push('Jiminy Cricket: this action is not reversible; a mitigation pathway requires human review.');
  }
  if (wacv >= LOCAL_POLICY.containAt) reasons.push('Dragon Guardian: WACV proxy reaches the local containment threshold.');
  else if (wacv >= LOCAL_POLICY.guardAt) reasons.push('Dragon Guardian: elevated WACV proxy requires restricted review.');
  else if (wacv >= LOCAL_POLICY.warnAt) reasons.push('Dragon Guardian: WACV proxy requires corrective review.');
  else reasons.push('Dragon Guardian: WACV proxy is within the local safe region.');
  reasons.push('Taipan Guardian: evidence is supplied, but cryptographic semantic alignment is unproven.');
  reasons.push('Human authorization is required; no real-world action is executed by this workbench.');

  const outcome = region === 'red' ? 'contained' : 'review';
  return {
    proposal, region, wacv, tauMs, outcome, createdAt, reasons,
    trace: [
      'Pandora: normalized the proposal and checked required evidence.',
      `Dragon Guardian: operator-supplied WACV proxy ${wacv.toFixed(3)}; provisional tau_network ${tauMs} ms.`,
      `Jiminy Cricket: estimated harm score ${(harm * 100).toFixed(1)}/100; reversible ${proposal.reversible ? 'yes' : 'no'}.`,
      'Taipan Guardian: cryptographic alignment proof is not implemented; human review remains mandatory.',
      'Canonization Chain: caller must append and verify this decision before any sandbox artifact.',
      outcome === 'contained'
        ? 'eKernel: local promotion contained; no sandbox artifact may be executed.'
        : 'Wise Quorum: await five-voice review, Solomon arbitration, and explicit human authorization.',
    ],
  };
}

/** JSON-only canonical serialization; rejects lossy values rather than hiding them. */
export function canonicalize(value: unknown): string {
  const active = new Set<object>();
  const walk = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object') throw new TypeError('Audit details must contain only JSON values');
    if (active.has(item)) throw new TypeError('Audit details cannot contain cycles');
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const parts: string[] = [];
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw new TypeError('Sparse arrays are not valid audit details');
        parts.push(walk(item[i]));
      }
      result = `[${parts.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Audit details must use plain objects');
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys are not valid audit details');
      const object = item as Record<string, unknown>;
      result = `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${walk(object[key])}`).join(',')}}`;
    }
    active.delete(item);
    return result;
  };
  return walk(value);
}

export type AuditEntry = {
  sequence: number;
  previousHash: string;
  hash: string;
  timestamp: string;
  event: string;
  detail: unknown;
};

const GENESIS = '0'.repeat(64);
const hashPattern = /^[a-f0-9]{64}$/;
const auditKeys = ['detail', 'event', 'hash', 'previousHash', 'sequence', 'timestamp'];
const eventIsValid = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`omi.canonization.v1\0${canonicalize(value)}`);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies the supplied local chain. Without an externally anchored head, a
 * rewritten or truncated whole chain cannot be distinguished from an older one.
 * This is tamper evidence, not immutable storage or an ethical-truth proof.
 */
export async function verifyAudit(chain: AuditEntry[]): Promise<boolean> {
  if (!Array.isArray(chain)) return false;
  try {
    let previousHash = GENESIS;
    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      if (!entry || Object.keys(entry).sort().join(',') !== auditKeys.join(',')) return false;
      if (entry.sequence !== i + 1 || entry.previousHash !== previousHash || !hashPattern.test(entry.hash)) return false;
      if (!eventIsValid(entry.event) || typeof entry.timestamp !== 'string') return false;
      const time = new Date(entry.timestamp);
      if (!Number.isFinite(time.getTime()) || time.toISOString() !== entry.timestamp) return false;
      const { hash, ...unsigned } = entry;
      if (await digest(unsigned) !== hash) return false;
      previousHash = hash;
    }
    return true;
  } catch {
    return false;
  }
}

export async function appendAudit(chain: AuditEntry[], event: string, detail: unknown): Promise<AuditEntry[]> {
  // Snapshot before the first await so concurrent mutation cannot replace the
  // verified prefix or change what was requested for inclusion in the record.
  const snapshot = JSON.parse(canonicalize(chain)) as AuditEntry[];
  const frozenDetail = JSON.parse(canonicalize(detail)) as unknown;
  if (!eventIsValid(event)) throw new TypeError('Audit event must be nonempty text of at most 128 characters');
  if (!await verifyAudit(snapshot)) throw new Error('Canonization Chain integrity failed; append refused');
  const unsigned = {
    sequence: snapshot.length + 1,
    previousHash: snapshot.at(-1)?.hash ?? GENESIS,
    timestamp: new Date().toISOString(),
    event,
    detail: frozenDetail,
  };
  const hash = await digest(unsigned);
  return [...snapshot, { ...unsigned, hash }];
}
