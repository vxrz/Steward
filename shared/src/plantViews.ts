import type { AssetStatus, PlantLevel, Translations } from './plant.js';
import type { PlantAssetBrief, PlantAssetRef, PlantCheck, PlantCheckCode, PlantDirection, PlantProtocol, PlantUnitMismatch } from './plantData.js';
import type { LiveState } from './plantNetwork.js';

/**
 * Visualizations of the plant registry (#230): the structure of a site, the data flow of an asset, the lineage of a
 * data point, the KPI coverage matrix and the site overview tiles. They picture what the registry **documents**.
 * Status comes only from Steward items that are actually linked to a part – a monitor the asset links to, the dataset
 * a KPI instance names and its freshness, a plant check – everything else is documentation only (`live: null`).
 * Unknown stays unknown ("no data"), never "ok". See docs/PLANT.md (Visualizations).
 *
 * The graph types (`PlantFlowGraph`) are shared by every graph view; the OT network (#220) adds its node kinds.
 */

/** The state of a linked Steward item, reduced to four steps (the item's own word is in `status`). */
export const PLANT_LIVE_STATES = ['ok', 'warn', 'fail', 'unknown'] as const;
export type PlantLiveState = (typeof PLANT_LIVE_STATES)[number];

/** A linked Steward item that knows something about the part right now. */
export interface PlantLive {
  source: 'monitor' | 'dataset';
  state: PlantLiveState;
  /**
   * The item's own word: a monitor's status (up, degraded, down, maintenance, blocked, unknown), a dataset's freshness
   * (fresh, due, stale, no_data) – or `hidden`: an item the reader may not see (or that no longer exists). It counts
   * with its state only (ok, fail or unknown, as online, offline or unknown on the OT network), without name, time or
   * link.
   */
  status: string;
  /** The item's name (empty when the reader may not see it) */
  label: string;
  /** Its page, for readers who may open it */
  path: string | null;
  /** When it was evaluated or updated last */
  at: string | null;
}

/** The worst of several states (fail > warn > unknown > ok). */
export function worstLive(states: PlantLiveState[]): PlantLiveState | null {
  if (!states.length) return null;
  for (const s of ['fail', 'warn', 'unknown'] as const) if (states.includes(s)) return s;
  return 'ok';
}

// ---------- 1. site structure ----------

export interface PlantStructureNode {
  id: string;
  /** ISA-95 level (function) or a place of the location axis (IEC 81346) */
  level: PlantLevel | 'building';
  parentId: string | null;
  name: string;
  names: Translations;
  /** ISA-95 kind of a work center or unit, the kind of a building */
  type: string;
  childIds: string[];
  /** Assets here and below, by documented status */
  counts: Partial<Record<AssetStatus, number>>;
  total: number;
  /** Assets placed exactly here */
  own: number;
  /** Assets here and below with a linked monitor the reader may see, by its state */
  live: Partial<Record<PlantLiveState, number>>;
}

export interface PlantStructureAsset {
  id: string;
  name: string;
  status: AssetStatus;
  /** The innermost node of its location (null: none) */
  nodeId: string | null;
  /** The building that applies (null: none) */
  buildingId: string | null;
  /** The worst state of the monitors it links to (null: none linked) */
  live: PlantLiveState | null;
}

/** GET /api/plant/sites/:siteId/structure */
export interface PlantStructure {
  site: { id: string; code: string; name: string; names: Translations };
  /** The ISA-95 hierarchy (areas, work centers, work units), roots first in their order */
  function: PlantStructureNode[];
  /** The buildings and their parts */
  location: PlantStructureNode[];
  /** Totals of the site */
  counts: Partial<Record<AssetStatus, number>>;
  total: number;
  live: Partial<Record<PlantLiveState, number>>;
  /** Assets without a node / without a building, by status */
  unplaced: { function: Partial<Record<AssetStatus, number>>; location: Partial<Record<AssetStatus, number>> };
  /** The assets (at most PLANT_VIEW_LIMITS.structureAssets, by name) */
  assets: PlantStructureAsset[];
  assetsTruncated: boolean;
}

// ---------- 2./3. data flow and lineage (a graph) ----------

/**
 * Kinds of a graph node. The asset flow: asset → interface → collector → target → KPI job → dataset → dashboard; the
 * lineage of a data point: point → asset (or site, when many) → target → KPI definition → dataset → dashboard.
 */
export const PLANT_FLOW_NODE_KINDS = [
  'asset',
  'point',
  'site',
  'interface',
  'collector',
  'target',
  'kpi',
  'dataset',
  'dashboard',
  // the OT network (#220): IEC 62443-3-2 zones and conduits, IEEE 802.1Q VLANs, hosts (Steward systems), other parties
  'zone',
  'vlan',
  'conduit',
  'host',
  'peer',
  // 0.20: a Steward application or platform a data path pushes to, reads from or delivers to
  'application',
  'platform',
] as const;
export type PlantFlowNodeKind = (typeof PLANT_FLOW_NODE_KINDS)[number];

