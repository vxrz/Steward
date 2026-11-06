import { lazy, Suspense, type ReactNode } from 'react';
import { Anchor, Badge, Group, Text } from '@mantine/core';
import { Link, Navigate } from 'react-router-dom';
import { IconInfoCircle, IconRoute, IconSitemap, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantAssetDetail, PlantSiteDetail } from '@sm/shared';
import { DetailHeader } from '../../../components/page/DetailPage';
import { LinkTabs } from '../../../components/page/LinkTabs';
import { AssetStatusBadge, NotInSourceBadge, PreviewBadge, useNameOf } from '../../../components/plant/common';

/**
 * The tabs of a site and an asset (#230): the overview (the page as before) and the pictures of what the registry
 * documents. A tab is an address (/plant/sites/:id/structure, /plant/assets/:id/flow). Further tabs (the OT network,
 * #220) are added to these lists.
 */

const SiteStructureView = lazy(() => import('./SiteStructureView').then((m) => ({ default: m.SiteStructureView })));
const AssetFlowView = lazy(() => import('./AssetFlowView').then((m) => ({ default: m.AssetFlowView })));

export const SITE_TABS = ['', 'structure'] as const;
export type SiteTab = (typeof SITE_TABS)[number];
const SITE_TAB_ICONS: Record<SiteTab, Icon> = { '': IconInfoCircle, structure: IconSitemap };

export const ASSET_TABS = ['', 'flow'] as const;
export type AssetTab = (typeof ASSET_TABS)[number];
const ASSET_TAB_ICONS: Record<AssetTab, Icon> = { '': IconInfoCircle, flow: IconRoute };

const siteBase = (id: string) => `/plant/sites/${encodeURIComponent(id)}`;
const assetBase = (id: string) => `/plant/assets/${encodeURIComponent(id)}`;

export function SiteTabs({ site, active }: { site: Pick<PlantSiteDetail, 'id' | 'name' | 'names'>; active: SiteTab }) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  const base = siteBase(site.id);
  return (
    <LinkTabs
      label={t('tabs.siteLabel', { name: nameOf(site) })}
      active={active ? `${base}/${active}` : base}
      tabs={SITE_TABS.map((x) => ({
        to: x ? `${base}/${x}` : base,
        label: t(`tabs.site.${x || 'overview'}`),
        icon: SITE_TAB_ICONS[x],
        testId: `site-tab-${x || 'overview'}`,
      }))}
    />
  );
}

export function AssetTabs({ asset, active }: { asset: Pick<PlantAssetDetail, 'id' | 'name'>; active: AssetTab }) {
  const { t } = useTranslation('plantViews');
  const base = assetBase(asset.id);
  return (
    <LinkTabs
      label={t('tabs.assetLabel', { name: asset.name })}
      active={active ? `${base}/${active}` : base}
      tabs={ASSET_TABS.map((x) => ({
        to: x ? `${base}/${x}` : base,
        label: t(`tabs.asset.${x || 'overview'}`),
        icon: ASSET_TAB_ICONS[x],
        testId: `asset-tab-${x || 'overview'}`,
      }))}
    />
  );
}

function Loading() {
  const { t } = useTranslation('common');
  return (
    <Text size="sm" c="dimmed">
      {t('loading')}
    </Text>
  );
}

/** A tab of a site other than the overview: the same header, the tab's view. */
export function PlantSiteTabPage({ site, tab }: { site: PlantSiteDetail; tab: string }) {
  const nameOf = useNameOf();
  const known = SITE_TABS.find((x) => x === tab);
  if (!known) return <Navigate to={siteBase(site.id)} replace />;
  return (
    <>
      <DetailHeader
        recent={{ label: nameOf(site), kind: 'site', to: siteBase(site.id) }}
        back="plantSites"
        title={nameOf(site)}
        status={
          <>
            {site.code && <Badge variant="default">{site.code}</Badge>}
            {site.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        tabs={<SiteTabs site={site} active={known} />}
      />
      <Suspense fallback={<Loading />}>{known === 'structure' && <SiteStructureView siteId={site.id} />}</Suspense>
    </>
  );
}

/** A tab of an asset other than the overview. */
export function PlantAssetTabPage({ asset, tab }: { asset: PlantAssetDetail; tab: string }) {
  const { t } = useTranslation('plantViews');
  const nameOf = useNameOf();
  const known = ASSET_TABS.find((x) => x === tab);
  if (!known) return <Navigate to={assetBase(asset.id)} replace />;
  const site = asset.location.site;
  const where: ReactNode = (
    <Group gap={4} wrap="wrap" component="span">
      <Text span size="sm">
        {t('tabs.in')}
      </Text>
      <Anchor component={Link} to={siteBase(site.id)} size="sm">
        {nameOf(site)}
      </Anchor>
    </Group>
  );
  return (
    <>
      <DetailHeader
        recent={{ label: asset.name, kind: 'asset', to: assetBase(asset.id) }}
        back="plantAssets"
        title={asset.name}
        status={
          <>
            <AssetStatusBadge status={asset.status} size="md" />
            {asset.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        description={where}
        tabs={<AssetTabs asset={asset} active={known} />}
      />
      <Suspense fallback={<Loading />}>{known === 'flow' && <AssetFlowView assetId={asset.id} assetName={asset.name} canManage={asset.canManage} />}</Suspense>
    </>
  );
}
