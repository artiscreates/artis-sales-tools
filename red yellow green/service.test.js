import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const origin = `chrome-extension://${extensionId}`;
const store = `/tmp/crm-check-oauth-test-${process.pid}.enc`;
process.env.NODE_ENV = 'test';
process.env.CRM_CHECK_URL = 'http://localhost:3000';
process.env.CRM_CHECK_EXTENSION_ID = extensionId;
process.env.HUBSPOT_CLIENT_ID = 'test-client';
process.env.HUBSPOT_CLIENT_SECRET = 'test-secret';
process.env.HUBSPOT_ALLOWED_PORTAL_IDS = '12345';
process.env.CRM_CHECK_STORE_KEY = randomBytes(32).toString('hex');
process.env.CRM_CHECK_STORE = store;

const nativeFetch = globalThis.fetch;
let refreshed = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.pathname === '/oauth/2026-03/token') {
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'authorization_code') return Response.json({
      access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 0,
      hub_id: 12345, user_id: 987, scopes: ['oauth', 'crm.objects.companies.read', 'crm.objects.contacts.read', 'crm.objects.owners.read']
    });
    refreshed++;
    assert.equal(form.get('refresh_token'), 'refresh-1');
    return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
  }
  if (url.pathname === '/oauth/2026-03/token/revoke') return new Response(null, { status: 204 });
  if (url.pathname === '/crm/v3/owners') {
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer access-2');
    return Response.json({ results: [{ id: '7', firstName: 'Rep' }] });
  }
  throw new Error(`Unexpected mocked HubSpot request: ${url.pathname}`);
};

const { handle } = await import('./service.js');
async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const response = { status: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    writeHead(status, values = {}) { this.status = status; for (const [k, v] of Object.entries(values)) this.headers[k.toLowerCase()] = v; return this; },
    end(value = '') { this.body = value; return this; } };
  const normalized = Object.fromEntries(Object.entries({ origin, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { url: path, method, headers: normalized, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
  await handle(req, response);
  return { status: response.status, headers: response.headers, json: async () => JSON.parse(response.body || 'null') };
}
after(async () => {
  globalThis.fetch = nativeFetch;
  await rm(store, { force: true });
});

test('OAuth state, exchange, refresh, read-only routing, and disconnect', async () => {
  const invalid = await call('/oauth/callback?state=wrong&code=no');
  assert.equal(invalid.status, 400);

  const state = randomBytes(32).toString('hex');
  const start = await call(`/oauth/start?state=${state}`);
  assert.equal(start.status, 302);
  const auth = new URL(start.headers.location);
  assert.equal(auth.searchParams.get('state'), state);
  assert.equal(auth.searchParams.get('scope'), 'oauth crm.objects.companies.read crm.objects.contacts.read crm.objects.owners.read');

  const callback = await call(`/oauth/callback?state=${state}&code=single-use`);
  assert.equal(callback.status, 302);
  const redirect = new URL(callback.headers.location);
  assert.equal(redirect.hostname, `${extensionId}.chromiumapp.org`);
  const claim = await call('/oauth/claim', { method: 'POST', body: { ticket: redirect.searchParams.get('ticket'), state } });
  assert.equal(claim.status, 200);
  const { sessionToken, portalId } = await claim.json();
  assert.equal(portalId, 12345);

  const forbidden = await call('/api/hubspot', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: { path: '/crm/v3/objects/contacts', method: 'DELETE' } });
  assert.equal(forbidden.status, 403);
  const privateField = await call('/api/hubspot', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: { path: '/crm/v3/objects/contacts/search', method: 'POST', body: { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: ['person@example.com'] }] }], properties: ['password'], limit: 10 } } });
  assert.equal(privateField.status, 403);
  const owners = await call('/api/hubspot', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: { path: '/crm/v3/owners?limit=500' } });
  assert.equal(owners.status, 200);
  assert.equal((await owners.json()).results[0].firstName, 'Rep');
  assert.equal(refreshed, 1);

  const disconnect = await call('/session', { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
  assert.equal(disconnect.status, 204);
  const after = await call('/api/hubspot', { method: 'POST', headers: { Authorization: `Bearer ${sessionToken}` }, body: { path: '/crm/v3/owners?limit=500' } });
  assert.equal(after.status, 401);
});
