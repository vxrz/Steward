import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_CHECK_SOURCES,
  CHECK_TYPES,
  CHECK_TYPE_DEFS,
  COST_SOURCES,
  MATURITY_LEVELS,
  MODULES,
  MODULE_IDS,
  OUTPUT_TYPES,
  PLATFORM_KIND_GROUPS,
  PLATFORM_KIND_LIST,
  STEP_TYPES,
  VERIFIED_AGAINST,
  accessSourceKinds,
  checkPlatformKinds,
  checkSchema,
  checkTypeKinds,
  checkTypesOfKind,
  isPlatformKind,
  outputTypeKinds,
} from '@sm/shared';
import { PRESETS } from '../src/platforms/presets.js';
import { DRIVERS } from '../src/platforms/drivers.js';
import { CHECK_RUNNERS, validateCheckPlatform } from '../src/monitors/checks.js';
import { validateOutputPlatform } from '../src/monitors/kinds.js';

// One descriptor per platform kind and per check type (0.11.0, docs/ARCHITECTURE.md#adding-a-platform-kind): every
// kind and type has a complete one, the server and web records cover them, and the lists they replaced are gone.

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('platform kind descriptors', () => {
  it('describe every built-in kind completely', () => {
    expect(PLATFORM_KIND_LIST.length).toBeGreaterThan(0);
    for (const k of PLATFORM_KIND_LIST) {
      expect(k.label.trim(), k.id).not.toBe('');
      expect(PLATFORM_KIND_GROUPS, k.id).toContain(k.group);
      expect(MATURITY_LEVELS, k.id).toContain(k.maturity.maturity);
      expect(VERIFIED_AGAINST, k.id).toContain(k.maturity.verified);
      for (const t of k.checkTypes) expect(CHECK_TYPES, k.id).toContain(t);
      for (const t of k.outputTypes) expect(OUTPUT_TYPES, k.id).toContain(t);
      for (const t of k.stepTypes) expect(STEP_TYPES, k.id).toContain(t);
      if (k.accessSource) expect(ACCESS_CHECK_SOURCES, k.id).toContain(k.accessSource);
      expect(k.accessSource, k.id).not.toBe('dataset');
      expect(COST_SOURCES, k.id).toContain(k.costSource);
      // a JSON API or an example of its base URL only means something for an HTTP API with the HTTP test
      if (k.jsonApi || k.apiExample) expect(k.http, k.id).toBe(true);
    }
  });

  it('cover every connector of the setup wizard, and every kind has one', () => {
    const presetKinds = new Set(PRESETS.map((p) => p.kind));
    for (const kind of presetKinds) expect(isPlatformKind(kind), kind).toBe(true);
    for (const k of PLATFORM_KIND_LIST) expect(presetKinds.has(k.id), k.id).toBe(true);
  });

  it('match the server drivers: a kind with its own connection test has one, the others none', () => {
    for (const k of PLATFORM_KIND_LIST) expect(!!DRIVERS[k.id as keyof typeof DRIVERS]?.test, k.id).toBe(k.connectionTest === 'own');
    for (const kind of Object.keys(DRIVERS)) expect(isPlatformKind(kind), kind).toBe(true);
  });

  it('name a kind for every access source that reads a platform directly', () => {
    for (const source of ACCESS_CHECK_SOURCES) {
      if (source === 'dataset') expect(accessSourceKinds(source)).toEqual([]);
      else expect(accessSourceKinds(source).length, source).toBeGreaterThan(0);
    }
  });

  it('only name built-in kinds in the module registry', () => {
    for (const m of MODULES) for (const kind of m.platformKinds ?? []) expect(isPlatformKind(kind), `${m.id}: ${kind}`).toBe(true);
  });

  it('keep the effective check-type maps of 0.10 (plus the schema check for databases)', () => {
    expect(checkTypesOfKind('database')).toEqual(['database', 'db-schema']);
    expect(checkTypesOfKind('github')).toEqual(['git', 'platform']);
    expect(checkTypesOfKind('snowflake')).toEqual(['snowflake']);
    expect(checkTypesOfKind('zabbix')).toEqual([]);
    expect(checkTypesOfKind('my-own-connector')).toEqual(['platform']);
    expect(checkTypeKinds('git')).toEqual(['github', 'gitlab', 'forgejo']);
    expect(checkPlatformKinds({ type: 'freshness', source: 'insightsHub' })).toEqual(['insights-hub']);
    expect(checkPlatformKinds({ type: 'freshness' })).toEqual(['insights-hub']);
    expect(checkPlatformKinds({ type: 'freshness', source: 'platform' })).toEqual([]);
    expect(checkPlatformKinds({ type: 'platform' })).toEqual([]);
  });
});

