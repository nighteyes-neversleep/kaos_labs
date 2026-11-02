import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  DEFAULT_PARAMETERS, DEFAULT_SETTINGS, analyzeState, parameterWarnings,
  simulateCodex, validateCodexParameters,
  type CodexParameters, type SimulationSettings, type SimulationResult, type Sample,
} from '../core/codex';
import { appendAudit, verifyAudit, type AuditEntry } from '../core/governance';
import { Icon } from './Icons';

type Props = { chain: AuditEntry[]; onChainChange: (chain: AuditEntry[]) => Promise<void> };
type Parameter = { key: keyof CodexParameters; symbol: string; label: string; description: string; min: number; max: number };
const parameters: Parameter[] = [
  { key: 'V', symbol: 'V', label: 'Capacity growth', description: 'Intrinsic capacity growth rate.', min: 0, max: 10000 },
  { key: 'P', symbol: 'P', label: 'Carrying capacity', description: 'Positive maximum carrying capacity.', min: Number.MIN_VALUE, max: 1e6 },
  { key: 'D', symbol: 'D', label: 'Baseline decay', description: 'Positive decay in both channels.', min: Number.MIN_VALUE, max: 10000 },
  { key: 'R', symbol: 'R', label: 'Attrition', description: 'Coupling that reduces capacity.', min: 0, max: 10000 },
  { key: 'M', symbol: 'M', label: 'Mutualistic coupling', description: 'Capacity-to-protocol reinforcement.', min: 0, max: 10000 },
  { key: 'S', symbol: 'S', label: 'Protocol entropy', description: 'Positive protocol self-decay.', min: Number.MIN_VALUE, max: 10000 },
  { key: 'alpha', symbol: 'α', label: 'Control authority', description: 'Scales the control injection Φ.', min: 0, max: 10000 },
  { key: 'W', symbol: 'W', label: 'Commitment', description: 'Positive, constant investment for this run.', min: Number.MIN_VALUE, max: 1e6 },
  { key: 'beta1', symbol: 'β₁', label: 'Capacity support', description: 'Weights K/P in the injection.', min: 0, max: 10000 },
  { key: 'beta2', symbol: 'β₂', label: 'Commitment support', description: 'Weights W/(1+W).', min: 0, max: 10000 },
  { key: 'beta3', symbol: 'β₃', label: 'Protocol support', description: 'Weights T/(1+T).', min: 0, max: 10000 },
  { key: 'beta4', symbol: 'β₄', label: 'Attrition penalty', description: 'Weights RT/(1+K).', min: 0, max: 10000 },
];
const claimPosture = 'Local numerical experiment with illustrative parameters. No certified stability, equilibrium, or real-world safety claim.';
function draft<T extends object>(value: T): Record<keyof T, string> {
  return Object.fromEntries(Object.entries(value).map(([key, number]) => [key, String(number)])) as Record<keyof T, string>;
}
function numeric<T extends object>(value: Record<keyof T, string>): T {
  return Object.fromEntries(Object.entries(value).map(([key, text]) => [key, typeof text === 'string' && text.trim() ? Number(text) : NaN])) as T;
}
function format(value: number, digits = 4) {
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value === 0) return '0';
  if (Math.abs(value) < .001 || Math.abs(value) >= 1e4) return value.toExponential(Math.max(0, digits - 1));
  return Number(value.toPrecision(digits)).toString();
}
function saveDownload(contents: string, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(value: unknown) {
  if (typeof value === 'number') return String(value);
  return `"${String(value).replaceAll('"', '""')}"`;
}

export default function CodexLab({ chain, onChainChange }: Props) {
  const [parameterDraft, setParameterDraft] = useState(() => draft(DEFAULT_PARAMETERS));
  const [settingsDraft, setSettingsDraft] = useState(() => draft(DEFAULT_SETTINGS));
  const [recorded, setRecorded] = useState<{ result: SimulationResult; auditHead: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [operation, setOperation] = useState<'run' | 'export' | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const chainErrorRef = useRef<HTMLDivElement>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const chainRef = useRef(chain);
  const runNumber = useRef(0);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (chainValid === false && !error) chainErrorRef.current?.focus(); }, [chainValid, error]);
  useEffect(() => { if (recorded) resultHeadingRef.current?.focus(); }, [recorded]);
  useEffect(() => {
    chainRef.current = chain;
    let current = true;
    setChainValid(null);
    verifyAudit(chain).then(valid => { if (current) setChainValid(valid); }).catch(() => { if (current) setChainValid(false); });
    return () => { current = false; };
  }, [chain]);
  const currentParameters = numeric<CodexParameters>(parameterDraft);
  const inputErrors = validateCodexParameters(currentParameters);
  const warnings = inputErrors.length ? [] : parameterWarnings(currentParameters);
  const result = recorded?.result;
  const last = result?.samples.at(-1);
  const initial = result?.samples[0];
  const analysis = result && last ? analyzeState(result.parameters, last.K, last.T) : null;
  const changed = result && (JSON.stringify(numeric<CodexParameters>(parameterDraft)) !== JSON.stringify(result.parameters) || JSON.stringify(numeric<SimulationSettings>(settingsDraft)) !== JSON.stringify(result.settings));

  async function run(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setOperation('run'); setError(''); setRecorded(null);
    setAnnouncement('Running the numerical experiment. Results will be announced after the encrypted audit record is saved.');
    const thisRun = ++runNumber.current;
    try {
      const nextParameters = numeric<CodexParameters>(parameterDraft);
      const nextSettings = numeric<SimulationSettings>(settingsDraft);
      const errors = validateCodexParameters(nextParameters);
      if (errors.length) throw new Error(errors.join(' '));
      if (!(await verifyAudit(chainRef.current))) throw new Error('The Canonization Chain failed verification. No experiment can be recorded.');
      // Yield one frame so the busy state is visible before the bounded solver runs.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!mountedRef.current || thisRun !== runNumber.current) throw new Error('The numerical experiment session was closed.');
      const nextResult = simulateCodex(nextParameters, nextSettings);
      const nextChain = await appendAudit(chainRef.current, 'codex-simulation', { claimPosture, result: nextResult });
      if (!mountedRef.current || thisRun !== runNumber.current) throw new Error('The numerical experiment session was closed.');
      await onChainChange(nextChain);
      if (!mountedRef.current || thisRun !== runNumber.current) throw new Error('The capsule or numerical experiment session was closed.');
      chainRef.current = nextChain;
      setRecorded({ result: nextResult, auditHead: nextChain.at(-1)!.hash });
      setAnnouncement(`${nextResult.status === 'completed' ? 'Simulation completed' : 'Numerical run contained'} and saved to your encrypted audit chain. ${nextResult.samples.length} samples are available in the sampled data table. ${nextResult.reason}`);
    } catch (e) {
      if (mountedRef.current) { setAnnouncement('The numerical experiment was not recorded. Review the error message.'); setError(e instanceof Error ? e.message : 'The numerical experiment could not be recorded.'); }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) { setBusy(false); setOperation(null); }
    }
  }
  async function exportResult(kind: 'json' | 'csv') {
    if (!recorded || busyRef.current) return;
    busyRef.current = true; setBusy(true); setOperation('export'); setError(''); setAnnouncement('Verifying the audit chain before export.');
    try {
      const snapshot = recorded;
      if (!(await verifyAudit(chainRef.current)) || !chainRef.current.some(entry => entry.event === 'codex-simulation' && entry.hash === snapshot.auditHead)) {
        throw new Error('This experiment is not present in a verified audit chain. Export is blocked.');
      }
      if (!mountedRef.current) throw new Error('The numerical experiment session was closed.');
      const name = `omi-codex-${snapshot.auditHead.slice(0, 12)}`;
      if (kind === 'json') saveDownload(JSON.stringify({ ...snapshot.result, auditHead: snapshot.auditHead, claimPosture }, null, 2), `${name}.json`, 'application/json');
      else {
        const run = snapshot.result;
        const parameterKeys = parameters.map(parameter => parameter.key);
        const settingsKeys: (keyof SimulationSettings)[] = ['initialK', 'initialT', 'duration', 'tolerance'];
        const headings = ['modelVersion', 'status', 'reason', 'acceptedSteps', 'rejectedSteps', ...parameterKeys, ...settingsKeys, 't', 'K', 'T', 'phi', 'dK', 'dT', 'auditHead', 'claimPosture'];
        const rows = run.samples.map(sample => [run.modelVersion, run.status, run.reason, run.acceptedSteps, run.rejectedSteps, ...parameterKeys.map(key => run.parameters[key]), ...settingsKeys.map(key => run.settings[key]), sample.t, sample.K, sample.T, sample.phi, sample.dK, sample.dT, snapshot.auditHead, claimPosture]);
        saveDownload([headings.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n'), `${name}.csv`, 'text/csv;charset=utf-8');
      }
      setAnnouncement(`${kind.toUpperCase()} export prepared from the verified recorded experiment. The download contains full numerical precision.`);
    } catch (e) { if (mountedRef.current) { setAnnouncement('Export was blocked. Review the error message.'); setError(e instanceof Error ? e.message : 'Export could not be completed.'); } }
    finally { busyRef.current = false; if (mountedRef.current) { setBusy(false); setOperation(null); } }
  }
  function reset() { if (busyRef.current) return; setParameterDraft(draft(DEFAULT_PARAMETERS)); setSettingsDraft(draft(DEFAULT_SETTINGS)); setError(''); setAnnouncement('Inputs reset to illustrative defaults. Existing recorded results are unchanged.'); }

  return <section className="page-enter codex-lab">
    <div className="section-heading"><div><span className="eyebrow">THE DUAL MERGE CODEX</span><h1>A laboratory for interlock.</h1><p>Explore the coupling between capacity and protocol. Keep every experiment accountable.</p></div><span className="badge purple">Numerical exploration</span></div>
    <div className="notice"><Icon name="info"/><p>This local model implements the whitepaper’s Keeper–Tether equations with a bounded adaptive RK45 solver. Defaults are illustrative; β₁ = 1.5, β₂ = 3, β₃ = 1.5 are the document’s baseline weights. A numerical trajectory does not certify stability, equity, or deployment safety.</p></div>
    <p className="codex-live-status" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
    {busy && <div className="codex-operation"><progress aria-label={operation === 'export' ? 'Verifying and preparing export' : 'Running and recording numerical experiment'}/><span>{operation === 'export' ? 'Verifying and preparing export…' : 'Running and recording experiment…'}</span></div>}
    {error && <div className="error-banner" role="alert" tabIndex={-1} ref={errorRef}><strong>Numerical lab error. </strong>{error}</div>}
    {chainValid === false && <div className="error-banner" role="alert" tabIndex={-1} ref={chainErrorRef}>Audit integrity verification failed. Experiments and exports are blocked.</div>}
    <div className="codex-layout">
      <form className="panel codex-input-panel" onSubmit={run} noValidate>
        <div className="panel-title"><span className="step-number">01</span><div><h2>Set the conditions</h2><p>Rates and weights for a reproducible run</p></div></div>
        <div className="codex-input-grid">{parameters.slice(0, 8).map(parameter => <ParameterInput key={parameter.key} parameter={parameter} value={parameterDraft[parameter.key]} disabled={busy} onChange={value => setParameterDraft(current => ({ ...current, [parameter.key]: value }))}/>)}</div>
        <details className="codex-control-weights" open><summary>Control injection weights <span>β₁ … β₄</span></summary><div className="codex-input-grid">{parameters.slice(8).map(parameter => <ParameterInput key={parameter.key} parameter={parameter} value={parameterDraft[parameter.key]} disabled={busy} onChange={value => setParameterDraft(current => ({ ...current, [parameter.key]: value }))}/>)}</div></details>
        <div className="codex-run-settings"><span className="eyebrow">INITIAL STATE & SOLVER</span><div className="codex-input-grid"><div><label htmlFor="codex-initial-k">Initial capacity K₀</label><input id="codex-initial-k" type="number" step="any" min={Number.MIN_VALUE} max="1000000" aria-describedby="codex-initial-k-help" aria-invalid={invalidNumber(settingsDraft.initialK, Number.MIN_VALUE, 1e6)} value={settingsDraft.initialK} disabled={busy} onChange={e=>setSettingsDraft(current=>({...current,initialK:e.target.value}))}/><small id="codex-initial-k-help">Positive capacity, at most 10⁶ model units</small></div><div><label htmlFor="codex-initial-t">Initial protocol T₀</label><input id="codex-initial-t" type="number" step="any" min={Number.MIN_VALUE} max="1000000" aria-describedby="codex-initial-t-help" aria-invalid={invalidNumber(settingsDraft.initialT, Number.MIN_VALUE, 1e6)} value={settingsDraft.initialT} disabled={busy} onChange={e=>setSettingsDraft(current=>({...current,initialT:e.target.value}))}/><small id="codex-initial-t-help">Positive protocol value, at most 10⁶ model units</small></div><div><label htmlFor="codex-duration">Duration</label><input id="codex-duration" type="number" step="any" min="0.01" max="1000" aria-describedby="codex-duration-help" aria-invalid={invalidNumber(settingsDraft.duration, 0.01, 1000)} value={settingsDraft.duration} disabled={busy} onChange={e=>setSettingsDraft(current=>({...current,duration:e.target.value}))}/><small id="codex-duration-help">0.01–1000 model time units</small></div><div><label htmlFor="codex-tolerance">Solver tolerance</label><input id="codex-tolerance" type="number" step="any" min="0.0000000001" max="0.001" aria-describedby="codex-tolerance-help" aria-invalid={invalidNumber(settingsDraft.tolerance, 1e-10, 1e-3)} value={settingsDraft.tolerance} disabled={busy} onChange={e=>setSettingsDraft(current=>({...current,tolerance:e.target.value}))}/><small id="codex-tolerance-help">10⁻¹⁰–10⁻³, relative tolerance; absolute tolerance is one thousandth of this value</small></div></div></div>
        {warnings.length > 0 && <div className="codex-warnings"><strong>Model assumptions to review</strong><ul>{warnings.map(warning=><li key={warning}>{warning}</li>)}</ul></div>}
        <div className="codex-run-actions"><button type="submit" className="button primary" disabled={busy || chainValid !== true}><Icon name="activity" size={17}/>{busy ? (operation === 'export' ? 'Preparing export…' : 'Running & recording…') : 'Run simulation'}</button><button type="button" className="button ghost" disabled={busy} onClick={reset}>Reset defaults</button></div>
        <p className="fine-print">Complete parameters, settings, sampled output, and numerical interventions are recorded in your encrypted Canonization Chain before export becomes available. W is held constant; time and state values use model units.</p>
      </form>
      <div className="codex-results">
        {!result ? <div className="panel codex-empty"><div className="codex-empty-art" aria-hidden="true"><svg viewBox="0 0 280 150"><path d="M15 125H260M35 135V15" stroke="#574065" fill="none"/><path d="M35 120C75 120 65 30 120 42S190 112 245 38" stroke="#c4a1df" strokeWidth="2" fill="none"/><path d="M35 110C90 112 90 75 130 85S205 27 245 31" stroke="#91bcb4" strokeWidth="2" fill="none" strokeDasharray="5 4"/><circle cx="120" cy="42" r="4" fill="#d6b4f0"/></svg></div><span className="eyebrow">A MODEL, READY TO BE QUESTIONED</span><h2>Follow the relationship.</h2><p>Set your starting conditions and run an experiment to explore K, T, and the control injection over time.</p><div className="chart-legend"><span><i className="legend-k"/>Capacity K</span><span><i className="legend-t"/>Protocol T</span></div></div> : <>
          <div className={`panel codex-result-header ${result.status === 'contained' ? 'is-contained' : ''}`}><div><span className="eyebrow">RECORDED EXPERIMENT</span><h2 tabIndex={-1} ref={resultHeadingRef}>{result.status === 'completed' ? 'Trajectory complete.' : 'Numerical run contained.'}</h2><p>{result.reason}</p></div><span className={`badge ${result.status === 'completed' ? 'green' : 'amber'}`}><Icon name="chain" size={12}/>Saved to chain</span></div>
          {changed && <p className="codex-stale-note"><Icon name="info" size={14}/>Inputs have changed. Charts still show the last recorded experiment; run again to update them.</p>}
          <div className="panel codex-chart-panel"><div className="codex-chart-heading"><div><h2>Capacity & protocol</h2><p>Sampled state over model time</p></div><div className="chart-legend"><span><i className="legend-k"/>K</span><span><i className="legend-t"/>T</span></div></div><TimeChart samples={result.samples}/></div>
          <div className="codex-output-grid"><div className="panel codex-chart-panel"><div className="codex-chart-heading"><div><h2>Phase portrait</h2><p>Capacity K → protocol T</p></div></div><PhaseChart samples={result.samples}/></div><div className="panel codex-endpoint"><span className="eyebrow">LAST SAMPLED STATE</span><h2>At t = {format(last!.t)}</h2><dl><div><dt>Capacity K</dt><dd>{format(last!.K)}<small>from {format(initial!.K)}</small></dd></div><div><dt>Protocol T</dt><dd>{format(last!.T)}<small>from {format(initial!.T)}</small></dd></div><div><dt>Control injection Φ</dt><dd>{format(last!.phi)}</dd></div><div><dt>Derivative residual</dt><dd>{analysis ? format(analysis.residual) : 'Unavailable'}</dd></div></dl><p>This is a sampled endpoint, not a certified equilibrium. Residual is the local derivative norm.</p></div></div>
          <SampleTable key={recorded!.auditHead} samples={result.samples}/>
          <div className="panel codex-diagnostics"><div className="panel-title"><Icon name="layers" size={19}/><div><h2>Numerical diagnostics</h2><p>Inspect the calculation, not just the curve.</p></div></div><div className="codex-diagnostic-stats"><div><span>Accepted steps</span><strong>{result.acceptedSteps.toLocaleString()}</strong></div><div><span>Rejected steps</span><strong>{result.rejectedSteps.toLocaleString()}</strong></div><div><span>Recorded samples</span><strong>{result.samples.length}</strong></div></div>{analysis && <details className="codex-linearization"><summary>Local Jacobian at the last sample</summary><div className="jacobian-grid">{analysis.jacobian.flat().map((value,i)=><code key={i}>{format(value, 6)}</code>)}</div><div className="linearization-values"><span>Trace <strong>{format(analysis.trace, 6)}</strong></span><span>Determinant <strong>{format(analysis.determinant, 6)}</strong></span></div><p>These are local linearization values at the sampled state. Trace and determinant alone do not establish global stability or an equilibrium.</p></details>}<div className="codex-export-row"><div><strong>{result.modelVersion}</strong><code>Audit head {recorded!.auditHead.slice(0,16)}…</code></div><button className="button secondary" disabled={busy || chainValid !== true} onClick={()=>exportResult('json')}><Icon name="download" size={15}/>Export JSON</button><button className="button secondary" disabled={busy || chainValid !== true} onClick={()=>exportResult('csv')}>Export CSV</button></div></div>
        </>}
        <details className="panel codex-equations"><summary><span><Icon name="layers" size={18}/>The model behind the experiment</span><span className="expand-mark">+</span></summary><div><p>The Dual Merge Codex models capacity K and protocol efficacy / trust T. Both state variables remain in the positive orthant; numerical boundary or solver-limit events contain the run.</p><code>dK/dt = VK(1 − K/P) − RKT − DK</code><code>dT/dt = MKT − ST − DT + αΦ(K,T,W)</code><code>Φ = β₁(K/P) + β₂(W/(1+W)) + β₃(T/(1+T)) − β₄(RT/(1+K))</code><p>Positive equilibrium requires more than a completed simulation. The whitepaper’s V &gt; D and β₄ ≥ β₁ + β₂ + β₃ conditions are useful diagnostic assumptions, not a complete convergence proof.</p><p>Browser limits: P, W, K₀, and T₀ must be positive and no greater than 10⁶; D and S are positive; remaining rates and weights are nonnegative, with a 10⁴ ceiling. Run duration and tolerance are bounded. Out-of-domain states or exhausted numerical budgets stop the experiment instead of clamping its output.</p><p className="fine-print">Source: <cite>OMI Master Consolidated Whitepaper</cite>, chapter 6. Adaptive Dormand–Prince RK45 approximates these equations; finite tolerances and bounded computation limit numerical conclusions.</p></div></details>
      </div>
    </div>
  </section>;
}
function ParameterInput({parameter,value,disabled,onChange}:{parameter:Parameter;value:string;disabled:boolean;onChange:(value:string)=>void}) {
  return <div className="codex-parameter"><label htmlFor={`codex-${parameter.key}`}><span>{parameter.symbol}</span>{parameter.label}</label><input id={`codex-${parameter.key}`} type="number" step="any" min={parameter.min} max={parameter.max} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)} aria-label={parameter.label} aria-invalid={invalidNumber(value, parameter.min, parameter.max)} aria-describedby={`codex-${parameter.key}-help`}/><small id={`codex-${parameter.key}-help`}>{parameter.description}</small></div>;
}

