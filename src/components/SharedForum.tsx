import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from './Icons';

type Participant = { id: string; name: string; role: string; createdAt: string };
type Topic = { id: string; title: string; createdBy: string; createdAt: string };
type ForumMessage = { id: string; sequence: number; topicId: string; participantId: string; body: string; createdAt: string; clientMessageId: string };
type RequestGroup = 'identity' | 'topics' | 'participants' | 'messages' | 'post';
type Attempt = { fingerprint: string; clientMessageId: string };
class ForumError extends Error { constructor(message: string, readonly status = 0) { super(message); } }
const API = '/api/forum/v1';
const serviceUnavailable = 'Forum service is not running or cannot be reached. Ask the administrator to start the forum API, then retry.';
const aborted = () => new DOMException('The forum request was cancelled.', 'AbortError');
function isAbort(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validDate(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function participantFrom(value: unknown): Participant {
  if (!object(value) || !text(value.id) || !text(value.name) || !text(value.role) || !validDate(value.createdAt)) throw new ForumError('The forum returned an invalid participant identity.');
  return { id: value.id, name: value.name, role: value.role, createdAt: value.createdAt };
}
function topicFrom(value: unknown): Topic {
  if (!object(value) || !text(value.id) || !text(value.title) || value.title.length > 200 || !text(value.createdBy) || !validDate(value.createdAt)) throw new ForumError('The forum returned an invalid topic.');
  return { id: value.id, title: value.title, createdBy: value.createdBy, createdAt: value.createdAt };
}
function messageFrom(value: unknown): ForumMessage {
  if (!object(value) || !text(value.id) || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !text(value.topicId) || !text(value.participantId) || !text(value.body) || value.body.length > 12000 || !validDate(value.createdAt) || !text(value.clientMessageId)) throw new ForumError('The forum returned an invalid message.');
  return { id: value.id, sequence: Number(value.sequence), topicId: value.topicId, participantId: value.participantId, body: value.body, createdAt: value.createdAt, clientMessageId: value.clientMessageId };
}
function sortTopics(topics: Topic[]) { return [...topics].sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)); }
function sameAttempt(previous: Attempt | null, payload: unknown): Attempt {
  const fingerprint = JSON.stringify(payload);
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, clientMessageId: crypto.randomUUID() };
}

