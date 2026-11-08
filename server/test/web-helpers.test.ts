import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_EVENTS, notificationCategory, type Capabilities, type FlowNode, type ProcessDefinition } from '@sm/shared';

/**
 * Pure helpers of the web app (quality review Q10): the web has no unit-test runner of its own, so their logic is
 * checked here – formatting, sorting and filtering, the format locale, notification categories, module switches, the
 * flow editor's graph operations and clipboard, and the expression assistant.
 */

// the i18n module sets <html lang> once it is ready: give it a document to write to
vi.hoisted(() => {
  const g = globalThis as { document?: unknown };
  g.document ??= { documentElement: {} };
});

import i18n, { currentLanguage, formatLocale, setLanguage } from '../../web/src/i18n/index.js';
import { fmtBytes, fmtDuration, fmtNumber, runDuration } from '../../web/src/format.js';
import { compact, niceTicks, percent, toCsv } from '../../web/src/components/dashboard/format.js';
import { addWire, duplicateNode, removeNodes, renameNode, wireError, createNode } from '../../web/src/components/flow/graphOps.js';
import { copyNodes, pasteNodes } from '../../web/src/components/flow/clipboard.js';
import { enclosingLoops, filterSuggestions, sampleKeys, tokenAt, type Suggestion } from '../../web/src/components/editor/exprAssist.js';
import { issuesByCheck } from '../../web/src/components/monitors/validate.js';

const languages = (list: string[]) => vi.stubGlobal('navigator', { language: list[0], languages: list });

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('format locale', () => {
  it('takes the browser’s regional variant of the UI language, else the UI language', async () => {
    await setLanguage('en');
    languages(['en-GB', 'de-DE']);
    expect(formatLocale()).toBe('en-GB');
    languages(['fr-FR']);
    expect(formatLocale()).toBe('en');
    // a POSIX locale of a kiosk browser does not take the page down
    languages(['en-US@posix']);
    expect(formatLocale()).toBe('en-US');
    await setLanguage('de');
    languages(['en-GB', 'de-AT']);
    expect(currentLanguage()).toBe('de');
    expect(formatLocale()).toBe('de-AT');
    await setLanguage('en');
  });
});

describe('formatters', () => {
  beforeAll(async () => {
    await setLanguage('en');
    languages(['en-US']);
  });

  it('formats numbers, sizes and durations in the format locale', () => {
    expect(fmtNumber(1284)).toBe('1,284');
    expect(fmtNumber(null)).toBe('–');
    expect(fmtNumber(Number.NaN)).toBe('–');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(fmtBytes(undefined)).toBe('–');
    expect(fmtDuration(850)).toBe('850 ms');
    expect(fmtDuration(1234)).toBe('1.2 s');
    expect(fmtDuration(184_000)).toBe('3 min 4 s');
    expect(fmtDuration(null)).toBe('');
    expect(runDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:02.500Z')).toBe('2.5 s');
    languages(['de-DE']);
    // the UI is English: a German browser alone does not change the format
    expect(fmtNumber(1284.5)).toBe('1,284.5');
    languages(['en-US']);
  });

  it('formats dashboard values: compact numbers, percentages, axis ticks and CSV', () => {
    expect(compact(1284)).toBe('1,284');
    expect(compact(12_900)).toBe('12.9K');
    expect(compact(4_200_000)).toBe('4.2M');
    expect(compact(undefined)).toBe('–');
    expect(percent(0.42)).toBe('42%');
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(87)).toEqual([0, 50, 100]);
    expect(niceTicks(10)).toEqual([0, 5, 10]);
    expect(niceTicks(0.3)).toEqual([0, 0.1, 0.2, 0.3]);
    // text a spreadsheet would run as a formula is defused, numbers stay numbers
    expect(toCsv(['a', 'b'], [['=1+1', -3]])).toBe("a,b\n'=1+1,-3");
    expect(toCsv(['x'], [['say "hi"; bye']])).toBe('x\n"say ""hi""; bye"');
  });

  it('follows the UI language', async () => {
    await setLanguage('de');
    languages(['de-DE']);
    expect(fmtNumber(1284.5)).toBe('1.284,5');
    expect(fmtBytes(1536)).toBe('1,5 KB');
    expect(percent(0.42)).toMatch(/^42\s%$/); // a (narrow) no-break space
    await setLanguage('en');
    languages(['en-US']);
  });
});

