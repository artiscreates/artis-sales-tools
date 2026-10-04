importScripts('lib.js', 'service-config.js');
const { normalizeDomain, normalizeEmail, normalizeHandle, isFreeMail, isPlatform, evaluateRecord, worst } = self.ArtisCRM;

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map(); // key -> { at, value }
let owners = null; // { at, map } — active owners only
let account = null; // { portalId, uiDomain }

const COMPANY_PROPS = ['name', 'domain', 'instagram_handle', 'hubspot_owner_id', 'lifecyclestage',
  'customer_status', 'hs_num_open_deals', 'notes_last_contacted'];
const CONTACT_PROPS = ['email', 'firstname', 'lastname', 'hubspot_owner_id', 'lifecyclestage',
  'hs_email_optout', 'notes_last_contacted', 'associatedcompanyid'];

async function settings() {
  const local = await chrome.storage.local.get({ sessionToken: '' });
  return { sessionToken: local.sessionToken, windowDays: 45 };
}

async function hs(path, { method = 'GET', body } = {}, tries = 4) {
  const { sessionToken } = await settings();
  if (!sessionToken) throw Object.assign(new Error('Connect HubSpot in the extension settings.'), { code: 'NO_TOKEN' });
  const res = await fetch(`${self.ARTIS_CRM_SERVICE_URL}/api/hubspot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, method, body })
  });
  if (res.status === 401) {
    await chrome.storage.local.remove(['sessionToken', 'portalId']);
    cache.clear();
    owners = null; account = null;
    throw Object.assign(new Error('HubSpot connection expired. Reconnect in settings.'), { code: 'AUTH' });
  }
  if (res.status === 403) throw Object.assign(new Error('HubSpot access is missing a required read scope.'), { code: 'SCOPE' });
  // Search is limited to a few requests per second per portal; wait and retry.
  if (res.status === 429 && tries > 1) {
    await new Promise((r) => setTimeout(r, (Number(res.headers.get('Retry-After')) || 1) * 1000));
    return hs(path, { method, body }, tries - 1);
  }
  if (res.status === 429) throw Object.assign(new Error('HubSpot rate limit hit. Try again in a few seconds.'), { code: 'RATE' });
  if (!res.ok) throw new Error(`HubSpot error ${res.status}`);
  return res.json();
}

async function getOwners() {
  if (owners && Date.now() - owners.at < 60 * 60 * 1000) return owners.map;
  const map = {};
  let after;
  do {
    const r = await hs(`/crm/v3/owners?limit=500${after ? `&after=${after}` : ''}`);
    for (const o of r.results || []) {
      const name = [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
      map[o.id] = name || o.email || `Owner ${o.id}`;
    }
    after = r.paging?.next?.after;
  } while (after);
  owners = { at: Date.now(), map };
  return map;
}

async function getAccount() {
  if (account) return account;
  try {
    const r = await hs('/account-info/v3/details');
    account = { portalId: r.portalId, uiDomain: r.uiDomain || 'app.hubspot.com' };
  } catch (e) {
    if (e.code === 'NO_TOKEN' || e.code === 'AUTH') throw e;
    account = { portalId: null, uiDomain: 'app.hubspot.com' };
  }
  return account;
}

function recordUrl(type, id) {
  if (!account?.portalId) return null;
  return `https://${account.uiDomain}/contacts/${account.portalId}/record/${type === 'company' ? '0-2' : '0-1'}/${id}`;
}

function search(object, filterGroups, properties, limit = 10) {
  return hs(`/crm/v3/objects/${object}/search`, { method: 'POST', body: { filterGroups, properties, limit } })
    .then((r) => r.results || []);
}

async function batchRead(object, ids, properties) {
  if (!ids.length) return [];
  const r = await hs(`/crm/v3/objects/${object}/batch/read`, {
    method: 'POST', body: { properties, inputs: ids.map((id) => ({ id: String(id) })) }
  });
  return r.results || [];
}

function describe(type, rec, ctx) {
  const p = rec.properties || {};
  const ev = evaluateRecord(p, { windowDays: ctx.windowDays, ownerName: ctx.owners[p.hubspot_owner_id] });
  const name = type === 'company'
    ? p.name || p.domain
    : [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email;
  return { ...ev, type, id: rec.id, name, url: recordUrl(type, rec.id) };
}

function summarize(records, fallbackTitle) {
  if (!records.length) return { status: 'green', reason: 'Not in HubSpot', title: fallbackTitle, records: [] };
  const top = records.reduce((a, b) => worst(a, b));
  const company = records.find((r) => r.type === 'company');
  return { status: top.status, reason: top.reason, title: company ? company.name : fallbackTitle, url: top.url, records };
}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Website: companies by domain, plus contacts whose email is at that domain.
function lookupDomain(domain, ctx) {
  return cached(`d:${domain}`, async () => {
    const [companies, contacts] = await Promise.all([
      search('companies', [
        { filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] },
        { filters: [{ propertyName: 'domain', operator: 'EQ', value: `www.${domain}` }] },
        { filters: [{ propertyName: 'hs_additional_domains', operator: 'CONTAINS_TOKEN', value: domain }] }
      ], COMPANY_PROPS),
      search('contacts', [{ filters: [{ propertyName: 'hs_email_domain', operator: 'EQ', value: domain }] }], CONTACT_PROPS, 20)
    ]);
    const records = [...companies.map((c) => describe('company', c, ctx)), ...contacts.map((c) => describe('contact', c, ctx))];
    return summarize(records, domain);
  });
}

// Instagram: companies by instagram_handle, or by the handle inside the
// instagram_url field (some records only have the URL, in varying formats).
function lookupHandle(handle, ctx) {
  return cached(`h:${handle}`, async () => {
    const companies = await search('companies', [
      { filters: [{ propertyName: 'instagram_handle', operator: 'EQ', value: handle }] },
      { filters: [{ propertyName: 'instagram_handle', operator: 'EQ', value: `@${handle}` }] },
      { filters: [{ propertyName: 'instagram_url', operator: 'CONTAINS_TOKEN', value: handle }] }
    ], COMPANY_PROPS);
    return summarize(companies.map((c) => describe('company', c, ctx)), `@${handle}`);
  });
}

// Emails: the contact itself, its HubSpot company, and the firm behind its domain.
async function lookupEmails(emails, ctx, domainResults) {
  const out = {};
  const todo = emails.filter((e) => {
    const hit = cache.get(`e:${e}`);
    if (hit && Date.now() - hit.at < CACHE_TTL) { out[e] = hit.value; return false; }
    return true;
  });
  const found = {};
  for (let i = 0; i < todo.length; i += 100) {
    const res = await search('contacts', [{ filters: [{ propertyName: 'email', operator: 'IN', values: todo.slice(i, i + 100) }] }], CONTACT_PROPS, 100);
    for (const c of res) {
      const em = normalizeEmail(c.properties?.email);
      if (em) found[em] = c;
    }
  }
  const companyIds = [...new Set(Object.values(found).map((c) => c.properties?.associatedcompanyid).filter(Boolean))];
  const companies = {};
  for (let i = 0; i < companyIds.length; i += 100) {
    for (const co of await batchRead('companies', companyIds.slice(i, i + 100), COMPANY_PROPS)) companies[co.id] = describe('company', co, ctx);
  }

  for (const e of todo) {
    const d = normalizeDomain(e);
    const firm = !isFreeMail(d) ? domainResults[d] : null;
    const records = [];
    if (found[e]) {
      records.push(describe('contact', found[e], ctx));
      const co = companies[found[e].properties.associatedcompanyid];
      if (co) records.push(co);
    }
    let v;
    if (records.length) {
      v = records.reduce((a, b) => worst(a, b));
      if (firm && firm.status === 'red' && v.status !== 'red') v = { ...v, status: 'red', reason: `${v.reason} · firm: ${firm.reason}`, url: v.url || firm.url };
    } else if (firm && firm.status !== 'green') {
      v = { status: firm.status, reason: `New contact · firm: ${firm.reason}`, url: firm.url };
    } else {
      v = { status: 'green', reason: 'Not in HubSpot' };
    }
    cache.set(`e:${e}`, { at: Date.now(), value: v });
    out[e] = v;
  }
  return out;
}

async function lookup({ domain, handle, bioDomain, emails = [] }) {
  const { windowDays } = await settings();
  await getAccount();
  const ctx = { windowDays, owners: await getOwners().catch(() => ({})) };
  const cleanEmails = [...new Set(emails.map(normalizeEmail))].filter(Boolean).slice(0, 200);
  const usable = (d) => d && !isPlatform(d) && !isFreeMail(d);

  const siteDomain = domain ? normalizeDomain(domain) : '';
  const bio = bioDomain ? normalizeDomain(bioDomain) : '';
  const domains = new Set([siteDomain, bio].filter(usable));
  for (const e of cleanEmails) { const d = normalizeDomain(e); if (usable(d)) domains.add(d); }

  const domainResults = {};
  for (const d of domains) domainResults[d] = await lookupDomain(d, ctx);

  let site = null;
  const h = handle ? normalizeHandle(handle) : '';
  if (h) {
    const byHandle = await lookupHandle(h, ctx);
    const byBio = usable(bio) ? domainResults[bio] : null;
    const records = [...byHandle.records, ...(byBio?.records || [])].filter((r, i, a) => a.findIndex((x) => x.type === r.type && x.id === r.id) === i);
    site = { kind: 'instagram', handle: h, bioDomain: usable(bio) ? bio : null, ...summarize(records, `@${h}`) };
  } else if (usable(siteDomain)) {
    site = { kind: 'website', domain: siteDomain, ...domainResults[siteDomain] };
  }

  const emailResults = await lookupEmails(cleanEmails, ctx, domainResults);
  return { site, emails: emailResults };
}

async function connectHubSpot() {
  const state = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const start = `${self.ARTIS_CRM_SERVICE_URL}/oauth/start?state=${state}`;
  const redirected = await chrome.identity.launchWebAuthFlow({ url: start, interactive: true });
  if (!redirected) throw new Error('HubSpot sign-in was cancelled.');
  const returned = new URL(redirected);
  if (returned.origin !== `https://${chrome.runtime.id}.chromiumapp.org` || returned.searchParams.get('state') !== state) throw new Error('HubSpot authorization could not be verified. Try connecting again.');
  const response = await fetch(`${self.ARTIS_CRM_SERVICE_URL}/oauth/claim`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: returned.searchParams.get('ticket'), state })
  });
  const result = await response.json();
  if (!response.ok || !result.sessionToken) throw new Error(result.error || 'HubSpot connection failed.');
  await chrome.storage.local.set({ sessionToken: result.sessionToken, portalId: result.portalId });
  cache.clear(); owners = null; account = null;
  return { portalId: result.portalId };
}

