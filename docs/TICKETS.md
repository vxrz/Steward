# Ticket references

_Tickets_ in the sidebar (German _Ticket-Referenzen_) is where the service team notes tickets that live in other systems:

- **incidents users reported** through ServiceNow, which runs the incident process – Steward only records that the ticket exists, that it is open and who handles it on our side;
- **tickets the team opened with vendors** of the platforms and services it uses: "This is open with Vendor A for Platform B, responsible from our side is …, here is the link".

Steward is not a ticketing tool. There is no workflow, no approval and no freezing: you set the status to whatever it is in the other system, and Steward keeps the history.

- [What an entry holds](#what-an-entry-holds)
- [Who may do what](#who-may-do-what)
- [Working with entries](#working-with-entries)
- [Reminders](#reminders)
- [Where tickets show up](#where-tickets-show-up)
- [Settings](#settings)
- [API and MCP](#api-and-mcp)
- [Status sync (later)](#status-sync-later)

## What an entry holds

| Field                   | Notes                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Source                  | Where the ticket lives: _ServiceNow incident_, _ServiceNow (other)_, _Vendor ticket_, _Other_ – administrators can change the list.  |
| Number                  | As in the other system, e.g. `INC0012345` or the vendor's case number. One entry per source and number.                              |
| Link                    | An http(s) link to the ticket. Other schemes (`javascript:`, `file:` …) are refused.                                                 |
| Title, note             | The note is Markdown and is shown without any HTML.                                                                                  |
| Vendor                  | Free text. The form suggests the vendors of earlier entries.                                                                         |
| Responsible on our side | Steward users and teams. They may edit the entry and get the reminders.                                                              |
| Status                  | _Open_, _Waiting for vendor_, _Waiting for us_, _Resolved_, _Closed_. Any status can follow any other.                               |
| Opened, resolved        | _Resolved_ is filled in when the status changes to resolved or closed (you can correct it), and cleared when the ticket opens again. |
| Last checked            | Set by _Mark checked_ and by every status change.                                                                                    |
| Affected items          | Services, platforms, credentials, records, monitors and processes. Stored in the same link model as record links.                    |
| Reminder                | The default, off, or a number of days for this entry (see below).                                                                    |

Every change is in the entry's history and in the audit log (`ticket.created`, `ticket.updated`, `ticket.status_changed`, `ticket.checked`, `ticket.deleted`, `ticket.link_added`, `ticket.link_removed`).

## Who may do what

| Action                                | Who                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Read entries                          | Everyone who can sign in                                                         |
| Add entries                           | Administrators, designers, operators                                             |
| Edit, change the status, mark checked | Administrators, designers, operators, and the responsible users and team members |
| Delete entries                        | Administrators                                                                   |
| Change the sources and the default    | Administrators                                                                   |

A responsible person without an editor role cannot remove themselves (or their team) from the list – they would lock themselves out.

An affected item is shown by name only to people who may see it. Others see "an item you cannot see"; their edits keep such links as they are, and they cannot add links to items they cannot see.

## Working with entries

1. Open a service, platform or record and click **Add ticket reference** under _Open tickets_ – the item is filled in as affected. Or use **New ticket reference** on the _Tickets_ page or the command palette (Ctrl/Cmd+K).
2. Enter the source, number, title and link. Pick the responsible people.
3. When something happens in the other system, open the entry and use **Change status** (with an optional comment for the history).
4. When you looked at the ticket and nothing changed, use **Mark checked**. That resets the reminder.

The list filters by status (open, resolved and closed, or single statuses), source, vendor, service, responsible person ("me" includes your teams) and age.

## Reminders

Optional and off by default. With a reminder of _N_ days, the responsible people get a notification (event _Ticket not checked_, in-app and by e-mail per _Settings → Notifications_) when an open ticket was not checked for _N_ days, and again every _N_ days until somebody checks it or changes its status. The clock starts when the entry was added. Entries without responsible people remind the person who added them.

Each reminder is sent once – also across restarts. While the vault is locked no reminder is sent (and none is lost).

## Where tickets show up

- **Service, platform and record pages**: _Open tickets_ lists the entries that name the item as affected (resolved and closed ones on request).
- **Service catalogue**: a badge with the number of open tickets from vendor sources.
- **Daily summary**: open tickets you are responsible for (see [NOTIFICATIONS.md](NOTIFICATIONS.md)).
- **Scheduled reports**: the section _Ticket references_ shows the tickets open at the end of the period per service and per vendor with their age, the tickets opened and resolved in the period, and the mean time to resolution per vendor. The figures follow from the opening and resolution dates and the status history, so a report generated later for the same period shows the same numbers.

## Settings

_Settings → Ticket references_ (administrators):

- **Sources**: key (lower case, digits and dashes, cannot change once used), name and whether it is a _vendor source_ (counted in the service catalogue badge). A source in use cannot be removed – rename it instead.
- **Remind by default** after _N_ days without a check. Entries can choose their own value or turn it off.

## API and MCP

- Web UI API: `/api/ticket-references…` (see `server/src/tickets/routes.ts`).
- Public read API: `GET /api/v1/ticket-references` (filters `status`, `state`, `source`, `vendor`, `affected=kind:id`, `q`; paginated) and `GET /api/v1/ticket-references/{ticketId}` with the history. See [API.md](API.md) and `docs/openapi.json`.
- MCP tool `list_ticket_references` (open tickets by default; filters like the API). Affected items the token owner may not see are left out.

## Status sync (later)

Not built yet: reading the status from ServiceNow (or a vendor portal) instead of copying it by hand. The extension point is the interface `TicketStatusAdapter` in `server/src/tickets/sync.ts`. An adapter would serve one or more sources and be called by a periodic job for their open entries. It must use a Steward platform's connection and credentials (through the outbound policy, only to that platform's own origins – never to the entry's link), only read, apply a status like a manual change (history entry by `system`, audit entry, counts as a check) and log failures instead of throwing them.
