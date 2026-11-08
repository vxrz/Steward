# Approvals from Microsoft Teams

People who approve spend their day in Microsoft Teams. Steward meets them there in two stages ([ADR 0013](adr/0013-teams-approvals.md)):

| Stage                      | What people get                                                                       | What you set up                                                       | Inbound traffic                       |
| -------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------- |
| **1 – cards that open**    | a card with **Approve** / **Reject** that opens the decision in Steward, pre-filled   | a Teams channel (incoming webhook or Workflows), as for every message | none                                  |
| **2 – decide in the card** | **Approve** / **Reject** inside the card, for the people who may decide (**preview**) | an Entra app, an Azure Bot, a Teams app package, the bot listener     | HTTPS from Microsoft to one port only |

One rule for both: **a decision taken from Teams is the same decision as in Steward** – the same function, the same checks at that moment, the same audit entries, plus _via Microsoft Teams_. Where Steward cannot prove in Teams what it proves in the browser (a step-up, a look at the evidence), the card links to Steward.

## Stage 1: cards that open Steward

Nothing to install beyond a Teams channel ([NOTIFICATIONS.md](NOTIFICATIONS.md#look-of-e-mails-and-teams-messages)):

1. _Settings → Notifications_: turn on **Microsoft Teams** with the Workflows or incoming-webhook URL (or give a team its own channel in Teams format).
2. Route **A run waits for a decision** (`task.assigned`) and **AI requests** (`mcp.request`) to Teams.
3. Set the **base URL** for links (or `SM_PUBLIC_URL`): the buttons open Steward there – people need the company network or VPN, as for every link in a message.

What the card shows: process and step, platform, the change as `METHOD path_template`, who asked, since when and – for AI requests – when it expires. **Never** a request body, run inputs or values: everyone in the channel reads the card.

- **Approve / Reject** open `/runs/<run>?task=<step>&decide=approve|reject` or `/mcp-requests/<id>?decide=approve|reject`. The decision dialog opens with that choice; the person can change it, adds a comment, and **confirms** – in their signed-in session, with step-up and four-eyes as always. **A link never decides** and carries no token, so link scanners in mail and chat cannot approve anything.
- Select decisions, manual steps, verifications and proposals only get **Open**: they need the items, the entry, the evidence or the comparison.
- When the decision is made, the run is cancelled or the request expires, a **follow-up card** goes to the channels the card went to: _Decided: Open port 443 – Approved by Alma Approver at 10:42_. Incoming webhooks cannot change a posted card; the follow-up is how a channel learns the outcome.
- Quiet hours of a channel apply to both cards ([NOTIFICATIONS.md](NOTIFICATIONS.md#quiet-hours-and-digests)).

## Stage 2: decide in the card (preview)

**Preview** means: built and tested against a mock of the Bot Framework with its own signing keys, but not proven yet in many real tenants. It is **off by default**; turning it on is your choice.

### What you need

- A Steward reachable **from Microsoft's Bot Connector over HTTPS** on one port (below), and **outbound** access to Microsoft.
- **Single sign-on with Entra ID** whose stable identifier is **`tid` + `oid`** (the Entra ID preset, [ENTRA.md](ENTRA.md)). Only accounts linked that way can decide in Teams – never by user principal name, e-mail or display name (the nOAuth rule in [SECURITY-HARDENING.md](SECURITY-HARDENING.md)). Everybody else gets _Open in Steward_.
- **A recent Steward sign-in**: a person decides in Teams only when they signed in to Steward within the last **7 days** (_Sign-in needed within_, 1–30 days). Their roles and teams come from that sign-in; without it, someone removed from an IdP group could keep deciding in Teams. Otherwise the card says _Sign in to Steward once to decide here_.

### Set-up

1. **Entra app registration**: single-tenant; note the **application (client) id**. Add a **certificate** (preferred) or a client secret.
2. **Azure Bot** resource for that app (single tenant). Messaging endpoint: `https://<public host>/teams/bot/messages`. Turn on the **Microsoft Teams** channel.
3. **Bot listener**: set `SM_TEAMS_BOT_PORT` (and `SM_TEAMS_BOT_HOST` if it must bind elsewhere than `SM_HOST`), restart Steward. It serves **only** `POST /teams/bot/messages` – no cookies, no web app, no other route. Publish this port alone through your reverse proxy or firewall, with TLS (`SM_TLS_CERT`/`SM_TLS_KEY` apply to it too, with the same settings as the main server: TLS 1.2 or newer, forward-secret AEAD suites only, `SM_TLS_CIPHERS`).
4. **Outbound access** (_Settings → Outbound access_, when you use an allow-list): `https://login.botframework.com` (signing keys), `https://login.microsoftonline.com` (the bot's token) and `https://smba.trafficmanager.net` (the Teams service; for government clouds the `smba.infra.*` host of yours).
5. **Settings → Notifications → Teams bot**: the app id, the allowed tenant id(s), the Entra sign-in provider, how recent a Steward sign-in must be (default 7 days), and the certificate and its private key (PEM) or the secret. Saving asks for a step-up (_change notification delivery_) and is audited (`teams.bot_settings_changed`); the credential is sealed with the vault and re-encrypted at key rotation. Saving is refused when the provider's stable identifier is not `tid` + `oid` (`TEAMS_BOT_NEEDS_OID`).
6. **A second administrator approves** _Decide with the Teams bot_ (`teams.bot`) under _Settings → Assurance policy_: switching the bot on asks for it, and until then the bot records installations but takes no decisions and posts no cards.
7. **Download the Teams app package** (same card) and upload it in the Teams admin center (or for your team). It contains the bot only – scopes _personal_ and _team_, no tabs.
8. Add the app to a **channel**; under _Decision cards in channels_ pick that conversation for the instance channel or a team channel. People who want the cards in their **personal chat** add the app for themselves.

### What can be decided in the card

| In the card                                                                                                          | Only in Steward (_Open_)                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| approve-mode decision steps (`run.decide`), also when four-eyes asks for a second person and the clicker is it       | select decisions, manual steps and their verification, proposals (`review`)          |
| AI requests in mode _confirm_ and _four-eyes_ (`mcp.write`) – **only when the switch is turned on** (off by default) | anything whose rule asks for a step-up (Teams cannot show one)                       |
|                                                                                                                      | control points whose assurance rule says **not** _May be decided in Microsoft Teams_ |

The assurance policy has a switch per control point, **May be decided in Microsoft Teams** – on by default for `run.decide`, off for `mcp.write` (in Steward the full request is shown), impossible for points with a step-up ([ASSURANCE.md](ASSURANCE.md)). Turning it off tightens the policy at once; turning it on again needs a second administrator. Auditors see it in the policy, its history and in the proof of each decision.

Each viewer's buttons are computed for them when the card refreshes (`refresh.userIds`, up to 60 eligible deciders) and again on every click, for that one item: the same command layer as `POST /api/tasks/:id/complete` (`authorizeSignal`: visibility, `canDecide`, four-eyes; then `engine().signal`), and `decide()` of AI requests with its own claim. A person who may no longer see the item gets no facts. The card data carries the item, its version, its time and an HMAC with a server key; an edited or outdated card answers _This changed – here is the current state_, card data older than 30 days is refused. Decision steps are claimed exactly once (`AND status = 'open'`).

**What the card shows.** In a channel: process, step, platform, the change as `METHOD path_template`, who asked, since when, the expiry – never bodies, inputs or values. In a person's **personal chat** the card also shows what is decided: the step's instructions and items, or the AI request's concrete method and path, query, a shortened body and the assistant's reason (marked as data, not instructions).

When the decision is made, Steward **updates its cards** for everyone. Run protocols, run reports and the audit log read _Approved by alma (via Microsoft Teams)_; audit details carry `via: "teams"` and `teams: { tenantId, aadObjectId, conversationKind }`; the assurance proof records `via: "teams"` and no session.

### Security

The endpoint checks, cheap and non-revealing first: bot off → 404; body over 64 KB → 413; not JSON → 415; then the **Bot Framework token** – RS256 by a current key from Microsoft's OpenID metadata (cached; refreshed at most every 5 minutes for an unknown key id), the key **endorsed** for `msteams`, issuer `https://api.botframework.com`, audience = the app id, `exp`/`nbf` within 5 minutes – else 401 with no detail. The token's **`serviceUrl`** must equal the activity's and be a Teams service host (Steward sends its own token there when it answers). Then `channelId` `msteams` and an **allowed tenant**; an activity id seen in the last 24 hours gets the **same answer** and changes nothing; **rate limits** per tenant and per Teams user; vault locked → _Steward is locked – try again later_. Refusals are audited at most once per reason every 10 minutes (`teams.action_refused`). Installations are audited (`teams.conversation_added`, `teams.conversation_removed`).

| Threat                                     | What stops it                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Approval by link alone                     | Stage 1 links only open a dialog; the decision is a `POST` in a signed-in session.                                                         |
| Forged callback                            | Bot Framework signature, endorsement, issuer, audience, expiry, `channelId`, tenant – before anything else.                                |
| Steward's bot token sent to a foreign host | `serviceUrl` must equal the signed claim and be a Teams service host; no redirects are followed; outbound policy and address safety apply. |
| Replay of a click                          | Activity id (24 h), token expiry, card version + HMAC, the exactly-once claim.                                                             |
| Wrong person                               | Only Entra `tid` + `oid` through the configured provider, with a Steward sign-in within the last 7 days.                                   |
| Four-eyes or step-up bypassed              | The same checks as in Steward; nothing with a step-up is decided in the card; the policy switch.                                           |
| Information in a channel                   | No bodies, inputs or values; buttons only for eligible viewers.                                                                            |
| Stolen bot credential                      | Lets someone post as the bot, not approve: inbound calls need a token Microsoft signs. Prefer a certificate.                               |
| A wrong reverse-proxy rule                 | The bot listener serves nothing but the bot route.                                                                                         |

A compromised Teams account is a compromised Entra account – Entra's conditional access governs both. If that risk is not acceptable for a control point, turn its switch off.

### Without an internet-facing Steward

Stage 1 works fully. Stage 2 needs inbound HTTPS from Microsoft to the bot listener; installations that allow neither stay on stage 1.

### Testing

`server/test/teams-bot.test.ts` runs the endpoint against `server/src/mock/mockBotConnector.ts`: a token table (wrong key, wrong signature, issuer, audience, expired, not yet valid, `serviceUrl` mismatch, foreign host, unendorsed channel, foreign tenant, replay), decisions and four-eyes in the card, the policy switches, AI requests and posting through the bot. `server/test/teams-bot-security.test.ts` covers the findings of the 0.10.0 security review (sign-in bound, no redirects, old tasks, personal details, visibility on refresh, card data age, metadata backoff). They never call Microsoft.
