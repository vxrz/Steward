import { db } from '../db.js';
import { logger } from '../log.js';
import { currentUser, runAs } from '../auth/context.js';
import { findUserByName, listTeams, toAuthUser } from '../auth/users.js';
import { addServiceLink, createService, serviceInput } from './service.js';
import { canEditApplication, rateApplication, serviceApplicationInput, setServiceApplication } from './applications.js';
import { createSystem, linkSystem, systemInput, systemLinkInput } from './systems.js';
import { createMaintenance, maintenanceInput } from './maintenance.js';
import { createPage, pageInput } from './status-pages.js';
import { ratingInput } from './cia.js';
import { createRecord, transition } from '../records/service.js';
import { createCredential, credentialInputSchema } from '../credentials/service.js';
import { createTicket, ticketInputSchema } from '../tickets/service.js';
import { createDuty, dutyInput } from '../duties/service.js';
import { createObjective, objectiveInput, readPromObjectives } from '../scorecard/objectives.js';
import { createReportSchedule, scheduleInputSchema } from '../reports/schedules.js';

/**
 * The service half of the demo (U5 of the 0.10 review): three services built from the sample applications, with the
 * demo monitors linked, an availability objective, a duty, a system in two environments, a decision record, a change
 * record, a reviewed operations manual, credential register entries (metadata only – never a secret), a vendor ticket,
 * a planned maintenance window, a status page and a weekly report schedule. Everything is invented. It runs once:
 * when the first demo service exists, it does nothing.
 */
export const DEMO_SERVICES = { shop: 'Online shop (demo)', care: 'Customer care (demo)', plant: 'Plant monitoring (demo)' } as const;

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One part of the seed: a failure is logged and the rest goes on (a demo must never fail half way). */
function step<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    logger.warn({ err: (err as Error).message, what }, 'demo service data not complete');
    return undefined;
  }
}