describe('check type descriptors', () => {
  const schemaOf = new Map(checkSchema.options.map((o) => [o.shape.type.value as string, o]));

  it('describe every check type completely', () => {
    expect(Object.keys(CHECK_TYPE_DEFS).sort()).toEqual([...CHECK_TYPES].sort());
    for (const type of CHECK_TYPES) {
      const d = CHECK_TYPE_DEFS[type];
      expect(d.type).toBe(type);
      expect(d.label.trim(), type).not.toBe('');
      expect(d.help.trim(), type).not.toBe('');
      expect(d.defaultName.trim(), type).not.toBe('');
      if (d.module) expect(MODULE_IDS, type).toContain(d.module);
      // the default fields are fields of the type's schema
      const shape = schemaOf.get(type)!.shape as Record<string, unknown>;
      for (const key of Object.keys(d.defaults)) expect(Object.hasOwn(shape, key), `${type}.${key}`).toBe(true);
      // a platform kind reads it exactly when the descriptor says so; a check that reads a platform has the field
      expect(checkTypeKinds(type).length > 0, type).toBe(d.platform === 'kind');
      expect(Object.hasOwn(shape, 'platform'), type).toBe(d.platform !== 'none');
    }
  });

  it('have an evaluator on the server for every active type, and a form in the web app for every type', () => {
    for (const type of CHECK_TYPES) expect(Object.hasOwn(CHECK_RUNNERS, type), type).toBe(CHECK_TYPE_DEFS[type].active);
    const fields = fs.readFileSync(path.join(ROOT, 'web/src/components/monitors/checks/index.ts'), 'utf8');
    for (const type of CHECK_TYPES) expect(fields, type).toMatch(new RegExp(`^  '?${type}'?: \\w+,$`, 'm'));
  });

  it('refuse a platform of another kind for every type tied to platform kinds, and accept each kind it reads', () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
        return '';
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    const kindTypes = CHECK_TYPES.filter((t) => CHECK_TYPE_DEFS[t].platform === 'kind');
    expect(kindTypes).toEqual(expect.arrayContaining(['gatus', 'checkmk', 'prometheus', 'kubernetes', 'git', 'freshness', 'db-schema']));
    for (const type of kindTypes) {
      const c = { id: 'c', name: 'c', type, ...CHECK_TYPE_DEFS[type].defaults } as unknown as Parameters<typeof validateCheckPlatform>[0];
      const kinds = checkPlatformKinds(c);
      expect(kinds.length, type).toBeGreaterThan(0);
      expect(
        codeOf(() => validateCheckPlatform(c, { name: 'Other', kind: 'generic' })),
        type,
      ).toBe('CHECK_PLATFORM_KIND');
      expect(
        codeOf(() => validateCheckPlatform(c, { name: 'Own', kind: 'my-own-connector' })),
        type,
      ).toBe('CHECK_PLATFORM_KIND');
      // a kind the type reads passes the kind rule (the type's own rules may still refuse the empty defaults)
      for (const kind of kinds)
        expect(
          codeOf(() => validateCheckPlatform(c, { name: 'Fits', kind })),
          `${type} on ${kind}`,
        ).not.toBe('CHECK_PLATFORM_KIND');
    }
    // types that read any platform, or none, have no kind rule; nor the freshness check with an API request as its source
    for (const type of CHECK_TYPES.filter((t) => CHECK_TYPE_DEFS[t].platform !== 'kind')) {
      const c = { id: 'c', name: 'c', type, ...CHECK_TYPE_DEFS[type].defaults } as unknown as Parameters<typeof validateCheckPlatform>[0];
      expect(
        codeOf(() => validateCheckPlatform(c, { name: 'Other', kind: 'generic' })),
        type,
      ).not.toBe('CHECK_PLATFORM_KIND');
    }
    const api = { id: 'c', name: 'c', type: 'freshness', source: 'platform' } as unknown as Parameters<typeof validateCheckPlatform>[0];
    expect(codeOf(() => validateCheckPlatform(api, { name: 'Other', kind: 'gatus' }))).toBe('');
  });

  it('refuse a platform of another kind for every output type tied to platform kinds, and accept each kind it writes to', () => {
    const codeOf = (fn: () => void) => {
      try {
        fn();
        return '';
      } catch (e) {
        return (e as { code?: string }).code ?? String(e);
      }
    };
    const kindTypes = OUTPUT_TYPES.filter((t) => outputTypeKinds(t).length);
    expect(kindTypes).toEqual(expect.arrayContaining(['gatus', 'zabbix']));
    for (const type of OUTPUT_TYPES) {
      const o = { id: 'o', type };
      const kinds = outputTypeKinds(type);
      expect(
        codeOf(() => validateOutputPlatform(o, { name: 'Other', kind: 'generic' })),
        type,
      ).toBe(kinds.length ? 'OUTPUT_PLATFORM_KIND' : '');
      expect(
        codeOf(() => validateOutputPlatform(o, { name: 'Own', kind: 'my-own-connector' })),
        type,
      ).toBe(kinds.length ? 'OUTPUT_PLATFORM_KIND' : '');
      for (const kind of kinds)
        expect(
          codeOf(() => validateOutputPlatform(o, { name: 'Fits', kind })),
          `${type} on ${kind}`,
        ).toBe('');
    }
  });

  it('replace the lists that were kept by hand before 0.11', () => {
    const gone = [
      'MONITOR_TYPE_KINDS',
      'NON_HTTP_KINDS',
      'PLATFORM_KIND_MATURITY',
      'JSON_API_KINDS',
      'API_EXAMPLES',
      'PLATFORM_KIND',
      'CHECK_MODULES',
      'TRYABLE',
      'DEFAULT_NAMES',
      // one kind rule for every check type tied to platform kinds (0.11.0)
      'CHECK_GIT_PLATFORM',
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    for (const dir of ['shared/src', 'server/src', 'web/src']) walk(path.join(ROOT, dir));
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const name of gone) expect(new RegExp(`\\b${name}\\b`).test(text), `${path.relative(ROOT, f)}: ${name}`).toBe(false);
    }
  });
});
