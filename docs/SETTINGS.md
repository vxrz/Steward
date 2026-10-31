# Settings: where to find what

Settings have three scopes, and each scope has its own place:

| Scope                                         | Where                           | Who changes it             |
| --------------------------------------------- | ------------------------------- | -------------------------- |
| **Personal**: about yourself only             | _Profile_ (user menu → Profile) | every user, for themselves |
| **Team**: members and their roles in the team | _Users → Teams_                 | administrators             |
| **Instance**: the whole installation          | _Settings_, one area per topic  | administrators             |

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

## Personal settings

_Profile_: your account and display name, language, notification channels and subscriptions, your daily summary, password, and your API and MCP tokens. Your profile never shows instance settings.

## API

|                                  |                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/PUT /api/settings/instance` | the instance settings document (administrators; changing sign-in or outbound access asks for a step-up)                                   |
| `GET/PUT /api/settings`          | the old name of the same document, kept for one minor version: answers carry `Deprecation: true` and a `Link` to `/api/settings/instance` |

Every change is audited as `settings.updated` with `scope: instance` in its details.

## Upgrade

Nothing changes value. The settings are only grouped differently, and instances without teams see the same values in their new places.
