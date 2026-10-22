/**
 * Command line that runs npm without a shell, on every platform.
 *
 * On Windows npm is a batch file (npm.cmd), and Node refuses to start batch files without
 * `shell: true` (CVE-2024-27980). A shell would interpret metacharacters in the arguments, so
 * instead this runs npm's JavaScript entry point (npm-cli.js) with the current Node binary:
 * the path npm passes to scripts it runs (npm_execpath), else the npm that ships next to node.
 *
 *   const [cmd, args] = npmCommand(['run', 'test']);
 *   spawnSync(cmd, args, { stdio: 'inherit' });
 */
import fs from 'node:fs';
import path from 'node:path';

/** @param {string[]} args npm arguments @returns {[string, string[]]} command and arguments for spawn/execFile */
export function npmCommand(args) {
  if (process.platform !== 'win32') return ['npm', args];
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const cli = candidates.find((p) => p && path.basename(p) === 'npm-cli.js' && fs.existsSync(p));
  if (!cli) throw new Error(`npm-cli.js not found (looked at: ${candidates.filter(Boolean).join(', ')})`);
  return [process.execPath, [cli, ...args]];
}
