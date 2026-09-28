# artis-sales-tools

A stateless company-domain lookup using hosted Treg. No dependencies, database,
provider waterfall or ranking system. `lookup.js` owns enrichment; `slack.js` is
the thin command surface. Both use Node's built-in modules.

## Run

Requires Node 22 or newer. Put `TREG_TOKEN` in `.env` beside `lookup.js`, or export
it in the environment. The local `.env` is ignored by Git.
Copy `.env.example` to `.env` and fill in the token.
The CLI needs no Slack credentials. Never commit a token.

```sh
node lookup.js example.com
# Discovery only, suitable for non-interactive use:
node lookup.js example.com --list
```

The command finds up to ten people, finds missing emails, verifies unconfirmed
emails, and prints JSON. No selection prompt, title preferences or ranking.
Decide whom to contact after seeing the results. It also works without a terminal.

The module exports `lookup(domain)` for the full workflow. The optional
`lookup(domain, {listOnly:true})` / CLI `--list` performs discovery only, without
email finding or verification. It does not save a session or cache candidate data.
The module loads the adjacent `.env` without replacing existing environment variables.

The JSON result has `company`, `people`, and `_meta` with route
providers, attempts, call IDs, costs, errors and status. Unknown fields are null.
Results retain up to ten people in Treg's original order, including people whose
enrichment could not finish. Each person's `enrichment_status` is `complete`,
`partial`, `pending` or `not_started`; an unfinished lookup is not a confirmed
email miss. Company name is taken only from returned rows.
`verified` means an explicit mailbox-verification assertion from Treg/the
provider; it does not establish that a person still works at the company.
Catch-all, invalid and uncertain verdicts remain visible; they are not verified.

Exit codes: **0** completed (including discovery-only or no-result), **1** invalid input
or incomplete/error result, **2** a Treg task is still pending. Partial results
remain on stdout; input/config errors go to stderr.

## Treg investigation — 2026-09-27

The production equivalent of Arena's **Find people / Company domain / Waterfall**
is **`POST https://treg.to/call/treg.people.search`**, authenticated by
`X-Treg-Token`. The supplied team token is org-scoped; it does not need a separate
org header. Identity tokens require `X-Treg-Org`, and are outside this one-token setup.

```json
{"company_domain":"example.com","limit":10}
```

The waterfall is callable directly. Arena itself creates a saved plan with
`POST /arena/plans`, then starts it with `POST /arena/runs/{id}/start`.
It shares Treg's contracts/adapters but has its own run lifecycle and ordering;
we do not promise identical Arena ordering or reproduce its machinery.

The routed response is:

```json
{
  "output": {"people": [], "count": 0, "next_cursor": null},
  "raw": {},
  "_treg": {"served_by": null, "tried": [], "charged_micro": 0}
}
```

This is a shape illustration, not a recorded response. `count` and `next_cursor`
are optional. **People rows remain provider-native**, so the small normalization
function recognizes common snake_case/camelCase identity fields and leaves
unsupported/missing fields null. It does not scrape websites or synthesize data.
Multiple people are supported; `limit:10` requests the candidate pool, locally
capped at ten. All returned candidates are enriched within the spend cap. Search rows can include emails, but the first
probe returned names and titles without emails.

The implemented chain is:

1. `treg.people.search` with company domain and limit 10.
2. For each person's missing email, `treg.people.email.find` with
   `{"full_name":"…","domain":"…"}`; use `{"linkedin_url":"…"}` only when
   the name is unavailable. A hit alone does not imply verification.
3. If a person's email is not explicitly verified, `treg.people.email.verify` with
   `{"email":"…"}`. Its normalized fields are `valid`, provider `status` and
   optional `score`. Only an explicit positive, non-risky verdict becomes verified.

No email patterns are guessed. Existing usable emails are retained. Each returned
person gets at most one finder and one verifier call. Names/titles and the original
email remain available even when a follow-up fails. Every call has an idempotency
key recorded in its receipt, but there are no automatic retries or local fallbacks.

The route supports a single `title` input and country/location/keywords filters;
it has no canonical seniority field. The baseline sends no title preference.
The implementation enables strict filters so a provider cannot silently ignore
the requested limit. This narrows coverage; it is a deliberate development bound.
No undocumented provider-attempt-count header is sent: Treg owns attempt limits.

### Costs and pending work

The total budget is **$0.25 per company, including discovery**. Calls run
sequentially. Before each call, its `X-Treg-Route-Max-Cost` is the smaller of
**$0.05 or the remaining company budget**, calculated in integer micro-USD from
completed charges. Calls also send `X-Treg-Route-Waterfall: 1` and
`X-Treg-Route-Strict-Filters: 1`. Up to 21 requests can occur: one search plus at
most one finder and verifier for each of ten people. The program stops when no
budget remains, or when an unknown charge prevents a safe budget calculation.
This relies on Treg enforcing the request ceiling; local code does not control
upstream billing. `_meta.budget_usd`, `stop_reason` and each receipt's
`max_cost_usd` expose the spending boundary. Partial results retain all people.

