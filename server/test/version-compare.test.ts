import { describe, expect, it } from 'vitest';
import { behindOf, compareVersions, newestOf, parseVersion, type Scheme } from '../src/versions/compare.js';

/**
 * Version comparison of the version watch (#241): SemVer 2.0.0, PEP 440, Maven's ComparableVersion and a loose scheme,
 * each against the orderings their specifications give, and "behind by" major / minor / patch.
 */

const v = (s: string, scheme: Scheme) => {
  const x = parseVersion(s, scheme);
  if (!x) throw new Error(`not a ${scheme} version: ${s}`);
  return x;
};
/** Each version is older than the next one. */
function ascending(scheme: Scheme, list: string[]) {
  for (let i = 0; i + 1 < list.length; i++) {
    expect(compareVersions(v(list[i]!, scheme), v(list[i + 1]!, scheme)), `${list[i]} < ${list[i + 1]}`).toBeLessThan(0);
    expect(compareVersions(v(list[i + 1]!, scheme), v(list[i]!, scheme)), `${list[i + 1]} > ${list[i]}`).toBeGreaterThan(0);
  }
}
const same = (scheme: Scheme, a: string, b: string) => expect(compareVersions(v(a, scheme), v(b, scheme)), `${a} = ${b}`).toBe(0);

