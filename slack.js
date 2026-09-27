#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { lookup, normalizeDomain } from './lookup.js';

export function validSignature(body, timestamp, signature, secret) {
  if (!secret || !/^\d+$/.test(timestamp ?? '') ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !/^v0=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function formatResult(result) {
  const { company, people, _meta: meta } = result;
  const lines = [company.name ?? company.domain];
  if (meta.status === 'discovery_only') {
    lines.push('Candidates only; no email enrichment was requested.');
    people.forEach((person, index) => lines.push(`${index + 1}. ${person.name ?? 'Name unavailable'} — ${person.title ?? 'Title unavailable'}`));
    return lines.join('\n').slice(0, 2900);
  }
  if (meta.status === 'pending') lines.push('Lookup is still processing. Do not resubmit this lookup yet.');
  else if (meta.status === 'partial') lines.push('Lookup could not finish. Results below may be incomplete.');
  else if (!people.some(p => p.email_status === 'verified')) {
    lines.push(`No reliable contact found for ${company.domain}.`);
  }
  for (const person of people) {
    lines.push('', [person.name ?? 'Name unavailable', person.title].filter(Boolean).join(' — '));
    if (person.email) {
      lines.push(person.email, person.email_status === 'verified' ? '✓ Verified' :
        `Not verified (${person.email_status ?? 'unknown'})`);
    } else lines.push(person.enrichment_status === 'complete' ? 'No work email found.' : 'Email lookup incomplete.');
    if (person.linkedin_url) lines.push(`LinkedIn: ${person.linkedin_url}`);
  }
  return lines.join('\n').slice(0, 2900);
}

function message(text) {
  return { response_type: 'ephemeral', text,
    blocks: [{ type: 'section', text: { type: 'plain_text', text } }] };
}

function responseURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        ['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) &&
        url.pathname.startsWith('/commands/')) return url.href;
  } catch { /* Reject malformed callbacks before any paid lookup. */ }
  return null;
}

export function slackServer() {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret || !process.env.TREG_TOKEN) throw new Error('Set SLACK_SIGNING_SECRET and TREG_TOKEN before starting Slack.');
  return createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/slack/commands') return send(404, { error: 'Not found' });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65_536) return send(413, { error: 'Request too large' });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!validSignature(body, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'], secret)) {
        return send(401, { error: 'Invalid Slack signature' });
      }
      if (!req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        return send(415, { error: 'Expected a form request' });
      }
      const form = new URLSearchParams(body.toString('utf8'));
      if (form.get('command') !== '/find-contact') return send(200, message('Unknown command. Use /find-contact example.com.'));
      let domain;
      try { domain = normalizeDomain(form.get('text')); }
      catch { return send(200, message('Usage: /find-contact example.com')); }
      const callback = responseURL(form.get('response_url'));
      if (!callback) return send(400, { error: 'Invalid Slack response URL' });
      // A redelivery must not trigger another set of paid calls.
      if (req.headers['x-slack-retry-num']) return send(200, message('Request already received.'));
      send(200, message(`Looking up ${domain}. This can take several minutes.`));
      try {
        const result = await lookup(domain);
        // No credentials, callback URLs or contact records in service logs.
        console.log(JSON.stringify({ domain, status: result._meta.status, cost_usd: result._meta.cost_usd,
          calls: result._meta.calls.map(c => ({ call_id: c.call_id, http_status: c.http_status,
            call_ref: c.treg?.call_ref ?? null, idempotency_key: c.idempotency_key })) }));
        const delivered = await fetch(callback, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message(formatResult(result))) });
        if (!delivered.ok) console.error(`Slack result delivery failed: HTTP ${delivered.status}`);
      } catch {
        console.error('Slack lookup or delivery failed; inspect Treg call receipts before retrying.');
      }
    } catch {
      if (!res.headersSent) send(400, { error: 'Could not read request' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = slackServer();
    server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () => console.log('Slack command service listening.'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
