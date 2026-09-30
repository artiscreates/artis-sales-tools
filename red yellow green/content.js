(() => {
  if (window.top !== window || window.__artisCrmCheck) return;
  window.__artisCrmCheck = true;
  const { normalizeDomain, normalizeHandle, unwrapLink, isPlatform, extractEmails, EMAIL_RE, FILE_TLD } = window.ArtisCRM;

  const COLORS = {
    green: { bg: '#e7f6ec', fg: '#136c34', dot: '#1f9d55', label: 'Green' },
    yellow: { bg: '#fff5d6', fg: '#7a5a00', dot: '#e0a800', label: 'Yellow' },
    red: { bg: '#fde8e8', fg: '#9b1c1c', dot: '#e02424', label: 'Red' },
    grey: { bg: '#f1f1f1', fg: '#444', dot: '#999', label: 'CRM' }
  };
  const results = {}; // email -> status
  let site = null;
  let settings = { highlight: true, banner: true };

  // ---------- styles for in-page email highlights ----------
  const style = document.createElement('style');
  style.textContent = `
    .artis-crm-email { border-radius: 3px; padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; cursor: help; }
    .artis-crm-email[data-artis="green"]  { background: #c9eed6 !important; color: #0b4d24 !important; box-shadow: inset 0 -2px #1f9d55; }
    .artis-crm-email[data-artis="yellow"] { background: #ffecb0 !important; color: #5c4300 !important; box-shadow: inset 0 -2px #e0a800; }
    .artis-crm-email[data-artis="red"]    { background: #fcd0d0 !important; color: #7a1414 !important; box-shadow: inset 0 -2px #e02424; }
    a.artis-crm-email { text-decoration: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---------- banner (shadow DOM so page CSS can't touch it) ----------
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .card { max-width: 340px; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow: hidden; font-size: 13px; line-height: 1.35; }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 12px; cursor: pointer; }
      .dot { width: 11px; height: 11px; border-radius: 50%; flex: none; }
      .txt { flex: 1; min-width: 0; }
      .t1 { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .t2 { opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; font-size: 15px; line-height: 1; opacity: .6; }
      button:hover { opacity: 1; background: rgba(0,0,0,.07); }
      .body { display: none; padding: 0 12px 10px; }
      .open .body { display: block; }
      .row { padding: 6px 0; border-top: 1px solid rgba(0,0,0,.08); }
      .row b { font-weight: 600; }
      a { color: inherit; font-weight: 600; }
      .mini { display: none; width: 22px; height: 22px; border-radius: 50%; box-shadow: 0 3px 12px rgba(0,0,0,.25); cursor: pointer; border: 3px solid #fff; }
      .min .card { display: none; } .min .mini { display: block; }
    </style>
    <div class="wrap">
      <div class="card"><div class="head"><span class="dot"></span><div class="txt"><div class="t1"></div><div class="t2"></div></div><button class="x" title="Minimize">–</button></div><div class="body"></div></div>
      <div class="mini" title="Artis CRM Check"></div>
    </div>`;
  const $ = (s) => shadow.querySelector(s);
  $('.head').addEventListener('click', (e) => {
    if (e.target.closest('.x')) return;
    if (site?.code) chrome.runtime.sendMessage({ type: 'openOptions' });
    else $('.card').classList.toggle('open');
  });
  $('.x').addEventListener('click', () => $('.wrap').classList.add('min'));
  $('.mini').addEventListener('click', () => $('.wrap').classList.remove('min'));

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function renderBanner() {
    if (!settings.banner) return host.remove();
    const counts = { red: 0, yellow: 0, green: 0 };
    for (const v of Object.values(results)) counts[v.status]++;
    const nEmails = counts.red + counts.yellow + counts.green;
    if (!site && !nEmails) return host.remove();

    let c, t1, t2, rows = '';
    if (site?.code) {
      c = COLORS.grey; t1 = 'Artis CRM Check'; t2 = site.error;
    } else if (site) {
      c = COLORS[site.status];
      t1 = `${c.label} · ${site.title || site.domain || '@' + site.handle}`;
      t2 = site.reason;
      rows += (site.records || []).slice(0, 6).map((r) =>
        `<div class="row"><b>${esc(r.name)}</b> <span style="opacity:.7">(${r.type})</span><br>${esc(r.reason)}${r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">Open in HubSpot</a>` : ''}</div>`).join('');
      if (site.kind === 'instagram') rows = `<div class="row">Checked handle <b>@${esc(site.handle)}</b>${site.bioDomain ? ` and bio link <b>${esc(site.bioDomain)}</b>` : ' (no website in bio)'}.</div>` + rows;
      if (!site.records?.length) rows += `<div class="row">Nothing in HubSpot matches. Clear to prospect.</div>`;
    } else {
      const top = counts.red ? 'red' : counts.yellow ? 'yellow' : 'green';
      c = COLORS[top]; t1 = 'Emails on this page'; t2 = '';
    }
    if (nEmails) rows += `<div class="row">Emails on page: ${counts.red} red · ${counts.yellow} yellow · ${counts.green} green. Hover a highlighted email for details.</div>`;

    $('.card').style.background = c.bg; $('.card').style.color = c.fg;
    $('.dot').style.background = c.dot; $('.mini').style.background = c.dot;
    $('.t1').textContent = t1; $('.t2').textContent = t2 || `${nEmails} email${nEmails === 1 ? '' : 's'} checked`;
    $('.body').innerHTML = rows;
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  // ---------- email scanning + highlighting ----------
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'CODE', 'PRE', 'SVG', 'IFRAME']);

  function collectEmails() {
    const found = new Set(extractEmails(document.body?.innerText || ''));
    document.querySelectorAll('a[href^="mailto:" i]').forEach((a) => {
      extractEmails(decodeURIComponent(a.getAttribute('href').slice(7))).forEach((e) => found.add(e));
    });
    return [...found];
  }

  function paint() {
    if (!settings.highlight || !document.body) return;
    // mailto links: color the link itself
    document.querySelectorAll('a[href^="mailto:" i]').forEach((a) => {
      const em = extractEmails(decodeURIComponent(a.getAttribute('href').slice(7)))[0];
      const r = em && results[em];
      if (r) { a.classList.add('artis-crm-email'); a.dataset.artis = r.status; a.title = `Artis CRM: ${COLORS[r.status].label} · ${r.reason}`; }
    });
    // plain-text emails
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.indexOf('@') === -1) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest('.artis-crm-email, [contenteditable="true"], [contenteditable=""]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const re = new RegExp(EMAIL_RE.source, 'gi');
      let m, last = 0, frag = null;
      while ((m = re.exec(text))) {
        const em = m[0].toLowerCase().replace(/\.+$/, '');
        const r = results[em];
        if (!r || FILE_TLD.test(em)) continue;
        frag = frag || document.createDocumentFragment();
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('span');
        mark.className = 'artis-crm-email';
        mark.dataset.artis = r.status;
        mark.title = `Artis CRM: ${COLORS[r.status].label} · ${r.reason}`;
        mark.textContent = text.substr(m.index, em.length);
        if (r.url) mark.addEventListener('click', (ev) => { if (ev.altKey || ev.metaKey) { ev.preventDefault(); window.open(r.url, '_blank'); } });
        frag.appendChild(mark);
        last = m.index + em.length;
      }
      if (frag) {
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    }
  }

  // ---------- lookups ----------
  const isInstagram = /(^|\.)instagram\.com$/.test(location.hostname);
  let lastSiteKey = null;
  let busy = false;

  function instagramBioDomain() {
    const links = document.querySelectorAll('header a[href], section a[href^="https://l.instagram.com"]');
    for (const a of links) {
      const d = normalizeDomain(unwrapLink(a.href));
      if (d && !isPlatform(d)) return d;
    }
    return null;
  }

  // What the page is "about": a firm website, an Instagram profile, or nothing.
  function currentSite() {
    if (isInstagram) {
      const handle = normalizeHandle(location.pathname.split('/')[1] || '');
      if (!handle) return null;
      const bioDomain = instagramBioDomain();
      return { key: `ig:${handle}:${bioDomain || ''}`, handle, bioDomain };
    }
    const domain = normalizeDomain(location.hostname);
    return domain && !isPlatform(domain) ? { key: `d:${domain}`, domain } : null;
  }

  async function run() {
    if (busy) return;
    busy = true;
    try {
      const emails = collectEmails().filter((e) => !(e in results));
      const s = currentSite();
      const wantSite = s && s.key !== lastSiteKey;
      if (!s && site && !site.code) { site = null; renderBanner(); }
      if (!emails.length && !wantSite) { paint(); return; }
      if (wantSite) lastSiteKey = s.key;
      const r = await chrome.runtime.sendMessage({
        type: 'lookup',
        domain: wantSite ? s.domain || null : null,
        handle: wantSite ? s.handle || null : null,
        bioDomain: wantSite ? s.bioDomain || null : null,
        emails
      });
      if (!r?.ok) {
        site = { code: r?.code || 'ERR', error: r?.error || 'Lookup failed' };
        lastSiteKey = null;
      } else {
        if (wantSite) site = r.site;
        Object.assign(results, r.emails);
      }
      paint();
      renderBanner();
    } catch (_) {
      /* extension reloaded or context gone */
    } finally {
      busy = false;
    }
  }

  // Instagram is a single-page app: watch for profile changes.
  if (isInstagram) {
    let path = location.pathname;
    setInterval(() => {
      if (location.pathname !== path) {
        path = location.pathname;
        lastSiteKey = null; site = null;
        renderBanner();
        setTimeout(run, 1200);
      }
    }, 800);
  }

  let timer = null;
  const observer = new MutationObserver((muts) => {
    if (muts.every((m) => [...m.addedNodes].every((n) => n.nodeType === 1 && (n.classList?.contains('artis-crm-email') || n === host)))) return;
    clearTimeout(timer);
    timer = setTimeout(run, 1500);
  });

  chrome.storage.sync.get({ highlight: true, banner: true }).then((s) => {
    settings = s;
    run();
    if (document.body) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'pageStatus') reply({ site, emails: results });
  });
})();