describe('list sorting', () => {
  type SortValue = string | number | boolean | null | undefined;
  type SortRows = <T>(rows: T[], value: (row: T) => SortValue, dir: 'asc' | 'desc') => T[];

  it('sorts stably by the format locale, numbers by value, empty values last in both directions', async () => {
    // imported by URL, like modules.ts below: DataTable.tsx is a React file
    const { sortRows } = (await import(new URL('../../web/src/components/DataTable.tsx', import.meta.url).href)) as { sortRows: SortRows };
    const rows = [{ n: 'item 10' }, { n: '' }, { n: 'Item 9' }, { n: 'äpfel' }, { n: 'item 10' }, { n: 'Zebra' }].map((r, i) => ({ ...r, i }));
    const by = (dir: 'asc' | 'desc') => sortRows(rows, (r) => r.n, dir).map((r) => r.i);
    expect(by('asc')).toEqual([3, 2, 0, 4, 5, 1]);
    expect(by('desc')).toEqual([5, 0, 4, 2, 3, 1]);
    expect(sortRows([{ v: 10 }, { v: null }, { v: 9 }, { v: -1 }], (r) => r.v, 'asc').map((r) => r.v)).toEqual([-1, 9, 10, null]);
  });
});

describe('notification categories', () => {
  it('sorts every event into one category: decisions, alerts, updates', () => {
    const by = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, NOTIFICATION_EVENTS.filter((e) => notificationCategory(e) === c)]));
    expect(by.decision).toEqual(expect.arrayContaining(['task.assigned', 'mcp.request']));
    expect(by.alert).toEqual(expect.arrayContaining(['run.failed', 'monitor.status', 'backup.failed']));
    expect(by.update).toEqual(expect.arrayContaining(['check.resolved', 'credential.due']));
    expect(Object.values(by).flat().sort()).toEqual([...NOTIFICATION_EVENTS].sort());
    // an event the web app does not know yet is an update, never an alert
    expect(notificationCategory('something.new')).toBe('update');
  });
});

// web/src/modules.ts imports the React hooks next to the helpers: the session and the API client are left out here
vi.mock('../../web/src/auth.tsx', () => ({ useMe: () => null }));
vi.mock('../../web/src/api.ts', () => ({ get: () => Promise.resolve(null) }));

describe('module switches', () => {
  it('leaves a module on unless the server says it is off; the plant registry keeps its own flag', async () => {
    // imported by URL: the server's type check does not compile the web app's React files (modules.ts → auth.tsx)
    const { moduleOn, navModuleOn } = (await import(new URL('../../web/src/modules.ts', import.meta.url).href)) as {
      moduleOn: (caps: Capabilities, id: string) => boolean;
      navModuleOn: (caps: Capabilities, key: string) => boolean;
    };
    const caps = (c: Partial<Capabilities>) => c as Capabilities;
    expect(moduleOn(caps({}), 'costs')).toBe(true);
    expect(moduleOn(caps({ modules: { costs: false } } as Partial<Capabilities>), 'costs')).toBe(false);
    expect(moduleOn(caps({ modules: { costs: true } } as Partial<Capabilities>), 'costs')).toBe(true);
    // plant: off unless the server says it is on (older servers only send `plant`)
    expect(moduleOn(caps({}), 'plant')).toBe(false);
    expect(moduleOn(caps({ plant: true }), 'plant')).toBe(true);
    expect(moduleOn(caps({ plant: true, modules: { plant: false } } as Partial<Capabilities>), 'plant')).toBe(false);
    // a sidebar entry without a module is always on
    expect(navModuleOn(caps({ modules: { costs: false } } as Partial<Capabilities>), 'processes')).toBe(true);
  });
});

const node = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra }) as unknown as FlowNode;
const def = (nodes: FlowNode[], wires: ProcessDefinition['wires'] = []): ProcessDefinition =>
  ({ name: 'Test', connections: [{ slot: 'api' }], inputs: [], nodes, wires }) as unknown as ProcessDefinition;

