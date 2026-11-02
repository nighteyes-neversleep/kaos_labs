import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { createVault, unlockVault, saveVault, hasVault, type VaultData, type PrivacyArea } from './core/capsule';
import { authorizeSharing, effectiveSharing, freshSharing, revokeSharing, setSharingOption, type ShareSession, type SharingOption } from './core/sharing';
import { registeredApps } from './core/cartridges';
import { canonicalize, type AuditEntry } from './core/governance';
import CartridgeHost from './components/CartridgeHost';
import GovernanceWorkbench from './components/GovernanceWorkbench';
import CodexLab from './components/CodexLab';
import AccessibleDialog from './components/AccessibleDialog';
import SharedForum from './components/SharedForum';
import { Icon, OmiMark } from './components/Icons';

type Page = 'overview' | 'governance' | 'apps' | 'capsule' | 'sharing' | 'ledger' | 'codex' | 'forum';
const navigation: { id: Page; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'governance', label: 'Governance', icon: 'shield' },
  { id: 'codex', label: 'Codex laboratory', icon: 'activity' },
  { id: 'apps', label: 'Applications', icon: 'apps' },
  { id: 'forum', label: 'Shared forum', icon: 'share' },
  { id: 'capsule', label: 'Personal Capsule', icon: 'capsule' },
  { id: 'sharing', label: 'Resource sharing', icon: 'share' },
  { id: 'ledger', label: 'Canonization Chain', icon: 'chain' },
];
const appPresentation: Record<string, { icon: string; color: string; description: string; short?: string }> = {
  'eagles-nest': { icon: 'bird', color: 'amethyst', description: 'A private place for the people closest to you. Keep family notes and everyday plans together.', short: 'Your circle, held close.' },
  corvid: { icon: 'bird', color: 'blue', description: 'A dedicated research cartridge for inquiry, observation, and discovery.' },
  'bio-tank': { icon: 'flask', color: 'green', description: 'An isolated space for biological research and exploration.' },
  'digital-assembly-line': { icon: 'layers', color: 'amber', description: 'A modular workspace for learning, building, and research.' },
  'war-window': { icon: 'globe', color: 'rose', description: 'Humanitarian contacts and support resources, separately governed.', short: 'Humanitarian support' },
  'lisa-braid': { icon: 'spark', color: 'blue', description: 'Universal spectral structure and research visualization.' },
  'pandora-sat-track': { icon: 'globe', color: 'amethyst', description: 'An isolated Pandora mini-app for satellite and telemetry research.' },
};
function message(error: unknown) { return error instanceof Error ? error.message : 'Something could not be saved. Please try again.'; }
function getVaultExists() { try { return hasVault(); } catch { return false; } }
function validChain(value: unknown): AuditEntry[] { return Array.isArray(value) ? value as AuditEntry[] : []; }
function malformedChain(value: unknown) {
  return value !== undefined && (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== 'object' || typeof entry.event !== 'string' || typeof entry.hash !== 'string' || typeof entry.timestamp !== 'string' || !Number.isInteger(entry.sequence)));
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [data, setData] = useState<VaultData | null>(null);
  const [vaultExists, setVaultExists] = useState(getVaultExists);
  const [authOpen, setAuthOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [consent, setConsent] = useState<string | null>(null);
  const [mounted, setMounted] = useState<string | null>(null);
  const [sharing, setSharing] = useState<ShareSession>(freshSharing);
  const [minutes, setMinutes] = useState(15);
  const [sharePercent, setSharePercent] = useState(15);
  const [shareConsent, setShareConsent] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [languageDraft, setLanguageDraft] = useState('en');
  const [profileBusy, setProfileBusy] = useState(false);
  const [largeText, setLargeText] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const dataRef = useRef<VaultData | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const mainRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const pageFocusRequested = useRef(false);
  const mobileRestoreRequested = useRef(false);
  const chainMalformed = malformedChain(data?.appData.__omiGovernance);
  const chain = chainMalformed ? [] : validChain(data?.appData.__omiGovernance);

  const updateData = useCallback((update: (current: VaultData) => VaultData): Promise<void> => {
    const capturedKey = keyRef.current;
    const operation = writeQueue.current.then(async () => {
      if (!capturedKey || keyRef.current !== capturedKey || !dataRef.current) throw new Error('Unlock your capsule again before saving.');
      const next = update(dataRef.current);
      await saveVault(next, capturedKey);
      if (keyRef.current !== capturedKey) throw new Error('The capsule was locked while saving. Unlock it again before continuing.');
      dataRef.current = next; setData(next);
    });
    writeQueue.current = operation.catch(() => undefined);
    return operation;
  }, []);
  const persistChain = useCallback((next: AuditEntry[]) => updateData(current => {
    const stored = current.appData.__omiGovernance;
    if (malformedChain(stored)) throw new Error('Saved governance history is malformed. The existing data was preserved.');
    const previous = validChain(stored);
    if (next.length <= previous.length || canonicalize(next.slice(0, previous.length)) !== canonicalize(previous)) {
      throw new Error('Governance history changed while this action was pending. Retry from the current chain.');
    }
    return { ...current, appData: { ...current.appData, __omiGovernance: next } };
  }), [updateData]);
  function notify(text: string) { setToast(text); setAnnouncement(text); }
  const focusMain = useCallback(() => {
    const target = mainRef.current?.querySelector<HTMLElement>('h1') ?? mainRef.current;
    if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, []);
  function closeMobileNavigation() {
    mobileRestoreRequested.current = true;
    setMobileOpen(false);
  }
  useLayoutEffect(() => {
    if (!mobileOpen && mobileRestoreRequested.current) {
      mobileRestoreRequested.current = false;
      mobileToggleRef.current?.focus({ preventScroll: true });
    }
  }, [mobileOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const change = () => { setIsMobile(media.matches); if (!media.matches) setMobileOpen(false); };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const title = navigation.find(item => item.id === page)?.label ?? 'Workspace';
    document.title = `${title} | OMI — Oracle Mechanism of Interlock`;
    if (!pageFocusRequested.current) return;
    pageFocusRequested.current = false;
    const frame = requestAnimationFrame(focusMain);
    return () => cancelAnimationFrame(frame);
  }, [page, focusMain]);
  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    const sidebar = sidebarRef.current;
    const frame = requestAnimationFrame(() => sidebar?.querySelector<HTMLElement>('.nav-item[aria-current="page"]')?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMobileNavigation(); return; }
      if (event.key !== 'Tab' || !sidebar) return;
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')).filter(item => item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey); };
  }, [isMobile, mobileOpen]);
  useEffect(() => { if (toast) { const t = setTimeout(()=>setToast(''), 3500); return ()=>clearTimeout(t); } }, [toast]);
  useEffect(() => {
    const id = setInterval(() => setSharing(current => {
      const next = effectiveSharing(current);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    }), 1000);
    const visibility = () => { if (document.hidden) setSharing(revokeSharing()); };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    if (data) { setNameDraft(data.displayName); setLanguageDraft(data.capsule.identity.preferred_language || 'en'); }
  }, [data?.displayName, data?.capsule.identity.preferred_language]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'omi.personal-capsule.v1') {
        keyRef.current = null; dataRef.current = null; setData(null); setMounted(null); setConsent(null); setAuthOpen(false); setPin(''); setPinConfirm(''); setSharing(revokeSharing()); setVaultExists(getVaultExists());
        setError('Your capsule changed in another tab. Unlock it again to continue safely.');
      }
    };
    window.addEventListener('storage', onStorage); return ()=>window.removeEventListener('storage', onStorage);
  }, []);
  function navigate(next: Page) { pageFocusRequested.current = true; if (next === page) { pageFocusRequested.current = false; requestAnimationFrame(focusMain); } setPage(next); setMobileOpen(false); setError(''); window.scrollTo({ top: 0, behavior: 'auto' }); }
  function openAuth() { if (consent || mounted) return; setMobileOpen(false); setVaultExists(getVaultExists()); setPin(''); setPinConfirm(''); setAuthError(''); setAuthOpen(true); }
  async function authenticate(event: FormEvent) {
    event.preventDefault(); setAuthBusy(true); setAuthError('');
    try {
      if (!vaultExists && pin !== pinConfirm) throw new Error('Your PINs do not match.');
      const result = vaultExists ? await unlockVault(pin) : await createVault(displayName, pin);
      keyRef.current = result.key; dataRef.current = result.data; setData(result.data); setVaultExists(true);
      setSharing(freshSharing()); setShareConsent(false); setAuthOpen(false); setPin(''); setPinConfirm(''); setError(''); notify(vaultExists ? 'Your capsule is unlocked.' : 'Your Personal Capsule is ready.');
    } catch (e) { setAuthError(message(e)); }
    finally { setAuthBusy(false); }
  }
  function lock() { keyRef.current = null; dataRef.current = null; setData(null); setMounted(null); setConsent(null); setAuthOpen(false); setPin(''); setPinConfirm(''); setSharing(revokeSharing()); setShareConsent(false); notify('Capsule locked. Sharing authorization revoked.'); requestAnimationFrame(focusMain); }
  function requestMount(appId: string) { if (authOpen || consent || mounted) return; if (!data) { openAuth(); return; } setConsent(appId); }
  async function saveProfile(event: FormEvent) {
    event.preventDefault(); setProfileBusy(true); setError('');
    try { await updateData(current => ({ ...current, displayName: nameDraft.trim(), capsule: { ...current.capsule, identity: { ...current.capsule.identity, preferred_language: languageDraft } } })); notify('Capsule preferences saved.'); }
    catch (e) { setError(message(e)); } finally { setProfileBusy(false); }
  }
  async function updatePrivacy(area: PrivacyArea, mode: 'private'|'selected'|'family') {
    try { await updateData(current => ({ ...current, capsule: { ...current.capsule, privacy: { ...current.capsule.privacy, [area]: { mode } } } })); notify('Privacy preference saved.'); }
    catch (e) { setError(message(e)); }
  }
  function enableShare(event: FormEvent) {
    event.preventDefault();
    try { if (!shareConsent || !data) throw new Error('Unlock your capsule and authorize the share window.'); setSharing(authorizeSharing(minutes, sharePercent)); setError(''); notify('Local authorization window opened. No peer resources are connected.'); }
    catch (e) { setError(message(e)); }
  }
  function toggleOption(option: SharingOption, enabled: boolean) {
    try { setSharing(setSharingOption(sharing, option, enabled)); } catch(e) { setError(message(e)); }
  }
  const activePage = navigation.find(item=>item.id===page)!;
  const filteredApps = registeredApps.filter(app => (!search || `${app.name} ${app.category}`.toLowerCase().includes(search.toLowerCase())) && (filter === 'all' || filter === 'available' && app.available || filter === 'research' && app.category.includes('research')));
  const isPrivate = ['governance','capsule','sharing','ledger','codex'].includes(page);

  return <div className={`omi-app ${largeText ? 'large-text' : ''} ${highContrast ? 'high-contrast' : ''}`}>
    <a href="#main-content" className="skip-link" hidden={isMobile && mobileOpen}>Skip to content</a>
    {isMobile && mobileOpen && <div className="sidebar-scrim" aria-hidden="true" onClick={closeMobileNavigation}/>}
    <aside id="omi-sidebar" ref={sidebarRef} className={`sidebar ${mobileOpen ? 'is-open' : ''}`} inert={isMobile && !mobileOpen ? true : undefined} role={isMobile && mobileOpen ? 'dialog' : undefined} aria-modal={isMobile && mobileOpen ? true : undefined} aria-label={isMobile && mobileOpen ? 'Workspace navigation' : undefined}>
      <button className="icon-button sidebar-close" onClick={closeMobileNavigation} aria-label="Close navigation"><Icon name="close"/></button>
      <button className="brand" onClick={()=>navigate('overview')} title="Return to overview"><OmiMark/><span><strong>OMI<span className="brand-period">.</span></strong><small>ORACLE MECHANISM OF INTERLOCK</small></span></button>
      <div className="sidebar-label">YOUR CONTROL ROOM</div>
      <nav aria-label="Main navigation">{navigation.map(item=><button key={item.id} className={`nav-item ${page===item.id ? 'active' : ''}`} aria-current={page===item.id ? 'page' : undefined} onClick={()=>navigate(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{item.id==='apps' && <span className="nav-count">7</span>}{item.id==='ledger' && chain.length>0 && <span className="nav-count">{chain.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-policy"><Icon name="shield"/><div><strong>Human authority. Always.</strong><p>Your data. Your permissions.<br/>Your decision to share.</p></div></div><div className="kaos-wordmark"><span className="kaos-symbol">K<span>✦</span></span><span>KAOS LABS<small>FOR HUMANITY</small></span><span className="version">v0.1</span></div></div>
    </aside>
    <div className="workspace" inert={isMobile && mobileOpen ? true : undefined}>
      <header className="topbar"><div className="breadcrumb"><button ref={mobileToggleRef} className="icon-button mobile-menu" aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} aria-controls="omi-sidebar" onClick={()=>setMobileOpen(current=>!current)}><Icon name="menu"/></button><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>{activePage.label}</strong></div><div className="topbar-right"><span className="local-indicator"><span className="status-dot"/>Local workspace</span><span className="topbar-divider"/>{data ? <><button className="profile-button" onClick={()=>navigate('capsule')}><span className="avatar">{data.displayName.slice(0,1).toUpperCase()}</span><span>{data.displayName}</span></button><button className="icon-button" aria-label="Lock capsule" title="Lock capsule" onClick={lock}><Icon name="lock" size={18}/></button></> : <button className="button compact secondary" onClick={openAuth}><Icon name="lock" size={15}/>{vaultExists ? 'Unlock capsule' : 'Create capsule'}</button>}</div></header>
      <main id="main-content" ref={mainRef} className="main-content" tabIndex={-1} aria-label={`${activePage.label} content`}>
        {error && <div className="error-banner" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
        {page==='overview' && <section className="page-enter">
          <div className="overview-heading"><div><span className="eyebrow">ONE SEAT. YOUR ENTIRE WORLD.</span><h1>Your world.<br/><span>In your control.</span></h1><p>A personal home for your apps, your identity, and the decisions<br className="desktop-break"/> that connect them. Built around you.</p><div className="hero-actions"><button className="button primary" onClick={()=>navigate('apps')}>Explore applications<Icon name="arrow" size={18}/></button><button className="text-button" onClick={()=>navigate('governance')}>Open governance<Icon name="arrow" size={16}/></button></div><div className="hero-assurance"><Icon name="lock" size={14}/><span>Private by default</span><i/><Icon name="shield" size={14}/><span>Governed by design</span></div></div><div className="hero-visual" aria-hidden="true"><div className="visual-halo"/><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="hero-core"><OmiMark/><span>OMI</span></div><div className="orbit-node node-top"><Icon name="shield" size={21}/></div><div className="orbit-node node-right"><Icon name="capsule" size={21}/></div><div className="orbit-node node-bottom"><Icon name="chain" size={21}/></div><div className="orbit-node node-left"><Icon name="apps" size={21}/></div><div className="visual-tag tag-one"><span className="status-dot"/>PERSONAL CAPSULE</div><div className="visual-tag tag-two">GOVERNANCE AT THE CORE</div><span className="visual-coordinate coord-a">01 / IDENTITY</span><span className="visual-coordinate coord-b">02 / INTERLOCK</span></div></div>
          <div className="stats-grid"><Stat icon="apps" label="Registered applications" value="07" detail="One local cartridge available"/><Stat icon="capsule" label="Personal Capsule" value={data ? 'Unlocked' : 'Locked'} detail={data ? 'Encrypted when stored' : vaultExists ? 'Encrypted and stored locally' : 'Create your private identity'} compact/><Stat icon="chain" label="Canonization records" value={String(chain.length).padStart(2,'0')} detail={data ? 'Your local decision history' : 'Unlock to view your history'}/><Stat icon="share" label="Resource sharing" value={sharing.enabled ? 'Authorized' : 'Off'} detail="Your foreground always comes first" compact/></div>
          <div className="section-heading slim"><div><span className="eyebrow">A PLACE FOR EVERY PART OF YOUR WORLD</span><h2>Your applications</h2></div><button className="text-button" onClick={()=>navigate('apps')}>View all 7<Icon name="arrow" size={16}/></button></div>
          <div className="featured-grid"><article className="featured-card"><div className="featured-art"><div className="bird-emblem"><Icon name="bird" size={62}/></div><span className="tiny-label">FAMILY / PRIVATE</span><div className="art-dots"/></div><div className="featured-content"><div className="card-label-row"><span className="badge green"><span className="status-dot"/>Local cartridge</span><span className="edition">FIRST EDITION</span></div><h2>Eagle’s Nest</h2><p>A little space for the people who mean everything. Keep notes and make everyday plans, together in one private board.</p><button className="button secondary" onClick={()=>requestMount('eagles-nest')}>Open your nest<Icon name="arrow" size={17}/></button></div></article><article className="panel governance-feature"><div className="panel-topline"><div className="orb-icon"><Icon name="shield" size={24}/></div><span className="tiny-label">THE OMI CONTROL LOOP</span></div><h2>Every action <br/>has a checkpoint.</h2><p>Bring an intent through risk assessment, structured human review, and a linked audit record.</p><div className="guardian-pills"><span><i/>Dragon</span><span><i/>Taipan</span><span><i/>eKernel</span></div><button className="text-button" onClick={()=>navigate('governance')}>Enter the workbench<Icon name="arrow" size={16}/></button></article></div>
          <div className="architecture-panel panel"><div className="architecture-intro"><Icon name="layers" size={23}/><div><h3>Separate by design. Connected by OMI.</h3><p>Identity, governance, applications, and communications keep their boundaries.</p></div></div><div className="architecture-steps"><span><Icon name="capsule" size={18}/>Personal Capsule</span><i/><span><Icon name="shield" size={18}/>OMI Core</span><i/><span><Icon name="apps" size={18}/>Isolated cartridges</span><i/><span className="muted"><Icon name="share" size={18}/>Talky Spider <small>Not connected</small></span></div></div>
        </section>}
        {page==='apps' && <section className="page-enter"><div className="section-heading"><div><span className="eyebrow">MODULAR BY NATURE</span><h1>Your applications</h1><p>Each application has its own space. OMI holds the boundaries.</p></div><span className="badge purple">7 registered · 1 local edition</span></div><div className="apps-toolbar"><div className="filter-tabs" role="group" aria-label="Filter applications">{[['all','All applications'],['available','Available'],['research','Research']].map(([value,label])=><button className={filter===value ? 'selected' : ''} aria-pressed={filter===value} key={value} onClick={()=>setFilter(value)}>{label}</button>)}</div><label className="search-field"><Icon name="search" size={18}/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Find an application…" aria-label="Find an application"/></label></div><p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{filteredApps.length} {filteredApps.length === 1 ? 'application matches' : 'applications match'} your search and filter.</p><div className="apps-grid">{filteredApps.map(app=>{const presentation=appPresentation[app.app_id]||appPresentation.corvid; return <article className="panel app-card" key={app.app_id}><div className="app-card-top"><div className={`app-icon ${presentation.color}`}><Icon name={presentation.icon} size={29}/></div><span className={`badge ${app.available ? 'green' : 'neutral'}`}>{app.available ? 'Local edition' : 'Source not added'}</span></div><span className="eyebrow app-category">{app.category.replaceAll('-',' ')}</span><h2>{app.name}</h2><p>{presentation.description}</p><div className="app-card-footer"><span><Icon name="lock" size={13}/>{app.scope.replaceAll('-',' ')}</span>{app.available ? <button className="text-button" onClick={()=>requestMount(app.app_id)}>Open<Icon name="arrow" size={16}/></button> : <span className="unavailable-label">Awaiting source</span>}</div></article>})}</div>{!filteredApps.length&&<div className="empty-state panel"><Icon name="search" size={35}/><h2>No applications found</h2><p>Try a different name or filter.</p><button className="button secondary" onClick={()=>{setSearch('');setFilter('all')}}>Clear filters</button></div>}<p className="fine-print apps-footnote"><Icon name="shield" size={14}/>Only verified local bundles can open. The remaining app families are registered declarations and have no installed source.</p></section>}
        {isPrivate && !data && <LockedView title={page==='capsule' ? 'A capsule that belongs to you.' : 'Your private workspace starts here.'} exists={vaultExists} onOpen={openAuth}/>}
        {data && page==='capsule' && <section className="page-enter"><div className="section-heading"><div><span className="eyebrow">IDENTITY / PRIVACY / PREFERENCES</span><h1>Your Personal Capsule</h1><p>Your identity stays with you. Access starts with your permission.</p></div><button className="button secondary" onClick={lock}><Icon name="lock"/>Lock capsule</button></div><div className="capsule-banner panel"><span className="profile-avatar">{data.displayName.slice(0,1).toUpperCase()}</span><div><h2>{data.displayName}</h2><p>Personal seat · encrypted browser storage</p><code>{data.capsule.capsule_id}</code></div><span className="badge green"><Icon name="shield" size={14}/>AES-256-GCM</span></div><div className="two-columns capsule-columns"><form className="panel settings-panel" onSubmit={saveProfile}><div className="panel-title"><Icon name="capsule"/><div><h2>Make it yours</h2><p>Local profile preferences</p></div></div><label htmlFor="profile-name">Display name</label><input id="profile-name" required maxLength={80} value={nameDraft} onChange={e=>setNameDraft(e.target.value)}/><label htmlFor="profile-language">Preferred language</label><select id="profile-language" value={languageDraft} onChange={e=>setLanguageDraft(e.target.value)}><option value="en">English</option><option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option></select><p className="fine-print">Stores your language preference. This first edition’s interface is in English.</p><button className="button primary" disabled={profileBusy} type="submit">{profileBusy ? 'Saving…' : 'Save preferences'}<Icon name="check" size={17}/></button><div className="settings-divider"/><h3>Comfort & accessibility</h3><Toggle label="Larger text" description="Give the interface more breathing room." checked={largeText} onChange={setLargeText}/><Toggle label="Higher contrast" description="Stronger borders and clearer text." checked={highContrast} onChange={setHighContrast}/></form><div className="panel settings-panel"><div className="panel-title"><Icon name="eye"/><div><h2>Your privacy boundaries</h2><p>Everything starts private.</p></div></div>{(Object.keys(data.capsule.privacy) as PrivacyArea[]).map(area=><div className="privacy-row" key={area}><label htmlFor={`privacy-${area}`}>{area.charAt(0).toUpperCase()+area.slice(1)}</label><select id={`privacy-${area}`} value={data.capsule.privacy[area].mode} onChange={e=>updatePrivacy(area,e.target.value as 'private'|'selected'|'family')}><option value="private">Only me</option><option value="selected">Selected people</option><option value="family">Family</option></select></div>)}<p className="fine-print">These are stored audience preferences. No contacts or peer transport are connected, so changing an audience does not transmit data.</p><div className="inline-assurance"><Icon name="lock"/><span>No raw biometrics retained. Your PIN never leaves this browser.</span></div></div></div></section>}
        {data && page==='sharing' && <section className="page-enter"><div className="section-heading"><div><span className="eyebrow">YOUR RESOURCES. YOUR TERMS.</span><h1>Sharing begins with you.</h1><p>Foreground activity always wins. Private data never enters the resource pool.</p></div><span className={`badge ${sharing.enabled ? 'amber' : 'neutral'}`}><span className="status-dot"/>{sharing.enabled ? 'Window authorized' : 'Sharing off'}</span></div><div className="notice"><Icon name="info"/><p>This is a local authorization controller. No CPU, GPU, storage, or peer resources are measured or consumed. Talky Spider is not connected.</p></div><div className="sharing-layout"><form className="panel settings-panel" onSubmit={enableShare}><div className="panel-title"><Icon name="share"/><div><h2>A deliberate share window</h2><p>Authorization expires automatically.</p></div></div><label htmlFor="share-window">Share window</label><select id="share-window" value={minutes} disabled={sharing.enabled} onChange={e=>setMinutes(Number(e.target.value))}><option value={5}>5 minutes</option><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option></select><div className="range-field"><label htmlFor="share-percent">Ceiling of currently idle resources <output>{sharePercent}%</output></label><input id="share-percent" type="range" min="1" max="15" step="1" value={sharePercent} disabled={sharing.enabled} onChange={e=>setSharePercent(Number(e.target.value))}/><small>Never more than 15% of what is currently idle.</small></div>{sharing.enabled ? <div className="authorized-window"><Icon name="clock"/><div><strong>Authorized until {new Date(sharing.expiresAt!).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</strong><p>Revoked on lock, expiry, or leaving this browser tab.</p></div><button className="button danger-button" type="button" onClick={()=>{setSharing(revokeSharing());setShareConsent(false);setToast('Sharing authorization revoked.')}}>Revoke now</button></div> : <><label className="checkbox-label"><input type="checkbox" checked={shareConsent} onChange={e=>setShareConsent(e.target.checked)}/><span>I authorize this bounded, local share window.</span></label><button type="submit" className="button primary full-width" disabled={!shareConsent}>Authorize window<Icon name="arrow"/></button></>}</form><div className="panel settings-panel"><div className="panel-title"><Icon name="activity"/><div><h2>Dependent controls</h2><p>An active authorization is required.</p></div></div><Toggle label="AUTO MANAGE" description="Manage within your authorized window." checked={sharing.autoManage} disabled={!sharing.enabled} onChange={enabled=>toggleOption('autoManage',enabled)}/><Toggle label="TURBO" description="Manual mode, with the same 15%-of-idle ceiling." checked={sharing.turbo} disabled={!sharing.enabled} onChange={enabled=>toggleOption('turbo',enabled)}/><Toggle label="Load balancing" description="Locked until Share is explicitly authorized." checked={sharing.loadBalance} disabled={!sharing.enabled} onChange={enabled=>toggleOption('loadBalance',enabled)}/><div className="idle-illustration"><div className="idle-bar"><span/></div><div><span>Currently idle resources</span><strong>≤ 15% authorized</strong></div><p>Your foreground work can reclaim the entire budget immediately.</p></div></div></div></section>}
        {data && (page==='governance'||page==='ledger'||page==='codex') && chainMalformed && <div className="error-banner" role="alert">Saved governance history has an invalid structure. Governance is locked; the existing history has been preserved.</div>}
        {data && !chainMalformed && (page==='governance'||page==='ledger') && <GovernanceWorkbench operator={data.capsule.owner_id} chain={chain} view={page==='ledger' ? 'ledger' : 'workbench'} onChainChange={persistChain}/>}
        {data && !chainMalformed && page==='codex' && <CodexLab chain={chain} onChainChange={persistChain}/>}
        {page==='forum' && <SharedForum/>}
        <footer className="workspace-footer"><span>Oracle Mechanism of Interlock</span><span>Built for people. Governed by people.<span className="footer-star">✦</span></span></footer>
      </main>
    </div>
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
    {toast && <div className="toast" aria-hidden="true"><span className="toast-check"><Icon name="check" size={15}/></span>{toast}</div>}
    {authOpen && <Modal title={vaultExists ? 'Welcome back.' : 'A space that is yours.'} onClose={()=>{if(!authBusy)setAuthOpen(false)}}><div className="auth-emblem"><OmiMark/></div><span className="eyebrow">PERSONAL CAPSULE</span><h2>{vaultExists ? 'Welcome back.' : 'A space that is yours.'}</h2><p>{vaultExists ? 'Unlock your encrypted capsule on this browser.' : 'Create a local identity to keep your apps, preferences, and governance history together.'}</p><form onSubmit={authenticate} aria-busy={authBusy}>{!vaultExists&&<><label htmlFor="capsule-name">What should we call you?</label><input id="capsule-name" disabled={authBusy} autoComplete="nickname" maxLength={80} value={displayName} onChange={e=>setDisplayName(e.target.value)} required placeholder="Your name" autoFocus/></>}<label htmlFor="capsule-pin">{vaultExists ? 'Your PIN' : 'Choose a PIN'}</label><p id="capsule-pin-help" className="field-help">Use 8 to 64 digits. Your PIN unlocks this browser’s encrypted capsule; there is no PIN recovery in this edition.</p><input id="capsule-pin" aria-describedby={`capsule-pin-help${authError ? ' capsule-auth-error' : ''}`} aria-invalid={authError ? true : undefined} disabled={authBusy} type="password" inputMode="numeric" pattern="[0-9]{8,64}" minLength={8} maxLength={64} autoComplete={vaultExists ? 'current-password' : 'new-password'} value={pin} onChange={e=>setPin(e.target.value)} required placeholder="At least 8 digits" autoFocus={vaultExists}/>{!vaultExists&&<><label htmlFor="capsule-pin-confirm">Confirm your PIN</label><input id="capsule-pin-confirm" aria-describedby={`capsule-pin-help${authError ? ' capsule-auth-error' : ''}`} aria-invalid={authError && pin !== pinConfirm ? true : undefined} disabled={authBusy} type="password" inputMode="numeric" minLength={8} maxLength={64} autoComplete="new-password" value={pinConfirm} onChange={e=>setPinConfirm(e.target.value)} required placeholder="Enter your PIN again"/></>}{authError&&<p id="capsule-auth-error" role="alert" className="error-banner">{authError}</p>}<button className="button primary full-width" disabled={authBusy} type="submit"><Icon name={vaultExists ? 'unlock' : 'capsule'}/>{authBusy ? 'Securing your capsule…' : vaultExists ? 'Unlock capsule' : 'Create my capsule'}</button></form><div className="auth-footnote"><Icon name="lock" size={15}/><p>AES-256 encryption. Stored only in this browser. Keep your PIN safe: this edition has no recovery or cloud backup. Clearing browser data removes the capsule.</p></div></Modal>}
    {consent && <Modal title="Open Eagle’s Nest" onClose={()=>setConsent(null)}><div className="consent-icon"><Icon name="bird" size={40}/></div><span className="eyebrow">CARTRIDGE PERMISSIONS</span><h2>Open Eagle’s Nest?</h2><p>This new local edition keeps a simple family board inside your Personal Capsule.</p><ul className="permission-list"><li><Icon name="check"/>Read and save only its own board</li><li><Icon name="shield"/>Run in a separate, sandboxed frame</li><li><Icon name="lock"/>No access to your capsule identity or other apps</li></ul><div className="notice"><Icon name="info"/><p>No microphone, camera, location, or network access is requested. A development signature is checked before loading.</p></div><button className="button primary full-width" onClick={()=>{setMounted(consent);setConsent(null)}}>Allow & open<Icon name="arrow"/></button><button className="button ghost full-width" onClick={()=>setConsent(null)}>Keep closed</button></Modal>}
    {mounted && data && <AccessibleDialog title="Eagle’s Nest family board" className="cartridge-dialog" describedBy="cartridge-keyboard-help" initialFocusSelector=".cartridge-host button" onClose={()=>setMounted(null)}><p id="cartridge-keyboard-help" className="sr-only">Eagle’s Nest is open in a modal workspace. Use Tab to enter the family board. Use the Close cartridge button or Escape to return to OMI.</p><CartridgeHost appId={mounted} data={data.appData[mounted]} onClose={()=>setMounted(null)} onSave={async appData=>{try{await updateData(current=>({...current,appData:{...current.appData,[mounted]:appData}}))}catch(e){setError(message(e));throw e}}}/></AccessibleDialog>}
  </div>;
}
function Stat({icon,label,value,detail,compact=false}:{icon:string;label:string;value:string;detail:string;compact?:boolean}) { return <article className="panel stat-card"><div><span>{label}</span><Icon name={icon} size={18}/></div><strong className={compact?'compact-value':''}>{value}</strong><small>{detail}</small></article>; }
function LockedView({title,exists,onOpen}:{title:string;exists:boolean;onOpen:()=>void}) { return <section className="locked-view page-enter"><div className="locked-illustration"><div/><Icon name="capsule" size={50}/><i/></div><span className="eyebrow">PERSONAL, BEFORE ANYTHING ELSE</span><h1>{title}</h1><p>{exists ? 'Your encrypted capsule is waiting on this browser. Unlock it to continue.' : 'Create your encrypted Personal Capsule to open your apps, set privacy boundaries, and record governance decisions.'}</p><button className="button primary" onClick={onOpen}><Icon name={exists ? 'unlock' : 'capsule'}/>{exists ? 'Unlock your capsule' : 'Create your capsule'}<Icon name="arrow" size={17}/></button><div className="locked-assurances"><span><Icon name="lock" size={15}/>Encrypted local storage</span><span><Icon name="shield" size={15}/>Private by default</span><span><Icon name="share" size={15}/>Sharing starts off</span></div></section>; }
function Toggle({label,description,checked,onChange,disabled=false}:{label:string;description:string;checked:boolean;onChange:(enabled:boolean)=>void;disabled?:boolean}) { return <label className={`toggle-row ${disabled?'disabled':''}`}><span><strong>{label}</strong><small>{description}</small></span><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e=>onChange(e.target.checked)}/></label>; }
function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) { return <AccessibleDialog title={title} onClose={onClose}><div className="modal-body"><button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><Icon name="close"/></button>{children}</div></AccessibleDialog>; }
