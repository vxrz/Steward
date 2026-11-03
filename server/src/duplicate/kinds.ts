/**
 * The kinds that can be duplicated (0.4.0) and how each one is copied – with its own create function, so a copy is
 * checked like anything new. The rules they share are in common.ts.
 */
import {
  DEFAULT_SCHEDULE_NOTIFY,
  type AccessCheck,
  type Credential,
  type Dashboard,
  type DuplicateKind,
  type MaintenanceWindowDetail,
  type ProcessDetail,
  type ReportSchedule,
  type Schedule,
  type StatusPage,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, slugify } from '../util.js';
import { me } from '../auth/access.js';
import { capabilities, isAdmin } from '../auth/permissions.js';
import { memberships } from '../auth/policy.js';
import { listTeams } from '../auth/users.js';
import * as processes from '../processes/service.js';
import * as dashboards from '../dashboards/service.js';
import * as credentials from '../credentials/service.js';
import * as scheduler from '../scheduler.js';
import * as reportSchedules from '../reports/schedules.js';
import * as maintenance from '../catalogue/maintenance.js';
import * as statusPages from '../catalogue/status-pages.js';
import * as reconciliation from '../compliance/reconciliation.js';
import { canCreateChecks } from '../compliance/access.js';
import { canCreateServices } from '../records/access.js';
import { getPlatform } from '../platforms/service.js';
import { secretInputNames } from '../engine/secret-inputs.js';
import { copyOwningTeams, type Duplicator } from './common.js';
import { monitorDuplicator } from './monitor.js';
import { applicationDuplicator, serviceDuplicator } from './catalogue.js';

/** Platforms bound to a schedule must be usable by the person who copies it (as when they create one). */
const usablePlatforms = (bindings: Record<string, string>): boolean =>
  Object.values(bindings).every((pid) => {
    try {
      return getPlatform(pid).permissions.includes('use');
    } catch {
      return false;
    }
  });

const processDuplicator: Duplicator<ProcessDetail> = {
  kind: 'process',
  entityType: 'process',
  label: 'Process',
  accessApplies: true,
  view(id) {
    const perms = processes.permissionsFor(id);
    if (!perms.includes('view')) throw new HttpError(404, `Process ${id} not found`, 'PROCESS_NOT_FOUND', { id });
    const p = processes.getProcess(id);
    return { id: p.id, name: p.name, key: p.id, mayManage: perms.includes('manage'), data: p };
  },
  mayCreate: () => capabilities(me()).createProcesses,
  keyTaken: (k) => slugify(k) !== k || !!db().get('SELECT 1 FROM processes WHERE id = ?', k),
  keyMax: 48,
  copy(src, input) {
    const p = src.data;
    const def = structuredClone(p.definition);
    def.name = input.name;
    // a secret input never has a stored value to copy (a default would be one)
    const secrets = new Set(secretInputNames(def.inputs));
    for (const i of def.inputs ?? []) if (secrets.has(i.name)) delete (i as { default?: unknown }).default;
    const made = processes.createProcess(def, { id: input.key!, comment: `Copied from ${p.id} v${p.currentVersion}` });
    if (input.copyAccess) {
      db().run('UPDATE processes SET acl = ? WHERE id = ?', JSON.stringify(p.acl), made.id);
      copyOwningTeams('process', p.id, made.id);
    }
    return { id: made.id, name: made.name, key: made.id, details: { version: p.currentVersion } };
  },
  paths: (id) => ({ path: `/processes/${id}`, editPath: `/processes/${id}` }),
};

const dashboardDuplicator: Duplicator<Dashboard> = {
  kind: 'dashboard',
  entityType: 'dashboard',
  label: 'Dashboard',
  accessApplies: true,
  view(id) {
    const d = dashboards.getDashboard(id);
    return { id: d.id, name: d.name, key: d.id, mayManage: d.canEdit, data: d };
  },
  mayCreate: () => capabilities(me()).createProcesses,
  keyTaken: (k) => slugify(k) !== k || !!db().get('SELECT 1 FROM dashboards WHERE id = ?', k),
  keyMax: 48,
  copy(src, input) {
    const made = dashboards.createDashboard({ ...structuredClone(src.data.definition), name: input.name }, { id: input.key! });
    if (input.copyAccess) copyOwningTeams('dashboard', src.id, made.id);
    return { id: made.id, name: made.name, key: made.id };
  },
  paths: (id) => ({ path: `/dashboards/${id}`, editPath: `/dashboards/${id}?edit=1` }),
};

