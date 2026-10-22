// English is the source language: these imports define the key types (see i18next.d.ts).
// Only the namespaces in BUNDLED_NAMESPACES are part of the first download; the
// other English files are loaded on demand like every other language.
import type access from '../locales/en/access.json';
import type audit from '../locales/en/audit.json';
import type dashboard from '../locales/en/dashboard.json';
import type dashboards from '../locales/en/dashboards.json';
import type editor from '../locales/en/editor.json';
import type mcp from '../locales/en/mcp.json';
import type monitors from '../locales/en/monitors.json';
import type platforms from '../locales/en/platforms.json';
import type processes from '../locales/en/processes.json';
import type profile from '../locales/en/profile.json';
import type records from '../locales/en/records.json';
import type reports from '../locales/en/reports.json';
import type runs from '../locales/en/runs.json';
import type schedules from '../locales/en/schedules.json';
import type services from '../locales/en/services.json';
import type settings from '../locales/en/settings.json';
import type system from '../locales/en/system.json';
import type tasks from '../locales/en/tasks.json';
import type triggers from '../locales/en/triggers.json';
import type users from '../locales/en/users.json';
import type credentials from '../locales/en/credentials.json';
import type reportSchedules from '../locales/en/reportSchedules.json';
import type gatus from '../locales/en/gatus.json';
import type gitSync from '../locales/en/gitSync.json';
import type tickets from '../locales/en/tickets.json';
import auth from '../locales/en/auth.json';
import common from '../locales/en/common.json';
import errors from '../locales/en/errors.json';
import nav from '../locales/en/nav.json';
import notifications from '../locales/en/notifications.json';

export const bundledEnglish = { common, nav, auth, errors, notifications };

export interface Resources {
  common: typeof common;
  nav: typeof nav;
  auth: typeof auth;
  errors: typeof errors;
  notifications: typeof notifications;
  access: typeof access;
  dashboard: typeof dashboard;
  processes: typeof processes;
  editor: typeof editor;
  runs: typeof runs;
  reports: typeof reports;
  tasks: typeof tasks;
  schedules: typeof schedules;
  triggers: typeof triggers;
  monitors: typeof monitors;
  platforms: typeof platforms;
  dashboards: typeof dashboards;
  audit: typeof audit;
  settings: typeof settings;
  users: typeof users;
  profile: typeof profile;
  system: typeof system;
  credentials: typeof credentials;
  reportSchedules: typeof reportSchedules;
  gatus: typeof gatus;
  mcp: typeof mcp;
  records: typeof records;
  services: typeof services;
  gitSync: typeof gitSync;
  tickets: typeof tickets;
}
