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

function summary(result) {
  const { people, _meta: meta } = result;
  const verified = new Set(people.filter(p => p.email && p.email_status === 'verified')
    .map(p => p.email.toLowerCase())).size;
  const lines = [`${people.length} contact record${people.length === 1 ? '' : 's'} · ${verified} unique provider-verified email${verified === 1 ? '' : 's'}`];
  if (meta.status === 'discovery_only') lines.push('Discovery only — emails have not been checked.');
  else if (meta.status === 'pending') lines.push('Still processing — do not resubmit this lookup yet.');
  else if (meta.status === 'partial') lines.push('Incomplete lookup — some results could not be checked.');
  else if (!people.length) lines.push('No people found.');
  else if (!people.some(p => p.email)) lines.push('No work email found.');
  return lines.join('\n');
}

function contactStatus(person, people) {
  const lines = [];
  if (person.email) {
    lines.push(person.email_status === 'verified' ? '✓ Provider verified' :
      person.email_status === 'invalid' ? '✕ Invalid email — do not use' :
      !person.email_status || person.email_status === 'unverified' ? 'Email found' :
      `Email found (${person.email_status})`);
    if (people.some(p => p !== person && p.email?.toLowerCase() === person.email.toLowerCase())) {
      lines.push('Shared email in these results — confirm identity');
    }
  } else lines.push(person.enrichment_status === 'complete' ? 'No work email found' : 'Email lookup incomplete');
  return lines.join('\n');
}

export function formatResult(result) {
  const { company, people } = result;
  const lines = [`/find-contact ${company.domain}`, company.name ?? company.domain, summary(result)];
  for (const person of people) {
    lines.push('', [person.name ?? 'Name unavailable', person.title].filter(Boolean).join(' — '));
    if (person.email) lines.push(person.email);
    if (result._meta.status !== 'discovery_only') lines.push(contactStatus(person, people));
    if (person.linkedin_url) lines.push(`LinkedIn: ${person.linkedin_url}`);
  }
  return lines.join('\n');
}

// Provider text must not create Slack mentions, links or formatting.
const slackText = value => String(value).replace(/[\r\n*_`~]/g, ' ')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function resultMessage(result) {
  const { company, people, _meta: meta } = result;
  const verified = new Set(people.filter(p => p.email && p.email_status === 'verified')
    .map(p => p.email.toLowerCase())).size;
  const invalid = new Set(people.filter(p => p.email && p.email_status === 'invalid')
    .map(p => p.email.toLowerCase())).size;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: (company.name ?? company.domain).slice(0, 150) } },
    { type: 'context', elements: [{ type: 'plain_text', text: `/find-contact ${company.domain}` }] },
    { type: 'section', fields: [
      { type: 'mrkdwn', text: `*${people.length}*\nContact records` },
      { type: 'mrkdwn', text: meta.status === 'discovery_only' ? '*Not checked*\nEmail verification' :
        `*${verified}*\nUnique provider-verified emails${invalid ? ` · ${invalid} invalid` : ''}` },
    ] },
  ];
  const notices = summary(result).split('\n').slice(1);
  if (notices.length) blocks.push({ type: 'section', text: { type: 'plain_text', text: notices.join('\n') } });
  for (const person of people) {
    let name = slackText((person.name ?? 'Name unavailable').slice(0, 200)).replace(/\|/g, ' ');
    if (person.linkedin_url) {
      try {
        const url = new URL(person.linkedin_url);
        if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
            /(^|\.)linkedin\.com$/.test(url.hostname) && url.pathname.startsWith('/in/')) {
          const href = url.href.replace(/&/g, '&amp;').replace(/\|/g, '%7C').replace(/>/g, '%3E').replace(/</g, '%3C');
          name = `<${href}|${name}>`;
        }
      } catch { /* A malformed profile must not prevent the remaining results being shown. */ }
    }
    const details = [`*${name}*`, slackText((person.title ?? 'Title unavailable').slice(0, 300))];
    const status = meta.status === 'discovery_only' ? 'Email not checked' : contactStatus(person, people).split('\n')[0];
    const email = person.email ? person.email.slice(0, 320) : '—';
    blocks.push({ type: 'divider' }, { type: 'section', fields: [
      { type: 'mrkdwn', text: details.join('\n'), verbatim: true },
      { type: 'plain_text', text: `${email}\n${status}` },
    ] });
    if (person.email && people.some(p => p !== person && p.email?.toLowerCase() === person.email.toLowerCase())) {
      blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: '⚠ Shared email across records — confirm the person before using it.' }] });
    }
  }
  blocks.push({ type: 'context', elements: [{ type: 'plain_text',
    text: 'Provider order · Leadership coverage is not guaranteed. Provider verification does not confirm current employment.' }] });
  return { text: formatResult(result), blocks };
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

async function postMessage(token, payload) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, unfurl_links: false, unfurl_media: false, parse: 'none' }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Slack post failed: ${data.error ?? response.status}`);
  if (!data.ts) throw new Error('Slack response missing message timestamp');
  return data;
}

export function slackServer() {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!secret || !process.env.TREG_TOKEN || !botToken) throw new Error('Set SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN and TREG_TOKEN before starting Slack.');
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
      const channel = form.get('channel_id');
      const user = form.get('user_id');
      if (!/^[CDG][A-Z0-9]+$/.test(channel ?? '') || !/^[UW][A-Z0-9]+$/.test(user ?? '')) {
        return send(400, { error: 'Invalid Slack channel or user' });
      }
      send(200, message(`Starting ${domain}. Results will appear in a channel thread.`));
      let parent;
      try {
        // Create the thread before paying for enrichment; no bot access means no lookup.
        parent = await postMessage(botToken, { channel,
          text: `/find-contact ${domain} — requested by <@${user}>`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `*Contact lookup: ${domain}*\nRequested by <@${user}>` } },
            { type: 'context', elements: [{ type: 'plain_text', text: 'Results will appear in this thread. A lookup can take several minutes.' }] },
          ] });
        const result = await lookup(domain);
        // No credentials, callback URLs or contact records in service logs.
        console.log(JSON.stringify({ domain, status: result._meta.status, cost_usd: result._meta.cost_usd,
          calls: result._meta.calls.map(c => ({ call_id: c.call_id, http_status: c.http_status,
            call_ref: c.treg?.call_ref ?? null, idempotency_key: c.idempotency_key })) }));
        await postMessage(botToken, { channel, thread_ts: parent.ts, ...resultMessage(result) });
      } catch (error) {
        console.error('Slack lookup or delivery failed; inspect Treg call receipts before retrying.');
        const failure = parent
          ? `Lookup or result delivery failed for ${domain}. Check the existing call receipts before retrying.`
          : `Could not start the thread for ${domain}. Add Artis Sales Tools to this channel and confirm its bot has chat:write permission. No lookup was started.`;
        try {
          if (parent) await postMessage(botToken, { channel, thread_ts: parent.ts, text: failure });
          else {
            const response = await fetch(callback, { method: 'POST', redirect: 'error',
              signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(message(failure)) });
            if (!response.ok) console.error('Slack setup error notification failed.');
          }
        } catch { console.error('Slack failure notification could not be delivered.'); }
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