export interface PlantFlowNode {
  id: string;
  kind: PlantFlowNodeKind;
  label: string;
  /** A second line: protocol and endpoint, the path, the KPI's name … */
  detail: string;
  protocol?: PlantProtocol;
  direction?: PlantDirection;
  /** Its page in Steward (null: none, or the reader may not open it) */
  path: string | null;
  /** Documented as not set up or not active: drawn dashed */
  inactive: boolean;
  /** A linked item the reader may not see: drawn without its name */
  hidden?: boolean;
  /** Plant checks that fail on this part */
  checks: PlantCheck[];
  /** Live status from a linked Steward item (null: documentation only) */
  live: PlantLive | null;
  /** Several assets at once (lineage by site): how many, and how many deliver */
  count?: { total: number; delivering: number };
  /** Lineage: KPI instances of this definition on the assets drawn */
  instances?: number;
  /** The area (a group node: a zone, a VLAN) it is drawn in */
  parent?: string;
  /** An area drawn around the nodes that name it as their parent */
  group?: boolean;
  /** Short facts shown beside the name (a VID, a criticality, SL-T) */
  tags?: string[];
  /** What hovering or focusing it shows (an asset's devices, a VLAN's subnets) */
  info?: { label: string; value: string }[];
  /** A small node (an empty VLAN, a party outside the zones) */
  small?: boolean;
}

export interface PlantFlowEdge {
  id: string;
  from: string;
  to: string;
  /** Data points that take this way (0: a result, or an interface without data points) */
  points: number;
  /** Lineage: assets that take this way */
  assets: number;
  /** Files of a file-transfer interface */
  files: number;
  /** The way is documented, but not active (an interface not set up): drawn dashed */
  inactive: boolean;
  /** A plant check fails on it (a KPI input that is not delivered): drawn dashed and marked */
  problem: boolean;
  /** A KPI's result rather than data points */
  result: boolean;
  /** OT network: data paths that take the way */
  paths?: number;
  /** What the way carries, in words (protocol and port) */
  label?: string;
  /** Traffic goes both ways (a conduit): arrows at both ends, no direction to animate */
  both?: boolean;
  /** A conduit between two zones (drawn as a wide pipe) */
  conduit?: boolean;
  /** The way crosses from one zone into another without a documented conduit */
  noConduit?: boolean;
  /** Live status of where the data comes from (#220: an offline asset colours its way) */
  live?: LiveState | null;
}

/** A way through the graph that hovering highlights: a data point (asset flow) or an asset (lineage). */
export interface PlantFlowPath {
  id: string;
  kind: 'point' | 'asset' | 'path';
  label: string;
  detail: string;
  /** Data points: delivered, or why not */
  delivers: boolean;
  reason: 'interface_inactive' | 'unavailable' | null;
  /** A data path of the OT network: the live status of its asset (null: nothing watches it) */
  live?: LiveState | null;
  /** Offline as planned: every offline check of the asset is a monitor that is off (ADR 0021) – drawn grey, not red */
  offPlanned?: boolean;
  nodes: string[];
  edges: string[];
}

/** GET /api/plant/assets/:assetId/flow, GET /api/plant/profiles/:profileId/points/:pointId/lineage */
export interface PlantFlowGraph {
  nodes: PlantFlowNode[];
  edges: PlantFlowEdge[];
  paths: PlantFlowPath[];
  /** Lineage with many assets: one node per site instead of one per asset */
  grouped: boolean;
  /** Why the graph is empty: no assignment, no profile, no asset delivers it */
  empty: 'no_assignment' | 'no_profile' | 'no_assets' | null;
}

/** GET /api/plant/sites/:siteId/network/placement: which VLANs of the site the hosts of its data paths are in (their network segments). */
/**
 * Where the Steward items the data paths of a site name stand in its OT network diagram (docs/PLANT.md#ot-network-diagram):
 * a system on the VLANs of this site linked to a segment it is a member of, else in a zone of this site that lists it
 * (0.20); an application where the first system it runs on that is placed in this site stands; a platform in a zone of
 * this site that lists it. Items the reader may not see place nothing.
 */
export interface PlantHostPlacement {
  hosts: { id: string; vlans: string[]; zones: string[] }[];
  /** 0.20: an application and the system it is drawn with */
  applications: { id: string; system: string }[];
  /** 0.20: a platform and the zones that list it */
  platforms: { id: string; zones: string[] }[];
}

// ---------- 4. KPI coverage ----------

/** has an instance · could have one (delivers every input) · cannot (inputs missing) · problem (a check fails) · not checked (no data point inputs). */
export const PLANT_COVERAGE_STATES = ['has', 'problem', 'could', 'cannot', 'unchecked'] as const;
export type PlantCoverageState = (typeof PLANT_COVERAGE_STATES)[number];

