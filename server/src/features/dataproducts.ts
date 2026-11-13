import { DATA_PRODUCT_MIGRATIONS } from '../migrations/dataproducts.js';
import { dataProductRoutes } from '../dataproducts/routes.js';
import { dataProductHealthRoutes } from '../dataproducts/health-routes.js';
import { dataProductViewRoutes } from '../dataproducts/views-routes.js';
import { DATA_PRODUCT_LINK_KIND_RESOLVERS } from '../dataproducts/links.js';
import { dataProductTransferRoutes } from '../dataproducts/transfer-routes.js';
import { dataProductApiRoutes } from '../dataproducts/api-v1.js';
import { dataProductTools } from '../dataproducts/mcp.js';
import { defineFeature } from './define.js';

/**
 * Data products (0.22.0, ADR 0036, docs/DATA-PRODUCTS.md, preview, off by default): domains, data objects, products,
 * the element catalogue, membership, ports, consumers and steps. Its routes answer 404 while the module is off.
 */
export default defineFeature({
  name: 'dataproducts',
  module: 'dataProducts',
  // checks and health (WP3); the pictures (WP6): the pipeline of a product, the product map, the lineage of an element
  // import and export, ODPS (WP7)
  routes: [dataProductRoutes, dataProductHealthRoutes, dataProductViewRoutes, dataProductTransferRoutes],
  // the public API (read-only) and the MCP read tools (WP7, ADR 0036 parts 14 and 19); not listed while the module is off
  apiV1: [dataProductApiRoutes],
  mcpTools: dataProductTools,
  // ADR 0036 part 17: documents, records and ticket references link products and data objects
  linkKinds: [...DATA_PRODUCT_LINK_KIND_RESOLVERS],
  migrations: [DATA_PRODUCT_MIGRATIONS],
});
