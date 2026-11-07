import type { AssetStatus, GeoPosition, Translations } from './plant.js';
import type { PlantCoverageState, PlantLiveState } from './plantViews.js';

/**
 * The map of sites (#234, ADR 0015): where its tiles come from, what the browser is told about the map, and the sites
 * it draws. The browser never talks to a tile provider: it loads a style, tiles, glyphs and sprites from Steward
 * (/api/plant/map/…), and Steward fetches what it does not have from the chosen source – see docs/PLANT.md (Map).
 */

/**
 * Where the tiles come from: _Off_ (the default: the list only, nothing leaves Steward), _OpenStreetMap_ (raster),
 * _Light / Dark_ (vector, OpenFreeMap, following the theme), an own tile source, a self-hosted PMTiles file.
 */
export const MAP_SOURCES = ['off', 'osm', 'openfreemap', 'own', 'file'] as const;
export type MapSource = (typeof MAP_SOURCES)[number];

/** An own source: a raster URL template ({z}, {x}, {y}) or a MapLibre style URL. */
export const MAP_OWN_KINDS = ['raster', 'style'] as const;
export type MapOwnKind = (typeof MAP_OWN_KINDS)[number];

/** Where an own source's API key goes: nowhere (no key), a query parameter or a request header of that name. */
export const MAP_KEY_PLACES = ['none', 'query', 'header'] as const;
export type MapKeyPlace = (typeof MAP_KEY_PLACES)[number];

export const PLANT_MAP_LIMITS = {
  /** Sites drawn as pins (the list names all) */
  sites: 2000,
  /** Tiles up to this zoom are shared between users in Steward's cache; above it each user has their own */
  sharedCacheMaxZoom: 12,
  /** Largest tile an upstream may send */
  tileBytes: 2 * 1024 * 1024,
  /** Largest style, TileJSON, sprite or glyph file */
  fileBytes: 1024 * 1024,
  /** Layers and sources kept from an own style */
  styleLayers: 1000,
  styleSources: 20,
  /** Tiles per user and minute (rateLimits.ts) */
  tilesPerMinute: 600,
  attribution: 300,
  url: 2000,
} as const;

/** What the settings page shows an administrator (never the API key itself). */
export interface PlantMapSettingsView {
  source: MapSource;
  own: {
    kind: MapOwnKind;
    url: string;
    attribution: string;
    keyPlace: MapKeyPlace;
    keyName: string;
    /** A key is stored in the vault */
    hasKey: boolean;
    maxZoom: number;
  } | null;
  file: { name: string; attribution: string } | null;
  /** The origins Steward's server fetches from for the current source (empty: nothing leaves Steward) */
  origins: string[];
  /** The PMTiles files found in <data>/maps/ */
  files: PlantMapFile[];
  /** Where Steward looks for PMTiles files */
  mapsDir: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PlantMapFile {
  name: string;
  bytes: number;
  kind: 'raster' | 'vector' | 'unknown';
  /** The vector schema Steward has a style for (Protomaps or OpenMapTiles), else null */
  schema: 'protomaps' | 'openmaptiles' | null;
  /** From the file's metadata (plain text) */
  attribution: string;
  minZoom: number;
  maxZoom: number;
  /** Why the file cannot be used (unreadable, an unknown vector schema …) */
  problem: string | null;
}

/** POST /api/settings/plant/map/check: what an own style or template would fetch from, before it is saved. */
export interface PlantMapCheck {
  origins: string[];
  kind: 'raster' | 'vector';
  layers: number;
  attribution: string;
}

/** What every reader of the plant registry is told about the map (GET /api/plant/config → map). */
export interface PlantMapClient {
  on: boolean;
  source: MapSource;
  kind: 'raster' | 'vector';
  /** The style has a light and a dark variant (style.json?theme=dark) */
  themed: boolean;
  /** Plain text, shown on the map (always) */
  attribution: string[];
  /** The tiles are OpenStreetMap data: "© OpenStreetMap contributors" links to the copyright page */
  osm: boolean;
  minZoom: number;
  maxZoom: number;
  /** Changes with every change of the settings (part of the style URL, so no stale style is drawn) */
  version: string;
}

/**
 * The state of a site on the map: the worst of its assets' live status (linked monitors) and its failing plant checks.
 * `none`: nothing watches the site (drawn neutral, never as online).
 */
export const PLANT_MAP_STATES = ['fail', 'warn', 'unknown', 'ok', 'none'] as const;
export type PlantMapState = (typeof PLANT_MAP_STATES)[number];

export interface PlantMapSite {
  id: string;
  code: string;
  name: string;
  names: Translations;
  /** null: the site has no position (listed, not drawn) */
  geo: GeoPosition | null;
  state: PlantMapState;
  /** Assets by documented status */
  counts: Partial<Record<AssetStatus, number>>;
  total: number;
  /** Assets with a linked monitor, by its state */
  live: Partial<Record<PlantLiveState, number>>;
  /** Failing plant checks */
  checks: number;
  /** KPI coverage of the site's assets */
  coverage: Record<PlantCoverageState, number>;
}

/** GET /api/plant/map/sites: the sites the reader may see (only those; a hidden site gives no pin and no count). */
export interface PlantMapSites {
  sites: PlantMapSite[];
}

/** GET /api/plant/map/status: whether the source answered lately (the reason for administrators only). */
export interface PlantMapStatus {
  ok: boolean;
  at: string | null;
  reason: string | null;
}

/** The worst of a site's live states and checks (see PlantMapState). */
export function siteMapState(t: { live: Partial<Record<PlantLiveState, number>>; checks: number }): PlantMapState {
  if (t.live.fail) return 'fail';
  if (t.live.warn || t.checks > 0) return 'warn';
  if (t.live.unknown) return 'unknown';
  if (t.live.ok) return 'ok';
  return 'none';
}
