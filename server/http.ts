import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { ForumStore, ForumStoreError, type Participant } from './forum-store.ts';

export type ForumServerOptions = {
  store: ForumStore;
  staticDir?: string;
  publicOrigin?: string;
  rateLimit?: { requests?: number; failures?: number; windowMs?: number };
};
const API = '/api/forum/v1';
const MAX_BODY = 65_536;
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function fault(status: number, code: string, message: string): never { throw new ForumStoreError(status, code, message); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') fault(415, 'JSON_REQUIRED', 'Send application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') fault(415, 'ENCODING_UNSUPPORTED', 'Compressed request bodies are not accepted.');
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_BODY) fault(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY) fault(413, 'BODY_TOO_LARGE', 'Request body is too large.');
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { fault(400, 'INVALID_JSON', 'Request body must be valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault(400, 'INVALID_JSON', 'Request body must be an object.');
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some(key => !names.includes(key))) fault(400, 'UNKNOWN_FIELD', 'Request includes an unsupported field.');
}
function integer(value: string | null, fallback: number, label: string): number {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) fault(400, 'INVALID_NUMBER', `${label} must be a nonnegative safe integer.`);
  return Number(value);
}

/** Authenticated, same-origin forum API and public compiled client. Never executes message content. */
export function createForumServer(options: ForumServerOptions) {
  const { store } = options;
  const staticRoot = options.staticDir ? resolve(options.staticDir) : null;
  const origin = options.publicOrigin ? new URL(options.publicOrigin).origin : null;
  const requestsPerWindow = options.rateLimit?.requests ?? 300;
  const failuresPerWindow = options.rateLimit?.failures ?? 20;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const clients = new Map<string, { start: number; requests: number; failures: number }>();
  function bucket(request: IncomingMessage) {
    const address = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = clients.get(address);
    if (!entry || now - entry.start >= windowMs) {
      if (clients.size >= 4096) {
        for (const [key, value] of clients) if (now - value.start >= windowMs) clients.delete(key);
        if (clients.size >= 4096) clients.delete(clients.keys().next().value!);
      }
      entry = { start: now, requests: 0, failures: 0 };
      clients.set(address, entry);
    }
    entry.requests++;
    return entry;
  }
  function authenticate(request: IncomingMessage, entry: ReturnType<typeof bucket>): Participant {
    const authorizationCount = request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'authorization').length;
    const match = authorizationCount === 1 && /^Bearer ([A-Za-z0-9._~-]{24,512})$/i.exec(request.headers.authorization ?? '');
    const actor = match ? store.authenticate(match[1]) : null;
    if (!actor) { entry.failures++; fault(401, 'UNAUTHENTICATED', 'A valid participant bearer token is required.'); }
    return actor;
  }
  return createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (origin?.startsWith('https://')) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(request.url ?? '/', 'http://omi.invalid');
      const method = request.method ?? 'GET';
      if (url.pathname === '/health' && method === 'GET') { json(response, 200, { ok: true, service: 'omi-forum', version: '1.0.0' }); return; }
      if (url.pathname === API || url.pathname.startsWith(`${API}/`)) {
        const entry = bucket(request);
        if (entry.requests > requestsPerWindow || entry.failures >= failuresPerWindow) {
          response.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
          fault(429, 'RATE_LIMITED', 'Too many requests. Retry later.');
        }
        if (request.headers.origin) {
          let same = false;
          try {
            const supplied = new URL(request.headers.origin);
            same = supplied.origin !== 'null' && (origin ? supplied.origin === origin : ['http:', 'https:'].includes(supplied.protocol) && supplied.host === request.headers.host);
          } catch {}
          if (!same) fault(403, 'ORIGIN_DENIED', 'This API accepts same-origin browser requests only.');
        }
        if (method === 'OPTIONS') fault(403, 'CROSS_ORIGIN_UNSUPPORTED', 'Cross-origin browser access is not enabled.');
        if ([...url.searchParams.keys()].some(key => /token|key|authorization/i.test(key))) fault(400, 'QUERY_CREDENTIALS_DENIED', 'Credentials must use the Authorization header.');
        const actor = authenticate(request, entry);
        if (url.pathname === `${API}/identity` && method === 'GET') { json(response, 200, { participant: actor }); return; }
        if (url.pathname === `${API}/participants` && method === 'GET') { json(response, 200, { participants: store.listParticipants() }); return; }
        if (url.pathname === `${API}/participants` && method === 'POST') {
          if (actor.role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An administrator must create participant identities.');
          const input = await body(request); fields(input, ['id', 'name', 'role']);
          if (authenticate(request, entry).role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An active administrator is required.');
          const token = randomBytes(32).toString('base64url');
          const participant = store.createParticipant({ id: input.id as string, name: input.name as string, role: (input.role ?? 'participant') as 'admin' | 'participant', token });
          json(response, 201, { participant, token }); return;
        }
        const revoke = url.pathname.match(new RegExp(`^${API}/participants/([A-Za-z0-9_-]+)/revoke$`));
        const rotate = url.pathname.match(new RegExp(`^${API}/participants/([A-Za-z0-9_-]+)/rotate$`));
        if (rotate && method === 'POST') {
          if (actor.role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An administrator must rotate participant credentials.');
          const input = await body(request); fields(input, []);
          if (authenticate(request, entry).role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An active administrator is required.');
          const token = randomBytes(32).toString('base64url');
          const participant = store.rotateParticipantToken(rotate[1], token);
          json(response, 200, { participant, token }); return;
        }
        if (revoke && method === 'POST') {
          if (actor.role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An administrator must revoke a participant.');
          if (revoke[1] === actor.id) fault(409, 'SELF_REVOCATION_DENIED', 'Use another administrator to revoke this administrator.');
          const input = await body(request); fields(input, []);
          if (authenticate(request, entry).role !== 'admin') fault(403, 'ADMIN_REQUIRED', 'An active administrator is required.');
          store.revokeParticipant(revoke[1]); json(response, 200, { revoked: revoke[1] }); return;
        }
        if (url.pathname === `${API}/topics` && method === 'GET') { json(response, 200, { topics: store.listTopics() }); return; }
        if (url.pathname === `${API}/topics` && method === 'POST') {
          const input = await body(request); fields(input, ['title', 'body', 'clientMessageId']);
          authenticate(request, entry);
          json(response, 201, store.createTopic(actor, input as { title: string; body: string; clientMessageId: string })); return;
        }
        const reply = url.pathname.match(new RegExp(`^${API}/topics/([A-Za-z0-9_-]+)/messages$`));
        if (reply && method === 'POST') {
          const input = await body(request); fields(input, ['body', 'clientMessageId']);
          authenticate(request, entry);
          json(response, 201, { message: store.postReply(actor, reply[1], input as { body: string; clientMessageId: string }) }); return;
        }
        if (url.pathname === `${API}/messages` && method === 'GET') {
          const allowed = new Set(['after', 'limit', 'topicId']);
          if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length > 1)) fault(400, 'INVALID_QUERY', 'Unsupported or repeated message query.');
          json(response, 200, store.listMessages({ after: integer(url.searchParams.get('after'), 0, 'Cursor'), limit: integer(url.searchParams.get('limit'), 100, 'Limit'), ...(url.searchParams.has('topicId') ? { topicId: url.searchParams.get('topicId')! } : {}) })); return;
        }
        fault(404, 'NOT_FOUND', 'Forum endpoint does not exist.');
      }
      if (method !== 'GET' && method !== 'HEAD') fault(405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD can read the client.');
      if (!staticRoot) fault(404, 'NOT_FOUND', 'Client assets are not configured.');
      let decoded: string;
      try { decoded = decodeURIComponent(url.pathname); } catch { fault(400, 'INVALID_PATH', 'Invalid path encoding.'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) fault(404, 'NOT_FOUND', 'File not found.');
      let file = resolve(staticRoot, `.${decoded}`);
      if (file !== staticRoot && !file.startsWith(staticRoot + sep)) fault(404, 'NOT_FOUND', 'File not found.');
      try { if (!(await stat(file)).isFile()) file = resolve(staticRoot, 'index.html'); }
      catch { if (extname(decoded)) fault(404, 'NOT_FOUND', 'File not found.'); file = resolve(staticRoot, 'index.html'); }
      const canonicalRoot = await realpath(staticRoot);
      const canonicalFile = await realpath(file);
      if (!canonicalFile.startsWith(canonicalRoot + sep)) fault(404, 'NOT_FOUND', 'File not found.');
      const contents = await readFile(canonicalFile);
      response.setHeader('Content-Security-Policy', "frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': extname(file) === '.html' || file.endsWith('.bundle.json') ? 'no-store' : 'public, max-age=3600' });
      response.end(method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof ForumStoreError) json(response, error.status, { error: { code: error.code, message: error.message } });
      else json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
    }
  });
}