On the common path observed in the initial sample, finding and verifying ten
emails projects to **$0.06614**: ten times $0.004834 + $0.00178, plus any discovery
charge. This is an estimate, not a flat quote. Prices vary by provider; some misses cost
money. The live catalog's child price ranges were $0–$0.10 for people search,
$0.004834–$0.15 for email finding, and $0–$0.0138 for verification. These are
catalog units, not a flat end-to-end quote. Reinspect the catalog before changing
limits or running a larger sample. No top-up is performed by this utility.

`X-Treg-Cost-Micro` is the charged amount in millionths of a dollar;
`X-Treg-Call-Id` identifies the parent call. `_meta.calls` preserves those headers
and the complete route `_treg` details, including attempted providers, their
statuses, `charged_micro`, dropped candidates, and ignored filters. `_meta.cost_usd`
is null if any charge is unknown. Do not add parent and child charges together.

Treg polls an async child internally for up to 60 seconds. If it returns **202**,
the CLI preserves `_treg.call_ref`, the async poll descriptor, reservation and
unknown charge, marks the result pending and stops. It does not relaunch the
lookup or automatically interpret provider-specific poll bodies. Inspect that
existing task through Treg before running the same lookup again. A network timeout
also leaves cost unknown; the saved idempotency key permits a deliberate same-key
retry without submitting new work. The per-request timeout is 180 seconds.

**402** and caller/auth errors stop further calls. Provider/server failures are
reported as partial results; the utility may continue to the next person,
but never switches providers itself. A malformed response is an error, not an
empty successful search. A successful empty search exits cleanly. A routed miss
marked `capped` is incomplete, not proof that no person/email exists.

### Provider participation

The live people route lists 22 child endpoints across AI Ark, Aviato,
CompanyEnrich, Crustdata, Dropleads, Exa, Fiber AI, Findymail, Harvest,
Hunter, Icypeas, LeadMagic, Leadsforge, Lusha, Prospeo, Quickenrich and Wiza.
Not every child accepts a bare domain or strict limit. The first probe considered
the compatible subset and tried Quickenrich, then Leadsforge; Leadsforge returned
three rows for $0. Actual participation is recorded per call, not hard-coded here.

Sources: [live people route](https://treg.to/catalog/endpoints/treg.people.search),
[email finder](https://treg.to/catalog/endpoints/treg.people.email.find),
[email verifier](https://treg.to/catalog/endpoints/treg.people.email.verify),
[agent documentation](https://treg.to/llms.txt),
[API reference](https://treg.to/docs),
[Arena source documentation](https://github.com/superdesigndev/treg/blob/main/docs/context/interface/enrich-arena.md),
[routing contracts](https://github.com/superdesigndev/treg/blob/main/src/treg/catalog/contracts.yaml).
The API reference's general statement that Treg does not route applies to direct
provider calls; the live synthetic `treg.*` catalog and routing source establish
the supported routed behavior used here.

## Slack channel threads

`slack.js` verifies raw-body HMAC signatures and five-minute timestamps, accepts
`POST /slack/commands`, and acknowledges immediately. It posts a channel-visible
request message identifying the firm and requester, then replies to that message
with the same `lookup()` result. Slash commands do not provide a parent message
timestamp, so the app creates the parent and uses its returned `ts` for the reply.
Results are visible to channel members. Replies are not broadcast to the channel.

The result uses a company heading, original command, unique verified-email counts,
and separate contact rows: name and title on the left, email and status on the
right. Names link directly to LinkedIn when a valid profile is available. Shared email addresses
are flagged without merging identities; invalid addresses are explicitly marked.
All ten records fit in separate Slack blocks instead of truncating one long block.
Pending, incomplete and missing results remain distinct.

Required variables: `TREG_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`.

```sh
npm start
```

The service listens on `PORT` (default 3000), with `GET /health` for a healthcheck.
Configure a Slack app with `commands` and `chat:write` bot scopes. Disable Socket
Mode. Set `/find-contact` to `https://<service-host>/slack/commands`, leaving link
escaping disabled. Install or reinstall the app after changing scopes. Copy its
Bot User OAuth Token to `SLACK_BOT_TOKEN`, then add the app to each intended channel.
No channel-history scope, database or queue is required.

The parent message must be posted successfully before enrichment starts. Missing
channel access produces a private setup error without paying for a lookup.
Concurrent requests keep separate parent timestamps. Neither API calls nor failed
lookups are automatically retried. Provider text is escaped to prevent mentions.

See Slack's [message API](https://docs.slack.dev/reference/methods/chat.postMessage/)
and [slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/).

Deployment is one continuously running Node service on Railway: Node 22+,
`npm start`, healthcheck `/health`. Publish and deploy only with approval.
The channel-thread update needs a bot token and live Slack verification before
activation; local integration tests use mocked Slack and Treg responses.

In-flight work exists only in this process. A restart after acknowledgement can
lose the result; paid Treg receipts remain upstream. Inspect existing receipts
before retrying a lookup whose completion or delivery is uncertain.