const credentialDuplicator: Duplicator<Credential> = {
  kind: 'credential',
  entityType: 'credential',
  label: 'Credential register entry',
  accessApplies: true,
  view(id) {
    const c = credentials.getCredential(id);
    return { id: c.id, name: c.name, key: null, mayManage: c.permissions.includes('edit'), data: c };
  },
  mayCreate: () => credentials.canCreateCredentials(me()),
  copy(src, input) {
    const c = src.data;
    // the documentation of the entry; its dates, certificate and expiry sync describe the original's secret
    const made = credentials.createCredential(
      credentials.credentialInputSchema.parse({
        name: input.name,
        type: c.type,
        belongsTo: c.belongsTo ? { kind: c.belongsTo.kind, id: c.belongsTo.id } : null,
        platformId: c.platformId,
        platformText: c.platformText,
        environment: c.environment,
        description: c.description,
        usedBy: { text: c.usedBy.text, links: c.usedBy.links.map((l) => ({ kind: l.kind, id: l.id })), urls: c.usedBy.urls },
        roles: c.roles,
        owners: c.owners,
        // owners of the entry may change it: they are its access settings
        ownerSubjects: input.copyAccess ? c.ownerSubjects : [],
        location: c.location,
        rotationIntervalDays: c.rotationIntervalDays,
        reviewIntervalDays: c.reviewIntervalDays,
        reminders: c.reminders,
        notes: c.notes,
        tags: c.tags,
      }),
    );
    if (input.copyAccess) copyOwningTeams('credential', c.id, made.id);
    return { id: made.id, name: made.name, key: null };
  },
  paths: (id) => ({ path: `/credentials?open=${id}`, editPath: `/credentials?edit=${id}` }),
};

const scheduleDuplicator: Duplicator<Schedule> = {
  kind: 'schedule',
  entityType: 'schedule',
  label: 'Schedule',
  accessApplies: false,
  startsDisabled: true,
  view(id) {
    const s = scheduler.getSchedule(id);
    if (!processes.permissionsFor(s.processId).includes('view')) throw new HttpError(404, 'Schedule not found', 'SCHEDULE_NOT_FOUND', { id });
    return { id: s.id, name: s.name, key: null, mayManage: !!s.canEdit, data: s };
  },
  // a schedule runs its process: the person needs the run right on it, and may use the platforms it binds
  mayCreate: (src) => processes.permissionsFor(src.data.processId).includes('run') && usablePlatforms(src.data.bindings ?? {}),
  copy(src, input) {
    const s = src.data;
    // secret inputs are kept encrypted for this schedule only: the copy asks for them again
    const secret = new Set(secretInputNames(processes.getProcess(s.processId).definition.inputs));
    const inputs = Object.fromEntries(Object.entries(s.inputs ?? {}).filter(([k]) => !secret.has(k)));
    const dropped = Object.keys(s.inputs ?? {}).length - Object.keys(inputs).length;
    const made = scheduler.saveSchedule({
      name: input.name,
      processId: s.processId,
      cron: s.cron,
      timezone: s.timezone,
      inputs,
      bindings: s.bindings,
      dryRun: s.dryRun,
      enabled: false,
      allowOverlap: s.allowOverlap,
      owner: null,
      notify: { ...DEFAULT_SCHEDULE_NOTIFY, ...s.notify, pause: null },
    });
    return { id: made.id, name: made.name, key: null, skipped: dropped ? [{ what: 'secretInputs', count: dropped }] : [] };
  },
  paths: (id) => ({ path: `/schedules?edit=${id}`, editPath: `/schedules?edit=${id}` }),
};

const reportScheduleDuplicator: Duplicator<ReportSchedule> = {
  kind: 'report-schedule',
  entityType: 'report_schedule',
  label: 'Report schedule',
  // the recipients see the reports: they are its access settings
  accessApplies: true,
  startsDisabled: true,
  view(id) {
    const s = reportSchedules.getReportSchedule(id);
    return { id: s.id, name: s.name, key: null, mayManage: s.canEdit, data: s };
  },
  mayCreate: () => reportSchedules.canCreateReportSchedules(me()),
  copy(src, input) {
    const s = src.data;
    const u = me();
    // the branding of a team the new owner belongs to (administrators: any)
    const team = s.team && (isAdmin(u) || memberships(u).has(s.team.id)) && listTeams().some((x) => x.id === s.team!.id) ? s.team.name : null;
    const made = reportSchedules.createReportSchedule(
      reportSchedules.scheduleInputSchema.parse({
        name: input.name,
        enabled: false,
        preset: s.preset,
        ...(s.preset === 'custom' ? { cron: s.cron } : {}),
        timezone: s.timezone,
        periodDays: s.periodDays,
        lang: s.lang,
        classification: s.classification,
        title: s.title,
        sections: s.sections,
        recipients: input.copyAccess ? s.recipients : { users: [], teams: [], emails: [] },
        attachPdf: s.attachPdf,
        team,
      }),
    );
    return { id: made.id, name: made.name, key: null, skipped: s.team && !team ? [{ what: 'team', count: 1 }] : [] };
  },
  paths: (id) => ({ path: `/reports?edit=${id}`, editPath: `/reports?edit=${id}` }),
};

