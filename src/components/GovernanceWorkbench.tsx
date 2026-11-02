import { useEffect, useRef, useState } from 'react';
import { appendAudit, canonicalize, evaluateProposal, verifyAudit, QUORUM, type Proposal, type Decision, type AuditEntry } from '../core/governance';
import { Icon } from './Icons';

type Props = { operator: string; chain: AuditEntry[]; onChainChange: (chain: AuditEntry[]) => Promise<void>; view?: 'workbench' | 'ledger' };
type FocusTarget = 'decision' | 'containment' | 'review' | 'authorization' | 'completion' | 'proposal';
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function prettyEvent(event: string) { return event.replaceAll('-', ' ').replaceAll('_', ' '); }

export default function GovernanceWorkbench({ operator, chain, onChainChange, view = 'workbench' }: Props) {
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [evidence, setEvidence] = useState('');
  const [volatility, setVolatility] = useState(.15);
  const [probability, setProbability] = useState(.1);
  const [severity, setSeverity] = useState(.1);
  const [reversible, setReversible] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [valid, setValid] = useState<boolean | null>(null);
  const [clearReason, setClearReason] = useState('');
  const [remaining, setRemaining] = useState(0);
  const [complete, setComplete] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const decisionHeading = useRef<HTMLHeadingElement>(null);
  const containmentHeading = useRef<HTMLHeadingElement>(null);
  const reviewInput = useRef<HTMLTextAreaElement>(null);
  const authorizationInput = useRef<HTMLInputElement>(null);
  const completionHeading = useRef<HTMLHeadingElement>(null);
  const proposalInput = useRef<HTMLInputElement>(null);
  const chainRef = useRef(chain);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const lastContainment = [...chain].reverse().find(entry => entry.event === 'containment' || entry.event === 'containment-cleared');
  const contained = lastContainment?.event === 'containment';
  const lastArtifact = [...chain].reverse().find(entry => entry.event === 'artifact-created');

  useEffect(() => {
    if (busy || !focusTarget || view !== 'workbench') return;
    const targets = {
      decision: decisionHeading.current,
      containment: containmentHeading.current,
      review: reviewInput.current,
      authorization: authorizationInput.current,
      completion: completionHeading.current,
      proposal: proposalInput.current,
    };
    targets[focusTarget]?.focus();
    setFocusTarget(null);
  }, [busy, focusTarget, view]);
  useEffect(() => { setAnnouncement(''); setFocusTarget(null); }, [view]);

  useEffect(() => {
    chainRef.current = chain;
    let active = true;
    verifyAudit(chain).then(result => { if (active) setValid(result); }).catch(() => { if (active) setValid(false); });
    return () => { active = false; };
  }, [chain]);
  useEffect(() => {
    if (!decision) return;
    const update = () => setRemaining(Math.max(0, new Date(decision.createdAt).getTime() + decision.tauMs - Date.now()));
    update(); const timer = setInterval(update, 100); return () => clearInterval(timer);
  }, [decision]);
  async function record(event: string, detail: unknown) {
    if (!mountedRef.current) throw new Error('The governance session was closed.');
    const next = await appendAudit(chainRef.current, event, detail);
    if (!mountedRef.current) throw new Error('The governance session was closed.');
    await onChainChange(next);
    if (!mountedRef.current) throw new Error('The governance session was closed.');
    chainRef.current = next; return next;
  }
  async function evaluate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    setAnnouncement('Evaluating the proposal and saving its decision to your encrypted capsule.');
    try {
      if (contained) throw new Error('eKernel containment is active. A human clearance is required before evaluating another action.');
      if (!(await verifyAudit(chainRef.current))) throw new Error('The audit chain failed verification. Execution is blocked.');
      const proposal: Proposal = { id: crypto.randomUUID(), title: title.trim(), intent: intent.trim(), evidence: evidence.trim(), volatility, harmProbability: probability, harmSeverity: severity, reversible, operator };
      const result = evaluateProposal(proposal);
      await record(result.outcome === 'contained' ? 'containment' : 'proposal-evaluated', { decision: result, policy: 'local-prototype-v1', inputSource: 'human-supplied' });
      setDecision(result); setNotes([]); setReviewNote(''); setAuthorize(false); setComplete(false);
      setAnnouncement(result.outcome === 'contained'
        ? `Decision saved. ${result.proposal.title} entered the red region. eKernel containment is active; human clearance is required.`
        : result.outcome === 'abstain'
          ? `Decision saved. OMI abstained from ${result.proposal.title}. Read the guardian reasons and correct the proposal.`
          : `Decision saved. ${result.proposal.title} is in the ${result.region} region. Review is required, beginning with Marcus Aurelius, step 1 of ${QUORUM.length}.`);
      setFocusTarget(result.outcome === 'contained' ? 'containment' : 'decision');
    } catch (e) { setAnnouncement(''); setError(e instanceof Error ? e.message : 'Could not evaluate this proposal.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function review() {
    if (!decision || reviewNote.trim().length < 8) return;
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    setAnnouncement(`Saving the ${QUORUM[notes.length]?.name ?? ''} review to your encrypted capsule.`);
    try {
      const member = QUORUM[notes.length];
      if (!member || contained || decision.outcome !== 'review') throw new Error('This action cannot proceed to review.');
      await record('quorum-review', { proposalId: decision.proposal.id, perspective: member.name, note: reviewNote.trim(), operator, kind: 'manual-human-review' });
      setNotes(current => [...current, reviewNote.trim()]); setReviewNote('');
      const nextMember = QUORUM[notes.length + 1];
      setAnnouncement(nextMember
        ? `${member.name} review saved to your encrypted capsule and Canonization Chain. Next: ${nextMember.name}, step ${notes.length + 2} of ${QUORUM.length}.`
        : 'King Solomon review saved to your encrypted capsule and Canonization Chain. All six perspectives are recorded. Explicit human authorization is now required to create the local artifact.');
      setFocusTarget(nextMember ? 'review' : 'authorization');
    } catch (e) { setAnnouncement(''); setError(e instanceof Error ? e.message : 'Review could not be saved.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function createArtifact() {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    setAnnouncement('Recording your human authorization and local artifact before requesting its download.');
    try {
      if (!decision || decision.outcome !== 'review' || notes.length !== QUORUM.length || !authorize || contained || complete) throw new Error('Complete all governance gates first.');
      if (Date.now() < new Date(decision.createdAt).getTime() + decision.tauMs) throw new Error('The Dragon latency window is still active.');
      if (!(await verifyAudit(chainRef.current))) throw new Error('The audit chain failed verification. Artifact creation is blocked.');
      const attestation = { proposalId: decision.proposal.id, operator, reviews: QUORUM.map((q, i) => ({ perspective: q.name, note: notes[i] })), authorization: 'Explicit human authorization for a local JSON artifact only; not a cryptographic proof of semantic alignment.' };
      await record('human-authorized', attestation);
      const output = { title: decision.proposal.title, intent: decision.proposal.intent, evidence: decision.proposal.evidence, execution: 'local-json-artifact-only' };
      const artifactId = crypto.randomUUID();
      const next = await record('artifact-created', { artifactId, proposalId: decision.proposal.id, output, stableCheckpoint: true });
      const unsignedArtifact = {
        Bundle_ID: artifactId, Timestamp: next.at(-1)!.timestamp, Audit_Head: next.at(-1)!.hash,
        Manifest_ID: 'omi-client/manifest.json@0.1.0', Intent_Data: decision.proposal,
        Governance_State: { region: decision.region, wacv: decision.wacv, tau_network_ms: decision.tauMs, outcome: 'human-authorized-local-artifact', policy: 'local-prototype-v1', measured: false },
        Intervention_Trace: { guardians: decision.trace, humanAttestation: attestation, auditSequence: next.at(-1)!.sequence }, Output_Summary: output,
      };
      if (!mountedRef.current) throw new Error('The governance session was closed.');
      const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalize(unsignedArtifact)));
      const integrityHash = Array.from(new Uint8Array(hashBytes), byte => byte.toString(16).padStart(2, '0')).join('');
      const artifact = { ...unsignedArtifact, Integrity_Hash: integrityHash };
      if (!mountedRef.current) throw new Error('The governance session was closed.');
      download(artifact, `omi-bundle-${artifactId}.json`); setComplete(true);
      setAnnouncement(`Local artifact created and recorded in your encrypted capsule. Download requested: omi-bundle-${artifactId}.json. No external action was executed.`);
      setFocusTarget('completion');
    } catch (e) { setAnnouncement(''); setError(e instanceof Error ? e.message : 'Artifact creation failed.'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function clearContainment() {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    setAnnouncement('Saving your human clearance to the Canonization Chain.');
    try {
      if (clearReason.trim().length < 12) throw new Error('Explain the human clearance in at least 12 characters.');
      await record('containment-cleared', { operator, reason: clearReason.trim(), restoredCheckpoint: lastArtifact?.hash ?? null, effect: 'local workbench authorization only; no external system rollback' });
      setDecision(null); setClearReason('');
      setAnnouncement('Human clearance saved to your encrypted capsule and Canonization Chain. Local containment is cleared. Define and evaluate a new proposal before review can resume.');
      setFocusTarget('proposal');
    } catch (e) { setAnnouncement(''); setError(e instanceof Error ? e.message : 'Clearance could not be recorded.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  const proposalGate = busy
    ? 'A governance record is being saved. Wait for the result before evaluating again.'
    : contained
      ? 'Evaluation is blocked while eKernel containment is active. Record a human clearance above first.'
      : valid === false
        ? 'Evaluation is blocked because the audit chain failed integrity verification.'
        : 'The decision must be saved to your encrypted capsule before review can begin.';
  const artifactGates = [
    ...(busy ? ['A governance record is being saved.'] : []),
    ...(!authorize ? ['Select the human authorization checkbox to permit this local artifact.'] : []),
    ...(remaining > 0 ? [`The Dragon delay is active; ${Math.ceil(remaining / 1000)} seconds remain.`] : []),
    ...(valid !== true ? ['The audit chain must finish verification successfully.'] : []),
  ];
  const artifactGate = complete
    ? 'The artifact has been recorded and its download requested. Evaluate a new proposal to create another artifact.'
    : artifactGates.length
      ? artifactGates.join(' ')
      : 'All local gates are satisfied. You may create and download this JSON artifact.';

  if (view === 'ledger') return <section className="page-enter" aria-labelledby="canonization-heading">
    <div className="section-heading">
      <div><span className="eyebrow">THE FLIGHT RECORDER</span><h1 id="canonization-heading">Canonization Chain</h1><p>Every decision, linked to the one before it.</p></div>
      <button className="button secondary" onClick={() => { download(chain, 'omi-canonization-chain.json'); setAnnouncement('Canonization Chain download requested: omi-canonization-chain.json.'); }} disabled={!chain.length}>
        <Icon name="download"/>Export chain
      </button>
    </div>
    <p className="fine-print" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    <div className="ledger-summary panel">
      <div className="orb-icon small"><Icon name="chain" size={25}/></div>
      <div><strong>{chain.length} audit {chain.length === 1 ? 'record' : 'records'}</strong><p>Encrypted inside your Personal Capsule.</p></div>
      <span className={`badge ${valid === false ? 'danger' : 'green'}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="status-dot" aria-hidden="true"/>{valid === null ? 'Verifying audit chain' : valid ? 'Chain verified' : 'Audit integrity failure'}
      </span>
    </div>
    <p className="fine-print">Local SHA-256 links reveal changes to existing records. This browser ledger is tamper-evident, not externally anchored or immutable. An attacker who rewrites the full local history can create a new chain.</p>
    {!chain.length
      ? <div className="empty-state panel"><Icon name="chain" size={36}/><h2>A clear beginning.</h2><p>Evaluate your first proposal in Governance to start the chain. Export becomes available after the first record is saved.</p></div>
      : <div className="ledger-list">{[...chain].reverse().map(entry => <details className="panel ledger-entry" key={entry.hash}>
          <summary>
            <span className="ledger-number">{String(entry.sequence).padStart(2,'0')}</span>
            <span><strong>{prettyEvent(entry.event)}</strong><small>{new Date(entry.timestamp).toLocaleString()}</small></span>
            <code>{entry.hash.slice(0,14)}…</code><span className="expand-mark" aria-hidden="true">+</span>
          </summary>
          <pre>{JSON.stringify(entry, null, 2)}</pre>
        </details>)}</div>}
  </section>;

  return <section className="page-enter" aria-labelledby="governance-heading">
    <div className="section-heading"><div><span className="eyebrow">INTENT → GOVERNANCE → ARTIFACT</span><h1 id="governance-heading">The governance workbench</h1><p>Explore freely. Act deliberately.</p></div><span className="badge purple">Local prototype policy</span></div>
    <div className="notice"><Icon name="info"/><p>Risk values are supplied by you. This workbench records structured human review and creates local JSON artifacts. It does not certify safety, prove semantic alignment, or execute external actions.</p></div>
    <p className="fine-print" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {valid === false && <div className="error-banner" role="alert">Audit integrity verification failed. Governance is locked.</div>}
    {contained && <div className="containment panel" role="region" aria-labelledby="containment-heading">
      <Icon name="shield" size={30}/><div>
        <h2 id="containment-heading" ref={containmentHeading} tabIndex={-1} aria-describedby="containment-explanation">eKernel containment is active</h2>
        <p id="containment-explanation">The previous proposal entered the red region. Promotion is frozen until a human records a clearance. The last local artifact remains available in your ledger.</p>
        <label htmlFor="clearance">Human clearance reason</label>
        <p className="fine-print" id="clearance-help">Explain what changed and why local review may resume. Use 12 to 2,000 characters. Recording clearance saves it to your encrypted capsule and permits a new proposal; it does not authorize an artifact.</p>
        <textarea id="clearance" aria-describedby="clearance-help" value={clearReason} onChange={e=>setClearReason(e.target.value)} maxLength={2000} placeholder="What changed, and why can local review resume?"/>
        <button className="button secondary" aria-describedby="clearance-help" disabled={busy || clearReason.trim().length < 12 || valid === false} onClick={clearContainment}>Record clearance & resume</button>
      </div>
    </div>}
    <div className="governance-layout">
      <form className="panel proposal-form" onSubmit={evaluate} aria-labelledby="proposal-heading" aria-busy={busy}>
        <div className="panel-title"><span className="step-number" aria-hidden="true">01</span><div><h2 id="proposal-heading">Define the intent</h2><p>Pandora · normalized action input</p></div></div>
        <label htmlFor="proposal-title">Action title</label><input id="proposal-title" ref={proposalInput} required maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="What would you like to do?"/>
        <label htmlFor="proposal-intent">Intended outcome</label>
        <p className="fine-print" id="proposal-intent-help">Describe the action, who it affects, and the outcome you want. Required; up to 4,000 characters.</p>
        <textarea id="proposal-intent" aria-describedby="proposal-intent-help" required maxLength={4000} value={intent} onChange={e=>setIntent(e.target.value)} placeholder="Describe the action, who it affects, and the outcome you want."/>
        <label htmlFor="proposal-evidence">Evidence & assumptions</label>
        <p className="fine-print" id="proposal-evidence-help">Record supporting evidence and make uncertainty explicit. Required; up to 6,000 characters.</p>
        <textarea id="proposal-evidence" aria-describedby="proposal-evidence-help" required maxLength={6000} value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="Add the evidence supporting this action. Make uncertainty explicit."/>
        <div className="range-field">
          <label htmlFor="volatility">Architectural volatility proxy <output aria-hidden="true">{Math.round(volatility*100)}%</output></label>
          <input id="volatility" type="range" min="0" max="1" step="0.01" value={volatility} aria-valuetext={`${Math.round(volatility*100)} percent`} aria-describedby="volatility-help" onChange={e=>setVolatility(Number(e.target.value))}/>
          <small id="volatility-help">Dragon input · supplied estimate, not measured WACV</small>
        </div>
        <div className="two-columns">
          <div className="range-field"><label htmlFor="harm-probability">Harm probability <output aria-hidden="true">{Math.round(probability*100)}%</output></label><input id="harm-probability" type="range" min="0" max="1" step="0.01" value={probability} aria-valuetext={`${Math.round(probability*100)} percent`} onChange={e=>setProbability(Number(e.target.value))}/></div>
          <div className="range-field"><label htmlFor="harm-severity">Harm severity <output aria-hidden="true">{Math.round(severity*100)}%</output></label><input id="harm-severity" type="range" min="0" max="1" step="0.01" value={severity} aria-valuetext={`${Math.round(severity*100)} percent`} onChange={e=>setSeverity(Number(e.target.value))}/></div>
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={reversible} onChange={e=>setReversible(e.target.checked)}/><span>The proposed outcome is reversible.</span></label>
        <button className="button primary full-width" type="submit" aria-describedby="proposal-gate" disabled={busy || contained || valid === false}>{busy ? 'Recording…' : 'Evaluate proposal'}<Icon name="arrow"/></button>
        <p className="fine-print" id="proposal-gate">{proposalGate}</p>
        <p className="fine-print">Local thresholds: safe &lt; 25%; warn &lt; 50%; guard &lt; 75%; red ≥ 75%. Harm and irreversibility can increase restriction. These are provisional implementation choices.</p>
      </form>
      <div className="review-column">
        {!decision ? <div className="panel awaiting-panel"><OmiFlow/><span className="eyebrow">READY WHEN YOU ARE</span><h2>Intent needs a checkpoint.</h2><p>Define an action to see Dragon’s risk region, Taipan’s review gate, and the path to a recorded artifact.</p><div className="mini-gates"><span>Risk</span><i/><span>Review</span><i/><span>Audit</span></div></div> : <>
          <div className="panel decision-panel" role="region" aria-labelledby="guardian-heading">
            <div className="panel-title"><span className="step-number" aria-hidden="true">02</span><div><h2 id="guardian-heading" ref={decisionHeading} tabIndex={-1} aria-describedby="decision-summary">Guardian checkpoint</h2><p>Dragon · Taipan · Jiminy Cricket</p></div><span className={`badge ${decision.region === 'red' ? 'danger' : decision.region === 'safe' ? 'green' : 'amber'}`}>{decision.region}</span></div>
            <p id="decision-summary">Recorded decision for “{decision.proposal.title}”. Result: {decision.outcome === 'review' ? 'human review required' : decision.outcome === 'contained' ? 'halted; human clearance required' : 'abstained; correct the proposal before review'}. This decision uses the submitted proposal; later form edits require a new evaluation.</p>
            <div className="decision-metrics"><div><span>Volatility proxy</span><strong>{Math.round(decision.wacv*100)}<small>%</small></strong></div><div><span>τ network</span><strong>{(decision.tauMs/1000).toFixed(2)}<small>s</small></strong></div><div><span>Result</span><strong className="outcome-text">{decision.outcome === 'review' ? 'Review' : decision.outcome === 'contained' ? 'Halted' : 'Abstain'}</strong></div></div>
            <ul className="reason-list" aria-label="Guardian decision reasons">{decision.reasons.map((reason,i)=><li key={i}>{reason}</li>)}</ul>
            <div className="audit-confirmation"><Icon name="chain" size={16}/>Decision saved to your encrypted capsule and Canonization Chain before promotion</div>
          </div>
          {decision.outcome === 'review' && !contained && <div className="panel quorum-panel" role="region" aria-labelledby="quorum-heading" aria-busy={busy}>
            <div className="panel-title"><span className="step-number" aria-hidden="true">03</span><div><h2 id="quorum-heading">Wise Quorum review</h2><p>One human. Six structured perspectives.</p></div></div>
            <p className="fine-print">{notes.length} of {QUORUM.length} perspectives saved. Reviews must follow this fixed order. King Solomon arbitrates after the first five perspectives; explicit human authorization follows.</p>
            <ol className="quorum-list" role="list" aria-label="Fixed Wise Quorum review order">{QUORUM.map((member,i)=>{
              const done = notes.length > i;
              const current = notes.length === i;
              return <li key={member.name} className={done ? 'done' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
                <span className="quorum-index" aria-hidden="true">{done ? <Icon name="check" size={13}/> : String(i+1).padStart(2,'0')}</span>
                <div>
                  <strong>{member.name}</strong><small>{member.perspective}</small>
                  <small>Step {i+1} of {QUORUM.length}: {done ? 'Completed and saved to the Canonization Chain.' : current ? 'Current perspective. Record your review below.' : 'Not started. Complete the preceding perspectives first.'}</small>
                  {done && <details><summary>Read saved {member.name} review</summary><p style={{overflowWrap:'anywhere'}}>{notes[i]}</p></details>}
                </div>
                {i===5 && <span className="tiny-label">ARBITER</span>}
              </li>;
            })}</ol>
            {notes.length < QUORUM.length ? <>
              <label htmlFor="review-note">Your {QUORUM[notes.length].name} review</label>
              <p className="fine-print" id="review-note-help">Current perspective, step {notes.length+1} of {QUORUM.length}: {QUORUM[notes.length].perspective}. Enter 8 to 4,000 characters. Record perspective saves this note to your encrypted capsule before moving to the next step.</p>
              <textarea id="review-note" ref={reviewInput} aria-describedby="review-note-help" maxLength={4000} value={reviewNote} onChange={e=>setReviewNote(e.target.value)} placeholder="Record your reasoning from this perspective. Minimum 8 characters."/>
              <button className="button secondary full-width" aria-describedby="review-note-help" disabled={busy || reviewNote.trim().length < 8} onClick={review}>Record perspective<Icon name="arrow"/></button>
            </> : <div className="human-authorization">
              <span className="eyebrow">FINAL HUMAN AUTHORITY</span>
              <h3 ref={completionHeading} tabIndex={-1} aria-describedby="artifact-gate">{complete ? 'Local artifact created and recorded.' : 'The decision is yours.'}</h3>
              <p>All six perspectives are saved. Authorize only the creation of this local artifact.</p>
              <label className="checkbox-label"><input ref={authorizationInput} type="checkbox" checked={authorize} onChange={e=>setAuthorize(e.target.checked)} disabled={complete} aria-describedby="artifact-gate"/><span>I authorize this local JSON artifact.</span></label>
              <button className="button primary full-width" aria-describedby="artifact-gate" disabled={busy || !authorize || remaining > 0 || complete || valid !== true} onClick={createArtifact}><Icon name={complete ? 'check' : 'download'}/>{complete ? 'Artifact created & recorded' : remaining > 0 ? `Dragon window · ${(remaining/1000).toFixed(1)}s` : 'Authorize & create artifact'}</button>
              <p className="fine-print" id="artifact-gate">{artifactGate}</p>
            </div>}
          </div>}
        </>}
      </div>
    </div>
  </section>;
}
function OmiFlow() { return <div className="checkpoint-art" aria-hidden="true"><div/><Icon name="shield" size={45}/><span/><i/></div>; }
