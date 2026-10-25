import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Release consistency: the compose files pin the release image of their own version, and the
// container workflow derives its image tags with scripts/ci/image-tags.sh.
const repo = path.resolve(__dirname, '../..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version as string;

describe('release files', () => {
  it('package.json and the server report the same version', () => {
    const configTs = fs.readFileSync(path.join(repo, 'server/src/config.ts'), 'utf8');
    expect(configTs.match(/^\s*version: '([^']+)',/m)?.[1]).toBe(version);
  });

  it.each(['docker-compose.yml', 'docker-compose.postgres.yml'])('%s uses the release image of this version', (file) => {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    const images = [...text.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]).filter((i) => i.includes('steward'));
    expect(images).toEqual([`ghcr.io/vxrz/steward:${version}`]);
  });
});

describe.skipIf(process.platform === 'win32')('scripts/ci/image-tags.sh', () => {
  const script = path.join(repo, 'scripts/ci/image-tags.sh');
  const releases = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tags-')), 'releases.txt');
  fs.writeFileSync(releases, ['v0.1.0', 'v0.1.2', 'v0.2.0', 'v0.2.1-rc.1', 'v0.10.0-beta.1', 'not-a-version'].join('\n') + '\n');
  const tags = (tag: string, ...args: string[]) => {
    const r = spawnSync('sh', [script, ...args], { env: { ...process.env, CI_PIPELINE_EVENT: 'tag', CI_COMMIT_TAG: tag }, encoding: 'utf8' });
    return { status: r.status, tags: r.stdout.split('\n').filter(Boolean) };
  };

  it('Woodpecker (no options): version, minor, major and latest', () => {
    expect(tags('v1.2.3')).toEqual({ status: 0, tags: ['1.2.3', '1.2', '1', 'latest'] });
  });

  it('GitHub (--no-major --releases): latest and X.Y only for the newest release', () => {
    const gh = (tag: string) => tags(tag, '--no-major', '--releases', releases).tags;
    expect(gh('v0.2.1')).toEqual(['0.2.1', '0.2', 'latest']);
    expect(gh('v0.2.0')).toEqual(['0.2.0', '0.2', 'latest']); // the tag itself is in the list
    expect(gh('v0.1.3')).toEqual(['0.1.3', '0.1']); // a fix for an older line
    expect(gh('v0.1.1')).toEqual(['0.1.1']);
    expect(gh('v0.10.0')).toEqual(['0.10.0', '0.10', 'latest']); // numeric, not text order
  });

  it('pre-releases only get their own tag', () => {
    expect(tags('v1.2.3-rc.1', '--no-major', '--releases', releases)).toEqual({ status: 0, tags: ['1.2.3-rc.1'] });
  });

  it('refuses tags that are not versions and unknown options', () => {
    expect(tags('v1.2').status).toBe(2);
    expect(tags('v1.2.3+build.1').status).toBe(2);
    expect(tags('v1.2.3', '--bogus').status).toBe(2);
    expect(tags('v1.2.3', '--releases', '/nonexistent/file').status).toBe(2);
  });
});