export default function SharedForum() {
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginInvalid, setLoginInvalid] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [participants, setParticipants] = useState<Record<string, Participant>>({});
  const [selected, setSelected] = useState<Topic | null>(null);
  const [messages, setMessages] = useState<ForumMessage[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reading, setReading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [postBusy, setPostBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Enter your personal forum token to connect.');
  const [newTopicOpen, setNewTopicOpen] = useState(false);
  const [topicTitle, setTopicTitle] = useState('');
  const [topicBody, setTopicBody] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const tokenRef = useRef('');
  const participantRef = useRef<Participant | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const selectionRef = useRef(0);
  const selectedRef = useRef<Topic | null>(null);
  const messagesRef = useRef<ForumMessage[]>([]);
  const cursorRef = useRef(0);
  const moreRef = useRef(false);
  const controllers = useRef(new Map<AbortController, RequestGroup>());
  const readRef = useRef<{ selection: number; topicId: string } | null>(null);
  const loginRef = useRef(false);
  const postingRef = useRef(false);
  const refreshRef = useRef(false);
  const draftOwnerRef = useRef<string | null>(null);
  const topicAttemptRef = useRef<Attempt | null>(null);
  const replyAttemptsRef = useRef<Record<string, Attempt>>({});
  const tokenFieldRef = useRef<HTMLInputElement>(null);
  const newTitleRef = useRef<HTMLInputElement>(null);
  const threadHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<() => void>(() => {});

  function abortRequests(group?: RequestGroup) {
    for (const [controller, currentGroup] of controllers.current) if (!group || currentGroup === group) controller.abort();
  }
  function clearDrafts() {
    setTopicTitle(''); setTopicBody(''); setReplyDrafts({}); setNewTopicOpen(false);
    topicAttemptRef.current = null; replyAttemptsRef.current = {}; draftOwnerRef.current = null;
  }
  function disconnect(reason = 'Disconnected. Your access token has been forgotten.', preserveDrafts = false) {
    epochRef.current++; selectionRef.current++; abortRequests(); tokenRef.current = ''; participantRef.current = null;
    selectedRef.current = null; messagesRef.current = []; cursorRef.current = 0; moreRef.current = false; readRef.current = null;
    loginRef.current = false; postingRef.current = false; refreshRef.current = false;
    setParticipant(null); setTokenInput(''); setTopics([]); setParticipants({}); setSelected(null); setMessages([]); setCursor(0); setHasMore(false);
    setLoginBusy(false); setPostBusy(false); setReading(false); setRefreshing(false); setOnline(false); setLastRefresh(null); setStatus(reason);
    if (!preserveDrafts) clearDrafts();
    requestAnimationFrame(() => { if (mountedRef.current) tokenFieldRef.current?.focus(); });
  }
  async function request(path: string, group: RequestGroup, options: { method?: string; body?: unknown; token?: string } = {}): Promise<unknown> {
    const epoch = epochRef.current;
    const token = options.token ?? tokenRef.current;
    if (!token) throw new ForumError('Enter your personal forum access token.');
    const controller = new AbortController(); controllers.current.set(controller, group);
    try {
      const response = await fetch(`${API}${path}`, {
        method: options.method ?? 'GET', signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!mountedRef.current || epoch !== epochRef.current) throw aborted();
      if (response.status === 401) {
        const detail = 'Your forum access token is invalid or has been revoked. Ask the administrator for access, then reconnect. Unsent drafts are kept in this view for the same participant.';
        disconnect(detail, true); setLoginInvalid(true); setError(detail);
        throw new ForumError(detail, 401);
      }
      if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) throw new ForumError(serviceUnavailable, response.status);
      let data: unknown;
      try { data = await response.json(); } catch { throw new ForumError('The forum service did not return a valid JSON response. No data was accepted.', response.status); }
      if (!mountedRef.current || epoch !== epochRef.current) throw aborted();
      if (!response.ok) {
        let detail = '';
        if (object(data)) {
          if (typeof data.error === 'string') detail = data.error;
          else if (object(data.error) && typeof data.error.message === 'string') detail = data.error.message;
          else if (typeof data.message === 'string') detail = data.message;
        }
        throw new ForumError(detail ? detail.slice(0, 600) : `The forum request was not accepted (HTTP ${response.status}).`, response.status);
      }
      return data;
    } catch (cause) {
      if (isAbort(cause) || cause instanceof ForumError) throw cause;
      throw new ForumError(serviceUnavailable);
    } finally { controllers.current.delete(controller); }
  }
  function showError(cause: unknown, posting = false, silent = false) {
    if (isAbort(cause) || !mountedRef.current) return;
    setOnline(false);
    setError(cause instanceof Error ? cause.message : 'The forum request could not be completed.');
    if (cause instanceof ForumError && cause.status === 401) {
      setStatus('Forum access was rejected. Reconnect with a valid personal token. Your unsent draft remains in memory for the same participant.');
      return;
    }
    setStatus(posting ? 'The service has not acknowledged this post. Your draft is preserved; retrying unchanged content uses the same message identifier.' : 'Forum refresh failed. No new server data was accepted. Use Refresh to retry.');
    if (!silent) requestAnimationFrame(() => errorRef.current?.focus());
  }
  async function loadTopics(silent = false) {
    try {
      const data = await request('/topics', 'topics');
      if (!object(data) || !Array.isArray(data.topics)) throw new ForumError('The forum returned an invalid topic list.');
      const next = data.topics.map(topicFrom);
      setTopics(sortTopics(next)); setOnline(true); setLastRefresh(new Date().toISOString()); return next.length;
    } catch (cause) { showError(cause, false, silent); return null; }
  }
  async function loadParticipants(silent = false) {
    try {
      const data = await request('/participants', 'participants');
      if (!object(data) || !Array.isArray(data.participants)) throw new ForumError('The forum returned an invalid participant list.');
      const next = Object.fromEntries(data.participants.map(value => { const person = participantFrom(value); return [person.id, person]; }));
      setParticipants(next); return true;
    } catch (cause) { showError(cause, false, silent); return false; }
  }
  function mergeMessages(incoming: ForumMessage[]): number {
    const next = new Map(messagesRef.current.map(message => [message.id, message]));
    let count = 0;
    for (const message of incoming) { if (!next.has(message.id)) count++; next.set(message.id, message); }
    const sorted = Array.from(next.values()).sort((a,b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    messagesRef.current = sorted; setMessages(sorted); return count;
  }
  async function loadMessages(topic: Topic, after: number, selection: number, mode: 'initial'|'more'|'poll'|'refresh') {
    if (readRef.current?.selection === selection && readRef.current.topicId === topic.id) return;
    readRef.current = { selection, topicId: topic.id }; setReading(true);
    try {
      const data = await request(`/messages?after=${after}&limit=100&topicId=${encodeURIComponent(topic.id)}`, 'messages');
      if (selection !== selectionRef.current || selectedRef.current?.id !== topic.id) return;
      if (!object(data) || !Array.isArray(data.messages) || data.messages.length > 100 || !Number.isSafeInteger(data.nextCursor) || Number(data.nextCursor) < after || typeof data.hasMore !== 'boolean') throw new ForumError('The forum returned an invalid message page.');
      const next = data.messages.map(messageFrom);
      if (next.some(message => message.topicId !== topic.id || message.sequence <= after || message.sequence > Number(data.nextCursor)) || data.hasMore && Number(data.nextCursor) <= after) throw new ForumError('The forum returned an inconsistent message cursor.');
      const added = mergeMessages(next);
      cursorRef.current = Number(data.nextCursor); moreRef.current = data.hasMore;
      setCursor(Number(data.nextCursor)); setHasMore(data.hasMore); setOnline(true); setLastRefresh(new Date().toISOString());
      if (mode !== 'poll' || added) setStatus(`${added} ${added === 1 ? 'message' : 'messages'} received in ${topic.title}. ${messagesRef.current.length} loaded.${data.hasMore ? ' More messages are available.' : ''}`);
    } catch (cause) { if (selection === selectionRef.current) showError(cause, false, mode === 'poll'); }
    finally { if (selection === selectionRef.current && readRef.current?.selection === selection) { readRef.current = null; setReading(false); } }
  }
  function selectTopic(topic: Topic, firstMessage?: ForumMessage) {
    abortRequests('messages'); const selection = ++selectionRef.current;
    selectedRef.current = topic; setSelected(topic); messagesRef.current = firstMessage ? [firstMessage] : []; setMessages(messagesRef.current);
    cursorRef.current = firstMessage?.sequence ?? 0; moreRef.current = false; setCursor(cursorRef.current); setHasMore(false); readRef.current = null;
    setNewTopicOpen(false); setError(''); setStatus(`Loading ${topic.title}.`);
    requestAnimationFrame(() => threadHeadingRef.current?.focus({ preventScroll: true }));
    void loadMessages(topic, cursorRef.current, selection, 'initial');
  }
  async function connect(event: FormEvent) {
    event.preventDefault(); if (loginRef.current) return;
    const token = tokenInput.trim(); if (!token) { setLoginInvalid(true); setError('Enter the access token supplied by your forum administrator.'); tokenFieldRef.current?.focus(); return; }
    loginRef.current = true; setLoginBusy(true); setError(''); setStatus('Checking your forum identity…'); setLoginInvalid(false);
    const epoch = ++epochRef.current;
    try {
      const data = await request('/identity', 'identity', { token });
      if (!object(data)) throw new ForumError('The forum returned an invalid identity response.');
      const identity = participantFrom(data.participant);
      if (epoch !== epochRef.current || !mountedRef.current) return;
      if (draftOwnerRef.current && draftOwnerRef.current !== identity.id) clearDrafts();
      draftOwnerRef.current = identity.id; tokenRef.current = token; participantRef.current = identity; setParticipant(identity); setTokenInput('');
      setParticipants({ [identity.id]: identity }); setOnline(true); setStatus(`Connected as ${identity.name}. Loading forum topics.`);
      const loaded = await Promise.allSettled([loadTopics(), loadParticipants()]);
      if (epoch === epochRef.current && mountedRef.current && loaded[0].status === 'fulfilled' && typeof loaded[0].value === 'number' && loaded[1].status === 'fulfilled' && loaded[1].value === true) setStatus(`Connected as ${identity.name}. ${loaded[0].value} topics available.`);
      if (epoch === epochRef.current && mountedRef.current) requestAnimationFrame(() => document.getElementById('forum-topic-list-heading')?.focus());
    } catch (cause) { if (!isAbort(cause)) { setLoginInvalid(cause instanceof ForumError && cause.status === 401); showError(cause); } }
    finally { if (epoch === epochRef.current && mountedRef.current) { loginRef.current = false; setLoginBusy(false); } }
  }
  async function refreshForum(silent = false) {
    if (refreshRef.current || !tokenRef.current) return;
    refreshRef.current = true; if (!silent) { setRefreshing(true); setError(''); setStatus('Refreshing the shared forum…'); }
    const epoch = epochRef.current;
    try {
      const jobs: Promise<unknown>[] = [loadTopics(silent), loadParticipants(silent)];
      const topic = selectedRef.current;
      if (topic && !moreRef.current) jobs.push(loadMessages(topic, cursorRef.current, selectionRef.current, silent ? 'poll' : 'refresh'));
      const loaded = await Promise.allSettled(jobs);
      if (!silent && !topic && epoch === epochRef.current && mountedRef.current && loaded[0].status === 'fulfilled' && typeof loaded[0].value === 'number' && loaded[1].status === 'fulfilled' && loaded[1].value === true) setStatus(`Forum refreshed. ${loaded[0].value} topics available. Choose a topic or start a new one.`);
    } finally { if (epoch === epochRef.current && mountedRef.current) { refreshRef.current = false; setRefreshing(false); } }
  }
  async function createTopic(event: FormEvent) {
    event.preventDefault(); if (postingRef.current) return;
    const title = topicTitle.trim(), body = topicBody.trim();
    if (!title || title.length > 200 || !body || body.length > 12000) { setError('A topic needs a title of 1–200 characters and a first message of 1–12,000 characters.'); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    postingRef.current = true; setPostBusy(true); setError(''); setStatus('Sending the new topic. Waiting for the forum service to acknowledge it.');
    const epoch = epochRef.current;
    topicAttemptRef.current = sameAttempt(topicAttemptRef.current, { title, body });
    try {
      const data = await request('/topics', 'post', { method: 'POST', body: { title, body, clientMessageId: topicAttemptRef.current.clientMessageId } });
      if (!object(data)) throw new ForumError('The forum did not return an acknowledged topic.');
      const topic = topicFrom(data.topic), message = messageFrom(data.message);
      if (topic.title !== title || message.body !== body || message.topicId !== topic.id || message.participantId !== participantRef.current?.id || message.clientMessageId !== topicAttemptRef.current?.clientMessageId) throw new ForumError('The forum acknowledgement did not match this topic request.');
      if (epoch !== epochRef.current || !mountedRef.current) return;
      setTopics(current => sortTopics([...current.filter(item => item.id !== topic.id), topic])); setTopicTitle(''); setTopicBody(''); topicAttemptRef.current = null;
      selectTopic(topic, message); setOnline(true); setStatus('Your new topic was acknowledged by the forum service.');
    } catch (cause) { showError(cause, true); }
    finally { if (epoch === epochRef.current && mountedRef.current) { postingRef.current = false; setPostBusy(false); } }
  }
  async function postReply(event: FormEvent) {
    event.preventDefault(); if (postingRef.current || !selectedRef.current) return;
    const topic = selectedRef.current, selection = selectionRef.current, body = (replyDrafts[topic.id] ?? '').trim();
    if (!body || body.length > 12000) { setError('Write a message of 1–12,000 characters.'); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    postingRef.current = true; setPostBusy(true); setError(''); setStatus('Sending your reply. Waiting for the forum service to acknowledge it.');
    const epoch = epochRef.current;
    const attempt = sameAttempt(replyAttemptsRef.current[topic.id] ?? null, { topicId: topic.id, body }); replyAttemptsRef.current[topic.id] = attempt;
    try {
      const data = await request(`/topics/${encodeURIComponent(topic.id)}/messages`, 'post', { method: 'POST', body: { body, clientMessageId: attempt.clientMessageId } });
      if (!object(data)) throw new ForumError('The forum did not return an acknowledged message.');
      const message = messageFrom(data.message);
      if (message.body !== body || message.topicId !== topic.id || message.participantId !== participantRef.current?.id || message.clientMessageId !== attempt.clientMessageId) throw new ForumError('The forum acknowledgement did not match this reply.');
      if (epoch !== epochRef.current || !mountedRef.current) return;
      setReplyDrafts(current => ({ ...current, [topic.id]: '' })); delete replyAttemptsRef.current[topic.id];
      if (selection === selectionRef.current && selectedRef.current?.id === topic.id) mergeMessages([message]);
      // An acknowledged post must not advance the read cursor: other participants
      // may have posted unseen messages before this acknowledgement's sequence.
      setOnline(true); setStatus(`Your reply was acknowledged as message ${message.sequence}.`);
    } catch (cause) { showError(cause, true); }
    finally { if (epoch === epochRef.current && mountedRef.current) { postingRef.current = false; setPostBusy(false); } }
  }
  pollRef.current = () => { if (!document.hidden && tokenRef.current && participantRef.current) void refreshForum(true); };
  useEffect(() => {
    mountedRef.current = true;
    const interval = setInterval(() => pollRef.current(), 5000);
    return () => { mountedRef.current = false; epochRef.current++; selectionRef.current++; abortRequests(); tokenRef.current = ''; participantRef.current = null; clearInterval(interval); };
  }, []);
  useEffect(() => { if (newTopicOpen) newTitleRef.current?.focus(); }, [newTopicOpen]);
  function author(id: string) { return participants[id]?.name ?? (participant?.id === id ? participant.name : `Participant ${id}`); }

  return <section className="page-enter shared-forum" aria-labelledby="shared-forum-heading">
    <div className="section-heading"><div><span className="eyebrow">A SHARED PLACE FOR THE CONVERSATION</span><h1 id="shared-forum-heading">Shared forum</h1><p>Real participants. Shared topics. Messages acknowledged by the forum service.</p></div>{participant && <button className="button secondary" onClick={() => { setError(''); disconnect(); }}><Icon name="power" size={16}/>Disconnect</button>}</div>
    <div className="notice"><Icon name="info"/><p>Your forum identity is separate from your Personal Capsule. Nothing is copied between them automatically. Posting sends that message to the shared forum service. Your access token stays only in memory and is forgotten when you disconnect or leave this view.</p></div>
    <p className="forum-status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
    {error && <div ref={errorRef} className="error-banner" role="alert" tabIndex={-1}>{error}</div>}
    {!participant ? <div className="panel forum-connect-panel"><div className="orb-icon"><Icon name="share" size={26}/></div><h2>Connect as yourself.</h2><p id="forum-token-help">Ask your forum administrator for your personal access token. Every participant has their own identity. This is a forum token, separate from your Personal Capsule PIN.</p><form onSubmit={connect} aria-busy={loginBusy}><label htmlFor="forum-access-token">Forum access token</label><input ref={tokenFieldRef} id="forum-access-token" type="password" maxLength={4096} autoComplete="off" autoCapitalize="none" spellCheck={false} required aria-describedby="forum-token-help" aria-invalid={loginInvalid || undefined} disabled={loginBusy} value={tokenInput} onChange={event=>{setTokenInput(event.target.value);setLoginInvalid(false)}}/><button className="button primary" type="submit" disabled={loginBusy}>{loginBusy ? 'Checking identity…' : 'Connect to forum'}<Icon name="arrow" size={17}/></button></form><p className="fine-print">No participant identity or messages are invented when the service is unavailable. This view connects to the same-origin authenticated forum API.</p></div> : <>
      <div className="panel forum-connection"><div className="forum-participant"><span className="avatar" aria-hidden="true">{participant.name.slice(0,1).toUpperCase()}</span><div><strong>{participant.name}</strong><span>Participant <code>{participant.id}</code> · {participant.role}</span></div></div><span className={`badge ${online ? 'green' : 'amber'}`}><span className="status-dot"/>{online ? 'Service connected' : 'Refresh interrupted'}</span><div className="forum-refresh"><span>{lastRefresh ? <>Last response <time dateTime={lastRefresh}>{new Date(lastRefresh).toLocaleTimeString()}</time></> : 'Waiting for first topic response'}</span><button className="button secondary" disabled={refreshing || postBusy} onClick={()=>void refreshForum()}>{refreshing ? 'Refreshing…' : 'Refresh forum'}</button></div></div>
      <div className="forum-layout"><section className="panel forum-topics" aria-labelledby="forum-topic-list-heading"><div className="forum-topics-heading"><div><span className="eyebrow">THE CONVERSATIONS</span><h2 id="forum-topic-list-heading" tabIndex={-1}>Topics <span>({topics.length})</span></h2></div><button className="button secondary" disabled={postBusy} onClick={()=>{setNewTopicOpen(true);setError('')}}>New topic</button></div>{topics.length ? <ul>{topics.map(topic=><li key={topic.id}><button className={selected?.id===topic.id&&!newTopicOpen ? 'selected' : ''} aria-pressed={selected?.id===topic.id&&!newTopicOpen} disabled={postBusy} onClick={()=>selectTopic(topic)}><strong>{topic.title}</strong><span>{author(topic.createdBy)}</span><time dateTime={topic.createdAt}>{new Date(topic.createdAt).toLocaleDateString()}</time></button></li>)}</ul> : <div className="forum-no-topics"><Icon name="share" size={30}/><h3>No topics have been shared.</h3><p>Create a topic to start a conversation.</p></div>}<p className="fine-print">Refreshes every 5 seconds while this page is visible. Message pages contain at most 100 records.</p></section>
      <div className="forum-thread-area">{newTopicOpen ? <section className="panel forum-compose" aria-labelledby="forum-compose-heading"><h2 id="forum-compose-heading">Start a new topic</h2><p>Its first message is posted using your authenticated participant identity.</p><form onSubmit={createTopic} aria-busy={postBusy}><label htmlFor="forum-topic-title">Topic title</label><input ref={newTitleRef} id="forum-topic-title" required maxLength={200} disabled={postBusy} value={topicTitle} aria-describedby="forum-topic-title-count" onChange={event=>setTopicTitle(event.target.value)}/><p id="forum-topic-title-count" className="forum-field-count">{topicTitle.length} of 200 characters</p><label htmlFor="forum-topic-body">First message</label><textarea id="forum-topic-body" required maxLength={12000} rows={7} disabled={postBusy} value={topicBody} aria-describedby="forum-topic-body-help" onChange={event=>setTopicBody(event.target.value)}/><p id="forum-topic-body-help" className="forum-field-count">{topicBody.length} of 12,000 characters. Plain text only.</p><div className="forum-compose-actions"><button className="button primary" type="submit" disabled={postBusy}>{postBusy ? 'Awaiting acknowledgement…' : 'Create topic'}</button><button className="button ghost" type="button" disabled={postBusy} onClick={()=>{setNewTopicOpen(false);requestAnimationFrame(()=>document.getElementById('forum-topic-list-heading')?.focus())}}>Keep draft & return</button></div></form></section> : selected ? <section className="panel forum-thread" aria-labelledby="forum-thread-heading"><header className="forum-thread-heading"><span className="eyebrow">SHARED TOPIC</span><h2 ref={threadHeadingRef} id="forum-thread-heading" tabIndex={-1}>{selected.title}</h2><p>Started by {author(selected.createdBy)} · <time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString()}</time></p><details className="forum-identifiers"><summary>Topic identifier</summary><code>{selected.id}</code></details></header><div className="forum-message-pagination"><p>{messages.length} loaded · Read cursor {cursor}{hasMore ? ' · More messages available' : ''}</p>{hasMore && <button className="button secondary" disabled={reading || postBusy} onClick={()=>void loadMessages(selected,cursorRef.current,selectionRef.current,'more')}>{reading ? 'Loading…' : 'Load next 100 messages'}</button>}</div>{reading && !messages.length ? <p className="forum-loading">Loading messages from the forum service…</p> : !messages.length ? <div className="forum-empty-thread"><p>No messages have been loaded in this topic.</p></div> : <ol className="forum-messages" aria-label={`Messages in ${selected.title}`}>{messages.map(message=><li key={message.id}><article className="forum-message" aria-labelledby={`forum-message-${message.id}`}><header><div><h3 id={`forum-message-${message.id}`}>{author(message.participantId)}{message.participantId===participant.id && <span className="forum-self-label">You</span>}</h3><span>Participant <code>{message.participantId}</code></span></div><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></header><p className="forum-message-body">{message.body}</p><details className="forum-identifiers"><summary>Message {message.sequence} · identifiers</summary><dl><div><dt>Message ID</dt><dd><code>{message.id}</code></dd></div><div><dt>Global sequence</dt><dd>{message.sequence}</dd></div><div><dt>Client message ID</dt><dd><code>{message.clientMessageId}</code></dd></div></dl></details></article></li>)}</ol>}<form className="forum-reply" onSubmit={postReply} aria-busy={postBusy}><label htmlFor="forum-reply-body">Reply to {selected.title}</label><textarea id="forum-reply-body" required maxLength={12000} rows={4} disabled={postBusy} value={replyDrafts[selected.id]??''} aria-describedby="forum-reply-help" onChange={event=>setReplyDrafts(current=>({...current,[selected.id]:event.target.value}))}/><p id="forum-reply-help" className="forum-field-count">{(replyDrafts[selected.id]??'').length} of 12,000 characters. Sent as {participant.name}. Your draft stays here if acknowledgement fails.</p><button className="button primary" type="submit" disabled={postBusy}>{postBusy ? 'Awaiting acknowledgement…' : 'Post reply'}<Icon name="arrow" size={16}/></button></form></section> : <div className="panel forum-welcome"><div className="orb-icon"><Icon name="share" size={28}/></div><span className="eyebrow">THE SHARED CONVERSATION</span><h2>Choose a topic. Join the discussion.</h2><p>Read a conversation from the topic list, or start a new one. Messages appear only after the forum service returns them.</p><button className="button secondary" onClick={()=>setNewTopicOpen(true)}>Start a topic<Icon name="arrow" size={16}/></button></div>}</div></div>
    </>}
  </section>;
}
