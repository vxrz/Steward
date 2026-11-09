/** Test documents of security advisories (0.14, docs/ADVISORIES.md): invented vendors and products only. */

/** A minimal valid CSAF document around a product tree and vulnerabilities. */
export function csaf(o: { id?: string; tree?: unknown; vulns?: unknown[]; tlp?: string; current?: string; publisher?: string } = {}): string {
  return JSON.stringify({
    document: {
      category: 'csaf_security_advisory',
      csaf_version: '2.0',
      publisher: { category: 'vendor', name: o.publisher ?? 'Fooke Automation GmbH', namespace: 'https://psirt.fooke.example' },
      title: 'Fooke A100: invented test advisory',
      ...(o.tlp ? { distribution: { tlp: { label: o.tlp } } } : {}),
      tracking: {
        id: o.id ?? 'FOOKE-SA-0001',
        version: '1',
        status: 'final',
        initial_release_date: '2026-01-01T00:00:00Z',
        current_release_date: o.current ?? '2026-01-01T00:00:00Z',
        revision_history: [{ date: '2026-01-01T00:00:00Z', number: '1', summary: 'Initial' }],
      },
    },
    product_tree: o.tree ?? {
      branches: [
        {
          category: 'vendor',
          name: 'Fooke Automation GmbH',
          branches: [
            {
              category: 'product_name',
              name: 'A100',
              branches: [
                { category: 'product_version_range', name: 'vers:generic/<2.4', product: { name: 'Fooke A100 <2.4', product_id: 'P1' } },
                { category: 'product_version', name: '2.4', product: { name: 'Fooke A100 2.4', product_id: 'P2' } },
              ],
            },
          ],
        },
      ],
    },
    vulnerabilities: o.vulns ?? [
      {
        cve: 'CVE-2099-0001',
        product_status: { known_affected: ['P1'], fixed: ['P2'] },
        scores: [{ products: ['P1'], cvss_v3: { baseScore: 8.1, baseSeverity: 'HIGH', vectorString: 'CVSS:3.1/AV:N' } }],
        remediations: [{ category: 'vendor_fix', details: 'Update to 2.4', product_ids: ['P1'] }],
      },
    ],
  });
}