async function disconnectHubSpot() {
  const { sessionToken } = await settings();
  if (sessionToken) await fetch(`${self.ARTIS_CRM_SERVICE_URL}/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${sessionToken}` } });
  await chrome.storage.local.remove(['sessionToken', 'portalId']);
  cache.clear(); owners = null; account = null;
  return { ok: true };
}

const BADGE = { red: '#e02424', yellow: '#e0a800', green: '#1f9d55' };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Colored dot on the toolbar icon for the page's site status.
  if (msg?.type === 'badge' && sender.tab) {
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: msg.status ? ' ' : '' });
    chrome.action.setTitle({ tabId, title: msg.title || 'Artis CRM Check' });
    if (msg.status) chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE[msg.status] });
    return;
  }
  if (msg?.type === 'lookup') {
    lookup(msg).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message, code: e.code }));
    return true;
  }
  if (msg?.type === 'test') {
    account = null; owners = null; cache.clear();
    Promise.all([getAccount(), getOwners()])
      .then(([a, o]) => reply({ ok: true, portalId: a.portalId, owners: Object.keys(o).length }))
      .catch((e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'connectHubSpot') {
    connectHubSpot().then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'disconnectHubSpot') {
    disconnectHubSpot().then((r) => reply(r), (e) => reply({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'clearCache') { cache.clear(); account = null; owners = null; reply({ ok: true }); }
  if (msg?.type === 'openOptions') { chrome.runtime.openOptionsPage(); reply({ ok: true }); }
});
