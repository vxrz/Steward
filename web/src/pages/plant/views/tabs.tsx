import { lazy, Suspense, type ReactNode } from 'react';
import { Anchor, Badge, Group, Text } from '@mantine/core';
import { Link, Navigate } from 'react-router-dom';
import {
  IconBuilding,
  IconChevronRight,
  IconCloudDataConnection,
  IconDatabaseImport,
  IconFileCheck,
  IconHistory,
  IconInfoCircle,
  IconLock,
  IconRoute,
  IconSitemap,
  type Icon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantAssetDetail, PlantKpiDetail, PlantProfileDetail, PlantSiteDetail } from '@sm/shared';
import { DetailHeader } from '../../../components/page/DetailPage';
import { LinkTabs } from '../../../components/page/LinkTabs';
import { AssetStatusBadge, NotInSourceBadge, PreviewBadge, useNameOf } from '../../../components/plant/common';
import { EntryHistory } from '../../../components/plant/changes/EntryHistory';
import { AccessTab } from '../../../components/access/AccessTab';

/**
 * The tabs of a site and an asset (#230): the overview (the page as before) and the pictures of what the registry
 * documents. A tab is an address (/plant/sites/:id/structure, /plant/assets/:id/flow). Further tabs (the OT network,
 * #220) are added to these lists.
 */

const SiteStructureView = lazy(() => import('./SiteStructureView').then((m) => ({ default: m.SiteStructureView })));
const AssetFlowView = lazy(() => import('./AssetFlowView').then((m) => ({ default: m.AssetFlowView })));
const SiteDocumentationView = lazy(() => import('./SiteDocumentationView').then((m) => ({ default: m.SiteDocumentationView })));
const AssetCollectionsView = lazy(() => import('../AssetCollections').then((m) => ({ default: m.AssetCollectionsView })));
const SiteIhCoverageView = lazy(() => import('./SiteIhCoverageView').then((m) => ({ default: m.SiteIhCoverageView })));

// 0.13.0: the history of the entry and what belongs to it (ADR 0020 §4); 0.14: the documentation health and the
// Insights Hub sinks of its collections – mapped, verified, watched
export const SITE_TABS = ['', 'structure', 'documentation', 'insights-hub', 'history'] as const;
export type SiteTab = (typeof SITE_TABS)[number];
const SITE_TAB_ICONS: Record<SiteTab, Icon> = {
  '': IconInfoCircle,
  structure: IconSitemap,
  documentation: IconFileCheck,
  'insights-hub': IconCloudDataConnection,
  history: IconHistory,
};

export const ASSET_TABS = ['', 'flow', 'collections', 'history'] as const;
export type AssetTab = (typeof ASSET_TABS)[number];
const ASSET_TAB_ICONS: Record<AssetTab, Icon> = { '': IconInfoCircle, flow: IconRoute, collections: IconDatabaseImport, history: IconHistory };

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
        description={site.description || undefined}
        status={
          <>
            {site.code && <Badge variant="default">{site.code}</Badge>}
            {site.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        tabs={<SiteTabs site={site} active={known} />}
      />
      <Suspense fallback={<Loading />}>
        {known === 'structure' && <SiteStructureView siteId={site.id} />}
        {known === 'documentation' && <SiteDocumentationView siteId={site.id} />}
        {known === 'insights-hub' && <SiteIhCoverageView siteId={site.id} />}
        {known === 'history' && <EntryHistory kind="site" id={site.id} children />}
      </Suspense>
    </>
  );
}

