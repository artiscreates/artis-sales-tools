import { createServer } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.CRM_CHECK_URL || '').replace(/\/$/, '');
const EXTENSION_ID = process.env.CRM_CHECK_EXTENSION_ID || '';
const CLIENT_ID = process.env.HUBSPOT_CLIENT_ID || '';
const CLIENT_SECRET = process.env.HUBSPOT_CLIENT_SECRET || '';
const ALLOWED_PORTALS = new Set((process.env.HUBSPOT_ALLOWED_PORTAL_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const STORE_KEY = process.env.CRM_CHECK_STORE_KEY || '';
const STORE = process.env.CRM_CHECK_STORE || join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp', 'crm-check-tokens.enc');
const CALLBACK = `${BASE}/oauth/callback`;
const TOKEN_URL = 'https://api.hubapi.com/oauth/2026-03/token';
const SCOPES = ['oauth', 'crm.objects.companies.read', 'crm.objects.contacts.read', 'crm.objects.owners.read'];
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
let db = { pending: {}, tickets: {}, sessions: {} };
let writes = Promise.resolve();
const refreshing = new Map();

if (!(BASE.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) || !/^[a-p]{32}$/.test(EXTENSION_ID) || !CLIENT_ID || !CLIENT_SECRET || !ALLOWED_PORTALS.size || [...ALLOWED_PORTALS].some((id) => !/^\d+$/.test(id)) || !/^[0-9a-f]{64}$/i.test(STORE_KEY)) {
  throw new Error('Set CRM_CHECK_URL, CRM_CHECK_EXTENSION_ID, HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET, HUBSPOT_ALLOWED_PORTAL_IDS, and a 64-character hex CRM_CHECK_STORE_KEY.');
}

const key = Buffer.from(STORE_KEY, 'hex');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const seal = (value) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), body: body.toString('base64url') });
};
const unseal = (value) => {
  const { iv, tag, body } = JSON.parse(value);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]));
};

try { db = unseal(await readFile(STORE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read encrypted CRM Check token store.'); }

async function save() {
  // ponytail: one encrypted file and one service instance; move to a shared database if replicas are needed.
  writes = writes.then(async () => {
    const tmp = `${STORE}.${process.pid}.tmp`;
    await writeFile(tmp, seal(db), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, STORE);
  });
  return writes;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

async function hubspotToken(form) {
  const values = { ...form, client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
  if (form.grant_type === 'authorization_code') values.redirect_uri = CALLBACK;
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values), signal: AbortSignal.timeout(15_000)
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error_description || value.message || 'HubSpot OAuth request failed.');
  return value;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin !== ORIGIN) return false;
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  return true;
}

function sessionFor(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token || token.length < 32) return null;
  const session = db.sessions[hash(token)];
  return session && session.sessionExpiresAt > Date.now() && ALLOWED_PORTALS.has(String(session.portalId)) ? session : null;
}

const COMPANY_FIELDS = new Set(['name', 'domain', 'instagram_handle', 'hubspot_owner_id', 'lifecyclestage', 'customer_status', 'hs_num_open_deals', 'notes_last_contacted']);
const CONTACT_FIELDS = new Set(['email', 'firstname', 'lastname', 'hubspot_owner_id', 'lifecyclestage', 'hs_email_optout', 'notes_last_contacted', 'associatedcompanyid']);
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));

function allowedPayload(path, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (path === '/crm/v3/objects/companies/batch/read') {
    return onlyKeys(payload, ['properties', 'inputs']) && Array.isArray(payload.properties) && payload.properties.length > 0 && payload.properties.every((p) => COMPANY_FIELDS.has(p)) && Array.isArray(payload.inputs) && payload.inputs.length > 0 && payload.inputs.length <= 100 && payload.inputs.every((item) => onlyKeys(item, ['id']) && /^\d+$/.test(String(item.id)));
  }
  const object = path.match(/^\/crm\/v3\/objects\/(companies|contacts)\/search$/)?.[1];
  if (!object || !onlyKeys(payload, ['filterGroups', 'properties', 'limit']) || !Array.isArray(payload.properties) || !payload.properties.length || !Array.isArray(payload.filterGroups) || !payload.filterGroups.length || payload.filterGroups.length > 3 || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 100) return false;
  const fields = object === 'companies' ? COMPANY_FIELDS : CONTACT_FIELDS;
  const filters = object === 'companies'
    ? { domain: ['EQ'], hs_additional_domains: ['CONTAINS_TOKEN'], instagram_handle: ['EQ'], instagram_url: ['CONTAINS_TOKEN'] }
    : { hs_email_domain: ['EQ'], email: ['IN'] };
  return payload.properties.every((p) => fields.has(p)) && payload.filterGroups.every((group) => onlyKeys(group, ['filters']) && Array.isArray(group.filters) && group.filters.length > 0 && group.filters.every((filter) => onlyKeys(filter, ['propertyName', 'operator', 'value', 'values']) && filters[filter.propertyName]?.includes(filter.operator) && (filter.operator === 'IN' ? !('value' in filter) && Array.isArray(filter.values) && filter.values.length > 0 && filter.values.length <= 100 && filter.values.every((v) => typeof v === 'string' && v.length <= 500) : !('values' in filter) && typeof filter.value === 'string' && filter.value.length <= 500)));
}

