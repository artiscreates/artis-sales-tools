const { normalizeDomain, normalizeEmail, normalizeHandle, isPlatform } = window.ArtisCRM;
const LABEL = { green: 'Green', yellow: 'Yellow', red: 'Red' };

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function card(title, r) {
  if (!r) return '';
  const link = r.url ? `<br><a href="${esc(r.url)}" target="_blank">Open in HubSpot</a>` : '';
  const recs = (r.records || []).slice(0, 4).map((x) => `<div style="margin-top:4px">• ${esc(x.name)} (${x.type}): ${esc(x.reason)}</div>`).join('');
  return `<div class="item ${r.status}"><b>${LABEL[r.status]} · ${esc(title)}</b>${esc(r.reason)}${link}${recs}</div>`;
}
function note(msg) { return `<div class="item grey">${esc(msg)}</div>`; }

// Accepts: studio.com, https://studio.com/x, name@studio.com, @handle, instagram.com/handle
function parseInput(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (/instagram\.com\//i.test(s) || /^@[a-z0-9._]+$/i.test(s)) {
    const handle = normalizeHandle(s);
    return handle ? { handle, label: `@${handle}` } : { error: 'That doesn’t look like an Instagram profile.' };
  }
  if (s.includes('@') && !s.includes('/')) {
    const email = normalizeEmail(s);
    return { email, label: email };
  }
  const domain = normalizeDomain(s);
  if (!domain) return { error: 'Enter a website, email or @instagram handle.' };
  if (isPlatform(domain)) return { error: `${domain} is a platform site, not a firm. Paste the firm’s own website, email or @handle.` };
  return { domain, label: domain };
}

async function check(raw) {
  const q = parseInput(raw);
  if (!q) return '';
  if (q.error) return note(q.error);
  const r = await chrome.runtime.sendMessage({ type: 'lookup', domain: q.domain || null, handle: q.handle || null, emails: q.email ? [q.email] : [] });
  if (!r?.ok) return note(r?.error || 'Lookup failed');
  if (q.email) return card(q.label, r.emails[q.email]);
  return card(r.site?.title || q.label, r.site);
}

document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('out');
  out.innerHTML = note('Checking…');
  out.innerHTML = await check(document.getElementById('q').value);
});
document.getElementById('opts').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

(async () => {
  const el = document.getElementById('site');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let status = null;
  try { status = await chrome.tabs.sendMessage(tab.id, { type: 'pageStatus' }); } catch (_) { /* no content script */ }
  if (status?.site && !status.site.code) {
    const s = status.site;
    el.innerHTML = card(s.title || s.domain || `@${s.handle}`, s);
    return;
  }
  if (status?.site?.code) { el.innerHTML = note(status.site.error); return; }
  el.innerHTML = note('Open a firm’s website or Instagram profile to check it.');
})();
