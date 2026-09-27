# Artis sales tools

Keep this a small, stateless Node utility. Read README.md for the current Treg
contract and activation gate. Use hosted Treg via ordinary fetch and one
TREG_TOKEN; Treg owns provider selection, waterfall, finding and verification.

Keep the workflow in lookup.js. Find up to ten people and automatically find/verify
their emails in provider order. No selection prompt or title ranking. Limit total
spend to $0.25 per company, including discovery, using Treg's per-request ceiling
and actual charged micro-USD. Stop on unknown cost; preserve partial results.
Never invent identities, email
patterns, company names or verification.
Unknown fields are null. Pending work must retain its call reference and must
not be resubmitted as a new lookup. Preserve partial results and charged costs.

No database, queues, agents, custom provider waterfall, ranking framework,
HubSpot integration, extra dependencies or directory architecture. slack.js is
only a signed command/response surface and calls the same exported lookup function.
Slack configuration is deferred. The stub calls the same one-step lookup; live
activation needs credentials and a URL. Deployment needs separate approval.

Never commit .env or credentials. Live lookups cost money: inspect current route
prices first, disclose the spend ceiling and retain call IDs. Keep live
evaluation evidence outside the public repository; do not build a benchmark system. Use temporary fixtures
for focused verification of normalization, failure, pending and cost behavior.
