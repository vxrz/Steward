import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The checkout / image root (the folder with server/, web/ and examples/). The sources (server/src/…) and the bundle
 * (server/dist/*.js) sit at different depths below it, so it is found by walking up to the folder that has
 * server/package.json. In the single-file executable import.meta is not available: the working directory then
 * stands in (paths come from SM_* variables set by the desktop launcher).
 */
function findRoot(): string {
  if (typeof import.meta.url !== 'string') return process.cwd();
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let dir = here, i = 0; i < 6; i++, dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'server', 'package.json'))) return dir;
  }
  return path.resolve(here, '..', '..');
}

export const ROOT_DIR = findRoot();
