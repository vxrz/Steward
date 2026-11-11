import { addDays, supplierCertificateInput, supplierContactInput, supplierContractInput, supplierInput } from '@sm/shared';
import { db } from '../db.js';
import { setOwningTeams } from '../auth/policy.js';
import { addCertificate, addContact, addContract, createSupplier, insertSupplier, supplierToday } from './service.js';

/**
 * The suppliers of the demo (0.17.0, ADR 0029): two invented suppliers – a SaaS payment platform whose ISO/IEC 27001
 * certificate runs out soon and whose contract's notice-by date is near, and a managed Kubernetes platform shared by two
 * services (ADR 0031): the shop's hosting held by the service desk team, a framework agreement with an order form for
 * customer care's licences, a contact scoped to the hosting contract – and a pair of suppliers split by team as the
 * 0.17 update left them. The
 * remaining free-text vendors of the demo become unconfirmed suppliers afterwards (catalogue/demo.ts), so the list
 * "To confirm" has something to work through. Everything is invented. Returns the ids.
 */
export function setupSupplierDemo(
  owners: string[],
  now = Date.now(),
  services: { shop?: string; care?: string; teamOwner?: string; userOwner?: string } = {},
): { payments: string; cloud: string } | null {
  if (db().get("SELECT 1 FROM suppliers WHERE name IN ('Paylumen', 'Example Cloud GmbH')")) return null;
  const today = supplierToday(now);
  const payments = createSupplier(
    supplierInput.parse({
      name: 'Paylumen',
      type: 'saas',
      description: 'Payment platform of the online shop: card payments, refunds and payment callbacks (invented).',
      website: 'https://paylumen.example',
      owners,
      personalData: true,
      dpaStatus: 'inPlace',
      dpaSince: '2025-03-01',
    }),
  );
  addContact(payments.id, supplierContactInput.parse({ name: 'Paylumen account team', role: 'accountManager', email: 'accounts@paylumen.example' }));
  addContact(payments.id, supplierContactInput.parse({ name: 'Paylumen security desk', role: 'security', email: 'security@paylumen.example' }));
  addContract(
    payments.id,
    supplierContractInput.parse({
      title: 'Payment platform subscription',
      reference: 'PL-C-2024-118',
      startsOn: '2024-04-01',
      endsOn: addDays(today, 120),
      noticeDays: 90,
      renewal: 'automatic',
      renewalMonths: 12,
      slaAvailability: 99.95,
      slaSupportHours: '24/7',
      slaResponse: 'Priority 1: 30 minutes, priority 2: 4 hours',
      rtoHours: 4,
      rpoHours: 0.25,
    }),
  );
  addCertificate(
    payments.id,
    supplierCertificateInput.parse({
      kind: 'iso27001',
      scope: 'Operation of the payment platform',
      issuer: 'Example certification body',
      issuedOn: addDays(today, -1070),
      validUntil: addDays(today, 25),
      checked: true,
    }),
  );
  addCertificate(
    payments.id,
    supplierCertificateInput.parse({ kind: 'soc2type2', scope: 'Payment processing', issuer: 'Example audit firm', issuedOn: addDays(today, -200) }),
  );
  const cloud = createSupplier(
    supplierInput.parse({
      name: 'Example Cloud GmbH',
      type: 'managedPlatform',
      description: 'Runs the managed Kubernetes clusters of the shop: backups, patching and recovery of the cluster (invented).',
      website: 'https://cloud.example',
      owners,
    }),
  );
  addContact(cloud.id, supplierContactInput.parse({ name: 'Example Cloud support', role: 'support', email: 'support@cloud.example' }));
  // shared by two services (ADR 0031): the shop's hosting is held by the service desk team, customer care's licences
  // are an order form of a framework agreement held by a person – each with the purpose for its service
  addContract(
    cloud.id,
    supplierContractInput.parse({
      title: 'Managed Kubernetes',
      ...(services.teamOwner ? { owners: [services.teamOwner] } : {}),
      ...(services.shop ? { services: [{ serviceId: services.shop, purpose: 'Hosting of the shop’s clusters' }] } : {}),
      reference: 'EC-2025-0042',
      startsOn: '2025-01-01',
      endsOn: '2027-12-31',
      noticeDays: 180,
      renewal: 'byAgreement',
      slaAvailability: 99.9,
      slaSupportHours: 'Business days 8–18',
      slaResponse: 'Severity 1: 1 hour',
      rtoHours: 8,
      rpoHours: 24,
    }),
  );
  addCertificate(
    cloud.id,
    supplierCertificateInput.parse({ kind: 'c5', scope: 'Managed Kubernetes', issuer: 'Example audit firm', validUntil: addDays(today, 400) }),
  );
  addContract(
    cloud.id,
    supplierContractInput.parse({
      title: 'Platform framework agreement',
      reference: 'EC-FA-2024',
      startsOn: '2024-01-01',
      endsOn: '2028-12-31',
      noticeDays: 180,
      renewal: 'byAgreement',
      slaAvailability: 99.5,
      slaSupportHours: 'Business days 8–18',
      rtoHours: 24,
      rpoHours: 24,
      personalData: true,
      dpaStatus: 'inPlace',
      dpaSince: '2024-01-01',
      ...(services.userOwner ? { owners: [services.userOwner] } : {}),
    }),
  );
  const framework = db().get<{ id: string }>("SELECT id FROM supplier_contracts WHERE supplier_id = ? AND reference = 'EC-FA-2024'", cloud.id)?.id;
  if (framework)
    addContract(
      cloud.id,
      supplierContractInput.parse({
        title: 'Order form: agent workspace licences',
        reference: 'EC-FA-2024-03',
        parentId: framework,
        startsOn: '2026-01-01',
        endsOn: addDays(today, 150),
        noticeDays: 60,
        renewal: 'automatic',
        renewalMonths: 12,
        ...(services.userOwner ? { owners: [services.userOwner] } : {}),
        ...(services.care ? { services: [{ serviceId: services.care, purpose: 'Licences for 40 agents' }] } : {}),
      }),
    );
  // a contact scoped to the hosting contract
  const hosting = db().get<{ id: string }>("SELECT id FROM supplier_contracts WHERE supplier_id = ? AND reference = 'EC-2025-0042'", cloud.id)?.id;
  if (hosting)
    addContact(
      cloud.id,
      supplierContactInput.parse({
        name: 'Example Cloud hosting account manager',
        role: 'accountManager',
        email: 'hosting-am@cloud.example',
        scope: [{ kind: 'contract', id: hosting }],
      }),
    );
  // a pair as the 0.17 update left it: one company, split by team – "Same supplier in several teams" suggests merging it
  const desk = db().get<{ id: string }>("SELECT id FROM teams WHERE lower(name) = 'service desk'")?.id;
  if (desk) {
    insertSupplier({ name: 'Invented Relay Mail', status: 'unconfirmed', aliases: ['invented relay mail'] }, 'system');
    const scoped = insertSupplier({ name: 'Invented Relay Mail GmbH', status: 'unconfirmed' }, 'system');
    setOwningTeams('supplier', scoped, [desk]);
  }
  return { payments: payments.id, cloud: cloud.id };
}
