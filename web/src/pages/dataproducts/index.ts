/**
 * The pages of the data products module (ADR 0036 part 13, WP5), loaded on demand from App.tsx:
 *
 *   /data-products[?filters]                       DataProductsPage
 *   /data-products/:id[/:tab]                      DataProductPage (ports, pipeline, elements, health, costs, access, links, history)
 *   /data-products/discovery[/:id]                 DataDiscoveryPage, DataDiscoverySourcePage
 *   /data-products/lineage/:id                     DataLineageSourcePage (0.24.0: lineage from tools, ./lineage)
 *   /data-elements[?filters], /data-elements/:id[/:tab]   DataElementsPage, DataElementPage (lineage, checks)
 *   /data-objects, /data-objects/:id[/links]       DataObjectsPage, DataObjectPage
 *   /data-domains                                  DataDomainsPage
 *   /data-products/access-requests                 DataAccessRequestsPage (0.24.0)
 *   /data-products/records-of-processing           DataRecordsOfProcessingPage (0.24.0, GDPR Art. 30)
 *
 * The pictures (map, pipeline, lineage) are WP6's: ./views.
 */
export { DataProductsPage } from './ProductsPage';
export { DataProductPage } from './ProductPage';
export { DataElementsPage } from './ElementsPage';
export { DataElementPage } from './ElementPage';
export { DataObjectsPage, DataObjectPage } from './ObjectsPage';
export { DataDomainsPage } from './DomainsPage';
export { DataDiscoveryPage, DataDiscoverySourcePage } from './DiscoveryPage';
export { LineageSourcePage as DataLineageSourcePage } from './lineage/LineageSources';
export { AccessRequestsPage as DataAccessRequestsPage } from './governance/AccessRequests';
export { RecordsOfProcessingPage as DataRecordsOfProcessingPage } from './governance/RecordsOfProcessingPage';
