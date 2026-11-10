import { addDays, supplierCertificateInput, supplierContactInput, supplierContractInput, supplierInput } from '@sm/shared';
import { db } from '../db.js';
import { addCertificate, addContact, addContract, createSupplier, supplierToday } from './service.js';

/**
 * The suppliers of the demo (0.17.0, ADR 0029): two invented suppliers – a SaaS payment platform whose ISO/IEC 27001
 * certificate runs out soon and whose contract's notice-by date is near, and a managed Kubernetes platform. The
 * remaining free-text vendors of the demo become unconfirmed suppliers afterwards (catalogue/demo.ts), so the list
 * "To confirm" has something to work through. Everything is invented. Returns the ids.
 */
export function setupSupplierDemo(owners: string[], now = Date.now()): { payments: string; cloud: string } | null {
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
  addContract(
    cloud.id,
    supplierContractInput.parse({
      title: 'Managed Kubernetes',
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
  return { payments: payments.id, cloud: cloud.id };
}