describe('SemVer 2.0.0', () => {
  it('orders like §11 of the specification', () => {
    ascending('semver', ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']);
    ascending('semver', ['1.0.0', '2.0.0', '2.1.0', '2.1.1', '2.10.0', '10.0.0']);
  });
  it('ignores build metadata and a leading v, missing parts are 0, four numbers (NuGet) work', () => {
    same('semver', '1.0.0+20130313144700', '1.0.0');
    same('semver', 'v1.2.3', '1.2.3');
    same('semver', '1.2', '1.2.0');
    ascending('semver', ['8.0.0', '8.0.0.1', '8.0.1']);
  });
  it('marks pre-releases (also Go pseudo-versions) and refuses what is not a version', () => {
    expect(v('1.0.0-rc.1', 'semver').pre).toBe(true);
    expect(v('v0.0.0-20191109021931-daa7c04131f5', 'semver').pre).toBe(true);
    expect(v('1.0.0', 'semver').pre).toBe(false);
    for (const bad of ['latest', '1.0.0-', '1..0', 'a.b.c', '1.0.0-al pha', '', '1.2.3.4.5']) expect(parseVersion(bad, 'semver'), bad).toBeNull();
  });
});

describe('PEP 440', () => {
  it('orders the example of the specification', () => {
    ascending('pep440', [
      '1.dev0',
      '1.0.dev456',
      '1.0a1',
      '1.0a2.dev456',
      '1.0a12.dev456',
      '1.0a12',
      '1.0b1.dev456',
      '1.0b2',
      '1.0b2.post345.dev456',
      '1.0b2.post345',
      '1.0rc1.dev456',
      '1.0rc1',
      '1.0',
      '1.0+abc.5',
      '1.0+abc.7',
      '1.0+5',
      '1.0.post456.dev34',
      '1.0.post456',
      '1.0.15',
      '1.1.dev1',
    ]);
  });
  it('normalises the other spellings, epochs win', () => {
    same('pep440', '1.0alpha1', '1.0a1');
    same('pep440', '1.0-beta.2', '1.0b2');
    same('pep440', '1.0c1', '1.0rc1');
    same('pep440', '1.0-1', '1.0.post1');
    same('pep440', '1.0rev2', '1.0.post2');
    same('pep440', '1.0.0', '1');
    same('pep440', 'v2.1', '2.1');
    ascending('pep440', ['2024.1', '1!0.1']);
    expect(v('5.2rc1', 'pep440').pre).toBe(true);
    expect(v('5.2.dev3', 'pep440').pre).toBe(true);
    expect(v('5.2.post1', 'pep440').pre).toBe(false);
    for (const bad of ['5.2-final', 'latest', '1.0+', '1.0+a b', '1.0.x']) expect(parseVersion(bad, 'pep440'), bad).toBeNull();
  });
});

describe('Maven ComparableVersion', () => {
  it('orders qualifiers like Maven', () => {
    ascending('maven', ['1-alpha-1', '1-beta-1', '1-milestone-1', '1-rc-1', '1-SNAPSHOT', '1', '1-sp-1', '1-abc', '1.1']);
    ascending('maven', ['3.0.0-M1', '3.0.0-RC1', '3.0.0', '3.0.1', '3.1.0']);
    ascending('maven', ['1.0', '1.0.1', '1.1', '1.10', '2']);
  });
  it('treats aliases and trailing zeros as Maven does', () => {
    same('maven', '1.0', '1');
    same('maven', '1.0.0', '1');
    same('maven', '1-ga', '1');
    same('maven', '1-final', '1');
    same('maven', '1-release', '1');
    same('maven', '1-cr-1', '1-rc-1');
    same('maven', '1a1', '1-alpha-1');
    same('maven', '1.0.RELEASE', '1');
  });
  it('marks pre-releases; unknown qualifiers (33.0.0-jre) are releases', () => {
    expect(v('6.2.0-M1', 'maven').pre).toBe(true);
    expect(v('3.0.0-RC1', 'maven').pre).toBe(true);
    expect(v('1.0-SNAPSHOT', 'maven').pre).toBe(true);
    expect(v('33.0.0-jre', 'maven').pre).toBe(false);
    expect(v('3.3.5', 'maven').release).toEqual([3, 3, 5]);
    expect(parseVersion('RELEASE', 'maven')).toBeNull();
  });
});

describe('loose', () => {
  it('reads tags and suffixes', () => {
    ascending('loose', ['16.4', '16.10', '17']);
    expect(v('1.27.3', 'loose').release).toEqual([1, 27, 3]);
    expect(v('2.5.0-rc1', 'loose').pre).toBe(true);
    expect(v('3.20.3', 'loose').pre).toBe(false);
    ascending('loose', ['2.5.0-rc1', '2.5.0']);
    expect(parseVersion('latest', 'loose')).toBeNull();
  });
  it('is linear on hostile input', () => {
    const long = `${'1.'.repeat(60)}x`;
    const t0 = Date.now();
    for (const s of ['semver', 'pep440', 'maven', 'loose'] as Scheme[]) parseVersion(long, s);
    parseVersion(`1${'-'.repeat(120)}`, 'maven');
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('behind by', () => {
  const b = (a: string, n: string, scheme: Scheme = 'semver') => behindOf(v(a, scheme), v(n, scheme));
  it('counts the first part that differs', () => {
    expect(b('22.11.0', '24.1.0')).toEqual({ lag: 'major', behind: { major: 2, minor: 0, patch: 0 } });
    expect(b('24.1.0', '24.11.1')).toEqual({ lag: 'minor', behind: { major: 0, minor: 10, patch: 0 } });
    expect(b('24.11.0', '24.11.1')).toEqual({ lag: 'patch', behind: { major: 0, minor: 0, patch: 1 } });
    expect(b('24.11.1', '24.11.1')).toEqual({ lag: 'current', behind: { major: 0, minor: 0, patch: 0 } });
    expect(b('25.0.0', '24.11.1').lag).toBe('current');
  });
  it('parts left out match any, a final after a pre-release is a patch', () => {
    expect(b('24', '24.11.1').lag).toBe('current');
    expect(b('22', '24.11.1')).toEqual({ lag: 'major', behind: { major: 2, minor: 0, patch: 0 } });
    expect(b('2.5.0-rc.1', '2.5.0')).toEqual({ lag: 'patch', behind: { major: 0, minor: 0, patch: 0 } });
    expect(b('5.1', '5.2', 'pep440')).toEqual({ lag: 'minor', behind: { major: 0, minor: 1, patch: 0 } });
  });
  it('picks the newest, pre-releases only when asked', () => {
    const list = ['1.0.0', '1.2.0', '2.0.0-rc.1', '1.10.0'].map((x) => ({ x, version: v(x, 'semver') }));
    expect(newestOf(list, false)?.x).toBe('1.10.0');
    expect(newestOf(list, true)?.x).toBe('2.0.0-rc.1');
    expect(newestOf([], false)).toBeNull();
  });
});
