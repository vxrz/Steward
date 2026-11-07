#!/usr/bin/env node
// The built-in light and dark map styles for vector PMTiles files in the Protomaps schema (#234, ADR 0015), generated
// with @protomaps/basemaps (a development dependency only) into server/assets/map/. The server reads them, puts its
// own source in and swaps the label language (plant/mapStyles.ts).
//
//   node scripts/map-styles.mjs [--check]
//
// Kept out: the layers that need a sprite (one-way arrows, road shields, points of interest) – Steward's styles have
// no sprite and no glyphs URL, so MapLibre draws the labels with the browser's own fonts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layers, namedFlavor } from '@protomaps/basemaps';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'assets', 'map');
const DROP = new Set(['roads_oneway', 'roads_shields', 'pois']);
const ICON_KEYS = ['icon-image', 'icon-size', 'icon-allow-overlap', 'icon-optional', 'icon-padding', 'icon-anchor', 'icon-offset', 'icon-rotate'];

function style(flavor) {
  return layers('base', namedFlavor(flavor), { lang: 'en' })
    .filter((l) => !DROP.has(l.id))
    .map((l) => {
      if (!l.layout) return l;
      const layout = Object.fromEntries(Object.entries(l.layout).filter(([k]) => !ICON_KEYS.includes(k)));
      return { ...l, layout };
    });
}

const check = process.argv.includes('--check');
let stale = 0;
for (const flavor of ['light', 'dark']) {
  const file = path.join(OUT, `protomaps-${flavor}.json`);
  const text = JSON.stringify({ generator: '@protomaps/basemaps 5.7.2 (scripts/map-styles.mjs)', layers: style(flavor) }) + '\n';
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
      console.error(`map-styles: ${path.relative(ROOT, file)} is out of date – run node scripts/map-styles.mjs`);
      stale++;
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`map-styles: wrote ${path.relative(ROOT, file)} (${text.length} bytes)`);
  }
}
process.exit(stale ? 1 : 0);
