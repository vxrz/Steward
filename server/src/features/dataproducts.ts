import { DATA_PRODUCT_MIGRATIONS } from '../migrations/dataproducts.js';
import { dataProductRoutes } from '../dataproducts/routes.js';
import { dataProductHealthRoutes } from '../dataproducts/health-routes.js';
import { dataProductViewRoutes } from '../dataproducts/views-routes.js';
import { discoveryRoutes } from '../dataproducts/discovery/routes.js';
import { dataLineageRoutes } from '../dataproducts/lineage/routes.js';
import { dataProductCostRoutes } from '../dataproducts/costs-routes.js';
import { DATA_PRODUCT_LINK_KIND_RESOLVERS } from '../dataproducts/links.js';
import { dataProductTransferRoutes } from '../dataproducts/transfer-routes.js';
import { dataProductApiRoutes } from '../dataproducts/api-v1.js';
import { dataProductTools } from '../dataproducts/mcp.js';
import { dataProductProposalTools } from '../dataproducts/proposals.js';
import { DATA_PRODUCT_SHARE_KIND } from '../dataproducts/shares.js';
import { dataProductQualityRoutes } from '../dataproducts/quality-routes.js';
import { dataProductsSection } from '../dataproducts/report-section.js';
import { dataProductGovernanceRoutes } from '../dataproducts/governance-routes.js';
import { dataProductSemanticRoutes } from '../dataproducts/semantic-routes.js';
import { defineFeature, every5Minutes, MINUTE } from './define.js';

/**
 * Data products (0.22.0, ADR 0036, docs/DATA-PRODUCTS.md, preview, off by default): domains, data objects, products,
 * the element catalogue, membership, ports, consumers and steps; discovery of elements from Snowflake, Kafka and the
 * schema snapshots of database platforms. Its routes answer 404 and its job does not run while the module is off.
 */
export default defineFeature({
  name: 'dataproducts',
  module: 'dataProducts',
  // the discovery sources first: /data-products/discovery-sources is not a product id; checks and health (WP3); the
  // pictures (WP6): the pipeline of a product, the product map, the lineage of an element; costs and scorecard (WP4);
  // import and export, ODPS (WP7); lineage sources, their push and the proposals (0.24.0, phase 2)
  routes: [
    discoveryRoutes,
    dataLineageRoutes,
    dataProductRoutes,
    dataProductHealthRoutes,
    dataProductViewRoutes,
    dataProductCostRoutes,
    dataProductTransferRoutes,
    // 0.24.0 (phase 2, package B): quality results, personal fields from contracts, scorecard history
    dataProductQualityRoutes,
    // consumers, access and governance (0.24.0, ADR 0036 phase 2): actual consumers, access requests and reviews,
    // promotion, endorsement, the GDPR Art. 30 view
    dataProductGovernanceRoutes,
    // phase 3, package D (0.25.0, ADR 0037 parts 4 and 6): semantic models, previews, the Art. 30 details
    dataProductSemanticRoutes,
  ],
  // 0.24.0 (ADR 0036 phase 2; the module's report section for ADR 0034): maturity, health and quality per product
  reportSections: [dataProductsSection],
  // the public API (read-only) and the MCP read tools (WP7, ADR 0036 parts 14 and 19); not listed while the module is off
  apiV1: [dataProductApiRoutes],
  // phase 2 (package D): proposals from assistants – applied by a person under AI requests, never by the assistant
  mcpTools: [...dataProductTools, ...dataProductProposalTools],
  // ADR 0036 part 17: documents, records and ticket references link products and data objects
  linkKinds: [...DATA_PRODUCT_LINK_KIND_RESOLVERS],
  // ADR 0033: products are shared with people and teams on their Access tab (data objects, elements and domains keep
  // their owning teams; shares of those follow in phase 2)
  shareKinds: [DATA_PRODUCT_SHARE_KIND],
  migrations: [DATA_PRODUCT_MIGRATIONS],
  jobs: [
    // ADR 0036 part 5: the discovery sources that are due, one at a time (a run stops after 10 minutes)
    every5Minutes('data-products', 30 * MINUTE, () => import('../dataproducts/discovery/job.js').then((m) => m.runDataProductsJob())),
    // 0.24.0 (ADR 0036 part 13 phase 2): the daily scorecard snapshots (asked hourly, written once a day), kept 400 days
    {
      name: 'data-products-scorecard',
      intervalMs: 60 * MINUTE,
      timeoutMs: 30 * MINUTE,
      run: () => import('../dataproducts/scorecard-history.js').then((m) => m.runScorecardJob()),
    },
    // 0.24.0: actual consumers read again daily, endorsement and access review reminders (at most hourly)
    every5Minutes('data-products-governance', 20 * MINUTE, () => import('../dataproducts/governance-job.js').then((m) => m.runGovernanceJob())),
  ],
});
