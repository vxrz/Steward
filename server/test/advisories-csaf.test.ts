import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADVISORY_LIMITS } from '@sm/shared';
import { cpeParts, parseCsaf } from '../src/plant/advisories/csaf.js';
import { inRange, parseRange, upperBound } from '../src/plant/advisories/versions.js';
import { matchAdvisory, normModel, normVendor, type MatchCandidate } from '../src/plant/advisories/match.js';
import { parseChanges } from '../src/plant/advisories/fetch.js';
import { csaf } from './advisories-helpers.js';

/**
 * Security advisories (0.14, docs/ADVISORIES.md): reading CSAF 2.0 documents – valid, malformed and oversized ones –,
 * version ranges (vers, vers-like and the free text advisories use), and matching: exact only with vendor, model and
 * firmware exact; anything weaker a possible match.
 */

const EXAMPLES = path.resolve(__dirname, '../../examples/plant/advisories');
const example = (name: string) => fs.readFileSync(path.join(EXAMPLES, name), 'utf8');

describe('reading CSAF 2.0 documents', () => {
  it('reads the invented examples: publisher, tracking, products, scores, remediations', () => {
    const p = parseCsaf(example('exctl-sa-2026-001.json'));
    expect(p.meta).toMatchObject({ publisher: 'Example Controls', trackingId: 'EXCTL-SA-2026-001', version: '2', status: 'final', tlp: 'WHITE' });
    expect(p.severity).toBe('high');
    expect(p.cvss).toBe(7.5);
    expect(p.cves).toEqual(['CVE-2099-10001']);
    expect(p.content.products.map((x) => [x.id, x.vendor, x.name, x.version, x.range])).toEqual([
      ['CSAFPID-0001', 'Example Controls', 'C80', '', 'vers:generic/>=3.0.0|<3.4.0'],
      ['CSAFPID-0002', 'Example Controls', 'C80', '3.4.0', ''],
    ]);
    expect(p.content.products[0]!.models).toEqual(['C80', 'C80-*']);
    expect(p.content.vulnerabilities[0]!.remediations.map((r) => r.category)).toEqual(['vendor_fix', 'mitigation']);
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const f of ['exmet-sa-2026-003.json', 'expm-sa-2026-007.json']) expect(() => parseCsaf(example(f))).not.toThrow();
    expect(parseCsaf(example('exmet-sa-2026-003.json')).severity).toBe('critical');
  });

  it('refuses what is not a CSAF 2.0 document', () => {
    const bad = (s: string) => {
      try {
        parseCsaf(s);
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return 'accepted';
    };
    expect(bad('not json')).toBe('PLANT_ADVISORY_INVALID');
    expect(bad('[]')).toBe('PLANT_ADVISORY_INVALID');
    expect(bad('{}')).toBe('PLANT_ADVISORY_INVALID');
    const doc = JSON.parse(csaf());
    expect(bad(JSON.stringify({ ...doc, document: { ...doc.document, csaf_version: '1.2' } }))).toBe('PLANT_ADVISORY_INVALID');
    const noTracking = structuredClone(doc);
    delete noTracking.document.tracking.id;
    expect(bad(JSON.stringify(noTracking))).toBe('PLANT_ADVISORY_INVALID');
    const badCategory = structuredClone(doc);
    badCategory.product_tree.branches[0].category = 'manufacturer';
    expect(bad(JSON.stringify(badCategory))).toBe('PLANT_ADVISORY_INVALID');
    const badScore = structuredClone(doc);
    badScore.vulnerabilities[0].scores[0].cvss_v3.baseScore = 11;
    expect(bad(JSON.stringify(badScore))).toBe('PLANT_ADVISORY_INVALID');
    // unknown properties are left out, not refused
    expect(bad(JSON.stringify({ ...doc, x_vendor: { anything: [1, 2, 3] } }))).toBe('accepted');
  });

  it('is bounded: size, nesting and counts are checked before the content', () => {
    const big = `{"document":${'0'.repeat(ADVISORY_LIMITS.documentBytes)}}`;
    expect(() => parseCsaf(big)).toThrow(expect.objectContaining({ code: 'PLANT_ADVISORY_TOO_LARGE', statusCode: 413 }));
    // a product tree nested deeper than the limit
    let deep: Record<string, unknown> = { category: 'product_version', name: '1', product: { name: 'x', product_id: 'X' } };
    for (let i = 0; i < ADVISORY_LIMITS.branchDepth + 2; i++) deep = { category: 'product_family', name: `f${i}`, branches: [deep] };
    expect(() => parseCsaf(csaf({ tree: { branches: [deep] } }))).toThrow(expect.objectContaining({ code: 'PLANT_ADVISORY_INVALID' }));
    // too many vulnerabilities
    const many = Array.from({ length: ADVISORY_LIMITS.vulnerabilities + 1 }, () => ({ cve: 'CVE-2099-1' }));
    expect(() => parseCsaf(csaf({ vulns: many }))).toThrow(expect.objectContaining({ code: 'PLANT_ADVISORY_INVALID' }));
    // long texts are cut, not kept whole
    const longNote = JSON.parse(csaf());
    longNote.document.notes = [{ category: 'summary', text: 'x'.repeat(ADVISORY_LIMITS.textChars + 100) }];
    expect(parseCsaf(JSON.stringify(longNote)).content.summary.length).toBeLessThanOrEqual(ADVISORY_LIMITS.textChars + 1);
  });

  it('keeps only http(s) links and reads full product names by their CPE and relationships', () => {
    const doc = JSON.parse(
      csaf({
        tree: {
          full_product_names: [{ name: 'Fooke A100', product_id: 'F1', product_identification_helper: { cpe: 'cpe:2.3:h:fooke:a100:2.3.1:*:*:*:*:*:*:*' } }],
          branches: [
            {
              category: 'vendor',
              name: 'Fooke',
              branches: [
                { category: 'product_name', name: 'B200', product: { name: 'Fooke B200', product_id: 'HW' } },
                {
                  category: 'product_name',
                  name: 'Firmware',
                  branches: [{ category: 'product_version_range', name: '<3.0', product: { name: 'Fooke FW <3.0', product_id: 'FW' } }],
                },
              ],
            },
          ],
          relationships: [
            {
              category: 'installed_on',
              product_reference: 'FW',
              relates_to_product_reference: 'HW',
              full_product_name: { name: 'Fooke FW <3.0 on B200', product_id: 'R1' },
            },
          ],
        },
        vulns: [
          {
            cve: 'CVE-2099-2',
            product_status: { known_affected: ['F1', 'R1'] },
            remediations: [{ category: 'mitigation', details: 'x', url: 'javascript:alert(1)' }],
          },
        ],
      }),
    );
    const p = parseCsaf(JSON.stringify(doc));
    expect(p.content.products.find((x) => x.id === 'F1')).toMatchObject({ vendor: 'fooke', name: 'a100', version: '2.3.1' });
    expect(p.content.products.find((x) => x.id === 'R1')).toMatchObject({ vendor: 'Fooke', name: 'B200', range: '<3.0', partOf: 'Fooke B200' });
    expect(p.content.vulnerabilities[0]!.remediations[0]!.url).toBe('');
    expect(cpeParts('cpe:/h:fooke:a100:2.3')).toEqual({ vendor: 'fooke', product: 'a100', version: '2.3' });
  });
});

