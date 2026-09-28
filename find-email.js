#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeDomain, normalizePerson } from './lookup.js';

export function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Supply a full name.');
  return value.trim().replace(/\s+/g, ' ');
}

export async function findEmail(input, fullName) {
  const domain = normalizeDomain(input);
  const name = normalizeName(fullName);
  const token = process.env.TREG_TOKEN;
  if (!token) throw new Error('Set TREG_TOKEN in .env or the environment.');
  const person = { ...normalizePerson({ full_name: name }), enrichment_status: 'partial' };
  const receipt = { endpoint: 'treg.people.email.find', person_index: 0,
    idempotency_key: randomUUID(), http_status: null, call_id: null,
    cost_usd: null, max_cost_usd: 0.05, treg: null };
  const meta = { status: 'complete', budget_usd: 0.05, stop_reason: null,
    people_provider: null, providers_tried: [], email_providers: [],
    cost_usd: null, calls: [receipt], errors: [] };
  const result = { company: { name: null, domain }, people: [person], _meta: meta };
  const started = Date.now();
  try {
    const response = await fetch('https://treg.to/call/treg.people.email.find', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { 'X-Treg-Token': token, 'Content-Type': 'application/json',
        'Idempotency-Key': receipt.idempotency_key, 'X-Treg-Route-Max-Cost': '0.05',
        'X-Treg-Route-Waterfall': '1', 'X-Treg-Route-Strict-Filters': '1' },
      body: JSON.stringify({ full_name: name, domain }),
    });
    receipt.http_status = response.status;
    receipt.call_id = response.headers.get('x-treg-call-id');
    const cost = response.headers.get('x-treg-cost-micro');
    if (cost !== null && /^\d+$/.test(cost) && Number.isSafeInteger(Number(cost))) {
      receipt.cost_usd = Number(cost) / 1e6;
    }
    const data = await response.json();
    receipt.treg = data?._treg ?? data?.detail ?? null;
    if (response.status === 202 || data?._treg?.outcome === 'pending') {
      receipt.cost_usd = null; // Reservations are not settled charges.
      meta.status = meta.stop_reason = 'pending';
      return result; // Keep the existing call reference; never resubmit.
    }
    if (!response.ok) {
      if (response.status === 402) meta.stop_reason = data?.detail?.error === 'route_max_cost' ? 'budget_limit' : 'payment_required';
      throw new Error(`Treg HTTP ${response.status}: request failed`);
    }
    const output = data?.output;
    if (!output || typeof output !== 'object' || Array.isArray(output) ||
        !Object.hasOwn(output, 'email') || (output.email !== null && typeof output.email !== 'string')) {
      throw new Error('Unexpected email finder response shape.');
    }
    const found = normalizePerson(output);
    person.email = found.email;
    person.email_status = found.email_status;
    if (output.email && !person.email) throw new Error('Email finder returned a malformed email.');
    if (data._treg?.capped && data._treg?.outcome === 'miss') {
      meta.stop_reason = 'budget_limit';
      throw new Error('Route cost limit reached; lookup is incomplete.');
    }
  } catch (error) {
    meta.status = 'partial';
    meta.errors.push({ endpoint: receipt.endpoint, person_index: 0, message: error.message });
  } finally {
    receipt.duration_ms = Date.now() - started;
    meta.cost_usd = receipt.cost_usd;
    meta.providers_tried = receipt.treg?.tried ?? [];
    meta.email_providers = receipt.treg?.served_by ? [receipt.treg.served_by] : [];
    if (receipt.cost_usd === null && meta.status !== 'pending') {
      meta.status = 'partial';
      meta.stop_reason = 'unknown_cost';
    }
    person.enrichment_status = meta.status;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length < 4) throw new Error('Usage: node find-email.js <company-website-or-domain> <full-name>');
    const result = await findEmail(process.argv[2], process.argv.slice(3).join(' '));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result._meta.status === 'pending' ? 2 : result._meta.status === 'partial' ? 1 : 0;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
