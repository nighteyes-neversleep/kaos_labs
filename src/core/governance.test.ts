import { describe, expect, it } from 'vitest';
import { appendAudit, canonicalize, evaluateProposal, LOCAL_POLICY, QUORUM, verifyAudit, type Proposal } from './governance';

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'local-artifact-1', title: 'Draft a family checklist', intent: 'Create a local sandbox artifact',
  volatility: 0.1, harmProbability: 0, harmSeverity: 0, reversible: true,
  evidence: 'Local synthetic inputs; artifact stays on this device.', operator: 'Test operator', ...overrides,
});

describe('local governance decisions', () => {
  it('never substitutes low risk for human authorization', () => {
    const decision = evaluateProposal(proposal());
    expect(decision.region).toBe('safe');
    expect(decision.outcome).toBe('review');
    expect(decision.trace.join(' ')).toContain('human authorization');
    expect(decision.trace.join(' ')).toContain('proof is not implemented');
    expect(LOCAL_POLICY.posture).toContain('Provisional');
  });

  it('fails closed for missing evidence, identity, and malformed inputs', () => {
    for (const invalid of [
      proposal({ evidence: ' ' }), proposal({ operator: '' }), proposal({ title: '' }),
      proposal({ volatility: Number.NaN }), proposal({ harmProbability: -0.1 }),
      proposal({ harmSeverity: 1.01 }), proposal({ reversible: 'yes' as unknown as boolean }),
      null as unknown as Proposal,
    ]) expect(evaluateProposal(invalid).outcome).toBe('abstain');
  });

  it('does not let missing evidence or invalid fields conceal a known critical signal', () => {
    for (const input of [
      proposal({ volatility: 1, evidence: '' }),
      proposal({ volatility: .75, harmProbability: Number.NaN }),
      proposal({ volatility: Number.NaN, harmProbability: 1, harmSeverity: .5 }),
      proposal({ operator: '', harmProbability: .8, harmSeverity: 1 }),
    ]) {
      const decision = evaluateProposal(input);
      expect(decision.outcome).toBe('contained');
      expect(decision.region).toBe('red');
      expect(decision.trace.join(' ')).toContain('human clearance');
    }
  });

  it('enforces exact provisional WACV region boundaries', () => {
    expect([0, .249, .25, .499, .5, .749, .75, 1].map(volatility =>
      evaluateProposal(proposal({ volatility })).region,
    )).toEqual(['safe', 'safe', 'warn', 'warn', 'guard', 'guard', 'red', 'red']);
    expect(evaluateProposal(proposal({ volatility: .75 })).outcome).toBe('contained');
  });

  it('contains high projected harm regardless of WACV and guards irreversibility', () => {
    expect(evaluateProposal(proposal({ harmProbability: .5, harmSeverity: 1 })).outcome).toBe('contained');
    expect(evaluateProposal(proposal({ harmProbability: .2, harmSeverity: 1 })).region).toBe('guard');
    expect(evaluateProposal(proposal({ reversible: false })).region).toBe('guard');
  });

  it('makes latency monotone and bounded for every valid WACV input', () => {
    const latencies = Array.from({ length: 101 }, (_, i) => evaluateProposal(proposal({ volatility: i / 100 })).tauMs);
    expect(latencies[0]).toBe(250);
    expect(latencies.at(-1)).toBe(5000);
    expect(latencies.every((value, i) => i === 0 || value >= latencies[i - 1])).toBe(true);
  });

  it('snapshots the proposal so later form edits cannot rewrite a review', () => {
    const input = proposal();
    const decision = evaluateProposal(input);
    input.volatility = 1;
    input.title = 'Changed';
    expect(decision.proposal.title).toBe('Draft a family checklist');
    expect(decision.proposal.volatility).toBe(.1);
  });

  it('preserves the fixed noncommutative Wise Quorum order', () => {
    expect(QUORUM.map(member => member.name)).toEqual([
      'Marcus Aurelius', 'Gandhi', 'Sun Tzu', 'Socrates', 'Michelangelo', 'King Solomon',
    ]);
    expect(QUORUM[5].perspective).toContain('Final arbiter');
  });
});

describe('Canonization Chain local tamper evidence', () => {
  it('appends linked records without mutating earlier chain values', async () => {
    const first = await appendAudit([], 'proposal.reviewed', { b: 2, a: 1 });
    const second = await appendAudit(first, 'human.authorized', { decisionId: 'local-artifact-1' });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[1].previousHash).toBe(second[0].hash);
    expect(second.map(entry => entry.sequence)).toEqual([1, 2]);
    expect(await verifyAudit(second)).toBe(true);
  });

  it('detects detail tampering, event changes, missing middle records and reordering', async () => {
    let chain = await appendAudit([], 'first', { intent: 'original' });
    chain = await appendAudit(chain, 'second', {});
    chain = await appendAudit(chain, 'third', {});
    const altered = structuredClone(chain);
    altered[0].detail = { intent: 'tampered' };
    expect(await verifyAudit(altered)).toBe(false);
    expect(await verifyAudit([{ ...chain[0], event: 'forged' }, ...chain.slice(1)])).toBe(false);
    expect(await verifyAudit([chain[0], chain[2]])).toBe(false);
    expect(await verifyAudit([chain[1], chain[0], chain[2]])).toBe(false);
    await expect(appendAudit(altered, 'fourth', {})).rejects.toThrow('integrity failed');
  });

  it('canonicalizes key order and refuses values JSON would silently change', () => {
    expect(canonicalize({ b: [3, { z: 1, a: 2 }], a: 'x' })).toBe(canonicalize({ a: 'x', b: [3, { a: 2, z: 1 }] }));
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), { missing: undefined }, [undefined], Array(1)]) {
      expect(() => canonicalize(value)).toThrow();
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalize(cycle)).toThrow('cycles');
  });

  it('binds appended details to their original snapshot', async () => {
    const detail = { title: 'original' };
    const pending = appendAudit([], 'proposal', detail);
    detail.title = 'changed';
    const chain = await pending;
    expect(chain[0].detail).toEqual({ title: 'original' });
    expect(await verifyAudit(chain)).toBe(true);
  });

  it('rejects invalid event names and malformed entry metadata', async () => {
    await expect(appendAudit([], ' ', {})).rejects.toThrow('Audit event');
    const chain = await appendAudit([], 'proposal', {});
    expect(await verifyAudit([{ ...chain[0], sequence: 2 }])).toBe(false);
    expect(await verifyAudit([{ ...chain[0], timestamp: 'not-a-time' }])).toBe(false);
    expect(await verifyAudit([{ ...chain[0], extra: true } as typeof chain[0]])).toBe(false);
  });
});
