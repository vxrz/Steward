import { COMPONENT_VERSIONS_DATASET, type DatasetRow, type DatasetStatus } from '@sm/shared';
import { db } from '../db.js';
import { publishDataset } from '../dashboards/datasets.js';
import { lifecycleOf, lifecycleSettings, releasesOf } from '../catalogue/lifecycle.js';
import { productLabel } from '../catalogue/components.js';
import { applicationEntries } from './check.js';
import { allEntries, isWellBehind, versionSettings, watchOf, type WatchedEntry } from './service.js';
import { currentUser, runAs } from '../auth/context.js';

/**
 * The built-in dataset "Component versions" (`catalogue.versions`, #241): one row per tech stack entry – of the
 * components of every application that is not archived, of the systems they run on, and of systems no application
 * runs on – with the installed and the newest version, how far behind, the end of life of its release cycle and
 * where the newest version was found; metrics entries, current, major, minor, patch, eol. Published by the job
 * "version-watch" (at most hourly). Like the AI usage, visible to administrators and auditors only
 * (dashboards/builtin.ts): it names every application, also those of teams others may not see.
 */

const COLUMNS = ['Application', 'Component', 'Kind', 'Environment', 'Product', 'Installed', 'Newest', 'Behind', 'Days behind', 'End of life', 'Source'];
let lastPublished = 0;

const behindText = (lag: string, b: { major: number; minor: number; patch: number } | null) =>
  lag === 'major'
    ? `${b?.major ?? 1} major`
    : lag === 'minor'
      ? `${b?.minor ?? 1} minor`
      : lag === 'patch'
        ? b?.patch
          ? `${b.patch} patch`
          : 'patch'
        : lag === 'current'
          ? 'up to date'
          : '–';

/**
 * Publishes the dataset (at most hourly unless forced). Returns whether it did. It is read by administrators and
 * auditors: every entry and platform, also when "Refresh now" of a designer publishes it (no reader's view).
 */
export function publishVersionDataset(force = false, now = Date.now()): boolean {
  if (currentUser()) return runAs(null, () => publishVersionDataset(force, now));
  if (!force && now - lastPublished < 3_600_000) return false;
  const apps = db().all<{ id: string; name: string }>('SELECT id, name FROM applications WHERE archived = 0 ORDER BY name');
  const entries: { app: string; e: WatchedEntry }[] = [];
  const seenSystems = new Set<string>();
  for (const a of apps)
    for (const e of applicationEntries(a.id, null)) {
      entries.push({ app: a.name, e });
      if (e.holderKind === 'system') seenSystems.add(e.holderId);
    }
  // systems no application runs on yet
  for (const e of allEntries()) if (e.holderKind === 'system' && !seenSystems.has(e.holderId)) entries.push({ app: '–', e });
  if (!entries.length && !db().get('SELECT key FROM datasets WHERE key = ?', COMPONENT_VERSIONS_DATASET)) return false;
  lastPublished = now;
  const watch = watchOf(
    entries.map((x) => x.e),
    now,
  );
  const s = versionSettings();
  const { warnDays } = lifecycleSettings();
  const releases = releasesOf([...new Set(entries.map((x) => x.e.product))]);
  const counts = { entries: entries.length, current: 0, major: 0, minor: 0, patch: 0, eol: 0, unknown: 0 };
  const rows: DatasetRow[] = entries.map(({ app, e }) => {
    const w = watch.get(`${e.holderKind}\u0000${e.holderId}\u0000${e.product}`)?.watch ?? null;
    const lc = lifecycleOf(e.product, e.version, releases, warnDays, now);
    const lag = w?.lag ?? 'unknown';
    counts[lag]++;
    if (lc?.state === 'eol') counts.eol++;
    const status: DatasetStatus = lc?.state === 'eol' || lag === 'major' ? 'serious' : w && isWellBehind(w, s) ? 'warning' : w?.newest ? 'good' : 'unknown';
    const label = productLabel(e.product);
    return {
      Application: app,
      Component: e.holderName,
      Kind: e.holderKind,
      Environment: e.environment,
      Product: label,
      Installed: e.version,
      Newest: w?.newest ?? '',
      Behind: behindText(lag, w?.behind ?? null),
      'Days behind': w?.daysBehind ?? null,
      'End of life': lc?.state ?? 'unknown',
      Source: w?.source ? `${w.where}` : '',
      _key: `${e.holderKind}/${e.holderId}/${e.product}/${app}`,
      _status: status,
      _reason:
        lc?.state === 'eol'
          ? `${label} ${e.version}: release cycle ${lc.cycle ?? ''} past its end of life`.trim()
          : lag === 'major'
            ? `${label} ${e.version} → ${w?.newest}: ${behindText(lag, w?.behind ?? null)} behind`
            : status === 'warning'
              ? `${label} ${e.version} → ${w?.newest}`
              : '',
    };
  });
  publishDataset({
    key: COMPONENT_VERSIONS_DATASET,
    title: 'Component versions',
    processId: 'catalogue:versions',
    processName: 'Version watch (built in)',
    runId: '',
    dryRun: false,
    columns: COLUMNS,
    rows,
    metrics: counts,
    // published at least hourly by the job
    staleAfterMinutes: 180,
    staleAfterFixed: true,
  });
  return true;
}
