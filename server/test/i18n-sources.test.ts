import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_ACTIONS,
  CATEGORY_ORDER,
  CHECK_TYPE_INFO,
  COMMON_FIELDS,
  MONITOR_STATUS_INFO,
  NOTIFICATION_EVENT_INFO,
  ROLE_INFO,
  STEP_META,
  WIDGET_INFO,
  validateProcess,
} from '@sm/shared';

// The shared package keeps English defaults for metadata shown in the UI; the web
// translates it with keys derived from ids. These tests keep the English locale
// files in sync with those defaults, so translators always see the current text.
const locales = path.resolve(__dirname, '../../web/src/locales');
const load = (lang: string, ns: string) => JSON.parse(fs.readFileSync(path.join(locales, lang, `${ns}.json`), 'utf8'));

describe('English locale files mirror the shared metadata', () => {
  const editor = load('en', 'editor');

  it('node palette: labels, descriptions, field labels and help', () => {
    for (const [type, meta] of Object.entries(STEP_META)) {
      expect(editor.steps[type]?.label, `steps.${type}.label`).toBe(meta.label);
      expect(editor.steps[type]?.description, `steps.${type}.description`).toBe(meta.description);
      for (const f of meta.fields) {
        expect(editor.steps[type].fields?.[f.key]?.label, `steps.${type}.fields.${f.key}.label`).toBe(f.label);
        expect(editor.steps[type].fields?.[f.key]?.help, `steps.${type}.fields.${f.key}.help`).toBe(f.help);
      }
    }
    for (const f of COMMON_FIELDS) {
      expect(editor.commonFields[f.key]?.label).toBe(f.label);
      expect(editor.commonFields[f.key]?.help).toBe(f.help);
    }
    for (const c of CATEGORY_ORDER) expect(editor.categories[c]).toBe(c);
    for (const b of BROWSER_ACTIONS) expect(editor.browserActions[b.action]).toBe(b.label);
  });

  it('notification events, widget types and roles', () => {
    const notifications = load('en', 'notifications');
    for (const [event, info] of Object.entries(NOTIFICATION_EVENT_INFO)) {
      const [a, b] = event.split('.') as [string, string];
      expect(notifications.events[a]?.[b]?.info, event).toBe(info);
    }
    const dashboards = load('en', 'dashboards');
    for (const [type, info] of Object.entries(WIDGET_INFO)) expect(dashboards.widgets[type]?.info, type).toBe(info);
    const common = load('en', 'common');
    for (const [role, info] of Object.entries(ROLE_INFO)) expect(common.roleInfo[role], role).toBe(info);
  });

  it('monitor statuses and check types', () => {
    const monitors = load('en', 'monitors');
    for (const [status, info] of Object.entries(MONITOR_STATUS_INFO)) expect(monitors.statusInfo[status], `statusInfo.${status}`).toBe(info);
    for (const [type, info] of Object.entries(CHECK_TYPE_INFO)) {
      expect(monitors.checkTypes[type]?.label, `checkTypes.${type}.label`).toBe(info.label);
      expect(monitors.checkTypes[type]?.help, `checkTypes.${type}.help`).toBe(info.help);
    }
  });

  it('every validation code has a translation', () => {
    const graphs = [
      { name: 'x', nodes: [{ id: 'a', type: 'log', message: 'm', x: 0, y: 0 }], wires: [] },
      {
        name: 'x',
        outputs: { 'bad name': 'x' },
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'h', type: 'http', connection: 'nope', method: 'GET', path: '/', x: 1, y: 0 },
          { id: 'u', type: 'userTask', mode: 'select', title: 't', x: 2, y: 0 },
          { id: 'i', type: 'if', condition: 'true', when: 'x', x: 3, y: 0 },
        ],
        wires: [
          { from: 'start', port: 'nope', to: 'h' },
          { from: 'h', port: 'out', to: 'start' },
          { from: 'h', port: 'out', to: 'ghost' },
        ],
      },
    ];
    const codes = new Set<string>();
    for (const g of graphs) {
      const r = validateProcess(g);
      for (const i of [...r.issues, ...r.warnings]) if (i.code) codes.add(i.code);
    }
    expect(codes.size).toBeGreaterThan(4);
    for (const c of codes) expect(editor.validation[c], c).toBeTypeOf('string');
    // and the other way round: no stale keys
    const src = fs.readFileSync(path.resolve(__dirname, '../../shared/src/process.ts'), 'utf8');
    for (const key of Object.keys(editor.validation)) expect(src, key).toContain(`code: '${key}'`);
  });
});