describe('version ranges', () => {
  // range, firmware, in range (null: not understood)
  const TABLE: [string, string, boolean | null][] = [
    ['vers:generic/<2.4', '2.3.1', true],
    ['vers:generic/<2.4', '2.4', false],
    ['vers:generic/<2.4', '2.4.0', false],
    ['vers:generic/<2.4', 'V2.3', true],
    ['vers:generic/>=3.0.0|<3.4.0', '3.2.0', true],
    ['vers:generic/>=3.0.0|<3.4.0', '3.4.2', false],
    ['vers:generic/>=3.0.0|<3.4.0', '2.9', false],
    ['vers:generic/<=1.0|>=2.0|<3.0', '1.0', true],
    ['vers:generic/<=1.0|>=2.0|<3.0', '1.5', false],
    ['vers:generic/<=1.0|>=2.0|<3.0', '2.5', true],
    ['vers:generic/1.2.3|1.2.5', '1.2.5', true],
    ['vers:generic/1.2.3|1.2.5', '1.2.4', false],
    ['vers:generic/>=1.0|!=1.5|<2.0', '1.5', false],
    ['vers:generic/>=1.0|!=1.5|<2.0', '1.6', true],
    ['vers:npm/>=2.0.0-beta|<2.0.0', '2.0.0-rc.1', true],
    ['vers:all/*', 'anything', true],
    ['<V3.0.29', 'V3.0.28', true],
    ['<V3.0.29', 'V3.0.29', false],
    ['>=8.1.5', '8.2', true],
    ['<=2', '2.0', true],
    ['<V4.00_Utilizes_Wibu-Systems_CodeMeter_7.60c', 'V3.10', true],
    ['All versions', '1.0', true],
    ['All versions < V3.0', 'V2.9', true],
    ['All versions < V3.0', 'V3.0', false],
    ['prior to 4.2', '4.1.9', true],
    ['4.2 and later', '4.1', false],
    ['4.2 and later', '4.3', true],
    ['1.0 - 2.0', '2.0', true],
    ['1.0 - 2.0', '2.1', false],
    // not understood: never a decision
    ['some versions', '1.0', null],
    ['vers:generic/~>2.0', '2.1', null],
    ['vers:generic/<2.4', 'unknown build', null],
    ['2.4', '2.4', null],
  ];
  for (const [range, fw, want] of TABLE)
    it(`${range} ∋ ${fw}: ${want}`, () => {
      expect(inRange(parseRange(range), fw)).toBe(want);
    });

  it('the upper end of an affected range is the fix it implies', () => {
    expect(upperBound(parseRange('vers:generic/>=3.0.0|<3.4.0'))).toBe('3.4.0');
    expect(upperBound(parseRange('<V3.0.29'))).toBe('V3.0.29');
    expect(upperBound(parseRange('>=2.0'))).toBeNull();
    expect(upperBound(parseRange('vers:generic/<1.0|>=2.0'))).toBeNull();
  });
});