describe('flow editor: graph operations and clipboard', () => {
  const base = def(
    [node('start', 'start'), node('http1', 'http', { connection: 'api', name: 'Fetch' }), node('log1', 'log')],
    [
      { from: 'start', port: 'out', to: 'http1' },
      { from: 'http1', port: 'out', to: 'log1' },
    ],
  );

  it('creates nodes with free ids, the first connection and texts in the UI language', async () => {
    const n = createNode(base, 'http', 10.4, 20.6);
    expect([n.id, n.x, n.y, (n as { connection?: string }).connection]).toEqual(['http2', 10, 21, 'api']);
    await setLanguage('de');
    await i18n.loadNamespaces('editor');
    expect((createNode(base, 'note', 0, 0) as { text?: string }).text).toBe('Kommentar');
    await setLanguage('en');
  });

  it('refuses wires to itself, to a node without input and duplicates', () => {
    expect(wireError(base, { from: 'log1', port: 'out', to: 'log1' })).toMatch(/itself/);
    expect(wireError(base, { from: 'log1', port: 'out', to: 'start' })).toMatch(/no input/);
    expect(wireError(base, { from: 'start', port: 'out', to: 'http1' })).toMatch(/Already/);
    expect(addWire(base, { from: 'start', port: 'out', to: 'http1' })).toBe(base);
    expect(addWire(base, { from: 'start', port: 'out', to: 'log1' }).wires).toHaveLength(3);
  });

  it('renames with the wires, never removes the last start node, duplicates with a new id', () => {
    const r = renameNode(base, 'http1', 'fetch');
    expect(r.wires.map((w) => `${w.from}>${w.to}`)).toEqual(['start>fetch', 'fetch>log1']);
    const removed = removeNodes(base, ['start', 'http1']);
    expect(removed.nodes.map((n) => n.id)).toEqual(['start', 'log1']);
    expect(removed.wires).toEqual([]);
    const [dup, id] = duplicateNode(base, 'http1');
    expect(id).toBe('http2');
    expect(dup.nodes.find((n) => n.id === 'http2')).toMatchObject({ name: 'Fetch (copy)', x: 40, y: 40 });
    expect(duplicateNode(base, 'start')).toEqual([base, null]);
  });

  it('copies the selected nodes (never the start node) with the wires between them and pastes them with new ids', () => {
    const clip = copyNodes(base, ['start', 'http1', 'log1'])!;
    expect(clip.nodes.map((n) => n.id)).toEqual(['http1', 'log1']);
    expect(clip.wires).toEqual([{ from: 'http1', port: 'out', to: 'log1' }]);
    expect(copyNodes(base, ['start'])).toBeNull();
    const [pasted, ids] = pasteNodes(base, clip);
    expect(ids).toEqual(['http2', 'log2']);
    expect(pasted.wires.at(-1)).toEqual({ from: 'http2', port: 'out', to: 'log2' });
    // offset so the copies do not cover the originals (or an earlier paste)
    const [twice] = pasteNodes(pasted, clip);
    const positions = twice.nodes.filter((n) => n.type === 'http').map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('expression assistant', () => {
  const s = (insert: string): Suggestion => ({ label: insert, insert, kind: 'var', detail: '' });
  const all = ['vars.user', 'vars.user.name', 'vars.users', 'inputs.userId', '$count('].map(s);

  it('finds the token at the caret, inside {{ }} and outside strings only', () => {
    expect(tokenAt('Hello {{ vars.us', 16, true)).toEqual({ start: 9, token: 'vars.us', exprStart: true });
    expect(tokenAt('{{ inputs.a + vars.us', 21, true)).toEqual({ start: 14, token: 'vars.us', exprStart: false });
    expect(tokenAt('Hello {{ vars.us }} x', 21, true)).toBeNull();
    expect(tokenAt('{{ "vars.us', 11, true)).toBeNull();
    expect(tokenAt('vars.x + inp', 12, false)).toEqual({ start: 9, token: 'inp', exprStart: false });
  });

  it('prefers prefix matches and direct children, matches the last part, and stays quiet on numbers', () => {
    expect(filterSuggestions(all, 'vars.u', false, false).map((x) => x.insert)).toEqual(['vars.user', 'vars.users', 'vars.user.name']);
    expect(filterSuggestions(all, 'name', false, false).map((x) => x.insert)).toEqual(['vars.user.name']);
    expect(filterSuggestions(all, '$cou', false, false).map((x) => x.insert)).toEqual(['$count(']);
    expect(filterSuggestions(all, '12', false, true)).toEqual([]);
    expect(filterSuggestions(all, '', true, false).map((x) => x.insert)).toContain('vars.');
    expect(filterSuggestions(all, '', false, false)).toEqual([]);
  });

  it('reads top-level keys of a (truncated) sample and the loops around a node', () => {
    expect(sampleKeys('{"id": 1, "name": "x", "nested": {"inner": 2}, "list": [{"deep": 1}], "trunc')).toEqual(['id', 'name', 'nested', 'list']);
    expect(sampleKeys('[1, 2]')).toEqual([]);
    const loop = def(
      [node('start', 'start'), node('each1', 'forEach', { as: 'host' }), node('http1', 'http'), node('log1', 'log')],
      [
        { from: 'start', port: 'out', to: 'each1' },
        { from: 'each1', port: 'each', to: 'http1' },
        { from: 'each1', port: 'out', to: 'log1' },
      ],
    );
    expect(enclosingLoops(loop, 'http1')).toEqual(['host']);
    expect(enclosingLoops(loop, 'log1')).toEqual([]);
  });
});

describe('monitor editor issues', () => {
  it('groups issues by check and keeps the first message per field', () => {
    const m = issuesByCheck([
      { path: 'checks.0.url', index: 0, field: 'url', message: 'Required', label: '' },
      { path: 'checks.0.url', index: 0, field: 'url', message: 'Second', label: '' },
      { path: 'checks.1', index: 1, field: null, message: 'Unknown type', label: '' },
      { path: 'name', index: null, field: null, message: 'Too long', label: '' },
    ]);
    expect([...m.keys()]).toEqual([0, 1]);
    expect(m.get(0)?.get('url')).toBe('Required');
    expect(m.get(1)?.get('')).toBe('Unknown type');
  });
});