/** A missing input of a KPI (the same codes and parameters as the checks). */
export interface PlantGap {
  code: PlantCheckCode;
  params: Record<string, string | number>;
}

export interface PlantCoverageCell {
  state: PlantCoverageState;
  /** The KPI instances (has, problem) */
  jobs?: string[];
  /** Every instance is inactive */
  inactive?: boolean;
  /** cannot: what is missing */
  gaps?: PlantGap[];
  /** problem: the checks that fail */
  checks?: PlantCheck[];
  /**
   * 0.12.0, could: whether the data is collected already – a data collection of the asset (any collector) maps every
   * data point input ("Collected – ready"), or not ("Device delivers, not collected")
   */
  collected?: boolean;
  /**
   * 0.14, could and collected: every input also goes to Insights Hub through a sink whose mapping was checked against
   * the tenant (the asset, aspect and variable exist) – "Collected – ready, verified in Insights Hub"
   */
  ihVerified?: boolean;
  /** 0.12.0, could and has: data point inputs the asset delivers in another unit than the KPI expects */
  units?: PlantUnitMismatch[];
  /**
   * 0.13, a KPI that rolls up from parts: the state comes from this part of the asset (its job, or the inputs it
   * delivers and collects) – the asset itself has no job and does not deliver every input
   */
  via?: PlantAssetRef;
  /**
   * 0.13, a KPI that rolls up from parts: this asset is a part of that one, which counts the KPI once for both – the
   * cell is not counted again in the totals and the KPI potential
   */
  rolledUp?: PlantAssetRef;
}

/** 0.12.0: KPI potential – of the cells that could have a KPI, those whose data is collected and those that need a collection. */
export interface PlantKpiPotential {
  ready: number;
  collect: number;
  /** 0.14: of the ready ones, those whose inputs are verified in Insights Hub */
  ihVerified?: number;
}

/** 0.12.0: the totals of one site (areaId null) or one area of it, over every asset that matches the filters. */
export interface PlantCoverageGroup {
  siteId: string;
  areaId: string | null;
  assets: number;
  totals: Record<PlantCoverageState, number>;
  potential: PlantKpiPotential;
}

export interface PlantCoverageRow {
  asset: PlantAssetBrief;
  area: { id: string; name: string; names: Translations } | null;
  profile: { id: string; name: string } | null;
  /** In the order of `kpis` */
  cells: PlantCoverageCell[];
}

/** GET /api/plant/views/coverage?site=&area=&profile=&kpi= */
export interface PlantCoverage {
  kpis: { id: string; name: string; names: Translations; category: string }[];
  rows: PlantCoverageRow[];
  /** Cells by state, over every row that matches (also those left out) */
  totals: Record<PlantCoverageState, number>;
  /** 0.12.0: the "could" cells split by whether their data is collected */
  potential: PlantKpiPotential;
  /** 0.12.0: totals per site and per area of a site, over every row that matches */
  groups: PlantCoverageGroup[];
  /** Rows that match; `rows` holds at most PLANT_VIEW_LIMITS.coverageCells / kpis of them */
  total: number;
  truncated: boolean;
  /** What the filters offer (only what the reader may see) */
  options: {
    sites: { id: string; code: string; name: string; names: Translations }[];
    areas: { siteId: string; id: string; name: string; names: Translations }[];
    profiles: { id: string; name: string }[];
  };
}

/** KPI coverage in per cent: instances of the KPIs that assets could have (null: nothing to cover). */
export function coveragePct(t: Pick<Record<PlantCoverageState, number>, 'has' | 'problem' | 'could'>): number | null {
  const n = t.has + t.problem + t.could;
  return n ? Math.round(((t.has + t.problem) / n) * 100) : null;
}

// ---------- 6. site overview ----------

/** GET /api/plant/views/overview: one tile per site the reader may see. */
export interface PlantSiteTile {
  siteId: string;
  counts: Partial<Record<AssetStatus, number>>;
  total: number;
  coverage: Record<PlantCoverageState, number>;
  /** 0.12.0: KPI potential – could-have cells whose data is collected, and those that need a collection */
  potential: PlantKpiPotential;
  /** Failing plant checks of the site's assets */
  checks: number;
  /** Assets with a linked monitor, by its state */
  live: Partial<Record<PlantLiveState, number>>;
}

export const PLANT_VIEW_LIMITS = {
  /** Assets a structure lists (the counts cover all) */
  structureAssets: 5000,
  /** Cells of the coverage matrix in one answer */
  coverageCells: 20_000,
  /** At most this many rows, whatever the number of KPIs */
  coverageRows: 2000,
  /** Lineage: one node per asset up to this many assets, else one per site */
  lineageAssets: 24,
} as const;
