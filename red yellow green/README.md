# Artis CRM Check

A Chrome extension that shows a red / yellow / green HubSpot status based on rules of engagement. It checks three things:

- **Websites.** The site's domain is matched against HubSpot company domains and contact email domains.
- **Instagram profiles.** The handle is matched against the company's Instagram Handle, and the website link in the bio is checked like any other website.
- **Emails.** Every email on the page is matched against HubSpot contacts and that contact's company, then highlighted in place.

Results show in a card in the bottom-right corner. The toolbar popup also checks any website, email or @handle you paste in.

## Colors

| Color | Rule |
|---|---|
| Red | In HubSpot and not contactable: lifecycle stage Customer (current or former), an open deal, opted out of email, or an email or call logged in the last 45 days. |
| Yellow | In HubSpot, but no email or call logged in the last 45 days. |
| Green | Not in HubSpot. |

"Email or call logged" is HubSpot's Last Contacted date, on the company or the contact. When several records match, the most restrictive color wins. Ownership shows in the label but doesn't change the color. Free email addresses (Gmail, Yahoo, iCloud and so on) match on the exact address only. You can change the 45-day window in Settings.

## Setup (once, by an admin)

1. In HubSpot, create a **private app**. It's under Settings → Integrations → Private Apps (newer portals may list it under Development → Legacy apps). Give it these read-only scopes:
   - `crm.objects.companies.read`
   - `crm.objects.contacts.read`
   - `crm.objects.owners.read`
2. Copy the access token (`pat-na1-…`).

## Install (each rep)

1. Unzip `artis-crm-check.zip`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
3. Pin the extension. Click it, then **Settings**. Paste the token, click **Test connection**, then **Save**.

To roll it out without Developer mode, publish it to the Chrome Web Store as **Unlisted** or **Private** (Private limits it to your Google Workspace domain). Workspace admins can then force-install it for the sales team.

## Notes

- Every rep's browser holds the token. Keep the private app's scopes read-only.
- Lookups are cached for 10 minutes per domain or email, to stay under HubSpot's rate limits.