const SAMPLE_PAGE_SIZE = 20;
function invalidNumber(value: string, minimum: number, maximum: number) {
  const number = value.trim() ? Number(value) : NaN;
  return !Number.isFinite(number) || number < minimum || number > maximum;
}
function SampleTable({ samples }: { samples: Sample[] }) {
  const [page, setPage] = useState(0);
  const descriptionId = useId();
  const tableId = useId();
  const pageCount = Math.max(1, Math.ceil(samples.length / SAMPLE_PAGE_SIZE));
  const start = page * SAMPLE_PAGE_SIZE;
  const visible = samples.slice(start, start + SAMPLE_PAGE_SIZE);
  const end = Math.min(start + SAMPLE_PAGE_SIZE, samples.length);
  return <details className="panel codex-sample-data">
    <summary>Read sampled data <span>{samples.length} recorded samples</span></summary>
    <p id={descriptionId}>This table provides the recorded values behind both charts, in time order. Time, state values, and control injection use model units; dK/dt and dT/dt are changes per model time unit. Values are rounded to eight significant digits here; verified JSON and CSV exports preserve full stored numerical precision.</p>
    <div className="codex-table-scroll" tabIndex={0} role="region" aria-label="Scrollable sampled values" aria-describedby={descriptionId}>
      <table id={tableId} className="codex-sample-table">
        <caption>Recorded Codex samples · model units · eight significant digits</caption>
        <thead><tr><th scope="col">Sample</th><th scope="col">Time t</th><th scope="col">Capacity K</th><th scope="col">Protocol T</th><th scope="col">Injection Φ</th><th scope="col">dK/dt</th><th scope="col">dT/dt</th></tr></thead>
        <tbody>{visible.map((sample, index) => <tr key={start + index}>
          <th scope="row">{start + index + 1}</th>
          <td>{format(sample.t, 8)}</td><td>{format(sample.K, 8)}</td><td>{format(sample.T, 8)}</td><td>{format(sample.phi, 8)}</td><td>{format(sample.dK, 8)}</td><td>{format(sample.dT, 8)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <div className="codex-table-pagination">
      <button type="button" className="button secondary" aria-controls={tableId} disabled={page === 0} onClick={() => setPage(current => Math.max(0, current - 1))}>Previous page</button>
      <p role="status" aria-live="polite" aria-atomic="true">Showing samples {samples.length ? start + 1 : 0}–{end} of {samples.length}. Page {page + 1} of {pageCount}.</p>
      <button type="button" className="button secondary" aria-controls={tableId} disabled={page + 1 >= pageCount} onClick={() => setPage(current => Math.min(pageCount - 1, current + 1))}>Next page</button>
    </div>
  </details>;
}

const bounds = { left: 62, top: 15, width: 530, height: 205 };
function ticks(minimum:number,maximum:number) { return Array.from({length:5},(_,i)=>minimum+(maximum-minimum)*i/4); }
function extent(values:number[]) { const min=Math.min(...values),max=Math.max(...values); const padding=(max-min)*.09 || Math.max(Math.abs(max)*.05,.1); return [Math.max(0,min-padding),max+padding]; }
function TimeChart({samples}:{samples:Sample[]}) {
  const id=useId(); const [yMin,yMax]=extent(samples.flatMap(s=>[s.K,s.T])); const maxT=Math.max(samples.at(-1)?.t || 1,1e-9);
  const x=(value:number)=>bounds.left+value/maxT*bounds.width; const y=(value:number)=>bounds.top+bounds.height-(value-yMin)/(yMax-yMin)*bounds.height;
  const path=(key:'K'|'T')=>samples.map((sample,i)=>`${i?'L':'M'}${x(sample.t).toFixed(2)},${y(sample[key]).toFixed(2)}`).join(' ');
  return <svg className="codex-chart" viewBox="0 0 625 270" aria-hidden="true" focusable="false"><title id={`${id}-title`}>Capacity K and protocol T over time</title><desc id={`${id}-description`}>{samples.length} samples from time {format(samples[0].t)} to {format(samples.at(-1)!.t)}. Capacity changes from {format(samples[0].K)} to {format(samples.at(-1)!.K)}. Protocol changes from {format(samples[0].T)} to {format(samples.at(-1)!.T)}.</desc>{ticks(yMin,yMax).map((value,i)=><g key={i}><line x1={bounds.left} x2={bounds.left+bounds.width} y1={y(value)} y2={y(value)} className="chart-grid"/><text x={bounds.left-10} y={y(value)+4} textAnchor="end">{format(value,3)}</text></g>)}{ticks(0,maxT).map((value,i)=><text key={i} x={x(value)} y={bounds.top+bounds.height+23} textAnchor="middle">{format(value,3)}</text>)}<path d={path('K')} className="trace-k"/><path d={path('T')} className="trace-t"/><text x={bounds.left+bounds.width/2} y="263" textAnchor="middle" className="chart-axis-label">Time · model units</text><text transform="translate(12 120) rotate(-90)" textAnchor="middle" className="chart-axis-label">State value</text></svg>;
}
function PhaseChart({samples}:{samples:Sample[]}) {
  const id=useId(); const [xMin,xMax]=extent(samples.map(s=>s.K));const [yMin,yMax]=extent(samples.map(s=>s.T));const area={left:57,top:15,width:220,height:170};
  const x=(value:number)=>area.left+(value-xMin)/(xMax-xMin)*area.width;const y=(value:number)=>area.top+area.height-(value-yMin)/(yMax-yMin)*area.height;
  const path=samples.map((s,i)=>`${i?'L':'M'}${x(s.K).toFixed(2)},${y(s.T).toFixed(2)}`).join(' ');const first=samples[0],last=samples.at(-1)!;
  return <svg className="codex-phase-chart" viewBox="0 0 300 230" aria-hidden="true" focusable="false"><title id={`${id}-title`}>Phase portrait: capacity K against protocol T</title><desc id={`${id}-description`}>Open marker: initial state K {format(first.K)}, T {format(first.T)}. Filled marker: last sample K {format(last.K)}, T {format(last.T)}. Line follows recorded time order.</desc>{ticks(yMin,yMax).map((value,i)=><g key={i}><line x1={area.left} x2={area.left+area.width} y1={y(value)} y2={y(value)} className="chart-grid"/><text x={area.left-9} y={y(value)+3} textAnchor="end">{format(value,3)}</text></g>)}{ticks(xMin,xMax).map((value,i)=><text x={x(value)} y={area.top+area.height+18} key={i} textAnchor="middle">{format(value,3)}</text>)}<path d={path} className="trace-k"/><circle cx={x(first.K)} cy={y(first.T)} r="4" className="phase-start"><title>Initial state</title></circle><circle cx={x(last.K)} cy={y(last.T)} r="4" className="phase-end"><title>Last sampled state</title></circle><text x={area.left+area.width/2} y="226" textAnchor="middle" className="chart-axis-label">Capacity K</text><text transform="translate(12 100) rotate(-90)" textAnchor="middle" className="chart-axis-label">Protocol T</text></svg>;
}
