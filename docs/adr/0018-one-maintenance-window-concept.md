# 0018. One maintenance-window concept; monitors as an objective source

- **Status:** Accepted
- **Date:** 2026-11-08
- **Since:** 0.11.0

## Context

Two concepts existed twice (review 0.10, P4):

- **Maintenance.** Monitors had maintenance windows of their own (`monitor_maintenance`: start, end, reason; set with the _acknowledge_ right). Next to them the catalogue had maintenance windows (`maintenance_windows`, #108): once or repeating, on platforms, systems, applications and services, with announcements, a change record and a calendar file. The catalogue windows already reached monitors through the platforms they check. The monitor engine asked both. Users had two forms for the same thing, and the two could silence a monitor in different ways.
- **Availability targets.** Availability objectives (the scorecard) took figures only from a Gatus endpoint or a PromQL query. Steward's own monitors compute a time-weighted uptime, but could not feed an objective: a service watched only by Steward monitors had "no data" on availability. Scheduled reports had their own per-section SLA target for the same monitors, so "target" lived in two places.

The documentation also said that Steward "works alongside Gatus instead of re-implementing monitoring", while monitors had grown to 26 check types, status pages and SLA reports.

## Decision

**Catalogue windows are the one maintenance-window concept.** A catalogue window can list monitors directly (target kind `monitor`, `shared/src/maintenance.ts`). The engine asks only the catalogue (`monitors/engine.ts` `activeMaintenance`, through `monitors/maintenance-hook.ts`, which `catalogue/maintenance.ts` fills): a monitor is in maintenance while a window with _Monitors stay quiet_ lists it or reaches a platform it checks. Status, notifications and outputs, the uptime figures, objectives and status pages follow from that, as they did for the old windows. Listing a monitor needs the _acknowledge_ right on it, as the old windows did; the "service editor" exception for items of the whole instance does not apply to monitors.

**The old windows are copied once.** Migration `monitors-002-maintenance-migrated` adds `migrated_to` and `migrated_at` to `monitor_maintenance` (additive). Once the vault is open, and after a migration package is imported, `migrateMonitorWindows()` copies every row not yet copied into a catalogue window that lists the monitor (once, quiet monitors, no reminder; its notices are claimed so it announces nothing, like before), marks the row and writes an audit entry `maintenance.migrated` per copy. Until then the engine still honours rows not copied. The monitor API's maintenance routes keep working for 0.11 and read and write catalogue windows in the old shape (deprecated; removed in a later release). The monitor page shows the windows that list or reach the monitor and edits them with the catalogue's form.

**A Steward monitor is an objective source.** An objective names either a platform with an endpoint key or PromQL query, or a monitor (`availability_objectives.monitor_id`, migration `scorecard-006-monitor-source`). Its figures are the monitor's time-weighted uptime over 1 h, 24 h, 7 d and 30 d from its recorded states (`monitors/stats.ts`: `statusPoints`, `upAndDown`). The monitor's own uptime, the objective and the availability section of scheduled reports use these same functions, so they show the same number for the same window. Time in maintenance (and unknown or blocked time) counts neither for nor against it. As for the other sources, a maintenance window that reaches the objective (its service, application or source monitor) holds the breach message and shows the planned minutes.

**Reports take the SLA target from the objective.** The availability section has `slaFromObjectives`: each monitor is judged by the target of the objective that has it as source, for the window closest to the report period (the strictest when there are several); monitors without one use the section's `slaTarget`. Schedules saved before 0.11 keep `slaTarget` alone; the form offers _Use the objective_ and marks the separate field deprecated.

## Consequences

- One form, one table and one audit trail for planned work. Monitor windows gain repetition, announcements, change records and calendar files.
- A service watched only by Steward monitors gets availability on its scorecard.
- The monitor's uptime, the objective and the report agree for the same window. Gatus' and Prometheus' figures still come from those tools and can differ from a Steward monitor watching the same thing.
- Copied windows of monitors that no longer exist are only marked. Windows that list only a deleted monitor go with it. Catalogue windows are not removed by the monitor-history retention, so the copies of old monitor windows stay until someone cancels or the monitor is deleted.
- The deprecated monitor maintenance routes stay for one release. Removing them, and the `monitor_maintenance` table later, is a separate change.
- Not part of this decision (review 0.10, P3): one network model for plant VLANs and catalogue network segments, dropping the component type "Platform", and renaming changedetection "components".
