/**
 * The pages of the data products module (ADR 0036 part 13, WP5), loaded on demand from App.tsx:
 *
 *   /data-products[?filters]                       DataProductsPage
 *   /data-products/:id[/:tab]                      DataProductPage (ports, pipeline, elements, health, costs, access, links, history)
 *   /data-products/discovery[/:id]                 DataDiscoveryPage, DataDiscoverySourcePage
 *   /data-elements[?filters], /data-elements/:id[/:tab]   DataElementsPage, DataElementPage (lineage, checks)
 *   /data-objects, /data-objects/:id[/links]       DataObjectsPage, DataObjectPage
 *   /data-domains                                  DataDomainsPage
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
