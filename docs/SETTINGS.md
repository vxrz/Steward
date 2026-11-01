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

_Users → Teams_ → the settings of a team, one tab per setting. A team without a value of its own uses the instance's; each tab shows _Instance default_ or _Overrides the instance default_, and _Back to the instance default_ removes the override. Members of the team see the settings, administrators change them.

| Setting                         | Default                                           | What the team can change                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Channel for the team's messages | the instance channel (_Settings → Notifications_) | its own Teams Workflow/incoming webhook (card) or JSON webhook. **Also**: the message goes to the team's channel and to the instance channel. **Instead**: only to the team's channel, when every owning team of the resource has its own channel that says so     |
| New resources of members        | _Once the team owns something_                    | _Always_: the team owns its members' new resources from the start. _Never_: they do not get this team, and members cannot choose it ([TEAMS.md](TEAMS.md#new-resources))                                                                                           |
| Daily summary for members       | the instance default: none                        | a daily summary (time, time zone, days, channel, sections) for members who did not choose their own in their profile. Their own settings always win; with several teams, the first by name that sets one applies                                                   |
| Report branding                 | the instance branding (_Settings → Appearance_)   | company name, accent colour, default classification, footer note and logo, each on its own: an empty field keeps the instance value. Used by the team's report schedules, run reports of its processes and PDFs of its records ([REPORTS.md](REPORTS.md#branding)) |

A message about a resource (a run of a process, a monitor, a credential, a document, a duty or objective of a service, a ticket reference, an access check of a platform …) goes to the channels of the resource's owning teams, if the notification routes send that event to Teams or a webhook. The URL is stored encrypted with the vault and never shown again; _Send a test message_ checks it. Every change is audited as `team.settings_changed` with `scope: team:<name>`, never with the URL. Migration packages carry team settings with their team: the URL encrypted with the package key, the defaults and the logo as they are, and which members chose the team for their new resources.

## Personal settings

_Profile_: your account and display name, language, notification channels and subscriptions, your daily summary, the owning team of your new resources, password, and your API and MCP tokens. Your profile never shows instance settings.

Where a personal value has a default, the profile says where it comes from:

- **Daily summary**: _Your own settings_, _Default of team …_ or _Instance default_ (none). Saving makes the settings your own; _Back to the default_ removes them, and the team's or the instance's default applies again.
- **Owning team of new resources** (shown to members of a team): _Default of your teams_, _Your choice_ or _Whole instance_, and which teams your new resources get now. Choose one of your teams, or _My teams' defaults_ again.

## Every setting, its scope and who changes it

| Setting                                                                            | Scope           | Changed by                                      | Where                               |
| ---------------------------------------------------------------------------------- | --------------- | ----------------------------------------------- | ----------------------------------- |
| Display name, e-mail (local accounts), language                                    | personal        | the person                                      | Profile                             |
| E-mail notifications, in-app subscriptions                                         | personal        | the person                                      | Profile                             |
| Daily summary                                                                      | personal        | the person (team default: administrators)       | Profile; _Users → Teams_ → settings |
| Owning team of one's new resources                                                 | personal        | the person                                      | Profile                             |
| Password, API and MCP tokens                                                       | personal        | the person                                      | Profile                             |
| Members, their roles in the team                                                   | team            | administrators                                  | _Users → Teams_                     |
| Team channel, new resources of members, daily summary for members, report branding | team            | administrators (members see them)               | _Users → Teams_ → settings          |
| Owning teams of a resource                                                         | resource        | administrators                                  | the resource's _Owning teams_ panel |
| Default language, browser automation, unattended operation                         | instance        | administrators                                  | _Settings → General_                |
| Sign-in, single sign-on only, outbound access, public API, MCP server, vault       | instance        | administrators (with a step-up for some)        | _Settings → Security & sign-in_     |
| API tokens of all users                                                            | instance        | administrators                                  | _Settings → Security & sign-in_     |
| Ticket sources, Git sync, migration, end of life                                   | instance        | administrators                                  | _Settings → Integrations_           |
| Notification channels, routes, e-mail domains, look of messages                    | instance        | administrators                                  | _Settings → Notifications_          |
| Daily summaries allowed (for everyone), credential reminders                       | instance        | administrators                                  | _Settings → Notifications_          |
| Colours, name and logo of the app; report branding                                 | instance        | administrators                                  | _Settings → Appearance & branding_  |
| Four-eyes rule for access findings, CIA scale, expected documents, environments    | instance        | administrators                                  | _Settings → Catalogue & compliance_ |
| Data retention and storage, backups, system status                                 | instance        | administrators (system status: auditors see it) | _Settings → Maintenance_            |
| Single sign-on providers and accounts                                              | instance        | administrators                                  | _Users_                             |
| A report schedule's sections, recipients and team                                  | report schedule | its owner and administrators                    | _Reports_                           |

## API

|                                                |                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/PUT /api/settings/instance`               | the instance settings document (administrators; changing sign-in or outbound access asks for a step-up)                                                                                                                                                                                                                                                                                              |
| `GET /api/teams/:id/settings`                  | a team's settings and the instance defaults it falls back to (members and administrators)                                                                                                                                                                                                                                                                                                            |
| `PUT /api/teams/:id/settings`                  | `{ channel?, newResources?: auto\|always\|never, summary?, branding? }`, each optional (omitted: unchanged); `channel: { enabled, format: teams\|json, mode: also\|instead, url? }`, `summary` as `PUT /api/me/daily-summary`, `branding: { companyName, accentColor, classification, footerNote }` (null fields keep the instance value). `null` goes back to the instance default (administrators) |
| `POST /api/teams/:id/settings/test`            | a test message to the team's channel (administrators)                                                                                                                                                                                                                                                                                                                                                |
| `GET/POST/DELETE /api/teams/:id/settings/logo` | the team's report logo: shown to members, uploaded (`{ contentBase64 }`, PNG or JPEG) and removed by administrators                                                                                                                                                                                                                                                                                  |
| `GET/PUT /api/me/new-resource-teams`           | the owning teams of your new resources, where they come from, and your choice (`{ teamId \| null }`)                                                                                                                                                                                                                                                                                                 |
| `DELETE /api/me/daily-summary`                 | your daily summary back to the default (a team's or the instance's)                                                                                                                                                                                                                                                                                                                                  |
| `GET/PUT /api/settings`                        | the old name of the same document, kept for one minor version: answers carry `Deprecation: true` and a `Link` to `/api/settings/instance`                                                                                                                                                                                                                                                            |

Every change is audited as `settings.updated` with `scope: instance` in its details.

## Upgrade

Nothing changes value. The settings are only grouped differently, and instances without teams see the same values in their new places. Teams start without settings of their own: every team uses the instance channel, branding and daily summary default, and new resources get their creator's teams as before (once a team owns something).
