#!/usr/bin/env node
import { loadEnvFile } from 'node:process';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

try { loadEnvFile(new URL('.env', import.meta.url)); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const text = (...values) => values.find(v => typeof v === 'string' && v.trim())?.trim() ?? null;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const COMPANY_BUDGET_MICRO = 250_000;

export function normalizeDomain(input) {
  if (typeof input !== 'string' || !input.trim() || /\s/.test(input.trim())) {
    throw new Error('Supply one company website or domain.');
  }
  const url = new URL(input.includes('://') ? input.trim() : `https://${input.trim()}`);
  const domain = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(domain) || domain.length > 253 || !domain.includes('.') ||
      !/^[a-z][a-z0-9-]*$/.test(domain.split('.').at(-1)) ||
      domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Supply a public company domain or HTTP(S) website, without credentials or a port.');
  }
  return domain;
}

function emailAddress(value) {
  const email = text(value);
  return email && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email) ? email : null;
}

function linkedin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      /(^|\.)linkedin\.com$/.test(url.hostname) && url.pathname.startsWith('/in/') ? url.href : null;
  } catch { return null; }
}

export function normalizePerson(row) {
  row = object(row);
  const name = text(row.full_name, row.fullName, row.name,
    [text(row.first_name, row.firstName), text(row.last_name, row.lastName)].filter(Boolean).join(' '));
  const email = emailAddress(text(row.work_email, row.workEmail, row.email, row.value));
  // Directory confidence scores and generic "valid" fields are not mailbox verification.
  const status = text(row.email_status, row.emailStatus, row.verification?.status)?.toLowerCase();
  const verified = email && !['invalid', 'accept_all', 'catch_all', 'unknown', 'unverified'].includes(status) &&
    (row.email_verified === true || row.verified === true ||
    ['verified', 'valid', 'deliverable'].includes(status));
  return {
    name,
    title: text(row.job_title, row.jobTitle, row.title, row.position),
    linkedin_url: linkedin(text(row.linkedin_url, row.linkedinUrl, row.employee_linkedin, row.linkedin, row.linkedin_profile)),
    email,
    email_status: email ? (verified ? 'verified' : status ?? 'unverified') : null,
  };
}

