import { catalogueRoutes } from '../catalogue/routes.js';
import { serviceApiRoutes } from '../catalogue/api-v1.js';
import { CATALOGUE_MIGRATIONS } from '../migrations/catalogue.js';
import { catalogueShareKind } from '../catalogue/shares.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** The service catalogue: services, applications, systems, maintenance windows, Kubernetes and repositories. */
export default defineFeature({
  name: 'catalogue',
  routes: [catalogueRoutes],
  apiV1: [serviceApiRoutes],
  jobs: [
    // Kubernetes namespaces and repositories of applications (every few hours)
    every5Minutes('kubernetes', 30 * MINUTE, () => import('../catalogue/kubernetes.js').then((m) => m.runKubernetesJob())),
    every5Minutes('repositories', 30 * MINUTE, () => import('../catalogue/repositories.js').then((m) => m.runRepositoryJob())),
    // maintenance windows: reminders, start and end messages (catalogue/maintenance.ts)
    every5Minutes('maintenance-windows', 2 * MINUTE, () => import('../catalogue/maintenance.js').then((m) => m.runMaintenanceJob())),
  ],
  migrations: [CATALOGUE_MIGRATIONS],
  // shares (ADR 0033, #291): services, applications and systems – the Access tab, end dates and their reminders
  shareKinds: [catalogueShareKind('service'), catalogueShareKind('application'), catalogueShareKind('system')],
});
