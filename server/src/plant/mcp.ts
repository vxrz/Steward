import { z } from 'zod';
import type { PlantDataPoint, PlantInterface, PlantModelOrigin, PlantResolvedProfile } from '@sm/shared';
import { pageArray } from '../api/v1/pagination.js';
import { ToolError, cursorArg, defineTool, limitArg, type ToolDef } from '../mcp/tooling.js';
import { HttpError } from '../util.js';
import { plantEnabled } from './settings.js';
import { currentId } from './ids.js';
import * as svc from './service.js';
import * as cat from './catalogue.js';
import { getAssignment } from './assignments.js';
import { assetCollections, getCollection, pointCollections } from './collections.js';
import { allAssignments, allProfiles, ownProfiles, pointsOf } from './data-model.js';
import { assignmentOut, kpiOut, profileOut, sourceOut } from './import-data.js';
import { plantJsonSchema, SCHEMA_ID } from './format.js';
import { collectionOut, sinkOut } from './import-network.js';
import { ihMapping } from './ih.js';

/**
 * The plant registry for AI assistants (0.12.0, docs/MCP.md "Plant registry"): read tools over sites, assets with their
 * assignments, device profiles (resolved, with their chain of bases and their own part), data points with their
 * known-as names, KPI definitions and data collections with their coverage. Every tool reads through the same services
 * as the web app, as the token owner – what they may not see is not there. While the module is off the tools are not
 * listed, and a call is refused. Results are compact and bounded (pages, limits, cut text); access lists, rights of
 * others and contacts are left out.
 */

const OFF = 'The plant registry is not enabled on this Steward (Settings → Modules)';
const short = (s: string | null | undefined, n = 300) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');

/** A service call; a refusal (404, 403) becomes a message the assistant sees. */
function read<T>(f: () => T): T {
  if (!plantEnabled()) throw new ToolError(OFF);
  try {
    return f();
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500)
      throw new ToolError(e.statusCode === 404 || e.statusCode === 403 ? `${e.message} (or you may not see it)` : e.message);
    throw e;
  }
}

const visible = () => plantEnabled();
const plantId = (what: string) => z.string().min(1).max(120).describe(what);
const query = z.string().max(200).optional().describe('Case-insensitive text to look for (a plain match, no pattern)');
const has = (needle: string | undefined, ...values: (string | null | undefined)[]) =>
  !needle || values.some((v) => (v ?? '').toLowerCase().includes(needle.toLowerCase()));

/** Where an item of a derived profile comes from, in one line. */
const originText = (o: PlantModelOrigin | undefined, self: string): string | undefined =>
  !o || (o.kind === 'own' && o.from === self)
    ? undefined
    : o.kind === 'overridden'
      ? `inherited from ${o.from}, changed here: ${o.fields.join(', ')}`
      : `inherited from ${o.from}`;

const pointOut = (d: PlantDataPoint, detail = false) => ({
  id: d.id,
  name: d.name,
  ...(d.description ? { description: detail ? d.description : short(d.description) } : {}),
  ...(d.dataType ? { dataType: d.dataType } : {}),
  ...(d.unit ? { unit: d.unit } : {}),
  ...(d.address ? { address: d.address } : {}),
  access: d.access,
  ...(d.updateRateMs !== null ? { updateRateMs: d.updateRateMs } : {}),
  ...(d.aliases.length ? { knownAs: d.aliases } : {}),
  ...(detail && d.enumValues.length ? { enumValues: d.enumValues } : {}),
  ...(detail && d.notes ? { notes: d.notes } : {}),
  ...(detail && d.publications.length ? { publications: d.publications } : {}),
  // 0.16.1: where it is described (a manual and the page)
  ...(d.source ? { source: sourceOut(d.source) } : {}),
});

function interfaceOut(i: PlantInterface, r: Pick<PlantResolvedProfile, 'id' | 'origins'> | null, points: boolean) {
  return {
    id: i.id,
    name: i.name,
    protocol: i.protocol,
    direction: i.direction,
    ...(i.description ? { description: i.description } : {}),
    ...(r ? { origin: originText(r.origins.interfaces[i.id], r.id), descriptionFrom: r.origins.interfaces[i.id]?.descriptionFrom } : {}),
    ...(i.defaultPort !== null ? { defaultPort: i.defaultPort } : {}),
    authentication: i.authentication,
    ...(i.client ? { client: i.client } : {}),
    groups: i.groups.map((g) => ({
      name: g.name,
      ...(g.description ? { description: g.description } : {}),
      dataPointCount: g.dataPoints.length,
      ...(points ? { dataPoints: g.dataPoints.map((d) => ({ ...pointOut(d), ...(r ? { origin: originText(r.origins.points[d.id], r.id) } : {}) })) } : {}),
    })),
    fileSets: i.fileSets.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      format: f.format,
      pathPattern: f.pathPattern,
    })),
  };
}

