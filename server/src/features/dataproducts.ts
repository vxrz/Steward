import { DATA_PRODUCT_MIGRATIONS } from '../migrations/dataproducts.js';
import { dataProductRoutes } from '../dataproducts/routes.js';
import { dataProductHealthRoutes } from '../dataproducts/health-routes.js';
import { dataProductViewRoutes } from '../dataproducts/views-routes.js';
import { discoveryRoutes } from '../dataproducts/discovery/routes.js';
import { DATA_PRODUCT_LINK_KIND_RESOLVERS } from '../dataproducts/links.js';
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
  // pictures (WP6): the pipeline of a product, the product map, the lineage of an element
  routes: [discoveryRoutes, dataProductRoutes, dataProductHealthRoutes, dataProductViewRoutes],
  // ADR 0036 part 17: documents, records and ticket references link products and data objects
  linkKinds: [...DATA_PRODUCT_LINK_KIND_RESOLVERS],
  migrations: [DATA_PRODUCT_MIGRATIONS],
  jobs: [
    // ADR 0036 part 5: the discovery sources that are due, one at a time (a run stops after 10 minutes)
    every5Minutes('data-products', 30 * MINUTE, () => import('../dataproducts/discovery/job.js').then((m) => m.runDataProductsJob())),
  ],
});
