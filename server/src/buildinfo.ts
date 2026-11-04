import fs from 'node:fs';
import sea from 'node:sea';
import type { BuildInfo, DeploymentKind } from '@sm/shared';
import { config, env } from './config.js';

/**
 * Version and build of the running server.
 *
 * The commit and build date come from SM_BUILD_COMMIT / SM_BUILD_DATE: the
 * container image sets them from build arguments (see Dockerfile and the
 * container workflow) and the desktop executable has them compiled in by
 * scripts/build-exe.mjs. Without them (npm start from a checkout) the build is
 * reported as "development".
 */
const clean = (v: string | undefined) => (v && v.trim() && !/^(unknown|development)$/i.test(v.trim()) ? v.trim() : null);

export function buildInfo(): BuildInfo {
  const commit = clean(env.SM_BUILD_COMMIT);
  const date = clean(env.SM_BUILD_DATE);
  return {
    version: config.version,
    commit: commit ? commit.slice(0, 40) : null,
    date: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null,
  };
}

let deployment: DeploymentKind | undefined;
/** How this server runs: the single-file desktop executable, a container or a plain Node.js process. */
export function deploymentKind(): DeploymentKind {
  if (deployment) return deployment;
  if (env.SM_DEPLOYMENT) return (deployment = env.SM_DEPLOYMENT);
  let inSea = false;
  try {
    inSea = sea.isSea();
  } catch {
    /* older runtimes */
  }
  if (inSea) return (deployment = 'executable');
  const container =
    !!process.env.KUBERNETES_SERVICE_HOST ||
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    (() => {
      try {
        return /docker|kubepods|containerd|podman|lxc/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
      } catch {
        return false;
      }
    })();
  return (deployment = container ? 'container' : 'node');
}