export async function setupServiceDemo(now = Date.now()): Promise<number> {
  if (db().get('SELECT 1 FROM services WHERE name IN (?, ?, ?)', DEMO_SERVICES.shop, DEMO_SERVICES.care, DEMO_SERVICES.plant)) return 0;
  const id = (sql: string, ...args: unknown[]) => db().get<{ id: string }>(sql, ...args)?.id;
  const app = (name: string) => id('SELECT id FROM applications WHERE name = ?', name);
  const monitor = (key: string) => id('SELECT id FROM monitors WHERE key = ?', key);
  const platform = (name: string) => id('SELECT id FROM platforms WHERE name = ?', name);
  const webshop = app('Webshop (demo)');
  const crm = app('CRM (demo)');
  const desk = listTeams().some((t) => t.name.toLowerCase() === 'service desk') ? ['team:service desk'] : [];
  const dana = findUserByName('dana') ? ['user:dana'] : [];
  const adam = findUserByName('adam');
  const asAdam = <T>(fn: () => T): T | undefined => (adam ? runAs(toAuthUser(adam), fn) : undefined);

  // ---- services ----
  const shop = createService(
    serviceInput.parse({
      name: DEMO_SERVICES.shop,
      description: 'The customer-facing shop: storefront, order API and payments. Runs on Kubernetes, events on Kafka, data in Snowflake.',
      contacts: [
        { role: 'business', email: 'shop-owner@example.com', name: 'Shop product owner' },
        { role: 'it', email: 'shop-ops@example.com', name: 'Shop operations' },
      ],
      owners: [...desk, ...dana],
      criticality: 'high',
      cmdb: { system: 'CMDB', id: 'SVC-0042', url: '' },
      tags: ['demo', 'customer-facing'],
    }),
  );
  const care = createService(
    serviceInput.parse({
      name: DEMO_SERVICES.care,
      description: 'Contact data and the customer service desk tools, built on the CRM application.',
      contacts: [{ role: 'business', email: 'care-lead@example.com', name: 'Customer care lead' }],
      owners: [...desk],
      criticality: 'medium',
      tags: ['demo'],
    }),
  );
  const plant = createService(
    serviceInput.parse({
      name: DEMO_SERVICES.plant,
      description: 'Machine data and power meters of the demo plant, watched through the IoT gateway and MQTT.',
      owners: [...dana],
      criticality: 'medium',
      tags: ['demo', 'ot'],
    }),
  );

  // ---- applications with a protection need (the scorecard's fourth part) ----
  const justification = 'Demo assessment';
  if (webshop) {
    step('shop application', () => setServiceApplication(shop.id, webshop, serviceApplicationInput.parse({ role: 'primary' })));
    step('shop rating', () =>
      rateApplication(
        webshop,
        ratingInput.parse({
          confidentiality: { level: 'high', justification: `${justification}: customer and order data` },
          integrity: { level: 'high', justification: `${justification}: prices and payments` },
          availability: { level: 'high', justification: `${justification}: revenue stops when the shop is down` },
        }),
      ),
    );
  }
  if (crm) {
    step('care application', () => setServiceApplication(care.id, crm, serviceApplicationInput.parse({ role: 'primary' })));
    if (webshop)
      step('shop dependency', () => setServiceApplication(shop.id, crm, serviceApplicationInput.parse({ role: 'dependency', roleText: 'Customer accounts' })));
    step('care rating', () =>
      rateApplication(
        crm,
        ratingInput.parse({
          confidentiality: { level: 'high', justification: `${justification}: personal data` },
          integrity: { level: 'normal', justification },
          availability: { level: 'normal', justification: `${justification}: the desk can work from the shop for a day` },
        }),
      ),
    );
  }

  // ---- the demo monitors, dashboards and processes linked to the services ----
  const links: [string, 'monitor' | 'dashboard' | 'process', string | undefined][] = [
    [shop.id, 'monitor', monitor('kubernetes-namespace')],
    [shop.id, 'monitor', monitor('kafka-orders')],
    [shop.id, 'monitor', monitor('shop-database')],
    [shop.id, 'monitor', monitor('error-budget-burn-rate')],
    [shop.id, 'monitor', monitor('kafka-connect-shop')],
    [shop.id, 'dashboard', id("SELECT id FROM dashboards WHERE id = 'service-levels'")],
    [shop.id, 'process', id("SELECT id FROM processes WHERE id = 'aws-iam-key-age'")],
    [care.id, 'monitor', monitor('crm-contacts-dynamodb')],
    [care.id, 'monitor', monitor('snowflake-account')],
    [plant.id, 'monitor', monitor('plant-services')],
    [plant.id, 'monitor', monitor('machine-17-powermeter')],
    [plant.id, 'monitor', monitor('mqtt-presses')],
  ];
  for (const [svc, kind, target] of links) if (target) step(`link ${kind}`, () => addServiceLink(svc, { kind, id: target, note: '' }));

  // ---- an availability objective from the demo Prometheus (avg of up{job="shop"}) ----
  const prometheus = platform('Prometheus (demo)');
  if (prometheus) {
    step('objective', () =>
      createObjective(
        objectiveInput.parse({
          serviceId: shop.id,
          applicationId: webshop ?? null,
          name: 'Shop instances up',
          description: 'Share of time the shop instances answer the Prometheus scrape.',
          platformId: prometheus,
          endpointKey: 'avg_over_time(up{job="shop"}[$window])',
          targets: { h1: null, h24: 99.5, d7: 99.5, d30: 99.9 },
        }),
      ),
    );
    await readPromObjectives(now, true).catch((err) => logger.warn({ err: (err as Error).message }, 'demo objective not read'));
  }

  // ---- a system in two environments ----
  const cluster = step('system', () =>
    createSystem(
      systemInput.parse({
        name: 'k8s-shop-01 (demo)',
        kind: 'cluster',
        vendor: 'Kubernetes',
        owners: [...desk],
        note: 'Kubernetes cluster of the shop. Namespace shop-prod is production, shop-test the test environment.',
        platformId: platform('Kubernetes (demo)') ?? null,
      }),
    ),
  );
  if (cluster && webshop) {
    for (const environment of ['prod', 'test'])
      step(`system link ${environment}`, () =>
        linkSystem(
          webshop,
          systemLinkInput.parse({ systemId: cluster.id, environment, note: `Namespace shop-${environment === 'prod' ? 'prod' : 'test'}` }),
          canEditApplication,
        ),
      );
  }

  // ---- documents: a decision, a change and an operations manual with a review cycle ----
  const adr = step('decision record', () =>
    createRecord({
      type: 'ADR',
      title: 'Publish order events on Kafka instead of calling the CRM directly',
      body: '## Context and problem statement\n\nThe shop called the CRM synchronously for every order. When the CRM was slow, checkout was slow.\n\n## Decision\n\nThe shop publishes an event on the topic `orders`; the CRM reads it.\n\n## Consequences\n\n- Good: checkout no longer waits for the CRM.\n- Bad: the CRM can lag a few seconds behind.\n',
      fields: { decisionDate: isoDay(now - 40 * DAY), deciders: 'Shop operations, Customer care lead' },
      tags: ['demo'],
      links: [{ kind: 'service', id: shop.id, note: '' }],
    }),
  );
  if (adr) {
    step('propose decision', () => transition(adr.id, { action: 'propose' }));
    step('accept decision', () => asAdam(() => transition(adr.id, { action: 'accept', comment: 'Agreed in the architecture board.' })));
  }
  const start = new Date(now + 4 * DAY);
  start.setUTCHours(20, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3_600_000);
  const change = step('change record', () =>
    createRecord({
      type: 'CR',
      title: 'Upgrade the shop database to the next major version',
      body: '## Description\n\nIn-place upgrade of the shop database.\n\n## Implementation plan\n\n1. Stop the order consumers.\n2. Upgrade and run the checks.\n3. Start the consumers again.\n',
      fields: {
        reason: 'The current major version reaches its end of life this year.',
        risk: 'medium',
        rollbackPlan: 'Restore the snapshot taken before the upgrade.',
        plannedStart: start.toISOString(),
        plannedEnd: end.toISOString(),
      },
      tags: ['demo'],
      links: [{ kind: 'service', id: shop.id, note: '' }],
    }),
  );
  if (change) {
    step('submit change', () => transition(change.id, { action: 'submit' }));
    step('approve change', () => asAdam(() => transition(change.id, { action: 'approve', comment: 'Window agreed with the shop owner.' })));
  }
  const manual = step('operations manual', () =>
    createRecord({
      type: 'DOC',
      title: 'Operations manual – Online shop',
      body: '## Purpose and scope\n\nHow the shop is run: deployments, on-call, restore.\n\n## Responsibilities\n\n- Service Desk: first response\n- Shop operations: deployments and restores\n\n## Content\n\nRestore the database from the nightly snapshot; see the change records for upgrades.\n',
      tags: ['demo'],
      links: [{ kind: 'service', id: shop.id, note: '' }],
    }),
  );
  if (manual) {
    step('submit manual', () => transition(manual.id, { action: 'submit', editionKind: 'major', changeSummary: 'First edition' }));
    step('approve manual', () => asAdam(() => transition(manual.id, { action: 'approve' })));
  }

  // ---- the credential register: where each credential is kept and when it is due – never the secret itself ----
  const credentials = [
    {
      name: 'Shop order API client (demo)',
      type: 'apiClient',
      environment: 'prod',
      description: 'OAuth client the storefront uses to call the order API.',
      location: { text: 'Vault folder Shop/Production' },
      expiresAt: isoDay(now + 12 * DAY),
      belongsTo: webshop ? { kind: 'application', id: webshop } : null,
    },
    {
      name: 'CRM sync technical user (demo)',
      type: 'technicalUser',
      environment: 'prod',
      description: 'Reads order events and writes contacts into the CRM.',
      location: { text: 'Vault folder CRM/Production' },
      rotationIntervalDays: 90,
      lastRotatedAt: isoDay(now - 120 * DAY),
      belongsTo: crm ? { kind: 'application', id: crm } : null,
    },
    {
      name: 'shop.example.com TLS certificate (demo)',
      type: 'certificate',
      environment: 'prod',
      description: 'Server certificate of the storefront.',
      location: { text: 'Certificate store of the ingress' },
      expiresAt: isoDay(now + 200 * DAY),
      belongsTo: cluster ? { kind: 'system', id: cluster.id } : null,
    },
  ];
  for (const c of credentials) step(`credential ${c.name}`, () => createCredential(credentialInputSchema.parse({ ...c, ownerSubjects: desk, tags: ['demo'] })));

  // ---- a vendor ticket the shop waits on ----
  step('ticket', () =>
    createTicket(
      ticketInputSchema.parse({
        source: 'vendor',
        externalNumber: 'PL-48213',
        title: 'Payment callbacks arrive late',
        note: 'Paylumen confirms delays of up to 10 minutes for some callbacks.',
        vendor: 'Paylumen',
        responsible: desk,
        status: 'waitingVendor',
        openedAt: isoDay(now - 9 * DAY),
        links: [{ kind: 'service', id: shop.id }],
      }),
    ),
  );

  // ---- duties: one done by the demo's own runs, one still open ----
  const duty = (serviceId: string, processId: string, name: string, interval: string, level: string) => {
    if (!db().get('SELECT 1 FROM processes WHERE id = ?', processId)) return;
    step(`duty ${name}`, () =>
      createDuty(dutyInput.parse({ serviceId, processId, name, interval, level, owners: desk, description: 'Taken in turns by the Service Desk.' })),
    );
  };
  duty(shop.id, 'aws-iam-key-age', 'Monthly access key review', 'monthly', 'mandatory');
  duty(shop.id, 'database-access-review', 'Quarterly database access review', 'quarterly', 'mandatory');
  duty(care.id, 'snowflake-account-hygiene', 'Weekly account hygiene', 'weekly', 'recommended');

  // ---- an upcoming maintenance window for the change ----
  step('maintenance', () =>
    createMaintenance(
      maintenanceInput.parse({
        title: 'Shop database upgrade',
        note: 'The shop shows a maintenance page during the upgrade.',
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        targets: [{ kind: 'service', id: shop.id }],
        responsible: desk,
        changeRecordId: change?.id ?? null,
      }),
    ),
  );

  // ---- a status page and a weekly report ----
  step('status page', () =>
    createPage(
      pageInput.parse({ title: 'Shop and customer care (demo)', description: 'The state of the customer-facing services.', serviceIds: [shop.id, care.id] }),
    ),
  );
  step('report schedule', () =>
    createReportSchedule(
      scheduleInputSchema.parse({
        name: 'Weekly service meeting (demo)',
        preset: 'weekly',
        title: 'Service meeting',
        sections: { scorecard: {}, duties: {}, credentials: {}, tickets: {}, runs: {} },
        recipients: { users: [currentUser()?.username].filter((n): n is string => !!n) },
      }),
    ),
  );
  return 3;
}
