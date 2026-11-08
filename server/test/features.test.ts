import { describe, expect, it } from 'vitest';
import { MODULES } from '@sm/shared';
import { FEATURES, featureJobs } from '../src/features/index.js';

/**
 * The composition root (server/src/features/, docs/ARCHITECTURE.md): one manifest per feature, and what they bring
 * agrees with the module registry (shared/src/modules.ts, ADR 0016).
 */
describe('the feature manifests', () => {
  it('have unique names', () => {
    const names = FEATURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('bring each background job once, and a module owns exactly the jobs of its features', () => {
    const names = featureJobs().map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of MODULES) {
      const ofModule = FEATURES.filter((f) => f.module === m.id).flatMap((f) => (f.jobs ?? []).map((j) => j.name));
      expect([...ofModule].sort(), m.id).toEqual([...m.jobs].sort());
    }
    // a job of a feature without a module is no module's job
    const moduleJobs = new Set(MODULES.flatMap((m) => m.jobs));
    for (const f of FEATURES.filter((x) => !x.module)) for (const j of f.jobs ?? []) expect(moduleJobs.has(j.name), j.name).toBe(false);
  });

  it('a built-in dataset of a module is brought by a feature of that module', () => {
    for (const m of MODULES)
      for (const prefix of m.datasets ?? []) {
        const id = prefix.endsWith(':') ? `${prefix}example` : prefix;
        const owners = FEATURES.filter((f) => (f.datasets ?? []).some((d) => d.owns(id)));
        expect(
          owners.map((f) => f.module),
          prefix,
        ).toEqual([m.id]);
      }
  });
});
