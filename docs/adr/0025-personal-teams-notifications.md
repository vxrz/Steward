# 0025. Personal Teams notifications

- **Status:** Accepted
- **Date:** 2026-11-10
- **Since:** 0.15.0

## Context

Steward reaches people in Microsoft Teams in two ways today:

- **Channel messages** (`notifications/channels.ts` `sendTeams()`): the instance channel, the instance webhook in format _Teams card_, a team's own channel and monitor outputs post an Adaptive Card through an incoming webhook or a Workflows URL. Everybody in the channel reads them, so they carry no personal detail.
- **The Teams bot** (ADR [0013](0013-teams-approvals.md), stage 2, a preview, off by default): it posts **decision cards** – `task.assigned` and `mcp.request` – to channels an administrator picks and to the **personal chat** of each decider who added the app for themselves (target `teamsChat:<user>`, `msteams/delivery.ts`). The conversation is recorded when Teams sends `installationUpdate` or `conversationUpdate` (`msteams/bot.ts` `conversationChanged()`, table `teams_conversations`, kind `personal`, with the Steward user found by Entra `tid` + `oid`).

Personally, a person otherwise gets only **in-app** notifications and **e-mail** (`users.email_notifications`, the routes per event in _Settings → Notifications_, quiet hours and digests of ADR [0012](0012-quiet-hours-and-digests.md)). People who live in Teams ask to get _their_ failed runs, due credentials or plant change sets there too.

Options:

- **(a) The existing bot sends 1:1 proactive messages.** It needs the app added by the person (scope _personal_, already in the package) and the conversation reference Teams sends on that first contact. No Microsoft Graph, no new permission, no new inbound traffic: the bot already answers through the conversation's `serviceUrl` with its own token (`msteams/connector.ts`).
- **(b) Microsoft Graph chat messages** (`POST /chats/{id}/messages` or `/users/{id}/teamwork/sendActivityNotification`). Application permissions such as `Chat.ReadWrite.All` or `TeamsActivity.Send` need tenant-wide admin consent, a second credential and Graph on the outbound list – heavy for a notification, and broader than what Steward needs.
- **(c) Power Automate per person** (a Workflows URL each person creates and pastes in the profile). Each URL is a bearer secret that posts as that person's flow, flows break silently when their owner leaves, and administrators cannot see or revoke them. No.

## Decision

We take **(a)**: the bot's personal chat becomes a third personal channel, **Teams (personal)**, beside in-app and e-mail. It is part of the bot preview: only while the bot is on and approved (`botActive()`), and only in the module `teamsBot`.

### Opt-in per person and event

- _Profile → Teams (personal)_ lists the events the person can choose and a checkbox per event. **Nothing is chosen by default**; nothing changes for anybody until they choose.
- An event can be chosen when the instance (or the source's notification policy) **routes it to e-mail** – Teams (personal) goes where a personal e-mail would go, with the person's own text, so administrators keep one place that decides which events may interrupt people outside the app. Decision cards (`task.assigned`, `mcp.request`) are not offered: they come to the chat as decision cards already (ADR 0013). The daily summary (`summary.daily`) has its own path and is not offered.
- It comes **in addition** to e-mail. Whoever wants Teams instead turns _E-mail notifications_ off.
- Stored in a new table `notification_personal_channels (user_id, channel, events, updated_at)` (migration `notifications-004-teams-personal`), one row per person and channel (`teamsPersonal`); a migration package moves it with the identity mapping like the quiet hours. Saving is audited (`notification.personal_channel_changed`, before and after). API: `GET`/`PUT /api/me/teams-personal`.

### The conversation reference

- Recorded as today on `installationUpdate` / `conversationUpdate` when the person adds the app, and now also on the **first message** a person sends to the bot in a personal chat when no active conversation is known (for example, the app was added while the bot was off and Microsoft's call was answered with 404). Audited `teams.conversation_added`.
- A new column `teams_conversations.aad_object_id` keeps the Entra object id of the person it was recorded for. A personal chat is used only while its **tenant is still allowed**, the person is **active** and still **linked** through the configured Entra provider to **that** object id (`aadObjectIdOf()`); a conversation recorded before 0.15.0 (no object id) only while the person is linked at all. Otherwise nothing is sent.
- **Removed** (`removed_at`, audited `teams.conversation_removed` with the reason) when the app is removed (as today), when the account is **deactivated**, and when the Bot Connector answers 403 or 404 for it (the person blocked or removed the bot). Adding the app or writing to the bot again records it again. **Pseudonymisation** deletes it, as today, and the person's choices with it. The **data export** lists the chats (as today) and the choices (`settings.personalChannels`).

### Delivery

- In `notify()` (`notifications/service.ts`) each recipient who chose the event and has a usable chat gets the **same text as their e-mail** (`text(locale, recipient)` with `personal`), rendered with `teamsCard()`: title, lead, body, facts, items, links (_Open in Steward_, runbook, settings) – `Action.OpenUrl` only. Never secrets, channel URLs or anything the e-mail does not carry. Only recipients of the notice get it, and the notice's recipients are already the people who may see what it is about.
- **Quiet hours and digests apply**: the person's own settings or their team's default, `deliveryPlan()` with `personal: true`, target `teamsChat:<user>`. Held messages are released there as one catch-up or digest card, with the rights checked again at release (`renderHeld()`, `stillVisible()`). Break-throughs (emergency access, expiring decisions, urgent sources) are the same as for e-mail. The send is claimed per event key and person (`claimSend`), like e-mail.
- **Throttling**: the Bot Connector answers 429 (or 502/503/504) under load. Steward retries a personal message up to three times with exponential backoff (1 s, 2 s, 4 s; a `Retry-After` up to 30 s is honoured). When it still fails, it falls back to **e-mail once**: the same message, only when e-mail can reach the person (SMTP on, an address, _E-mail notifications_ on, an allowed domain) and the e-mail for the same notice was not already sent (the same `claimSend` key). Logged, not audited – a delivery is not a change.
- **Bot off** (switched off, not approved, module off): the profile card is hidden, nothing is sent, the choices stay for when it is on again.

### Out of scope

Group chats and meeting chats; card actions other than links and the existing approvals of ADR 0013; Microsoft Graph; Power Automate; a team default for the choices; choosing Teams _instead of_ e-mail per event; a separate administrator route for Teams (personal).

## Consequences

- People who live in Teams get their own messages there without any new permission, host or secret: the bot, its credential and its outbound hosts are those of ADR 0013.
- The feature inherits the preview status of the bot and its limits: it needs inbound HTTPS from Microsoft for the first contact, Entra `tid` + `oid` sign-in, and a person must add the app themselves (or an administrator installs it for them through Teams policies).
- One more personal target means a person in quiet hours may get a catch-up both by e-mail and in Teams. We accept it: each is the channel they chose.
- Retries hold a send for up to about 40 seconds in the background; they never block the notice for others.
- Tests: `server/test/teams-personal.test.ts` against the mock Bot Connector (`server/src/mock/mockBotConnector.ts`, which can now throttle): the conversation lifecycle (install, first message, uninstall, deactivation, 403/404, pseudonymisation, export), the choices and their audit, delivery with quiet hours and digests, only to recipients, the fallback to e-mail after repeated throttling, and the channel hidden while the bot is off; the migration on PostgreSQL. `e2e/teams-personal.spec.ts` turns the channel on in the profile and checks that the demo's mock Bot Connector received the message.
- We revisit this if Microsoft retires proactive bot messages, if many people want Teams _instead of_ e-mail (a per-event choice), or if administrators need their own route for it.
