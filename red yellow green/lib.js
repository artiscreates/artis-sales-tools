// Shared, side-effect-free helpers. Loaded by the content script, the
// service worker (importScripts) and the Node tests.
(function (root) {
  const FREE_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com',
    'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net',
    'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net',
    'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com'
  ]);

  // Sites that are platforms, not a prospect's own website. The site-level
  // banner is skipped here; emails on the page are still checked.
  const PLATFORM_DOMAINS = new Set([
    'google.com', 'gmail.com', 'linkedin.com', 'instagram.com', 'facebook.com', 'x.com',
    'twitter.com', 'tiktok.com', 'youtube.com', 'pinterest.com', 'houzz.com', 'yelp.com',
    'hubspot.com', 'hubapi.com', 'hs-sites.com', 'notion.so', 'notion.site', 'slack.com',
    'airtable.com', 'clay.com', 'instantly.ai', 'apollo.io', 'zoominfo.com', 'github.com',
    'wikipedia.org', 'amazon.com', 'reddit.com', 'bing.com', 'duckduckgo.com', 'apple.com',
    'microsoft.com', 'office.com', 'live.com', 'zoom.us', 'calendly.com', 'claude.ai',
    'anthropic.com', 'openai.com', 'chatgpt.com', 'artis.ai', 'realocityapp.com',
    'squarespace.com', 'wix.com', 'wordpress.com', 'godaddy.com', 'figma.com', 'canva.com',
    'dropbox.com', 'box.com', 'vercel.app', 'railway.app', 'supabase.co', 'supabase.com',
    'threads.net', 'threads.com', 'linktr.ee', 'beacons.ai', 'linkin.bio', 'later.com', 'lnk.bio', 'bio.link', 'taplink.cc', 'msha.ke', 'stan.store'
  ]);

  const MULTI_PART_SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  const FILE_TLD = /\.(png|jpe?g|gif|webp|svg|avif|css|js|ico|bmp|tiff?)$/i;

  // "https://www.Studio-X.com/about" -> "studio-x.com"
  function normalizeDomain(input) {
    if (!input) return '';
    let s = String(input).trim().toLowerCase();
    if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0].split(':')[0];
    s = s.replace(/\.+$/, '');
    if (!s || /^\d+(\.\d+){3}$/.test(s) || !s.includes('.')) return '';
    const parts = s.split('.');
    const n = parts.length;
    const keep = n >= 3 && parts[n - 1].length === 2 && MULTI_PART_SLD.has(parts[n - 2]) ? 3 : 2;
    return parts.slice(-keep).join('.');
  }

  function normalizeEmail(e) {
    return String(e || '').trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
  }

  function isFreeMail(domainOrEmail) {
    return FREE_MAIL.has(normalizeDomain(domainOrEmail));
  }

  function isPlatform(domain) {
    return PLATFORM_DOMAINS.has(domain);
  }

  function extractEmails(text) {
    const out = new Set();
    for (const m of String(text || '').matchAll(EMAIL_RE)) {
      const e = normalizeEmail(m[0]).replace(/\.+$/, '');
      if (!FILE_TLD.test(e)) out.add(e);
    }
    return [...out];
  }

  function toMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    if (/^\d+$/.test(v)) return Number(v);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }

  // "Activity" = an email or call logged. HubSpot's "Last Contacted"
  // (notes_last_contacted) is set by logged calls, sales emails and meetings.
  function lastActivityMs(p) {
    return toMs(p.notes_last_contacted);
  }

  const RANK = { green: 0, yellow: 1, red: 2 };
  function worst(a, b) {
    if (!a) return b;
    if (!b) return a;
    return RANK[b.status] > RANK[a.status] ? b : a;
  }

  // Rules of engagement for one HubSpot company or contact record.
  //   Red:    customer lifecycle stage (current or former), an open deal,
  //           opted out of email, or an email/call logged within the window.
  //   Yellow: in HubSpot, none of the above.
  //   (Green = no record at all; decided by the caller.)
  // Ownership only affects the label, never the color.
  function evaluateRecord(props, { now = Date.now(), ownerName = null } = {}) {
    const stage = (props.lifecyclestage || '').toLowerCase();
    const openDeals = Number(props.hs_num_open_deals || 0);
    const last = lastActivityMs(props);
    const days = last === null ? null : Math.max(0, Math.floor((now - last) / 86400000));
    const owner = props.hubspot_owner_id ? ownerName || 'former rep' : null;
    const who = owner ? ` · ${owner}` : '';
    const touch = days === null ? 'no emails or calls logged' : days === 0 ? 'contacted today' : `last contacted ${days}d ago`;

    if (stage === 'customer' || stage === 'evangelist') {
      const former = String(props.customer_status || '').toLowerCase() === 'inactive';
      return { status: 'red', reason: `${former ? 'Former customer' : 'Customer'}${who}` };
    }
    if (openDeals > 0) return { status: 'red', reason: `Open deal${who}` };
    if (String(props.hs_email_optout) === 'true') return { status: 'red', reason: 'Opted out of email' };
    if (days !== null && days <= 45) return { status: 'red', reason: `${touch[0].toUpperCase()}${touch.slice(1)}${who}` };
    return { status: 'yellow', reason: `In HubSpot · ${touch}${who}` };
  }

  const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv',
    'about', 'developer', 'legal', 'web', 'emails', 'challenge', 'oauth', 'session', 'your_activity']);

  function normalizeHandle(input) {
    let s = String(input || '').trim().toLowerCase();
    if (s.includes('instagram.com')) s = s.replace(/^[a-z]+:\/\//, '').split('instagram.com/')[1] || '';
    s = s.replace(/^@/, '').split(/[/?#]/)[0];
    return /^[a-z0-9._]{1,30}$/.test(s) && !IG_RESERVED.has(s) ? s : '';
  }

  // l.instagram.com/?u=https%3A%2F%2Fstudiox.com -> studiox.com
  function unwrapLink(href) {
    try {
      const u = new URL(href);
      if (u.hostname.endsWith('instagram.com') && u.searchParams.get('u')) return u.searchParams.get('u');
      return href;
    } catch (_) { return href; }
  }

  const api = {
    normalizeDomain, normalizeEmail, isFreeMail, isPlatform, extractEmails,
    evaluateRecord, lastActivityMs, worst, normalizeHandle, unwrapLink, EMAIL_RE, FILE_TLD
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArtisCRM = api;
})(typeof self !== 'undefined' ? self : this);
