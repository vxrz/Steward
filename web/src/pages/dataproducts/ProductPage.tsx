import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Grid, Group, List, Select, SimpleGrid, Stack, Table, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  IconArrowsExchange,
  IconBinaryTree,
  IconCoins,
  IconHeartbeat,
  IconHistory,
  IconInfoCircle,
  IconLink,
  IconLock,
  IconPencil,
  IconPlugConnected,
  IconRoute,
  IconShieldHalf,
  IconTable,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_ENVIRONMENT_STATES, type DataEnvironmentState, type DataProduct } from '@sm/shared';
import { del, notifyError, put } from '../../api';
import { DetailState, Markdown } from '../../components/common';
import { DetailPage } from '../../components/page/DetailPage';
import { LinkTabs } from '../../components/page/LinkTabs';
import { confirmDanger } from '../../components/confirm';
import { RatingBadges } from '../../components/catalogue/cia';
import { EnvironmentBadge, useEnvironmentList } from '../../components/catalogue/environments';
import { TableScroll } from '../../components/TableScroll';
import { useSubjectLabel } from '../../components/SubjectsInput';
import { LifecycleForm, ProductForm, RatingForm } from '../../components/dataproducts/ProductForm';
import { ProductTransferItems } from '../../components/dataproducts/Transfer';
import { fmtDay, fmtNumber } from '../../format';
import { HealthBadge } from './views';
import { dpKeys, pagesOf, useDomains, useInvalidateDataProducts, useProduct, useProductHealth, useProductList, useScorecard } from './api';
import { ClassificationBadge, Fact, LifecycleBadge, RatingFloorNote, RefLink, Section, TypeBadge, useSortedEnvironments } from './parts';
import { ProductPortsTab } from './ProductPorts';
import { ProductPipelineTab } from './ProductPipeline';
import { ProductElementsTab } from './ProductElements';
import { ProductHealthTab } from './ProductHealth';
import { ProductCostsTab, ScorecardPanel, ValueAndCosts } from './ProductCosts';
import { ProductAccessTab, ProductHistoryTab, LinksTab } from './ProductMisc';

const TABS = ['', 'ports', 'pipeline', 'elements', 'health', 'costs', 'access', 'links', 'history'] as const;
type Tab = (typeof TABS)[number];
const TAB_ICONS = {
  '': IconInfoCircle,
  ports: IconPlugConnected,
  pipeline: IconRoute,
  elements: IconTable,
  health: IconHeartbeat,
  costs: IconCoins,
  access: IconLock,
  links: IconLink,
  history: IconHistory,
} as const;

/**
 * A data product (ADR 0036 part 13): the header – name, domain, type, lifecycle, health per environment, owners – and
 * the tabs Overview, Ports, Pipeline, Elements, Health, Costs, Access, Links and History, each an address of its own.
 */
