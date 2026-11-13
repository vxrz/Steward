/**
 * Device profiles and KPI definitions with owning teams and shares (0.21.0, #293, ADR 0033 parts 3 and 4).
 *
 * The catalogues belong to no site, so an asset a reader sees can use a profile – or a KPI instance a definition – the
 * reader may not see. The server then **counts, never names** it: an id the reader may not see is replaced by a
 * placeholder (`~hidden-1`, `~hidden-2` … per item, in the order the item names them), a name by `~hidden`. A form or a
 * file that sends a placeholder back **keeps** what it stands for; choosing a hidden entry anew answers like an unknown
 * one (`PLANT_PROFILE_NOT_FOUND`, `PLANT_KPI_NOT_FOUND`).
 */

/** Rights on a device profile or a KPI definition: see it, propose changes to it, change it, manage it (shares, delete). */
export const PLANT_CATALOGUE_PERMISSIONS = ['view', 'propose', 'edit', 'manage'] as const;
export type PlantCataloguePermission = (typeof PLANT_CATALOGUE_PERMISSIONS)[number];

/** The owned kinds of the plant catalogues (`OWNED_KINDS`). */
export const PLANT_CATALOGUE_KINDS = ['device_profile', 'kpi_definition'] as const;
export type PlantCatalogueKind = (typeof PLANT_CATALOGUE_KINDS)[number];

/** A name the reader may not see (check parameters, data flow labels …): the web app says "a device profile you may not see". */
export const PLANT_HIDDEN = '~hidden';
/** A placeholder for the id of an entry the reader may not see: `~hidden-<n>`, numbered per item. */
export const PLANT_HIDDEN_REF_RE = /^~hidden-[1-9][0-9]{0,3}$/;
export const plantHiddenRef = (n: number): string => `~hidden-${n}`;
/** Whether a value is a placeholder for something the reader may not see (an id or a name). */
export const isPlantHidden = (v: string | null | undefined): boolean => !!v && (v === PLANT_HIDDEN || PLANT_HIDDEN_REF_RE.test(v));

/** GET /api/plant/catalogue/hidden: how many entries of each catalogue the reader may not see (the lists count them). */
export interface PlantHiddenCatalogue {
  profiles: number;
  kpis: number;
  /** With `?q=`: how many profiles the reader may not see have data points that match (Explore data) */
  points?: number;
}
