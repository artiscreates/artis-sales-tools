# Artis CRM Check

A Chrome extension that shows red / yellow / green HubSpot status while reps prospect. It checks:

- **Websites:** company domains and contact email domains.
- **Instagram:** company handle or profile URL, plus the domain linked in the bio.
- **Emails:** contacts and their associated company; free email domains match by exact email only.

Results appear in a card at the bottom-right of the page and as a colored toolbar dot. Instagram also gets a status pill by the username. The popup checks a pasted website, email, or `@handle`.

## Rules

| Color | Rule |
|---|---|
| Red | Customer or former customer, open deal, email opt-out, or `notes_last_contacted` within 45 days. |
| Yellow | Any other HubSpot match. |
| Green | No HubSpot match. |

When multiple records match, the most restrictive color wins. Ownership appears in the explanation only. The 45-day window is fixed.

## OAuth architecture

Reps connect through HubSpot's sign-in and authorization flow. The extension never asks them to copy a HubSpot token. A small Node service exchanges OAuth codes, stores HubSpot access and refresh tokens encrypted, refreshes them, and proxies only the extension's read-only HubSpot endpoints. It grants no general HubSpot API proxy access.

HubSpot authorizes each rep through their own user login. This app uses the 2026.09 user-level OAuth setting so API requests follow that rep's HubSpot permissions. The initial rollout is private to the approved company portal.

## Local setup

1. Create/configure a HubSpot project-based OAuth app with scopes `oauth`, `crm.objects.companies.read`, `crm.objects.contacts.read`, and `crm.objects.owners.read`.
2. Set its OAuth redirect URL to `http://localhost:3000/oauth/callback` for local development.
3. Load the extension unpacked once and copy its extension ID from `chrome://extensions`.
4. Set `CRM_CHECK_URL=http://localhost:3000`, `CRM_CHECK_EXTENSION_ID`, `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, and the approved numeric portal ID(s) in `HUBSPOT_ALLOWED_PORTAL_IDS` (comma-separated) in the service environment. Generate a random 32-byte hex `CRM_CHECK_STORE_KEY` and keep it private.
5. Run `node 'red yellow green/service.js'` with Node 22 or newer. The encrypted token store defaults to `/tmp` locally. For hosting, set `CRM_CHECK_STORE` to a durable mounted volume path and keep one service instance; back up the encryption key separately.
6. For local testing, set `service-config.js` to `http://localhost:3000`; for the packaged release, it points at the deployed HTTPS service URL and `manifest.json` grants optional host access only to localhost and that service.
7. Load the extension from `chrome://extensions`, open Settings, and select **Connect HubSpot**.

Do not commit OAuth credentials, the encryption key, or the encrypted token store. Never use a committed HubSpot token. The service only supports the API reads in `background.js`. Its `/health` endpoint is available for a host health check.

## Distribution and production activation

Publish privately or unlisted through the Chrome Web Store, or use the organization's managed Chrome deployment. Configure the HubSpot project app to allowlist the approved portal and use the deployed service callback URL. Production hosting, HubSpot app creation/configuration, and extension publishing require separate approval. Do not use the local development OAuth credentials in production.
