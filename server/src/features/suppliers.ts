import { supplierRoutes } from '../suppliers/routes.js';
import { supplierApiRoutes } from '../suppliers/api-v1.js';
import { supplierTools } from '../suppliers/mcp.js';
import { capabilities } from '../auth/permissions.js';
import { currentUser } from '../auth/context.js';
import { SUPPLIER_MIGRATIONS } from '../migrations/suppliers.js';
import { catalogueShareKind } from '../catalogue/shares.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/** Suppliers (0.17.0, ADR 0029 part 1): core catalogue, linked from applications, systems, tickets, watches, cost plans and duties. */
export default defineFeature({
  name: 'suppliers',
  routes: [supplierRoutes],
  apiV1: [supplierApiRoutes],
  jobs: [
    // reminders before certificates run out and notice-by dates, and the dataset suppliers.expiring (at most hourly)
    every5Minutes('suppliers', 5 * MINUTE, () => import('../suppliers/jobs.js').then((m) => m.runSupplierJob())),
  ],
  datasets: [
    // its rows name every supplier: administrators and auditors (like the cost datasets)
    { name: 'suppliers', owns: (id) => id.startsWith('suppliers:'), visible: () => capabilities(currentUser()).viewAudit },
  ],
  mcpTools: supplierTools,
  migrations: [SUPPLIER_MIGRATIONS],
  // shares (ADR 0033, #292): the company record; contracts and scoped contacts keep their own rules (ADR 0031)
  shareKinds: [catalogueShareKind('supplier')],
});