export function DataProductPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const { id = '', tab: tabParam = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const q = useProduct(id);
  const health = useProductHealth(id);
  const scorecard = useScorecard(id, '');
  const domains = useDomains();
  const [editing, setEditing] = useState<'product' | 'lifecycle' | 'rating' | null>(null);
  const subject = useSubjectLabel();
  // the successor of a deprecated product: the other products the reader may see (first page)
  const others = useProductList('limit=100', editing === 'lifecycle');
  const tab = TABS.find((x) => x === tabParam);
  if (tab === undefined) return <Navigate to={`/data-products/${encodeURIComponent(id)}`} replace />;
  const p = q.data;
  if (!p) return <DetailState query={q} back={{ to: '/data-products', label: t('products.title') }} />;
  const base = `/data-products/${encodeURIComponent(p.id)}`;
  const canEdit = p.permissions.includes('edit');
  const canManage = p.permissions.includes('manage');
  const saved = (x: unknown) => {
    qc.setQueryData(dpKeys.product(p.id), x as DataProduct);
    invalidate();
    setEditing(null);
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('product.deleteConfirm', { name: p.name }) }))) return;
    try {
      await del(base);
      invalidate();
      navigate('/data-products');
    } catch (e) {
      notifyError(e);
    }
  };
  const tabs = TABS.map((x: Tab) => ({
    to: x ? `${base}/${x}` : base,
    label: t(`product.tabs.${x || 'overview'}`),
    icon: TAB_ICONS[x],
    count: x === 'ports' ? p.ports.length : x === 'elements' ? p.memberCounts.input + p.memberCounts.internal + p.memberCounts.output : undefined,
    testId: `product-tab-${x || 'overview'}`,
  }));
  const domainLabel = p.domain ? (p.domain.hidden ? t('hidden.domain') : p.domain.name) : null;
  return (
    <DetailPage
      back={{ to: '/data-products', label: t('products.title') }}
      title={p.name}
      status={
        <>
          <LifecycleBadge lifecycle={p.lifecycle} sunsetDate={p.sunsetDate} />
          <TypeBadge type={p.type} />
          {scorecard.data && (
            <Badge variant="outline" color="gray" tt="none" data-testid="product-maturity-badge">
              {t('scorecard.maturityShort', { level: scorecard.data.maturity })}
            </Badge>
          )}
          {(health.data ?? []).map((h) => (
            <Group key={h.environment || 'none'} gap={4} wrap="nowrap" component="span" data-testid={`product-health-${h.environment}`}>
              {health.data!.length > 1 && (
                <Text span size="xs" c="dimmed">
                  {h.environment}
                </Text>
              )}
              <HealthBadge status={h.status} />
            </Group>
          ))}
        </>
      }
      description={
        <>
          {[domainLabel, p.key, p.version && t('product.versionLabel', { version: p.version })].filter(Boolean).join(' · ')}
          {p.owners.length > 0 && ` · ${t('product.ownersLine', { owners: p.owners.map(subject).join(', ') })}`}
          {p.lifecycle === 'deprecated' && p.sunsetDate && ` · ${t('product.sunsetLine', { date: fmtDay(p.sunsetDate) })}`}
        </>
      }
      actions={
        canEdit && (
          <>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconArrowsExchange size={14} />}
              onClick={() => setEditing('lifecycle')}
              data-testid="product-lifecycle"
            >
              {t('product.changeLifecycle')}
            </Button>
            <Button size="xs" leftSection={<IconPencil size={14} />} onClick={() => setEditing('product')} data-testid="product-edit">
              {t('common:edit')}
            </Button>
          </>
        )
      }
      menu={{
        items: [
          { label: t('product.rate'), icon: IconShieldHalf, onClick: () => setEditing('rating'), disabled: !canEdit, testId: 'product-rate' },
          { label: t('product.pipelinePage'), icon: IconBinaryTree, to: `${base}/views/pipeline` },
          ...(canManage ? [{ label: t('common:delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'product-delete' }] : []),
        ],
        extra: <ProductTransferItems id={p.id} />,
      }}
      tabs={<LinkTabs label={t('product.tabs.label')} active={tab ? `${base}/${tab}` : base} tabs={tabs} />}
    >
      {tab === '' && <Overview p={p} onRate={canEdit ? () => setEditing('rating') : undefined} />}
      {tab === 'ports' && <ProductPortsTab p={p} />}
      {tab === 'pipeline' && <ProductPipelineTab p={p} />}
      {tab === 'elements' && <ProductElementsTab p={p} />}
      {tab === 'health' && <ProductHealthTab p={p} />}
      {tab === 'costs' && <ProductCostsTab p={p} />}
      {tab === 'access' && <ProductAccessTab p={p} />}
      {tab === 'links' && <LinksTab kind="data-product" id={p.id} />}
      {tab === 'history' && <ProductHistoryTab p={p} />}
      {editing === 'product' && <ProductForm product={p} domains={domains.data} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing === 'lifecycle' && (
        <LifecycleForm product={p} products={pagesOf(others.data).map((x) => ({ id: x.id, name: x.name }))} onClose={() => setEditing(null)} onSaved={saved} />
      )}
      {editing === 'rating' && (
        <RatingForm
          title={t('rating.productTitle', { name: p.name })}
          target={{ kind: 'product', id: p.id }}
          rating={p.rating}
          classification={p.classification}
          floor={p.ratingFloor}
          reasons={p.ratingReasons}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </DetailPage>
  );
}

function Overview({ p, onRate }: { p: DataProduct; onRate?: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const subject = useSubjectLabel();
  const scorecard = useScorecard(p.id, '');
  const consumers = p.ports
    .filter((x) => x.direction === 'output')
    .reduce((n, x) => ({ registered: n.registered + x.consumers.registered, derived: n.derived + x.consumers.derived }), { registered: 0, derived: 0 });
  const outputs = p.ports.filter((x) => x.direction === 'output');
  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          <RatingFloorNote floor={p.ratingFloor} />
          {p.lifecycle === 'deprecated' && (
            <Text size="sm" c="orange" data-testid="product-deprecated">
              {t('product.deprecatedNote', { date: p.sunsetDate ? fmtDay(p.sunsetDate) : '–' })}{' '}
              {p.successor && <RefLink r={p.successor} base="/data-products" />}
            </Text>
          )}
          <Section title={t('product.about')}>
            <Stack gap="sm">
              {p.description ? (
                <Markdown text={p.description} />
              ) : (
                <Text size="sm" c="dimmed">
                  {t('product.noDescription')}
                </Text>
              )}
              {p.purpose && (
                <div>
                  <Text size="xs" c="dimmed">
                    {t('form.purpose')}
                  </Text>
                  <Markdown text={p.purpose} />
                </div>
              )}
            </Stack>
          </Section>
          <Section title={t('product.dataObjects')} testId="product-objects">
            {p.objects.length ? (
              <Group gap={6}>
                {p.objects.map((o, i) =>
                  o.hidden ? (
                    <Badge key={`h${i}`} variant="outline" color="gray" tt="none">
                      {t('hidden.item')}
                    </Badge>
                  ) : (
                    <Badge key={o.id} variant="light" tt="none" component={Link} to={`/data-objects/${encodeURIComponent(o.id)}`} style={{ cursor: 'pointer' }}>
                      {o.name}
                    </Badge>
                  ),
                )}
              </Group>
            ) : (
              <Text size="sm" c="dimmed">
                {t('product.noObjects')}
              </Text>
            )}
          </Section>
          <ScorecardPanel query={scorecard} />
          <Section title={t('product.consumers')}>
            {outputs.length ? (
              <Stack gap={4}>
                <Text size="sm">{t('product.consumerCounts', { registered: consumers.registered, derived: consumers.derived })}</Text>
                <Anchor component={Link} to={`/data-products/${encodeURIComponent(p.id)}/ports`} size="sm">
                  {t('product.toPorts')}
                </Anchor>
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {t('product.noOutputPorts')}
              </Text>
            )}
          </Section>
          <ValueAndCosts p={p} />
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap="md">
          <Section
            title={t('product.facts')}
            actions={
              onRate && (
                <Button size="xs" variant="default" leftSection={<IconShieldHalf size={14} />} onClick={onRate}>
                  {t('product.rate')}
                </Button>
              )
            }
          >
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
              <Fact label={t('form.domain')}>{p.domain ? <RefLink r={p.domain} base="/data-domains" /> : '–'}</Fact>
              <Fact label={t('form.owners')}>
                {p.owners.length ? (
                  p.owners.map(subject).join(', ')
                ) : (
                  <Text span c="orange" size="sm">
                    {t('product.noOwner')}
                  </Text>
                )}
              </Fact>
              <Fact label={t('product.rating')} testId="product-rating">
                <RatingBadges rating={p.rating} size="sm" />
              </Fact>
              <Fact label={t('rating.classification')}>
                {p.classification ? <ClassificationBadge value={p.classification} /> : '–'}
                {p.ratingFloor.highestClassification && (
                  <Text size="xs" c="dimmed">
                    {t('rating.highestClassification', { value: t(`classification.${p.ratingFloor.highestClassification}`) })}
                  </Text>
                )}
              </Fact>
              <Fact label={t('form.criticality')}>{p.criticality ? t(`criticality.${p.criticality}`) : '–'}</Fact>
              <Fact label={t('form.tier')}>{p.tier ? t('tier', { tier: p.tier }) : '–'}</Fact>
              <Fact label={t('form.support')}>
                {[p.support.channel, p.support.hours].filter(Boolean).join(' · ') || (p.support.url ? '' : '–')}
                {p.support.url && (
                  <Anchor href={p.support.url} target="_blank" rel="noopener noreferrer" size="sm" display="block">
                    {p.support.url}
                  </Anchor>
                )}
              </Fact>
              <Fact label={t('form.version')}>{p.version || '–'}</Fact>
              <Fact label={t('product.members')}>
                {t('product.memberCounts', {
                  input: fmtNumber(p.memberCounts.input),
                  internal: fmtNumber(p.memberCounts.internal),
                  output: fmtNumber(p.memberCounts.output),
                })}
              </Fact>
              <Fact label={t('product.lifecycleDates')}>
                {Object.entries(p.lifecycleDates)
                  .map(([k, d]) => `${t(`lifecycle.${k as 'draft'}`)} ${fmtDay(d)}`)
                  .join(' · ') || '–'}
              </Fact>
            </SimpleGrid>
            {p.tags.length > 0 && (
              <Group gap={4} mt="sm">
                {p.tags.map((x) => (
                  <Badge key={x} variant="outline" color="gray" tt="none" size="sm">
                    {x}
                  </Badge>
                ))}
              </Group>
            )}
            {p.externalRefs.length > 0 && (
              <List size="sm" mt="sm" spacing={2}>
                {p.externalRefs.map((r, i) => (
                  <List.Item key={i}>
                    <Anchor href={r.url} target="_blank" rel="noopener noreferrer" size="sm">
                      {r.label || r.url}
                    </Anchor>
                  </List.Item>
                ))}
              </List>
            )}
          </Section>
          <EnvironmentsSection p={p} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/** The environments a product exists in (production first), their state, and adding one. */
function EnvironmentsSection({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const list = useEnvironmentList();
  const canEdit = p.permissions.includes('edit');
  const [adding, setAdding] = useState<string | null>(null);
  const base = `/data-products/${encodeURIComponent(p.id)}/environments`;
  const rows = useSortedEnvironments(p.environmentDetails.map((e) => e.environment)).map((n) => p.environmentDetails.find((e) => e.environment === n)!);
  const setState = async (env: string, state: DataEnvironmentState) => {
    try {
      qc.setQueryData(dpKeys.product(p.id), await put<DataProduct>(`${base}/${encodeURIComponent(env)}`, { state }));
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (env: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t('environments.removeConfirm', { environment: env }) }))) return;
    try {
      qc.setQueryData(dpKeys.product(p.id), await del<DataProduct>(`${base}/${encodeURIComponent(env)}`));
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const free = list.map((e) => e.name).filter((n) => !p.environmentDetails.some((e) => e.environment === n));
  return (
    <Section title={t('environments.title')} testId="product-environments">
      {rows.length ? (
        <TableScroll>
          <Table fz="sm" aria-label={t('environments.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('environment.label')}</Table.Th>
                <Table.Th scope="col">{t('environments.state')}</Table.Th>
                <Table.Th scope="col">{t('environments.monitor')}</Table.Th>
                {canEdit && (
                  <Table.Th scope="col">
                    <VisuallyHidden>{t('table.actions')}</VisuallyHidden>
                  </Table.Th>
                )}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((e) => (
                <Table.Tr key={e.environment}>
                  <Table.Td>
                    <EnvironmentBadge value={e.environment} size="xs" />
                  </Table.Td>
                  <Table.Td>
                    {canEdit ? (
                      <Select
                        size="xs"
                        aria-label={t('environments.stateOf', { environment: e.environment })}
                        data={DATA_ENVIRONMENT_STATES.map((s) => ({ value: s, label: t(`environments.states.${s}`) }))}
                        value={e.state}
                        onChange={(s) => s && void setState(e.environment, s as DataEnvironmentState)}
                        allowDeselect={false}
                        w={140}
                      />
                    ) : (
                      t(`environments.states.${e.state}`)
                    )}
                  </Table.Td>
                  <Table.Td>
                    {e.monitorId ? (
                      <Anchor component={Link} to={`/monitors/${encodeURIComponent(e.monitorId)}`} size="sm">
                        {t('environments.openMonitor')}
                      </Anchor>
                    ) : (
                      '–'
                    )}
                  </Table.Td>
                  {canEdit && (
                    <Table.Td>
                      <Tooltip label={t('environments.remove')}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('environments.removeNamed', { environment: e.environment })}
                          onClick={() => void remove(e.environment)}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      ) : (
        <Text size="sm" c="dimmed">
          {t('environments.none')}
        </Text>
      )}
      {canEdit && free.length > 0 && (
        <Group gap="xs" mt="sm" align="flex-end">
          <Select size="xs" label={t('environments.add')} data={free} value={adding} onChange={setAdding} clearable w={180} data-testid="environment-add" />
          <Button size="xs" variant="default" disabled={!adding} onClick={() => adding && void setState(adding, 'planned').then(() => setAdding(null))}>
            {t('environments.addButton')}
          </Button>
        </Group>
      )}
    </Section>
  );
}