export async function lookup(input, { listOnly = false } = {}) {
  const domain = normalizeDomain(input);
  const token = process.env.TREG_TOKEN;
  if (!token) throw new Error('Set TREG_TOKEN in .env or the environment.');
  const result = {
    company: { name: null, domain }, people: [],
    _meta: { status: 'complete', budget_usd: COMPANY_BUDGET_MICRO / 1e6, stop_reason: null, people_provider: null, providers_tried: [],
      email_providers: [], cost_usd: 0, calls: [], errors: [] },
  };
  const meta = result._meta;
  let stop = false;
  let spentMicro = 0;

  async function call(endpoint, body, personIndex = null) {
    const remainingMicro = COMPANY_BUDGET_MICRO - spentMicro;
    if (remainingMicro <= 0) {
      meta.status = 'partial';
      meta.stop_reason = 'budget_limit';
      stop = true;
      return null;
    }
    const maxCost = Math.min(50_000, remainingMicro) / 1e6;
    const started = Date.now();
    const idempotencyKey = randomUUID();
    const receipt = { endpoint, person_index: personIndex, idempotency_key: idempotencyKey,
      http_status: null, call_id: null, cost_usd: null, max_cost_usd: maxCost, treg: null };
    meta.calls.push(receipt);
    try {
      const response = await fetch(`https://treg.to/call/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
        headers: { 'X-Treg-Token': token, 'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey, 'X-Treg-Route-Max-Cost': String(maxCost),
          'X-Treg-Route-Waterfall': '1', 'X-Treg-Route-Strict-Filters': '1' },
        body: JSON.stringify(body),
      });
      receipt.http_status = response.status;
      receipt.call_id = response.headers.get('x-treg-call-id');
      const cost = response.headers.get('x-treg-cost-micro');
      if (cost !== null && /^\d+$/.test(cost)) receipt.cost_usd = Number(cost) / 1e6;
      const data = await response.json();
      receipt.treg = data._treg ?? data.detail ?? null;
      if (response.status === 202 || data._treg?.outcome === 'pending') {
        receipt.cost_usd = null; // A reservation is not a settled charge.
        meta.status = 'pending';
        meta.stop_reason = 'pending';
        stop = true; // Preserve descriptor; never restart this task or another provider.
        return null;
      }
      if (!response.ok) {
        const detail = object(data.detail);
        if (response.status === 402) meta.stop_reason = detail.error === 'route_max_cost' ? 'budget_limit' : 'payment_required';
        throw new Error(`Treg HTTP ${response.status}: ${text(detail.error, data.error, typeof data.detail === 'string' ? data.detail : null) ?? 'request failed'}`);
      }
      if (!data.output || typeof data.output !== 'object') throw new Error('Treg returned no output object.');
      if (data._treg?.capped && data._treg?.outcome === 'miss') {
        meta.status = 'partial';
        meta.errors.push({ endpoint, person_index: personIndex, message: 'Route cost limit reached; lookup is incomplete.' });
      }
      return data;
    } catch (error) {
      meta.errors.push({ endpoint, person_index: personIndex, message: error.message });
      meta.status = 'partial';
      // Do not burn more calls on auth, budget, malformed requests or uncertain network outcomes.
      if (receipt.http_status === null || [400, 401, 402, 403, 404, 422].includes(receipt.http_status)) stop = true;
      return null;
    } finally {
      receipt.duration_ms = Date.now() - started;
      meta.cost_usd = meta.calls.some(c => c.cost_usd === null) ? null :
        Math.round(meta.calls.reduce((sum, c) => sum + c.cost_usd, 0) * 1e6) / 1e6;
      if (receipt.cost_usd !== null) spentMicro += Math.round(receipt.cost_usd * 1e6);
      else if (meta.status !== 'pending') {
        meta.status = 'partial';
        meta.stop_reason = 'unknown_cost';
        stop = true; // Never spend again when the remaining budget cannot be established.
      }
    }
  }

  const search = await call('treg.people.search', { company_domain: domain, limit: 10 });
  if (!search) return result;
  meta.people_provider = search._treg?.served_by ?? null;
  meta.providers_tried = search._treg?.tried ?? [];
  const rows = search.output.people;
  if (rows !== null && !Array.isArray(rows)) {
    meta.errors.push({ endpoint: 'treg.people.search', message: 'Unexpected people response shape.' });
    meta.status = 'partial';
    return result;
  }
  const candidates = (rows ?? []).slice(0, 10);
  result.people = candidates.map(row => ({ ...normalizePerson(row), enrichment_status: 'not_started' }));
  result.company.name = text(...candidates.map(row => text(object(row).company?.name, object(row).organization?.name, object(row).company_name)));
  if (!result.people.length) {
    if (meta.status === 'complete') meta.status = 'no_results';
    return result;
  }
  if (listOnly) {
    if (meta.status === 'complete') meta.status = 'discovery_only';
    return result;
  }
  for (const [index, person] of result.people.entries()) {
    if (stop) break;
    const errorsBefore = meta.errors.length;
    if (!person.email && (person.name || person.linkedin_url)) {
      const identity = person.name ? { full_name: person.name, domain } : { linkedin_url: person.linkedin_url };
      const found = await call('treg.people.email.find', identity, index);
      if (found) {
        person.email = emailAddress(found.output.email);
        person.email_status = person.email ? (found.output.verified === true ? 'verified' : 'unverified') : null;
      }
    }
    if (stop) {
      person.enrichment_status = meta.status === 'pending' ? 'pending' : 'partial';
      break;
    }
    if (person.email && person.email_status !== 'verified') {
      const verified = await call('treg.people.email.verify', { email: person.email }, index);
      if (verified) {
        const status = text(verified.output.status)?.toLowerCase();
        // valid:false also covers catch-all/unknown; never collapse those to "invalid".
        person.email_status = verified.output.valid === true &&
          ['valid', 'deliverable', 'ok', 'verified'].includes(status) ? 'verified' :
          status === 'verified' ? 'unknown' : status ?? 'unknown';
      }
    }
    person.enrichment_status = stop ? (meta.status === 'pending' ? 'pending' : 'partial') :
      meta.errors.length > errorsBefore ? 'partial' : 'complete';
  }
  meta.email_providers = [...new Set(meta.calls.filter(c => c.person_index !== null)
    .map(c => c.treg?.served_by).filter(Boolean))];
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const listOnly = process.argv[3] === '--list';
    if (process.argv.length !== (listOnly ? 4 : 3)) throw new Error('Usage: node lookup.js <company-website-or-domain> [--list]');
    const result = await lookup(process.argv[2], { listOnly });
    console.log(JSON.stringify(result, null, 2));
    if (result._meta.status === 'pending') process.exitCode = 2;
    else if (result._meta.status === 'partial' || result._meta.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
