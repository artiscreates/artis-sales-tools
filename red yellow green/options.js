const DEFAULTS = { token: '', windowDays: 45, banner: true, highlight: true };
const $ = (id) => document.getElementById(id);

function show(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.className = ok ? 'ok' : 'bad';
  m.style.display = 'block';
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('token').value = s.token;
  $('window').value = s.windowDays;
  $('banner').checked = s.banner;
  $('highlight').checked = s.highlight;
});

async function save() {
  const windowDays = Math.max(1, Math.min(730, parseInt($('window').value, 10) || 45));
  await chrome.storage.sync.set({
    token: $('token').value.trim(),
    windowDays,
    banner: $('banner').checked,
    highlight: $('highlight').checked
  });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
}

$('save').addEventListener('click', async () => { await save(); show('Saved. Reload open tabs to apply.', true); });
$('test').addEventListener('click', async () => {
  await save();
  show('Testing…', true);
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  if (r?.ok) show(`Connected to HubSpot portal ${r.portalId ?? '(ID hidden)'} · ${r.owners} owners found.`, true);
  else show(r?.error || 'Connection failed.', false);
});
