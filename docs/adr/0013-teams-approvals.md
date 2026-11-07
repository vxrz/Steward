# 0013. Approvals from Microsoft Teams

- **Status:** Accepted
- **Date:** 2026-11-07
- **Since:** 0.10.0 (#237), planned in stages (below)

## Context

People who approve spend their day in Microsoft Teams. Today a card in Teams tells them a decision waits, and they must find it in Steward. The issue asks for cards that lead straight to the decision (stage 1) and, optionally, for approving inside the card (stage 2) – without weakening four-eyes, step-up or the evidence.

What the code does today:

- **Teams cards are posted, never answered.** `teamsCard()` in `server/src/notifications/channels.ts` builds an Adaptive Card 1.4 with `Action.OpenUrl` buttons only (_Open in …_, runbook, message settings). `sendTeams()` posts it with `postJson()` through `fetchCheckingRedirects()` (address safety and the redirect rules of 0.9.0, `platforms/outbound.ts`) to an incoming-webhook or Workflows URL: the instance channel (`teamsWebhookUrl` in `notifications.secrets`), the instance webhook in format _Teams card_, a team's own channel (`team_settings.channel_secret`, `notifications/team-channels.ts`) or a monitor output (`sendTeamsCards`, `monitors/outputs.ts`). Nothing comes back: no message id, so a posted card cannot be updated. A card must stay under 28 KB.
- **Links** in messages come from `absoluteLink()` / `publicBaseUrl()` (`notifications/settings.ts`): the notification base URL, else `SM_PUBLIC_URL`.
- **Decisions in runs** (#83): table `run_tasks` with `mode` (`select`, `approve`, `manual`), `assignees`, `four_eyes`, and for manual steps `stage` (`work`, `verify`) and `round`. `POST /api/tasks/:id/complete` (`routes/processes.ts`) checks `canDecide`, notes four-eyes (`fourEyesRequired('run.decide')`, `noteFourEyes`) and calls `completeTask()` (`engine/runner.ts`, audit `task.completed`). `POST /api/tasks/:id/verify` has an optional step-up (`verifyManualStep`). Recipients come from `taskRecipients()` and `verifierRecipients()` (`notifications/service.ts`). `store.decideTask()` updates the row **without** `AND status = 'open'`. That is safe today, because the check and the write run synchronously in one process. A second way in makes a real claim worth having.
- **MCP approved writes** (#11, `mcp/requests.ts`): modes `confirm` (the token owner), `fourEyes` (an approver or administrator other than the token owner who may use the platform, `secondPerson()`) and `review` (proposals). A request expires after 24 hours (`expireRequests()`). Approval claims the row (`UPDATE … WHERE status = 'pending' AND expires_at > ?`) and runs it once, as the requester (`execute()`). Every step is audited (`mcp.request_*`). The route `POST /api/mcp-requests/:id/decision` is `ACCESS.session`: API tokens cannot decide. The web page is `/mcp-requests/:id`.
- **Assurance** (`shared/src/assurance.ts`, `auth/assurance.ts`): `run.decide` (four-eyes optional, no step-up), `manualStep.verify` (four-eyes required, step-up optional), `mcp.write` (four-eyes optional, no step-up). ADR [0009](0009-platform-identities.md) plans `platform.privilegedIdentity` with step-up on, for approving privileged MCP requests and start approvals. `requireStepUp()`, `checkFourEyes()` and `noteFourEyes()` write the proof into the audit entries. **Step-up belongs to a session** (`requireSession`, `steppedUpUntil` in `auth/step-up.ts`): a request without a Steward session can never show a step-up.
- **Identity**: `users.external_id` links an account to its single sign-on identity (`auth/sso-claims.ts` `identityKeys`). With the Entra ID preset the stable identifier is `tid` + `oid` (`shared/src/sso.ts`): `<provider>#iss=…#tid=…#oid=…`. The default is `sub`, which in Entra differs per app registration and cannot be matched to anything Teams sends. `sameIdentity()` (`auth/aliases.ts`) treats former names and the linked identity as one person.
- **Inbound endpoints**: `POST /api/hooks/<triggerId>` (`triggers/hook.ts`, `ACCESS.hook`) is the model – cheap, non-revealing checks first, 404 for anything unknown, a rate limit, de-duplication, and rejections audited at most once per reason every 10 minutes. Every route is classified in the route matrix (ADR [0005](0005-route-access-declared-on-routes.md)). Steward has one listener (`main.ts`).
- **Libraries**: `jose` is already installed (through `openid-client`). There is no Bot Framework SDK.

What Teams allows (Microsoft's documented behaviour):

- **Incoming webhooks and Workflows** post cards. They cannot deliver a button press back (`Action.Submit`, `Action.Execute`), and they return no message id.
- **Outgoing webhooks** react to an @mention in a channel with a text reply, signed with a shared secret, within a few seconds. No card actions, no personal chats.
- **A bot** (Entra app registration + Azure Bot resource + a Teams app package installed in the tenant) receives `Action.Execute` (Universal Actions) as an `invoke` activity. It can update its own cards and refresh them per viewer (`refresh.userIds`, up to 60 people). Microsoft's Bot Connector must reach the bot's messaging endpoint over the internet with HTTPS. Each call carries a token signed by the Bot Framework, and the bot answers through the `serviceUrl` the call names.

## Decision

### One rule for both stages

A decision taken from Teams is **the same decision** as in Steward: the same function, the same checks at that moment, the same audit entries – plus _via Microsoft Teams_. Teams never gets a shortcut. Where Steward cannot prove in Teams what it proves in the browser (a step-up, a look at evidence), the card links to Steward.

### Stage 1 – cards that open Steward

On wherever Teams is set up. No bot, no inbound traffic.

- **What the card shows**, for `task.assigned` (decisions, manual steps, verifications) and `mcp.request`: process and step, platform (and identity, ADR 0009), the change as `METHOD path_template`, who asked, since when, and the expiry. Never the request body, the run inputs or values – a channel card is read by everyone in the channel. Built from `MessageParts` (`facts`, `actions`), so e-mail gets the same.
- **Buttons**: _Approve_ and _Reject_ are `Action.OpenUrl` links to `/runs/<runId>?task=<taskId>&decide=approve|reject` and `/mcp-requests/<id>?decide=approve|reject`. The page opens the decision dialog with the choice pre-selected; the person confirms, and the usual `POST` runs with sign-in, step-up and four-eyes. **A link never decides**, and it carries no token. Select decisions, manual steps and proposals get only _Open_: they need the items, the entry or the comparison.
- **When the decision is made** (in Steward or in Teams), the run is cancelled or the request expires, a short **follow-up card** goes to the same channel targets: _Approved by Alice Example at 10:42_. Incoming webhooks cannot update a card, so this is the only way to show the outcome. A new table `approval_posts (item_kind, item_id, target, posted_at)` remembers where the card went; the follow-up goes there and nowhere else.
- Quiet hours of channel targets (ADR [0012](0012-quiet-hours-and-digests.md)) apply to both cards.

### Stage 2 – approve inside Teams

Optional and **off by default**. Needs a Teams bot and an endpoint that Microsoft can reach.

#### Set-up

- An administrator registers a single-tenant Entra app and an Azure Bot, and uploads a Teams app package that Steward generates (bot id, scopes _personal_ and _team_, no tabs). In _Settings → Notifications → Teams bot_ they enter the app id, the allowed tenant id(s), a client certificate (preferred) or secret, and the Entra sign-in provider whose accounts the bot recognises.
- Saving needs the step-up `changeNotificationDelivery` and is audited (`teams.bot_settings_changed`). The credential is stored with the vault and registered for key rotation (`vault-rotation.ts`).
- Steward must reach Microsoft's documented hosts (token issuer, Bot Framework keys, the Teams `serviceUrl`). They are added to the outbound allow-list (_Settings → Outbound access_); address safety applies as to every other call.
- Saving is refused when the provider's stable identifier is not `tid` + `oid` (`TEAMS_BOT_NEEDS_OID`).

#### The endpoint

`POST /teams/bot/messages`, outside `/api`, with its own access kind `ACCESS.bot` in the route matrix. It is served on a separate, minimal listener (`SM_TEAMS_BOT_PORT`, decision 3 below). Order of checks, cheap and non-revealing first:

1. bot off → 404; body over 64 KB → 413; not JSON → 415;
2. no or bad token → 401 with no detail. The token must be signed by a current Bot Framework key (from its OpenID metadata, cached, refreshed at most every 5 minutes on an unknown key id), with issuer `https://api.botframework.com`, audience = the app id, and `exp`/`nbf` within 5 minutes of clock skew;
3. the token's `serviceUrl` claim equals the activity's `serviceUrl`, and its host is on a fixed list of Teams service hosts. Steward sends its own bot token to that URL when it answers, so a forged or foreign `serviceUrl` would leak it;
4. `channelId` is `msteams`; the tenant (`conversation.tenantId`, `channelData.tenant.id`) is an allowed tenant;
5. the activity id was not seen in the last 24 hours (`teams_bot_activities`). A repeat gets the same answer again and changes nothing;
6. rate limits per tenant and per Teams user;
7. vault locked → a card saying _Steward is locked – try again later_.

Rejections are audited at most once per reason every 10 minutes (`teams.action_refused`), as for webhook triggers. The bot handles only: installation and conversation updates (it remembers where it is installed), card actions (`adaptiveCard/action` with verbs `approve`, `reject`, `refresh`), and messages (answered with a short help text and a link). No chat commands.

#### Who is clicking

- Teams names the person by `from.aadObjectId` and the tenant. Steward builds the key `<provider>#iss=<issuer>#tid=<tenant>#oid=<object id>` for the configured provider and looks it up in `users.external_id`. The provider's issuer tenant must be the activity's tenant.
- The account must be active and linked through that provider. Never by user principal name, e-mail or display name (the nOAuth rule in [SECURITY-HARDENING.md](../SECURITY-HARDENING.md)).
- No match → the card says _Your Teams account is not linked to a Steward account_ and offers _Open in Steward_. Nobody else gets a way in (decision 4 below).
- The lookup happens on every action. No Steward session is created.

#### What can be decided in the card

Computed for each viewer when the card is refreshed, and again on every click:

- **In the card**: approve-mode decisions (`run.decide`); MCP gateway and run requests in `confirm` mode; MCP requests in `fourEyes` mode and four-eyes decisions, where the clicker is the second person and the control point allows it (_May be decided in Microsoft Teams_, decision 2 below).
- **Never in the card**, only _Open in Steward_: select decisions, manual steps and their verification, proposals (`review`), and anything whose effective rule asks for a step-up (`requireStepUp` would refuse – `manualStep.verify` with step-up on, `platform.privilegedIdentity`).
- **The check is the route's check.** A new `decideFromTeams(user, item, verb, version, comment)` runs under `runAs(user)` and calls what the routes call: for tasks `visibleTasks`, `canDecide`, `fourEyesRequired` / `noteFourEyes`, `completeTask(id, decision, actor)`; for MCP requests `decide()`, which checks `mayApprove`, expiry and the claim itself. A person who could not decide in Steward cannot decide in Teams.
- **Stale cards**: the card's data carries `{ kind, id, version, sig }`. `version` is the task's round and stage, or the request's status. `sig` is an HMAC with a server key over kind, id and version, so card data cannot be edited to point at another item. A mismatch answers with the current card: _This changed – here is the current state_.
- **Exactly once**: `store.decideTask()` gains `AND status = 'open'` and refuses when no row changed, like the MCP claim already does.
- The card has an optional comment field (500 characters). Rejecting needs the same rights as approving.

#### Where the bot posts

- With the bot on, decision cards (and only those) go through the bot. Per channel target the administrator picks the bot's conversation (the channel where the app is installed) instead of the webhook. Other events stay on the webhooks.
- People who installed the app for themselves also get the card in their chat with the bot. That chat is the target `teamsChat:<userId>` of ADR 0012, with the person's quiet hours. Steward does not install the app for people through Microsoft Graph (no extra Graph permission).
- A card in a channel shows the status and _Open_ to everyone. `refresh.userIds` lists the eligible deciders (at most 60); each of them sees their own buttons. When the decision is made, Steward updates the card for everyone (it posted it, so it has the activity id in `teams_cards`).
- Content follows the stage 1 rules and the hidden-resource rules: a team channel gets cards only about things its team may see.

### Data model

```sql
-- stage 1
CREATE TABLE approval_posts (
  item_kind TEXT NOT NULL,     -- task | mcp_request
  item_id TEXT NOT NULL,
  target TEXT NOT NULL,        -- teams:instance | webhook:instance | team:<teamId>
  posted_at TEXT NOT NULL,
  followed_up_at TEXT,
  PRIMARY KEY (item_kind, item_id, target)
);
-- stage 2
CREATE TABLE teams_conversations (
  id TEXT PRIMARY KEY,         -- tcv_…
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  service_url TEXT NOT NULL,
  kind TEXT NOT NULL,          -- channel | personal
  name TEXT NOT NULL DEFAULT '',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,  -- personal chats
  installed_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE TABLE teams_cards (
  item_kind TEXT NOT NULL, item_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES teams_conversations(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL, version TEXT NOT NULL, posted_at TEXT NOT NULL,
  PRIMARY KEY (item_kind, item_id, conversation_id)
);
CREATE TABLE teams_bot_activities (activity_id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
ALTER TABLE mcp_requests ADD COLUMN decided_via TEXT;   -- NULL = Steward, 'teams'
```

- `TaskDecision` gains `via?: 'teams'` (stored in `run_tasks.decision`).
- Migration packages: `teams_conversations` and the bot settings are `MOVED` (the credential through the vault rotation list); `approval_posts`, `teams_cards` and `teams_bot_activities` are `NOT_MOVED` (short-lived).

### Evidence and audit

- Decisions keep their audit actions (`task.completed`, `mcp.request_approved`, `mcp.request_rejected`, `mcp.request_executed`) with `details.via = 'teams'` and `details.teams = { tenantId, aadObjectId, conversationKind }`. The assurance proof records `via: 'teams'` and no session.
- Run protocols, run reports and evidence packs read _Approved by alice (via Microsoft Teams)_.
- New entries: `teams.bot_settings_changed`, `teams.conversation_added`, `teams.conversation_removed`, `teams.action_refused` (not linked, may not decide, step-up needed, stale card, expired; rate-limited).

### Without an internet-facing Steward

- **Stage 1 works fully.** Steward only sends. The buttons open Steward in the browser; that needs the company network or VPN, as every link in a message does today.
- **Stage 2 needs inbound HTTPS from Microsoft** to the bot endpoint, and outbound access to Microsoft. Installations that allow neither stay on stage 1. The bot listener (decision 3) is the only thing to publish.

## Security

| Threat                                     | What stops it                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval by link alone                     | Links only open a dialog; the decision is a `POST` in a signed-in session. No tokens in URLs. Link scanners that open URLs decide nothing.            |
| Forged callback                            | Bot Framework signature, issuer, audience, expiry, `channelId`, allowed tenants – before anything else is read.                                       |
| Steward's bot token sent to a foreign host | `serviceUrl` must equal the signed claim and be on the fixed Teams host list; outbound calls go through address safety and the outbound policy.       |
| Replay of a click                          | Activity id de-duplication (24 h), token expiry, card version + HMAC, and an exactly-once claim on the task or request.                               |
| Old card, new round                        | The version check; the answer is the current card.                                                                                                    |
| Wrong person                               | Only Entra `tid` + `oid` through the configured provider; never names or addresses.                                                                   |
| Four-eyes bypassed                         | The same `checkFourEyes` / `secondPerson` with `sameIdentity` as in Steward.                                                                          |
| Step-up bypassed                           | Nothing that needs a step-up is decided in the card.                                                                                                  |
| Information in a channel                   | No bodies, inputs or values; hidden-resource rules; buttons only for eligible viewers.                                                                |
| Flooding the endpoint                      | Body limit, cheap checks first, rate limits, rate-limited audit, kill switch (bot off → 404).                                                         |
| Stolen bot credential                      | Lets someone send messages as the bot, not approve: inbound calls need a token Microsoft signs. Vault, certificate preferred, changes audited.        |
| Compromised Teams account                  | The same as a compromised Entra account in Steward's sign-in. Entra's conditional access governs both. The policy switch lets an organisation say no. |

## Alternatives considered

- **Workflows or incoming webhooks with `Action.Submit`.** The press never reaches Steward.
- **Power Automate _post a card and wait for a response_, then call Steward.** The flow would assert who clicked, with a shared secret. Anyone who can edit the flow could approve as anyone. Steward cannot verify the person.
- **Outgoing webhooks** (`@Steward approve 123`). Needs inbound HTTPS anyway, channel only, text commands are error-prone, no per-viewer buttons.
- **Signed approve links** (one click in e-mail or a card decides). Approval by link alone. Mail and link scanners open links and would approve.
- **A Teams tab** (Steward's page inside Teams with Teams single sign-on). Loaded by the Teams client, so it works with an intranet Steward. But it is still link-out, with more set-up (app package, Entra app, `frame-ancestors`). A possible later step.

## Consequences

**Positive**

- Stage 1 removes the search for the decision, for every installation, with no new inbound surface.
- Stage 2 lets eligible people decide where they are, with the same checks and evidence.
- The exactly-once claim on tasks closes a gap that exists independently of Teams.

**Negative**

- Stage 2 is real operations work: an Entra app, an Azure Bot, a Teams app package, an inbound endpoint, outbound hosts, a credential to rotate.
- Two ways to decide mean more tests: every refusal must behave the same in both.
- Microsoft can change Teams behaviour. The mock Bot Connector proves Steward's side, not Microsoft's.

**Risks**

- **A validation mistake on the endpoint** would let forged decisions in. Mitigation: one small module (`server/src/msteams/bot-auth.ts`; `server/src/teams/` is about Steward's own teams) with a test table (wrong key, issuer, audience, expired, `serviceUrl` mismatch, foreign host, foreign tenant, replay); the endpoint is off by default.
- **People ask for "just approve it in Teams" for step-up points.** The record says no; the card explains why.
- **Cards in large channels** exceed the 60-person refresh list. Mitigation: those viewers see _Open_ only; personal chats are the better target for deciders.

### Rollout plan

Each step is its own PR.

1. **Stage 1.** Card parts and buttons, `?decide=` in the run and MCP request pages, follow-up cards, `approval_posts`, the `decideTask` claim. Tests on SQLite and PostgreSQL; e2e for the decision pages opened from a card.
2. **Stage 2a – the endpoint.** Bot settings, the endpoint and its checks, the identity lookup, conversation tracking, card actions for decisions and MCP requests, audit. A mock Bot Connector with its own signing keys (`server/src/mock/mockBotConnector.ts`) in tests.
3. **Stage 2b – posting through the bot.** Cards through the bot per channel target, personal chats, per-viewer refresh, card updates, the `teamsChat` target of ADR 0012. Docs: [NOTIFICATIONS.md](../NOTIFICATIONS.md) and a Teams bot set-up guide.

## Decided after review

1. **What ships in 0.10.0?** Decided: stage 1 complete, and stage 2 behind a setting that is off by default and marked _preview_. Stage 2 is built and tested against a mock Bot Framework with its own signing keys; only a real tenant shows how Teams behaves.
2. **May four-eyes decisions be taken in the card, when the clicker is the second person?** Decided: yes, unless the assurance policy says no. A new rule part per control point, _May be decided in Microsoft Teams_, is on by default for `run.decide` and `mcp.write` and impossible for points with a step-up; auditors see it in the policy, its history and the proof.
3. **Where is the bot endpoint served?** Decided: a separate listener. `SM_TEAMS_BOT_PORT` starts a second, minimal server with only `POST /teams/bot/messages`: no cookies, no static files, no other routes.
4. **Who can approve in Teams without an Entra single sign-on link?** Decided: nobody. Only accounts linked by `tid` + `oid` through the configured provider can decide in a card; everyone else uses the link to Steward.