const maintenanceDuplicator: Duplicator<MaintenanceWindowDetail> = {
  kind: 'maintenance-window',
  entityType: 'maintenance',
  label: 'Maintenance window',
  accessApplies: false,
  startsDisabled: true,
  view(id) {
    const w = maintenance.getMaintenance(id);
    return { id: w.id, name: w.title, key: null, mayManage: w.canEdit, data: w };
  },
  // planning maintenance for the items it lists (createMaintenance checks each one again)
  mayCreate: (src) => src.data.canEdit || canCreateServices(me()),
  copy(src, input) {
    const w = src.data;
    const made = maintenance.createMaintenance(
      maintenance.maintenanceInput.parse({
        title: input.name.slice(0, 160),
        note: w.note,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        recurrence: w.recurrence,
        // the items the person sees (the others stay the original's)
        targets: w.targets.map((t) => ({ kind: t.kind, id: t.id })),
        responsible: w.responsible,
        changeRecordId: w.changeRecord?.id ?? null,
        quietMonitors: w.quietMonitors,
        pauseMessages: w.pauseMessages,
        reminderHours: w.reminderHours,
        enabled: false,
      }),
    );
    return { id: made.id, name: made.title, key: null };
  },
  paths: (id) => ({ path: `/maintenance?open=${id}`, editPath: `/maintenance?edit=${id}` }),
};

const accessCheckDuplicator: Duplicator<AccessCheck> = {
  kind: 'access-check',
  entityType: 'access_check',
  label: 'Access check',
  accessApplies: false,
  startsDisabled: true,
  view(id) {
    const c = reconciliation.getCheck(id);
    return { id: c.id, name: c.name, key: null, mayManage: c.canEdit, data: c };
  },
  mayCreate: () => canCreateChecks(me()),
  copy(src, input) {
    const c = src.data;
    // ignored rights hide grants from every snapshot: only administrators set them (GOV-5)
    const ignoreRights = isAdmin(me()) ? c.ignoreRights : [];
    const made = reconciliation.createCheck(
      reconciliation.checkInput.parse({
        name: input.name.slice(0, 120),
        description: c.description,
        platformId: c.platformId,
        source: c.source,
        datasetKey: c.datasetKey,
        scope: c.scope,
        cron: c.cron,
        timezone: c.timezone,
        enabled: false,
        notify: c.notify,
        ignoreRights,
      }),
    );
    const skipped = c.ignoreRights.length && !ignoreRights.length ? [{ what: 'ignoredRights', count: c.ignoreRights.length }] : [];
    return { id: made.id, name: made.name, key: null, skipped };
  },
  paths: (id) => ({ path: `/compliance/reconciliation?check=${id}`, editPath: `/compliance/reconciliation?check=${id}&edit=1` }),
};

const statusPageDuplicator: Duplicator<StatusPage> = {
  kind: 'status-page',
  entityType: 'status_page',
  label: 'Status page',
  accessApplies: false,
  view(id) {
    const p = statusPages.getPage(id);
    return { id: p.id, name: p.title, key: null, mayManage: p.canEdit, data: p };
  },
  mayCreate: (src) => src.data.canEdit,
  copy(src, input) {
    const p = src.data;
    // the public link (a secret) stays with the original: the copy has none until someone creates one
    const serviceIds = p.serviceIds.filter((id) => statusPages.mayPublishService(id));
    if (!serviceIds.length) throw new HttpError(400, 'None of the services of this status page can be published by you', 'DUPLICATE_NO_SERVICES');
    const made = statusPages.createPage(
      statusPages.pageInput.parse({
        title: input.name.slice(0, 120),
        description: p.description,
        serviceIds,
        showObjectives: p.showObjectives,
        showVendorIssues: p.showVendorIssues,
        notice: p.notice,
        noticeLevel: p.noticeLevel,
      }),
    );
    const left = p.serviceIds.length - serviceIds.length;
    return { id: made.id, name: made.title, key: null, skipped: left ? [{ what: 'services', count: left }] : [] };
  },
  paths: (id) => ({ path: `/status-pages/${id}`, editPath: `/status-pages?edit=${id}` }),
};

export const DUPLICATORS: Record<DuplicateKind, Duplicator<never>> = {
  monitor: monitorDuplicator,
  process: processDuplicator,
  dashboard: dashboardDuplicator,
  credential: credentialDuplicator,
  application: applicationDuplicator,
  service: serviceDuplicator,
  schedule: scheduleDuplicator,
  'report-schedule': reportScheduleDuplicator,
  'maintenance-window': maintenanceDuplicator,
  'access-check': accessCheckDuplicator,
  'status-page': statusPageDuplicator,
} as unknown as Record<DuplicateKind, Duplicator<never>>;