export const plantReadTools: ToolDef[] = [
  defineTool({
    name: 'list_plant_sites',
    title: 'List plant sites',
    description:
      'Sites (factories) of the plant registry that you may see, ordered by name: id, code, name, description and counts of areas, buildings and assets. Use get_plant_site for the hierarchy of one site.',
    input: z.object({ query, cursor: cursorArg, limit: limitArg() }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const list = svc
          .listSites()
          .filter((s) => has(a.query, s.id, s.code, s.name, s.description))
          .map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            description: short(s.description),
            areas: s.areaCount,
            buildings: s.buildingCount,
            assets: s.assetCount,
            assetsByStatus: s.statusCounts,
            youMayChange: s.canManage,
          }));
        return pageArray(list, (s) => [s.name.toLowerCase(), s.id], a, { query: a.query });
      }),
  }),
  defineTool({
    name: 'get_plant_site',
    title: 'Get a plant site',
    description:
      'One site: its ISA-95 hierarchy (areas, work centers, work units – ids, names, types) and its buildings, with whether you may change it. Contacts and access lists are not returned.',
    input: z.object({ siteId: plantId('Site id (from list_plant_sites)') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const s = svc.getSite(currentId('site', '', a.siteId));
        type Node = (typeof s.areas)[number];
        const node = (n: Node): Record<string, unknown> => ({
          id: n.id,
          level: n.level,
          name: n.name,
          ...(n.type ? { type: n.type } : {}),
          ...(n.buildingId ? { building: n.buildingId } : {}),
          ...(n.description ? { description: short(n.description) } : {}),
          ...(n.children.length ? { children: n.children.map(node) } : {}),
        });
        return {
          id: s.id,
          code: s.code,
          name: s.name,
          description: s.description,
          areas: s.areas.map(node),
          buildings: s.buildings.map((b) => ({ id: b.id, name: b.name, kind: b.kind, parent: b.parentId })),
          assets: s.assetCount,
          youMayChange: s.canManage,
        };
      }),
  }),
  defineTool({
    name: 'list_plant_assets',
    title: 'List plant assets',
    description:
      'Assets (machines, controllers, devices) you may see, ordered by name: id, name, site, status, manufacturer and model, location and the device profile of its assignment. Filter by site, device profile (with dataPoint: the assets that deliver it), status or text. Use get_plant_asset for one asset’s assignment.',
    input: z
      .object({
        siteId: z.string().max(120).optional(),
        profileId: z.string().max(120).optional().describe('Only assets with this device profile'),
        dataPoint: z.string().max(120).optional().describe('With profileId: only assets that deliver this data point'),
        status: z.string().max(40).optional(),
        query,
        cursor: cursorArg,
        limit: limitArg(),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const profiles = allAssignments();
        const list = svc
          .listAssets({
            site: a.siteId ? currentId('site', '', a.siteId) : undefined,
            profile: a.profileId ? currentId('profile', '', a.profileId) : undefined,
            dataPoint: a.dataPoint,
            status: a.status,
            q: a.query,
          })
          .map((x) => ({
            id: x.id,
            name: x.name,
            siteId: x.siteId,
            status: x.status,
            ...(x.manufacturer ? { manufacturer: x.manufacturer } : {}),
            ...(x.model ? { model: x.model } : {}),
            location: [x.location.area, x.location.workCenter, x.location.workUnit].filter(Boolean).map((n) => ({ id: n!.id, name: n!.name })),
            profile: profiles.get(x.id)?.profileId ?? null,
            ...(x.tags.length ? { tags: x.tags } : {}),
            ...(x.parentId ? { parent: x.parentId } : {}),
          }));
        return pageArray(list, (x) => [x.name.toLowerCase(), x.id], a, {
          siteId: a.siteId,
          profileId: a.profileId,
          dataPoint: a.dataPoint,
          status: a.status,
          query: a.query,
        });
      }),
  }),
  defineTool({
    name: 'get_plant_asset',
    title: 'Get a plant asset',
    description:
      'One asset with its assignment: device profile and firmware, per interface whether it is set up and where (endpoint), its overrides of data points (asset-specific address, unit, data type, not delivered, a note), its additions (data points and interfaces of this asset alone), publications, KPI instances and the checks. `assignmentFile` is the assignment as written in the plant import format – change it and send it with propose_plant_changes.',
    input: z.object({ assetId: plantId('Asset id (from list_plant_assets)') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const id = currentId('asset', '', a.assetId);
        const x = svc.getAsset(id);
        const v = getAssignment(id);
        const asg = v.assignment;
        return {
          id: x.id,
          name: x.name,
          siteId: x.siteId,
          status: x.status,
          description: x.description,
          manufacturer: x.manufacturer,
          model: x.model,
          location: [x.location.area, x.location.workCenter, x.location.workUnit].filter(Boolean).map((n) => ({ id: n!.id, name: n!.name })),
          tags: x.tags,
          fields: x.fields,
          externalRefs: x.refs,
          youMayChange: x.canManage,
          assignment: asg
            ? {
                profile: v.profile ? { id: v.profile.id, name: v.profile.name } : asg.profileId ? { id: asg.profileId, name: null } : null,
                firmware: asg.firmware,
                interfaces: asg.interfaces,
                overrides: asg.overrides,
                additions: {
                  interfaces: asg.additions.interfaces.map((i) => interfaceOut(i, null, true)),
                  dataPoints: asg.additions.dataPoints.map((d) => ({ interface: d.interface, group: d.group, ...pointOut(d, true) })),
                },
                publications: asg.publications,
                kpis: v.kpis.map((k) => ({ kpi: k.kpi, job: k.job, active: k.active, params: k.params, dashboard: k.dashboard, dataset: k.dataset })),
                notes: asg.notes,
              }
            : null,
          dataModel: { interfaces: v.model.map((i) => ({ id: i.id, name: i.name, protocol: i.protocol, dataPoints: pointsOf({ interfaces: [i] }).length })) },
          checks: v.checks.slice(0, 50).map((c) => ({ code: c.code, message: c.message })),
          assignmentFile: asg ? assignmentOut(id, asg) : null,
        };
      }),
  }),
  defineTool({
    name: 'list_device_profiles',
    title: 'List device profiles',
    description:
      'Device profiles of the plant registry (a catalogue of the installation): id, name, manufacturer, model, version, category, the profile it extends, protocols and counts. Everyone who sees the plant registry sees them.',
    input: z.object({ query, cursor: cursorArg, limit: limitArg() }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const list = cat
          .listProfiles()
          .filter((p) => has(a.query, p.id, p.name, p.manufacturer, p.model, p.category))
          .map((p) => ({
            id: p.id,
            name: p.name,
            manufacturer: p.manufacturer,
            model: p.model,
            version: p.version,
            category: p.category,
            extends: p.extends,
            template: p.template,
            protocols: p.protocols,
            interfaces: p.interfaceCount,
            dataPoints: p.dataPointCount,
            assets: p.assetCount,
          }));
        return pageArray(list, (p) => [p.name.toLowerCase(), p.id], a, { query: a.query });
      }),
  }),
  defineTool({
    name: 'get_device_profile',
    title: 'Get a device profile',
    description:
      'One device profile as it is in effect (resolved): its interfaces, data point groups, data points (with known-as names and, since 0.16.1, their `source`: the document and page that describe them) and file sets, each with where it comes from when the profile extends another (`origin`, `descriptionFrom`), the chain of bases, the items marked as not present, the profiles that extend it and its assets. `file` is the profile’s own part in the plant import format (a derived profile lists only what it adds or changes) – change it and send it with propose_plant_changes. Use interfaceId and points: false for a large profile.',
    input: z
      .object({
        profileId: plantId('Device profile id (from list_device_profiles)'),
        interfaceId: z.string().max(120).optional().describe('Only this interface'),
        points: z.boolean().default(true).describe('false: groups with their counts only, no data points'),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const id = currentId('profile', '', a.profileId);
        const p = cat.getProfile(id);
        const resolved = allProfiles();
        const own = ownProfiles().get(id)!;
        const r = { id: p.id, origins: p.origins };
        return {
          id: p.id,
          name: p.name,
          manufacturer: p.manufacturer,
          model: p.model,
          version: p.version,
          category: p.category,
          description: p.description,
          descriptionFrom: p.descriptionFrom,
          notes: p.notes,
          extends: p.extends,
          template: p.template,
          bases: p.bases,
          extendedBy: p.extendedBy,
          interfaces: p.interfaces.filter((i) => !a.interfaceId || i.id === a.interfaceId).map((i) => interfaceOut(i, p.extends ? r : null, a.points)),
          notPresent: p.notPresent,
          assets: p.assets.slice(0, 200).map((x) => ({ id: x.id, name: x.name, siteId: x.siteId })),
          kpis: p.kpis.map((k) => ({ id: k.id, name: k.name, dataPoints: k.dataPoints })),
          youMayChange: p.canManage,
          file: profileOut(own, own.extends ? (resolved.get(own.extends) ?? null) : null),
        };
      }),
  }),
  defineTool({
    name: 'search_data_points',
    title: 'Search data points',
    description:
      'Data points of every device profile (resolved) whose id, name, address, description or known-as name (a gateway’s variable name, for example) contains the text: profile, interface, group, the data point and where it comes from. At most `limit` hits.',
    input: z
      .object({
        query: z.string().min(1).max(200).describe('Case-insensitive text (a plain match)'),
        profileId: z.string().max(120).optional().describe('Only this profile'),
        limit: limitArg(200, 50),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const out: Record<string, unknown>[] = [];
        let more = false;
        const only = a.profileId ? currentId('profile', '', a.profileId) : null;
        cat.listProfiles(); // the module check and the reader's catalogue right, as the web app's search
        for (const p of allProfiles().values()) {
          if (only && p.id !== only) continue;
          for (const { iface, group, point } of pointsOf(p)) {
            if (!has(a.query, point.id, point.name, point.address, point.description, ...point.aliases)) continue;
            if (out.length >= a.limit) {
              more = true;
              break;
            }
            out.push({
              profile: { id: p.id, name: p.name },
              interface: { id: iface.id, name: iface.name, protocol: iface.protocol },
              group,
              dataPoint: pointOut(point),
              ...(p.extends ? { origin: originText(p.origins.points[point.id], p.id) } : {}),
            });
          }
          if (more) break;
        }
        return { items: out, more };
      }),
  }),
  defineTool({
    name: 'get_data_point',
    title: 'Get a data point',
    description:
      'One data point of a device profile: its fields, known-as names and source (the document and page that describe it), where it comes from, which assets with the profile (or one that extends it) deliver it and why not, their asset-specific addresses, the KPI definitions that read it and the data collections that read it under which names.',
    input: z.object({ profileId: plantId('Device profile id'), pointId: z.string().min(1).max(120).describe('Data point id') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const profileId = currentId('profile', '', a.profileId);
        const pointId = currentId('data_point', profileId, a.pointId);
        const d = cat.getDataPoint(profileId, pointId);
        return {
          profile: d.profile,
          interface: d.interface,
          group: d.group,
          dataPoint: pointOut(d.point, true),
          origin: d.origin,
          assets: d.assets.slice(0, 200).map((x) => ({
            asset: { id: x.asset.id, name: x.asset.name, siteId: x.asset.siteId },
            delivers: x.delivers,
            reason: x.reason,
            ...(x.override?.address ? { address: x.override.address } : {}),
            ...(x.override?.notes ? { note: x.override.notes } : {}),
          })),
          kpis: d.kpis.map((k) => ({ id: k.id, name: k.name })),
          collections: pointCollections(profileId, pointId)
            .slice(0, 200)
            .map((c) => ({ assetId: c.assetId, collection: c.id, name: c.name, collector: c.collectorLabel, as: c.outputNames ?? [] })),
        };
      }),
  }),
  defineTool({
    name: 'list_kpi_definitions',
    title: 'List KPI definitions',
    description:
      'KPI definitions (ISO 22400-2 attributes) of the plant registry: id, name, category, unit, the profiles their inputs read, counts of parameters, columns and instances.',
    input: z.object({ query, cursor: cursorArg, limit: limitArg() }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const list = cat
          .listKpis()
          .filter((k) => has(a.query, k.id, k.name, k.category))
          .map((k) => ({
            id: k.id,
            name: k.name,
            category: k.category,
            unit: k.unit,
            profiles: k.profiles,
            parameters: k.parameterCount,
            columns: k.columnCount,
            instances: k.instanceCount,
            problems: k.problemCount,
          }));
        return pageArray(list, (k) => [k.name.toLowerCase(), k.id], a, { query: a.query });
      }),
  }),
  defineTool({
    name: 'get_kpi_definition',
    title: 'Get a KPI definition',
    description:
      'One KPI definition in the plant import format (`file`: inputs, parameters, result columns, computation), the assets with an instance, the assets that could have one, and what Steward checks.',
    input: z.object({ kpiId: plantId('KPI definition id') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const k = cat.getKpi(currentId('kpi', '', a.kpiId));
        return {
          id: k.id,
          name: k.name,
          description: k.description,
          youMayChange: k.canManage,
          instances: k.instances.slice(0, 200).map((x) => ({ asset: x.asset.id, job: x.job, active: x.active, problems: x.problems })),
          candidates: k.candidates.slice(0, 200).map((x) => x.id),
          checks: k.checks.slice(0, 50).map((c) => ({ code: c.code, message: c.message })),
          file: kpiOut(k),
        };
      }),
  }),
  defineTool({
    name: 'list_data_collections',
    title: 'List the data collections of an asset',
    description:
      'What collectors (gateways, ETL jobs, flows) read from one asset: per collection its collector, interface, mode and interval, description, number of items, whether the collector may write to the machine, and its coverage (mapped, raw, data points not collected).',
    input: z.object({ assetId: plantId('Asset id') }).strict(),
    visible,
    handler: (a) =>
      read(() => {
        const c = assetCollections(currentId('asset', '', a.assetId));
        return {
          asset: c.asset,
          totals: c.totals,
          collections: c.collections.map((x) => ({
            id: x.id,
            name: x.name,
            ...(x.description ? { description: short(x.description) } : {}),
            collector: { kind: x.collector.kind, ref: x.collector.ref, name: x.collectorRef?.label || x.collector.ref },
            interfaceId: x.interfaceId,
            mode: x.mode,
            intervalMs: x.intervalMs,
            items: x.items.length,
            writesToMachine: x.writes,
            coverage: {
              mapped: x.coverage.mapped,
              raw: x.coverage.raw,
              notCollected: x.coverage.notCollected.length,
              readTwice: x.coverage.duplicates.length,
            },
          })),
        };
      }),
  }),
  defineTool({
    name: 'get_data_collection',
    title: 'Get a data collection',
    description:
      'One data collection of an asset: its items (address read, the collector’s output name, the data point it is mapped to – or raw –, the asset’s address of that data point, description), access patterns, triggers, its sinks (where the data goes, with transformation steps) and coverage. Items are paged; `file: true` adds the collection and its sinks in the plant import format.',
    input: z
      .object({
        assetId: plantId('Asset id'),
        collectionId: z.string().min(1).max(120).describe('Collection id (from list_data_collections)'),
        file: z
          .boolean()
          .default(false)
          .describe('true: also the collection and its sinks in the plant import format (`file`, all items) – to change and send with propose_plant_changes'),
        cursor: cursorArg,
        limit: limitArg(500, 100),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const c = getCollection(currentId('asset', '', a.assetId), a.collectionId);
        const items = c.items.map((it, index) => ({
          index,
          address: it.address,
          outputName: it.outputName,
          ...(it.outputType ? { outputType: it.outputType } : {}),
          dataPoint: it.dataPoint,
          ...(c.points[index] ? { dataPointName: c.points[index]!.name, assetAddress: c.points[index]!.address } : {}),
          ...(it.description ? { description: short(it.description) } : {}),
          ...(it.transform.note ? { transform: short(it.transform.note) } : {}),
        }));
        const page = pageArray(items, (x) => [x.index], a, { id: c.id, asset: c.assetId });
        return {
          id: c.id,
          name: c.name,
          description: c.description,
          assetId: c.assetId,
          collector: { kind: c.collector.kind, ref: c.collector.ref, name: c.collectorRef?.label || c.collector.ref },
          interfaceId: c.interfaceId,
          dataPathId: c.dataPathId,
          mode: c.mode,
          intervalMs: c.intervalMs,
          debounceMs: c.debounceMs,
          triggers: c.triggers.slice(0, 50),
          sinks: c.sinks.map((x) => ({
            id: x.id,
            name: x.name,
            kind: x.kind,
            ref: x.ref,
            object: x.object,
            ...(x.description ? { description: short(x.description) } : {}),
            transforms: x.transforms
              .slice(0, 50)
              .map((t) => ({ kind: t.kind, field: t.field, expression: short(t.expression, 500), description: short(t.description) })),
            mappings: x.mappings.length,
          })),
          access: c.access,
          writesToMachine: c.writes,
          coverage: {
            mapped: c.coverage.mapped,
            raw: c.coverage.raw,
            unknownAddresses: c.coverage.unknown.slice(0, 200),
            stale: c.coverage.stale.slice(0, 200),
            readTwice: c.coverage.duplicates.slice(0, 50),
            notCollected: c.coverage.notCollected.slice(0, 200).map((p) => ({ id: p.id, name: p.name, interface: p.interface })),
          },
          items: page.items,
          nextCursor: page.nextCursor,
          ...(a.file
            ? {
                file: {
                  asset: c.assetId,
                  collections: [collectionOut(c)],
                  ...(c.sinks.length ? { collection_sinks: [{ collection: c.id, sinks: c.sinks.map(sinkOut) }] } : {}),
                },
              }
            : {}),
        };
      }),
  }),
  defineTool({
    name: 'get_insights_hub_mapping',
    title: 'Get the Insights Hub mapping of a sink',
    description:
      'For a sink of a data collection whose target is an Insights Hub platform (0.14): per item the Insights Hub asset, aspect and variable it goes to, the last check of the mapping against the tenant (ok, unit or type differs – hints –, asset, aspect or variable missing, not checked, failed) and the monitor checks that already watch it; per asset and aspect the variables no check watches. Read-only; the check itself and new monitors are made in the web app.',
    input: z
      .object({
        assetId: plantId('Asset id'),
        collectionId: z.string().min(1).max(120).describe('Collection id (from list_data_collections)'),
        sinkId: z.string().min(1).max(120).describe('Sink id (from get_data_collection)'),
        cursor: cursorArg,
        limit: limitArg(500, 100),
      })
      .strict(),
    visible,
    handler: (a) =>
      read(() => {
        const m = ihMapping(currentId('asset', '', a.assetId), a.collectionId, a.sinkId);
        const items = m.items.map((it) => ({
          index: it.index,
          item: it.item,
          ...(it.dataPoint ? { dataPoint: it.dataPoint.id } : {}),
          target: it.target,
          ...(it.check ? { check: it.check.status, ...(it.check.unit ? { unit: it.check.unit } : {}), ...(it.check.type ? { type: it.check.type } : {}) } : {}),
          watchedBy: it.watchedBy.map((w) => ({ monitor: w.monitorKey, check: w.checkId, enabled: w.enabled })),
          ...(it.hiddenWatchers ? { hiddenWatchers: it.hiddenWatchers } : {}),
        }));
        const page = pageArray(items, (x) => [x.index], a, { id: `${m.collectionId}/${m.sinkId}`, asset: m.assetId });
        return {
          assetId: m.assetId,
          collectionId: m.collectionId,
          sinkId: m.sinkId,
          isInsightsHub: m.isIh,
          platform: m.platform?.name || null,
          default: m.default,
          counts: { items: m.counts.items, mapped: m.counts.mapped, verified: m.counts.verified, watched: m.counts.watched },
          groups: m.groups.map((g) => ({ assetId: g.assetId, assetName: g.assetName, aspect: g.aspect, watched: g.watched, unwatched: g.unwatched })),
          lastCheck: m.lastRun ? { at: m.lastRun.checkedAt, by: m.lastRun.checkedBy, error: m.lastRun.error?.code ?? null, capped: m.lastRun.capped } : null,
          items: page.items,
          nextCursor: page.nextCursor,
        };
      }),
  }),
  defineTool({
    name: 'get_plant_import_format',
    title: 'Describe the plant import format',
    description: `The JSON Schema of the plant import format (${SCHEMA_ID}): without \`part\` the top-level keys and the names of its parts; with \`part\` (DeviceProfile, Interface, DataPoint, Assignment, KpiDefinition, Site, Asset …) that part's schema. propose_plant_changes takes a document of this format.`,
    input: z.object({ part: z.string().max(60).optional().describe('A part of the schema ($defs), e.g. DeviceProfile or Assignment') }).strict(),
    visible,
    handler: (a) => {
      if (!plantEnabled()) throw new ToolError(OFF);
      const s = plantJsonSchema() as {
        $id: string;
        title: string;
        description: string;
        properties: Record<string, { description?: string }>;
        $defs?: Record<string, unknown>;
      };
      const defs = s.$defs ?? {};
      if (a.part) {
        if (!(a.part in defs)) throw new ToolError(`No part "${a.part}" – one of: ${Object.keys(defs).join(', ')}`);
        return { $id: s.$id, part: a.part, schema: defs[a.part] };
      }
      return {
        $id: s.$id,
        title: s.title,
        description: s.description,
        keys: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, v.description ?? ''])),
        parts: Object.keys(defs),
      };
    },
  }),
];