async function hubspot(session, path, method, payload) {
  // Only the extension's existing read endpoints may pass through this service.
  const allowed = method === 'GET'
    ? /^\/(account-info\/v3\/details|crm\/v3\/owners)(\?limit=\d+(?:&after=[\w%.-]+)?)?$/.test(path)
    : method === 'POST' && allowedPayload(path, payload);
  if (!allowed) throw Object.assign(new Error('HubSpot read route is not allowed.'), { status: 403 });

  async function refresh() {
    if (!refreshing.has(session)) refreshing.set(session, (async () => {
      const value = await hubspotToken({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
      session.accessToken = value.access_token;
      session.refreshToken = value.refresh_token || session.refreshToken;
      session.expiresAt = Date.now() + Number(value.expires_in) * 1000;
      await save();
    })().finally(() => refreshing.delete(session)));
    return refreshing.get(session);
  }
  if (Date.now() > session.expiresAt - 60_000) await refresh();
  const send = () => fetch(`https://api.hubapi.com${path}`, {
    method, headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15_000)
  });
  let response = await send();
  if (response.status === 401) {
    await refresh();
    response = await send();
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function handle(req, res) {
  const url = new URL(req.url, BASE);
  if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true });
  const browserFlow = (url.pathname === '/oauth/start' && req.method === 'GET') || (url.pathname === '/oauth/callback' && req.method === 'GET');
  if (!browserFlow && !cors(req, res)) return json(res, 403, { error: 'Extension origin not allowed.' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/oauth/start' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      if (!/^[a-f0-9]{64}$/i.test(state)) return json(res, 400, { error: 'Invalid OAuth state.' });
      for (const [k, expiresAt] of Object.entries(db.pending)) if (expiresAt < Date.now()) delete db.pending[k];
      for (const [k, ticket] of Object.entries(db.tickets)) if (ticket.expiresAt < Date.now()) { delete db.sessions[ticket.session]; delete db.tickets[k]; }
      db.pending[hash(state)] = Date.now() + 10 * 60_000;
      await save();
      const authorize = new URL('https://app.hubspot.com/oauth/authorize');
      authorize.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: CALLBACK, scope: SCOPES.join(' '), state });
      res.setHeader('Cache-Control', 'no-store');
      res.writeHead(302, { Location: authorize.toString() });
      return res.end();
    }
    if (url.pathname === '/oauth/callback' && req.method === 'GET') {
      const state = url.searchParams.get('state') || '';
      const stateKey = hash(state);
      if (!state || !db.pending[stateKey] || db.pending[stateKey] < Date.now()) return res.writeHead(400).end('OAuth state expired. Return to the extension and connect again.');
      delete db.pending[stateKey];
      await save();
      if (url.searchParams.has('error')) return res.writeHead(400).end('HubSpot authorization was not completed. Return to the extension and try again.');
      const code = url.searchParams.get('code');
      if (!code) throw new Error('HubSpot did not return an authorization code.');
      const token = await hubspotToken({ grant_type: 'authorization_code', code });
      const portalId = token.hub_id;
      if (!portalId || !ALLOWED_PORTALS.has(String(portalId)) || !SCOPES.every((scope) => (token.scopes || []).includes(scope))) throw new Error('This HubSpot portal is not approved or did not grant the required read-only access.');
      const sessionToken = randomBytes(32).toString('base64url');
      const ticket = randomBytes(32).toString('base64url');
      db.sessions[hash(sessionToken)] = {
        accessToken: token.access_token, refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in) * 1000, portalId,
        userId: token.user_id || null, createdAt: Date.now(), sessionExpiresAt: Date.now() + 30 * 86400_000
      };
      db.tickets[hash(ticket)] = { session: hash(sessionToken), sessionToken, state: stateKey, expiresAt: Date.now() + 60_000 };
      await save();
      const redirect = new URL(`https://${EXTENSION_ID}.chromiumapp.org/oauth`);
      redirect.search = new URLSearchParams({ ticket, state });
      res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (url.pathname === '/oauth/claim' && req.method === 'POST') {
      const { ticket, state } = await body(req);
      const stateKey = hash(String(state || ''));
      const ticketKey = hash(String(ticket || ''));
      const entry = db.tickets[ticketKey];
      if (!entry || entry.expiresAt < Date.now() || entry.state !== stateKey) return json(res, 400, { error: 'Connection expired. Please connect again.' });
      delete db.tickets[ticketKey];
      await save();
      return json(res, 200, { sessionToken: entry.sessionToken, portalId: db.sessions[entry.session]?.portalId });
    }
    if (url.pathname === '/api/hubspot' && req.method === 'POST') {
      const session = sessionFor(req);
      if (!session) return json(res, 401, { error: 'Connect HubSpot again.' });
      const { path, method = 'GET', body: payload } = await body(req);
      try {
        const result = await hubspot(session, String(path || ''), method, payload);
        if (result.status === 401) {
          const token = req.headers.authorization.slice(7);
          delete db.sessions[hash(token)];
          await save();
          return json(res, 401, { error: 'HubSpot connection expired. Reconnect in extension settings.' });
        }
        return json(res, result.status, result.body);
      } catch (e) {
        if (e.status === 401 || /refresh_token|invalid_grant/i.test(e.message)) {
          const token = req.headers.authorization.slice(7);
          delete db.sessions[hash(token)];
          await save();
          return json(res, 401, { error: 'HubSpot connection expired. Reconnect in extension settings.' });
        }
        throw e;
      }
    }
    if (url.pathname === '/session' && req.method === 'DELETE') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const session = sessionFor(req);
      if (!session) return json(res, 204, {});
      try { await fetch('https://api.hubapi.com/oauth/2026-03/token/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: session.refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }), signal: AbortSignal.timeout(10_000) }); } catch { /* remove local credentials even if revoke is unavailable */ }
      delete db.sessions[hash(token)];
      await save();
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    return json(res, 404, { error: 'Not found.' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.status ? e.message : 'HubSpot connection failed. Try again.' });
  }
}

const server = createServer(handle);

if (process.env.NODE_ENV !== 'test') server.listen(PORT, () => process.stdout.write(`CRM Check OAuth service listening on ${PORT}\n`));

export { server, handle };
