# Settings: where to find what

Settings have three scopes, and each scope has its own place:

| Scope                                                              | Where                            | Who changes it                                     |
| ------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------- |
| **Personal**: about yourself only                                  | _Profile_ (user menu → Profile)  | every user, for themselves                         |
| **Team**: members, their roles in the team, the team's own channel | _Users → Teams_ (edit, settings) | administrators (members see their team's settings) |
| **Instance**: the whole installation                               | _Settings_, one area per topic   | administrators                                     |

People who are not administrators see in _Settings_ that instance settings are the administrators', with a link to their profile. The server refuses their changes as well.

## Instance settings by area

Each area has a stable address. Old links to `/settings` open _General_, and `/settings#notifications` (in messages) opens _Notifications_. Administrators also find every setting in the command palette (`Ctrl+K`): type its name, for example "data retention".

| Area                   | Address                   | Settings                                                                                                                                                                             |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| General                | `/settings/general`       | default language; browser automation (headless, timeout); unattended operation                                                                                                       |
| Security & sign-in     | `/settings/security`      | sign-in (password sign-in, single sign-on only); outbound access (platforms only, allow-list, open); public API documentation; MCP server; vault passphrase; API tokens of all users |
| Integrations           | `/settings/integrations`  | ticket sources; Git sync (sources at `/settings/git-sync`); migration to another instance (`/settings/migration`); end of life (endoflife.date)                                      |
| Notifications          | `/settings/notifications` | channels, routes and allowed e-mail domains; look of e-mails and Teams messages; daily summaries; credential reminders                                                               |
| Appearance & branding  | `/settings/appearance`    | colours, name and logo of the app; report branding                                                                                                                                   |
| Catalogue & compliance | `/settings/catalogue`     | four-eyes rule for dismissing access findings; CIA scale; expected documents (scorecard rules); environments                                                                         |
| Maintenance            | `/settings/maintenance`   | data retention and storage, cleanup; backups (`/settings/backups`); system status (`/settings/status`)                                                                               |

The CIA scale and the scorecard rules are also shown where they are used: _Applications → CIA scale_ and the scorecard. End of life opens from _Applications_ as well. All of them are the same settings.

Single sign-on providers and accounts are managed under _Users_.

## Team settings

_Users → Teams_ → the settings of a team. A team without settings of its own uses the instance's; the dialog shows _Instance default_ or _Overrides the instance default_, and _Back to the instance default_ removes the override.

| Setting                         | Default                                           | What the team can change                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel for the team's messages | the instance channel (_Settings → Notifications_) | its own Teams Workflow/incoming webhook (card) or JSON webhook. **Also**: the message goes to the team's channel and to the instance channel. **Instead**: only to the team's channel, when every owning team of the resource has its own channel that says so |

A message about a resource (a run of a process, a monitor, a credential, a document, a duty or objective of a service, a ticket reference, an access check of a platform …) goes to the channels of the resource's owning teams, if the notification routes send that event to Teams or a webhook. The URL is stored encrypted with the vault and never shown again; _Send a test message_ checks it. Every change is audited as `team.settings_changed` with `scope: team:<name>`, never with the URL. Migration packages carry team settings with their team, the URL encrypted with the package key.

## Personal settings

_Profile_: your account and display name, language, notification channels and subscriptions, your daily summary, password, and your API and MCP tokens. Your profile never shows instance settings.

## API

|                                     |                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/PUT /api/settings/instance`    | the instance settings document (administrators; changing sign-in or outbound access asks for a step-up)                                     |
| `GET /api/teams/:id/settings`       | a team's settings and the instance defaults it falls back to (members and administrators)                                                   |
| `PUT /api/teams/:id/settings`       | `{ channel: { enabled, format: teams\|json, mode: also\|instead, url? } \| null }`: null goes back to the instance default (administrators) |
| `POST /api/teams/:id/settings/test` | a test message to the team's channel (administrators)                                                                                       |
| `GET/PUT /api/settings`             | the old name of the same document, kept for one minor version: answers carry `Deprecation: true` and a `Link` to `/api/settings/instance`   |

Every change is audited as `settings.updated` with `scope: instance` in its details.

## Upgrade

Nothing changes value. The settings are only grouped differently, and instances without teams see the same values in their new places.
