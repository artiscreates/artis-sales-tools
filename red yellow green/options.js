const DEFAULTS = { banner: true, highlight: true };
const $ = (id) => document.getElementById(id);

function show(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.className = ok ? 'ok' : 'bad';
  m.style.display = 'block';
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('banner').checked = s.banner;
  $('highlight').checked = s.highlight;
});

async function refreshConnection() {
  const { portalId } = await chrome.storage.local.get({ portalId: null });
  $('connection').textContent = portalId ? `Connected to HubSpot portal ${portalId}.` : 'Not connected to HubSpot.';
  $('disconnect').style.display = portalId ? '' : 'none';
}
refreshConnection();

async function save() {
  await chrome.storage.sync.set({
    banner: $('banner').checked,
    highlight: $('highlight').checked
  });
  await chrome.runtime.sendMessage({ type: 'clearCache' });
}

$('save').addEventListener('click', async () => { await save(); show('Saved. Reload open tabs to apply.', true); });
$('connect').addEventListener('click', async () => {
  const serviceOrigin = new URL(self.ARTIS_CRM_SERVICE_URL).origin;
  const permission = await chrome.permissions.request({ origins: [`${serviceOrigin}/*`] });
  if (!permission) return show('Allow access to the configured Artis CRM Check service, then try again.', false);
  show('Connecting to HubSpot…', true);
  const r = await chrome.runtime.sendMessage({ type: 'connectHubSpot' });
  if (r?.ok) { await refreshConnection(); show('HubSpot connected.', true); }
  else show(r?.error || 'Connection failed.', false);
});
$('disconnect').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'disconnectHubSpot' });
  if (r?.ok) { await refreshConnection(); show('Disconnected from HubSpot.', true); }
  else show(r?.error || 'Could not disconnect.', false);
});
