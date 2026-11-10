import { db } from '../db.js';
import { logger } from '../log.js';
import { runAs } from '../auth/context.js';
import { findUserByName, listTeams, toAuthUser } from '../auth/users.js';
import { ensureCatalogues } from './controls.js';
import { setResponsibilities } from './responsibilities.js';
import { createSoa, updateEntry } from './soa.js';

/**
 * Demo data of the statement of applicability (ADR 0029 part 2): the responsibility matrix of two demo services – the
 * shop's backup done by the managed platform supplier, the rest by the team, a group function or shared – and a draft
 * statement of the ISO/IEC 27001:2022 Annex A catalogue with a few rows decided. Everything is invented. Runs once, with
 * the services of the demo (catalogue/demo.ts), as the demo designer.
 */
export function setupSoaDemo(services: { shop: string; care: string }, cloudSupplier: string | null): void {
  if (db().get('SELECT 1 FROM soas LIMIT 1') || db().get('SELECT 1 FROM service_responsibilities LIMIT 1')) return;
  const dana = findUserByName('dana');
  if (!dana) return;
  ensureCatalogues();
  const desk = listTeams().some((t) => t.name.toLowerCase() === 'service desk') ? 'team:service desk' : 'user:dana';
  try {
    runAs(toAuthUser(dana), () => {
      const contract = cloudSupplier
        ? db().get<{ id: string }>('SELECT id FROM supplier_contracts WHERE supplier_id = ? ORDER BY title LIMIT 1', cloudSupplier)?.id
        : undefined;
      setResponsibilities(services.shop, {
        areas: [
          cloudSupplier
            ? { area: 'backup', party: 'supplier', supplierId: cloudSupplier, contractId: contract ?? null, note: 'Volume snapshots of the managed cluster.' }
            : { area: 'backup', party: 'team' },
          { area: 'recovery', party: 'shared', note: 'The supplier restores the cluster; the team restores the shop database and checks the orders.' },
          { area: 'patching', party: 'team', note: 'Images of the shop rebuilt weekly; the cluster is patched by the supplier.' },
          { area: 'access', party: 'team' },
          { area: 'logging', party: 'central', centralName: 'Group security operations' },
          { area: 'incidents', party: 'shared', note: 'Group security operations triage; the Service Desk fixes and reviews.' },
        ],
      });
      setResponsibilities(services.care, {
        areas: [
          { area: 'backup', party: 'team' },
          { area: 'recovery', party: 'team' },
          { area: 'patching', party: 'central', centralName: 'Group IT workplace services' },
          { area: 'access', party: 'team' },
          { area: 'logging', party: 'central', centralName: 'Group security operations' },
          { area: 'incidents', party: 'central', centralName: 'Group security operations' },
        ],
      });
      const soa = createSoa({ catalogueId: 'ISO27001', scopeName: 'Online services (demo)', scopeServiceIds: [services.shop, services.care] });
      const control = (ref: string) => soa.entries.find((e) => e.ref === ref)?.controlId;
      const set = (ref: string, v: Parameters<typeof updateEntry>[2]) => {
        const id = control(ref);
        if (id) updateEntry('ISO27001', id, v);
      };
      set('5.15', {
        applicable: true,
        justification: 'Customer and order data need access control (risk RISK-ACC-01).',
        status: 'implemented',
        howMet: 'Roles per application, granted through access change records and reviewed every quarter.',
        party: 'team',
        owner: desk,
        reviewed: true,
        grcRef: 'RISK-ACC-01',
        grcUrl: 'https://grc.example.com/risks/RISK-ACC-01',
      });
      set('5.18', {
        applicable: true,
        justification: 'Leavers and movers must lose their access (risk RISK-ACC-07).',
        status: 'partly',
        howMet: 'Quarterly database access review; leavers are still removed by hand (see the corrective action).',
        party: 'team',
        owner: desk,
      });
      set('5.23', {
        applicable: true,
        justification: 'The shop runs on a managed Kubernetes platform.',
        status: 'implemented',
        howMet: 'Supplier record with contract, SLA and a C5 attestation; reviewed every year.',
        party: 'supplier',
        supplierId: cloudSupplier,
        evidenceLinks: [{ title: 'Trust centre of the supplier', url: 'https://cloud.example/trust' }],
      });
      set('7.1', {
        applicable: false,
        justification: 'No own premises: the data centres are run by the suppliers, covered by their certificates.',
      });
      set('8.13', {
        applicable: true,
        justification: 'Order and customer data must be restorable.',
        status: 'partly',
        howMet: 'Snapshots by the supplier for the shop; the customer care backup is the team’s.',
      });
      set('8.8', {
        applicable: true,
        justification: 'Internet-facing shop.',
        status: 'planned',
        howMet: 'A weekly scan of the shop images is planned for next quarter.',
      });
    });
  } catch (err) {
    // a demo must never fail half way: logged, the rest stays
    logger.warn({ err: (err as Error).message }, 'demo statement of applicability not complete');
  }
}
