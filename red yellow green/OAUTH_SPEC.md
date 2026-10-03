# Artis CRM Check OAuth specification

## Goal

Let each sales rep install the Chrome extension and connect to HubSpot through HubSpot's own sign-in and authorization screen. Preserve the existing red/yellow/green prospecting checks and keep HubSpot access read-only.

## User experience

1. The rep installs Artis CRM Check.
2. In extension settings, the rep selects **Connect HubSpot**.
3. Chrome opens the HubSpot OAuth flow. The rep signs in, selects the Artis HubSpot portal, and authorizes the requested read-only scopes.
4. The extension shows the connected portal and offers reconnect and disconnect controls.
5. If authorization expires or is revoked, the extension asks the rep to reconnect and does not present stale cached results as current.

## Existing checks to preserve

- Website domain: match HubSpot company domains and contact email domains.
- Instagram: match the handle on the company and check the bio-link domain as a website.
- Email: match the contact, its associated company, and the company behind its domain; match free-mail domains by exact email only.
- Green: no HubSpot match.
- Red: customer or former customer lifecycle, an open deal, email opt-out, or `notes_last_contacted` within 45 days.
- Yellow: any other HubSpot match.
- The most restrictive result wins across matched records. Owner names may appear in the explanation but never affect color.
- All color rules remain in `evaluateRecord` in `lib.js`. The activity window is fixed at 45 days.
- Reads remain limited to companies, contacts, and owners. No CRM writes, HubSpot workflows, or unrelated sales-tool changes.

## OAuth and service boundary

- Build a HubSpot project-based app with OAuth and private distribution to the intended HubSpot portal(s). New app work uses the current Projects platform, not a newly created legacy public app.
- OAuth client credentials, authorization-code exchange, refresh-token rotation, and HubSpot API requests must run in a small hosted service. The extension must not contain the OAuth client secret or a HubSpot private/service key.
- Keep long-lived refresh tokens server-side, encrypted at rest, associated with the authorized HubSpot portal, and inaccessible to the browser. The extension sends only a short-lived, revocable app session credential to the service.
- The service exposes only the read-only lookups needed by this extension. It must not become a general HubSpot proxy.
- Identify the portal during OAuth and prevent a rep from silently switching the extension to a different portal. Surface the connected portal clearly.
- Store no page contents or prospect data beyond the existing short-lived lookup cache. Do not log OAuth codes, tokens, full email addresses, or CRM record payloads.
- Disconnect revokes the HubSpot authorization where supported, deletes the stored refresh token and app session, and clears browser cache.

## Permission model and known limit

HubSpot's OAuth installation authorizes the app for a HubSpot account (portal). A rep uses their own HubSpot login to approve the install, but that alone does not prove that each extension request is restricted to that rep's personal CRM visibility. The implementation must not claim per-rep record-level isolation unless HubSpot's current project-app authorization behavior is verified for the chosen API flow. For the initial rollout, assume one company portal and require an authorized HubSpot admin to approve installation; reps then connect through the approved OAuth flow.

## Required data

Request only the scopes needed for read access to companies, contacts, and owners. Read only the existing properties used by the current extension: company name/domain/Instagram fields/owner/lifecycle/customer status/open-deal count/last-contacted, and contact email/name/owner/lifecycle/email opt-out/last-contacted/associated company. Do not add a deal read scope if the existing HubSpot company open-deal-count property supplies the rule.

## Acceptance criteria

1. A rep can connect and disconnect through HubSpot OAuth without entering or copying a token.
2. OAuth client secret and refresh token are absent from extension files, browser storage, logs, and Git.
3. Authorized lookups preserve current website, Instagram, and email behavior and all rules above; unknown or failed lookups never appear green.
4. Expired, revoked, wrong-portal, and insufficient-scope states show a useful error or reconnect action and do not expose cached results as current.
5. HubSpot calls are read-only and limited to the required scopes, objects, and properties.
6. Focused checks cover OAuth callback validation, token refresh/error handling, disconnect, and unchanged color evaluation without using live HubSpot credentials.

## Rollout and out of scope

- First rollout: one allowlisted company portal, private distribution, with the HubSpot admin approving the app and reps installing the extension.
- Chrome Web Store packaging and any organization-wide force install are follow-up distribution work.
- Marketplace listing, write scopes, shared/private app tokens, Slack/Treg changes, and changes to the color rules are out of scope.
- Hosting/deploying the OAuth service, creating/configuring the HubSpot app, and publishing the extension require separate approval before production activation.

## Implementation boundary

Build and locally verify the OAuth-capable extension and service configuration only. Do not create external HubSpot resources, provision production storage, deploy, publish, or commit credentials. Use environment-backed local configuration and mocked HubSpot responses for checks until the production setup is approved.
