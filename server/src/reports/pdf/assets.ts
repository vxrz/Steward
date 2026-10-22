import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerFile } from './pdfkit.js';
import { config } from '../../config.js';

/**
 * Files the PDF engine needs at run time: embedded fonts (PDF/A requires every
 * font to be embedded, so the PDF standard fonts are never used), the default
 * Steward logo and the sRGB colour profile for the PDF/A output intent.
 *
 * They live in server/assets (Node.js, container) or are unpacked from the
 * single-file executable into <data>/app/<version>/assets (SM_ASSETS_DIR).
 */
export const FONT_FILES = {
  sans: 'fonts/Inter-Regular.ttf',
  sansBold: 'fonts/Inter-Bold.ttf',
  mono: 'fonts/JetBrainsMono-Regular.ttf',
} as const;

export const DEFAULT_LOGO = 'logo/steward.png';

export const assetPath = (rel: string): string => path.join(config.assetsDir, ...rel.split('/'));

const cache = new Map<string, Buffer>();
export function readAsset(rel: string): Buffer {
  let b = cache.get(rel);
  if (!b) {
    const file = assetPath(rel);
    try {
      b = fs.readFileSync(file);
    } catch {
      throw new Error(`Report asset missing: ${file} (set SM_ASSETS_DIR to the folder containing fonts/ and logo/)`);
    }
    cache.set(rel, b);
  }
  return b;
}

let iccReady = false;
/**
 * PDFKit reads its sRGB profile from "./data/…" next to its own module. In the
 * bundled executable that file does not exist, so the copy shipped with the
 * report assets is registered under the exact URL PDFKit asks for (the bundle
 * shares one import.meta.url for all modules).
 */
export function ensureColorProfile(): void {
  if (iccReady) return;
  iccReady = true;
  const key = new URL('./data/sRGB_IEC61966_2_1.icc', import.meta.url).href;
  try {
    if (fs.existsSync(fileURLToPath(key))) return;
  } catch {
    /* not a file URL – register anyway */
  }
  const own = assetPath('pdfkit/sRGB_IEC61966_2_1.icc');
  if (fs.existsSync(own)) registerFile(key, fs.readFileSync(own));
}
