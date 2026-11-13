/**
 * The pictures of the data products module (ADR 0036 part 13, WP6) for the pages of WP5: each view reads its own data
 * (one request), keeps its filters in the address and brings its table, legend and export.
 *
 *   <PipelineView productId={id} />          the product's Pipeline tab
 *   <ProductMapView />                       the Map page
 *   <ElementLineageView elementId={id} />    the element's lineage
 *
 * Pages of their own (App.tsx): DataProductMapPage, DataPipelinePage, DataLineagePage.
 */
export { PipelineView } from './PipelineView';
export { ProductMapView } from './ProductMapView';
export { ElementLineageView } from './ElementLineageView';
export { DataLineagePage, DataPipelinePage, DataProductMapPage } from './pages';
export { HealthBadge } from './health';