describe('matching', () => {
  const asset = (id: string, manufacturer: string, model: string, firmware = '', profile: MatchCandidate['profile'] = null): MatchCandidate => ({
    assetId: id,
    siteId: 'site',
    manufacturer,
    model,
    firmware,
    profile,
  });
  const content = (doc = csaf()) => parseCsaf(doc).content;

  it('normalises vendors (legal forms, case, spaces) and models (letters and digits)', () => {
    expect(normVendor('Fooke Automation GmbH & Co. KG')).toBe('fookeautomation');
    expect(normVendor('FOOKE AUTOMATION')).toBe('fookeautomation');
    expect(normVendor('Example Meters Ltd.')).toBe(normVendor('Example Meters'));
    expect(normModel('PM-200')).toBe(normModel('PM 200'));
  });

  it('exact: vendor and model the same or normalised, firmware in range – with the reason', () => {
    const r = matchAdvisory(content(), [asset('a', 'Fooke Automation', 'A-100', '2.3.1'), asset('b', 'Fooke Automation GmbH', 'A100', '2.4')]);
    expect(r.get('a')).toMatchObject({ kind: 'exact', cves: ['CVE-2099-0001'], cvss: 8.1, severity: 'high' });
    expect(r.get('a')!.reasons[0]!.text).toBe(
      'matched on vendor Fooke Automation GmbH (normalised), model A100 (normalised), firmware 2.3.1 in vers:generic/<2.4',
    );
    expect(r.get('a')!.fixes).toEqual([{ version: '2.4', from: 'fixed_product', product: 'Fooke A100 2.4' }]);
    // the fixed version: no match at all
    expect(r.has('b')).toBe(false);
  });

  it('possible: firmware not recorded, a range not understood, a similar vendor or model, under investigation', () => {
    const tree = (range: string) => ({
      branches: [
        {
          category: 'vendor',
          name: 'Fooke',
          branches: [
            {
              category: 'product_name',
              name: 'A100',
              branches: [{ category: 'product_version_range', name: range, product: { name: 'x', product_id: 'P1' } }],
            },
          ],
        },
      ],
    });
    const c = content(csaf({ publisher: 'Fooke', tree: tree('vers:generic/<2.4'), vulns: [{ cve: 'CVE-1', product_status: { known_affected: ['P1'] } }] }));
    const r = matchAdvisory(c, [
      asset('nofw', 'Fooke', 'A100'),
      asset('similarModel', 'Fooke', 'A100 Pro', '2.0'),
      asset('similarVendor', 'Fooke Robotics', 'A100', '2.0'),
      asset('otherVendor', 'Bar', 'A100', '2.0'),
      asset('otherModel', 'Fooke', 'Z9', '2.0'),
    ]);
    expect(r.get('nofw')).toMatchObject({ kind: 'possible' });
    expect(r.get('nofw')!.reasons[0]!.version.how).toBe('unknown');
    expect(r.get('similarModel')!.kind).toBe('possible');
    expect(r.get('similarModel')!.reasons[0]!.model.how).toBe('similar');
    expect(r.get('similarVendor')!.kind).toBe('possible');
    expect(r.has('otherVendor')).toBe(false);
    expect(r.has('otherModel')).toBe(false);
    const unparsed = content(csaf({ publisher: 'Fooke', tree: tree('some versions'), vulns: [{ cve: 'CVE-1', product_status: { known_affected: ['P1'] } }] }));
    expect(matchAdvisory(unparsed, [asset('x', 'Fooke', 'A100', '2.0')]).get('x')!.reasons[0]!.version.how).toBe('unparsed');
    const investigating = content(
      csaf({ publisher: 'Fooke', tree: tree('vers:all/*'), vulns: [{ cve: 'CVE-1', product_status: { under_investigation: ['P1'] } }] }),
    );
    expect(matchAdvisory(investigating, [asset('x', 'Fooke', 'A100', '2.0')]).get('x')).toMatchObject({ kind: 'possible' });
  });

  it('through the device profile: the controller’s vendor and model with the assignment’s firmware', () => {
    const c = parseCsaf(example('exctl-sa-2026-001.json')).content;
    const ctl = { id: 'example-controls-c80', manufacturer: 'Example Controls', model: 'C80', version: '3.x' };
    const r = matchAdvisory(c, [
      asset('mill-01', 'Example Machine Tools', 'VMC 800', '3.4.2', ctl),
      asset('mill-02', 'Example Machine Tools', 'VMC 800', '3.2.0', ctl),
      asset('mill-03', 'Example Machine Tools', 'VMC 800', '', ctl),
    ]);
    expect(r.has('mill-01')).toBe(false);
    expect(r.get('mill-02')).toMatchObject({ kind: 'exact' });
    expect(r.get('mill-02')!.reasons[0]).toMatchObject({ via: 'profile', profileId: 'example-controls-c80' });
    expect(r.get('mill-02')!.reasons[0]!.text).toContain('via device profile example-controls-c80');
    expect(r.get('mill-02')!.fixes[0]!.version).toBe('3.4.0');
    // the profile's own version "3.x" does not read as a firmware: only a possible match
    expect(r.get('mill-03')!.kind).toBe('possible');
  });

  it('model numbers with wildcards are exact', () => {
    const c = parseCsaf(example('exctl-sa-2026-001.json')).content;
    expect(matchAdvisory(c, [asset('x', 'Example Controls', 'C80-PN', '3.1')]).get('x')).toMatchObject({ kind: 'exact' });
  });

  it('a version listed as not affected by the same vulnerability does not match', () => {
    const c = content(
      csaf({
        publisher: 'Fooke',
        tree: {
          branches: [
            {
              category: 'vendor',
              name: 'Fooke',
              branches: [
                {
                  category: 'product_name',
                  name: 'A100',
                  branches: [
                    { category: 'product_version_range', name: 'vers:generic/<3.0', product: { name: 'A100 <3.0', product_id: 'P1' } },
                    { category: 'product_version', name: '2.7', product: { name: 'A100 2.7', product_id: 'P2' } },
                  ],
                },
              ],
            },
          ],
        },
        vulns: [{ cve: 'CVE-1', product_status: { known_affected: ['P1'], known_not_affected: ['P2'] } }],
      }),
    );
    const r = matchAdvisory(c, [asset('a', 'Fooke', 'A100', '2.7'), asset('b', 'Fooke', 'A100', '2.6')]);
    expect(r.has('a')).toBe(false);
    expect(r.get('b')!.kind).toBe('exact');
  });
});

describe('directory distribution', () => {
  it('reads changes.csv and stays below the directory', () => {
    const list = parseChanges(
      '"2026/a.json","2026-10-01T00:00:00Z"\n"2025/b.json","2025-01-01T00:00:00Z"\n"../../evil.json","x"\nnot,a,json\n',
      'https://p.example/white/',
    );
    expect(list.map((x) => x.url)).toEqual(['https://p.example/white/2026/a.json', 'https://p.example/white/2025/b.json']);
    expect(list[0]!.hashes).toEqual(['https://p.example/white/2026/a.json.sha512', 'https://p.example/white/2026/a.json.sha256']);
  });
});
