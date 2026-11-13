import { DATA_PRODUCT_MIGRATIONS } from '../migrations/dataproducts.js';
import { dataProductRoutes } from '../dataproducts/routes.js';
import { DATA_PRODUCT_LINK_KIND_RESOLVERS } from '../dataproducts/links.js';
import { defineFeature } from './define.js';

/**
 * Data products (0.22.0, ADR 0036, docs/DATA-PRODUCTS.md, preview, off by default): domains, data objects, products,
 * the element catalogue, membership, ports, consumers and steps. Its routes answer 404 while the module is off.
 */
export default defineFeature({
  name: 'dataproducts',
  module: 'dataProducts',
  routes: [dataProductRoutes],
  // ADR 0036 part 17: documents, records and ticket references link products and data objects
  linkKinds: [...DATA_PRODUCT_LINK_KIND_RESOLVERS],
  migrations: [DATA_PRODUCT_MIGRATIONS],
});