/** A tab of an asset other than the overview. */
export function PlantAssetTabPage({ asset, tab }: { asset: PlantAssetDetail; tab: string }) {
  const { t } = useTranslation(['plantViews', 'plant']);
  const nameOf = useNameOf();
  const known = ASSET_TABS.find((x) => x === tab);
  if (!known) return <Navigate to={assetBase(asset.id)} replace />;
  // the same way to the asset's place as on its overview, so the header stays as it is when the tab changes
  const loc = asset.location;
  const crumbs = [
    { to: siteBase(loc.site.id), label: nameOf(loc.site) },
    ...[loc.area, loc.workCenter, loc.workUnit]
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((n) => ({ to: `/plant/assets?site=${encodeURIComponent(loc.site.id)}&node=${encodeURIComponent(n.id)}`, label: nameOf(n) })),
  ];
  const where: ReactNode = (
    <nav aria-label={t('plant:asset.location')}>
      <Group gap={4} wrap="wrap">
        {crumbs.map((c, i) => (
          <Group key={c.to} gap={4} wrap="nowrap">
            {i > 0 && <IconChevronRight size={12} aria-hidden />}
            <Anchor component={Link} to={c.to} size="sm">
              {c.label}
            </Anchor>
          </Group>
        ))}
        {loc.building && (
          <Group gap={4} wrap="nowrap" ml="xs">
            <IconBuilding size={14} aria-hidden />
            <Text size="sm">{nameOf(loc.building)}</Text>
          </Group>
        )}
      </Group>
    </nav>
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
      <Suspense fallback={<Loading />}>
        {known === 'flow' && <AssetFlowView assetId={asset.id} assetName={asset.name} canManage={asset.canManage} />}
        {known === 'collections' && <AssetCollectionsView assetId={asset.id} />}
        {known === 'history' && <EntryHistory kind="asset" id={asset.id} children />}
      </Suspense>
    </>
  );
}

// ---------- device profiles and KPI definitions (0.13.0): the page and its history; 0.21.0: its access ----------

export const CATALOGUE_TABS = ['', 'history', 'access'] as const;
export type CatalogueTab = (typeof CATALOGUE_TABS)[number];
const CATALOGUE_TAB_ICONS: Record<CatalogueTab, Icon> = { '': IconInfoCircle, history: IconHistory, access: IconLock };
type CatalogueKind = 'profile' | 'kpi';
const catalogueBase = (kind: CatalogueKind, id: string) => `/plant/${kind === 'profile' ? 'profiles' : 'kpis'}/${encodeURIComponent(id)}`;

export function CatalogueTabs({ kind, entry, active }: { kind: CatalogueKind; entry: { id: string; name: string }; active: CatalogueTab }) {
  const { t } = useTranslation('plantViews');
  const base = catalogueBase(kind, entry.id);
  return (
    <LinkTabs
      label={t(kind === 'profile' ? 'tabs.profileLabel' : 'tabs.kpiLabel', { name: entry.name })}
      active={active ? `${base}/${active}` : base}
      tabs={CATALOGUE_TABS.map((x) => ({
        to: x ? `${base}/${x}` : base,
        label: t(`tabs.${kind}.${x || 'overview'}`),
        icon: CATALOGUE_TAB_ICONS[x],
        testId: `${kind}-tab-${x || 'overview'}`,
      }))}
    />
  );
}

/** A tab of a device profile or KPI definition other than its page: the same header, the tab's view. */
export function CatalogueTabPage({ kind, entry, tab }: { kind: CatalogueKind; entry: PlantProfileDetail | PlantKpiDetail; tab: string }) {
  const nameOf = useNameOf();
  const known = CATALOGUE_TABS.find((x) => x === tab);
  const base = catalogueBase(kind, entry.id);
  if (!known) return <Navigate to={base} replace />;
  const title = kind === 'kpi' ? nameOf(entry as PlantKpiDetail) : entry.name;
  return (
    <>
      <DetailHeader
        recent={{ label: title, kind, to: base }}
        back={kind === 'profile' ? 'plantProfiles' : 'plantKpis'}
        title={title}
        status={
          <>
            {entry.category && <Badge variant="default">{entry.category}</Badge>}
            {entry.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        tabs={<CatalogueTabs kind={kind} entry={{ id: entry.id, name: title }} active={known} />}
      />
      {known === 'history' && <EntryHistory kind={kind} id={entry.id} />}
      {/* 0.21.0 (ADR 0033): owning teams, Restricted and who it is shared with – View, Edit, Manage and proposing */}
      {known === 'access' && <AccessTab kind={kind === 'profile' ? 'device_profile' : 'kpi_definition'} id={entry.id} />}
    </>
  );
}
