import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../../components/common';
import { ElementLineageView } from './ElementLineageView';
import { PipelineView } from './PipelineView';
import { ProductMapView } from './ProductMapView';
import { useLineageView, usePipelineView } from './queries';

/**
 * The pictures of the data products module as pages of their own (ADR 0036 part 13, WP6) – the product pages (WP5)
 * show the same views in their tabs and link here for a picture on the whole screen:
 *
 *   /data-products/map                       the product map
 *   /data-products/:id/views/pipeline        a product's pipeline
 *   /data-elements/:id/views/lineage         an element's lineage
 */

const productsCrumb = (label: string) => ({ to: '/data-products', label });

export function DataProductMapPage() {
  const { t } = useTranslation('dataProductViews');
  return (
    <>
      <PageHeader title={t('map.title')} description={t('map.help')} back={productsCrumb(t('nav.products'))} />
      <ProductMapView />
    </>
  );
}

export function DataPipelinePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('dataProductViews');
  const [params] = useSearchParams();
  // the same request as the view's: the header names the product once it is there
  const q = usePipelineView(id, params.get('environment'));
  const name = q.data?.product.name;
  return (
    <>
      <PageHeader
        title={name ? t('pipeline.title', { name }) : t('pipeline.titlePlain')}
        description={t('pipeline.help')}
        back={[productsCrumb(t('nav.products')), ...(name ? [{ to: `/data-products/${encodeURIComponent(id)}`, label: name }] : [])]}
      />
      <PipelineView productId={id} />
    </>
  );
}

export function DataLineagePage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('dataProductViews');
  const [params] = useSearchParams();
  const raw = Number(params.get('depth'));
  const q = useLineageView(id, Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 2);
  const name = q.data?.element.name;
  return (
    <>
      <PageHeader
        title={name ? t('lineage.title', { name }) : t('lineage.titlePlain')}
        description={t('lineage.help')}
        back={[{ to: '/data-elements', label: t('nav.elements') }, ...(name ? [{ to: `/data-elements/${encodeURIComponent(id)}`, label: name }] : [])]}
      />
      <ElementLineageView elementId={id} />
    </>
  );
}
