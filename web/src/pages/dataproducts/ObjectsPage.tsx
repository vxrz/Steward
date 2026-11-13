import { useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, List, Paper, Select, SimpleGrid, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconCategory, IconInfoCircle, IconLink, IconPencil, IconPlus, IconShieldHalf, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_CLASSIFICATIONS,
  DATA_OBJECT_LIFECYCLES,
  PERSONAL_DATA_CATEGORIES,
  PERSONAL_DATA_LEVELS,
  DATA_SUBJECT_SUGGESTIONS,
  type DataObject,
  type DataObjectSummary,
} from '@sm/shared';
import { del, notifyError } from '../../api';
import { DetailState, Markdown, QueryState, useCreateParam } from '../../components/common';
import { DataTable, ListFooter } from '../../components/DataTable';
import { ListPage } from '../../components/page/ListPage';
import { DetailPage } from '../../components/page/DetailPage';
import { LinkTabs } from '../../components/page/LinkTabs';
import { confirmDanger } from '../../components/confirm';
import { OwningTeams } from '../../components/OwningTeams';
import { useSubjectLabel } from '../../components/SubjectsInput';
import { ObjectForm } from '../../components/dataproducts/ObjectForm';
import { RatingForm, domainOptions } from '../../components/dataproducts/ProductForm';
import { fmtDate, fmtRelative } from '../../format';
import { dpKeys, pagesOf, qs, useDomains, useInvalidateDataProducts, useObject, useObjectElements, useObjectList } from './api';
import { ClassificationBadge, Fact, HiddenCount, LifecycleBadge, PersonalDataBadge, RefLink, Section, useKindLabel } from './parts';
import { LinksTab } from './ProductMisc';
import { RatingBadges, RatingPanelReadOnly } from './rating';
import { MissingBadge } from './ElementsPage';
import { useCanCreate } from './rights';

const enc = encodeURIComponent;
const to = (o: { id: string }) => `/data-objects/${enc(o.id)}`;

/**
 * The data objects (ADR 0036 part 2): what the business data is – Customer, Order –, how sensitive (rating and
 * classification), whether it is personal data and who answers for it. They are the module's business glossary.
 */
export function DataObjectsPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const navigate = useNavigate();
  const canCreate = useCanCreate();
  const invalidate = useInvalidateDataProducts();
  const domains = useDomains();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q] = useDebouncedValue(search.trim(), 300);
  const [creating, setCreating] = useState(false);
  useCreateParam(canCreate, () => setCreating(true));
  const f = {
    domain: params.get('domain') ?? '',
    lifecycle: params.get('lifecycle') ?? '',
    classification: params.get('classification') ?? '',
    personalData: params.get('personalData') ?? '',
  };
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const query = qs({ q, ...f });
  const list = useObjectList(query);
  const rows = pagesOf(list.data);
  const total = list.data?.pages[0]?.total ?? 0;
  const none = list.isSuccess && !query && total === 0;
  const active = Object.values(f).filter(Boolean).length + (q ? 1 : 0);
  return (
    <ListPage
      testId="data-objects"
      title={t('objects.title')}
      description={t('objects.description')}
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="object-new">
            {t('objects.new')}
          </Button>
        )
      }
      search={
        none
          ? undefined
          : {
              value: search,
              onChange: (v) => {
                setSearch(v);
                set('q', v.trim() || null);
              },
              placeholder: t('objects.search'),
            }
      }
      activeFilters={active}
      filters={
        none ? undefined : (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
            <Select size="xs" label={t('products.domain')} data={domainOptions(domains.data)} value={f.domain || null} onChange={(v) => set('domain', v)} clearable searchable w={{ base: '100%', xs: 200 }} />
            <Select
              size="xs"
              label={t('objects.lifecycle')}
              data={DATA_OBJECT_LIFECYCLES.map((x) => ({ value: x, label: t(`lifecycle.${x}`) }))}
              value={f.lifecycle || null}
              onChange={(v) => set('lifecycle', v)}
              clearable
              w={{ base: '100%', xs: 150 }}
            />
            <Select
              size="xs"
              label={t('rating.classification')}
              data={DATA_CLASSIFICATIONS.map((x) => ({ value: x, label: t(`classification.${x}`) }))}
              value={f.classification || null}
              onChange={(v) => set('classification', v)}
              clearable
              w={{ base: '100%', xs: 190 }}
            />
            <Select
              size="xs"
              label={t('objects.personalData')}
              data={PERSONAL_DATA_LEVELS.map((x) => ({ value: x, label: t(`personalData.${x}`) }))}
              value={f.personalData || null}
              onChange={(v) => set('personalData', v)}
              clearable
              w={{ base: '100%', xs: 190 }}
            />
          </Group>
        )
      }
      view={none ? undefined : 'data-objects'}
      empty={{
        show: none,
        icon: IconCategory,
        title: t('objects.emptyTitle'),
        text: t('objects.emptyText'),
        whoCanAct: canCreate ? undefined : t('products.whoCanAct'),
        action: canCreate && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('objects.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={list} />
      {!none && list.isSuccess && rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('objects.noMatch')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          testId="object-table"
          ariaLabel={t('objects.title')}
          rows={rows}
          rowKey={(o) => o.id}
          rowHref={to}
          card={(o: DataObjectSummary) => (
            <Paper withBorder p="sm" component="article" aria-labelledby={`object-${o.id}`}>
              <Stack gap={6}>
                <Anchor id={`object-${o.id}`} component={Link} to={to(o)} fw={600}>
                  {o.name}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {[o.domain?.hidden ? t('hidden.domain') : o.domain?.name, o.key].filter(Boolean).join(' · ')}
                </Text>
                <Group gap={6}>
                  <LifecycleBadge lifecycle={o.lifecycle} size="xs" />
                  <ClassificationBadge value={o.classification} size="xs" />
                  <PersonalDataBadge value={o.personalData} size="xs" />
                </Group>
                <RatingBadges rating={o.rating} />
              </Stack>
            </Paper>
          )}
          columns={[
            {
              key: 'name',
              header: t('products.name'),
              sortValue: (o) => o.name,
              cell: (o) => (
                <>
                  <Anchor component={Link} to={to(o)} size="sm" fw={500} onClick={(e) => e.stopPropagation()}>
                    {o.name}
                  </Anchor>
                  <Text size="xs" c="dimmed" className="mono">
                    {o.key}
                  </Text>
                </>
              ),
            },
            { key: 'domain', header: t('products.domain'), sortValue: (o) => o.domain?.name ?? '', cell: (o) => (o.domain?.hidden ? t('hidden.domain') : (o.domain?.name ?? '–')) },
            { key: 'lifecycle', header: t('objects.lifecycle'), nowrap: true, cell: (o) => <LifecycleBadge lifecycle={o.lifecycle} size="xs" /> },
            { key: 'classification', header: t('rating.classification'), nowrap: true, sortValue: (o) => (o.classification ? DATA_CLASSIFICATIONS.indexOf(o.classification) : null), cell: (o) => (o.classification ? <ClassificationBadge value={o.classification} size="xs" /> : '–') },
            { key: 'personal', header: t('objects.personalData'), nowrap: true, cell: (o) => (o.personalData === 'none' ? t('personalData.none') : <PersonalDataBadge value={o.personalData} size="xs" />) },
            { key: 'rating', header: t('products.rating'), cell: (o) => <RatingBadges rating={o.rating} /> },
            { key: 'owner', header: t('objects.owner'), cell: (o) => o.owner ?? '–' },
            { key: 'updated', header: t('products.updated'), sortValue: (o) => o.updatedAt, nowrap: true, cell: (o) => fmtRelative(o.updatedAt) },
          ]}
          footer={<ListFooter shown={rows.length} total={total} hasMore={!!list.hasNextPage} onLoadMore={() => void list.fetchNextPage()} loading={list.isFetchingNextPage} />}
        />
      )}
      {creating && (
        <ObjectForm
          domains={domains.data}
          onClose={() => setCreating(false)}
          onSaved={(o) => {
            invalidate();
            setCreating(false);
            navigate(to(o));
          }}
        />
      )}
    </ListPage>
  );
}

const TABS = ['', 'links'] as const;

/** A data object: definition, rating, classification, personal data, roles, implementing elements and exposing products. */
export function DataObjectPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const { id = '', tab: tabParam = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const domains = useDomains();
  const q = useObject(id);
  const [editing, setEditing] = useState<'object' | 'rating' | null>(null);
  const subject = useSubjectLabel();
  const tab = TABS.find((x) => x === tabParam);
  if (tab === undefined) return <Navigate to={to({ id })} replace />;
  const o = q.data;
  if (!o) return <DetailState query={q} back={{ to: '/data-objects', label: t('objects.title') }} />;
  const base = to(o);
  const canEdit = o.permissions.includes('edit');
  const canManage = o.permissions.includes('manage');
  const saved = (x: unknown) => {
    qc.setQueryData(dpKeys.object(o.id), x as DataObject);
    invalidate();
    setEditing(null);
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('objects.deleteConfirm', { name: o.name }) }))) return;
    try {
      await del(base);
      invalidate();
      navigate('/data-objects');
    } catch (e) {
      notifyError(e);
    }
  };
  const categories = (vs: string[]) =>
    vs.map((v) => ((PERSONAL_DATA_CATEGORIES as readonly string[]).includes(v) ? t(`objects.categoryNames.${v as 'contact'}`) : v)).join(', ') || '–';
  const subjects = (vs: string[]) =>
    vs.map((v) => ((DATA_SUBJECT_SUGGESTIONS as readonly string[]).includes(v) ? t(`objects.subjectNames.${v as 'customers'}`) : v)).join(', ') || '–';
  return (
    <DetailPage
      back={{ to: '/data-objects', label: t('objects.title') }}
      title={o.name}
      status={
        <>
          <LifecycleBadge lifecycle={o.lifecycle} />
          <ClassificationBadge value={o.classification} />
          <PersonalDataBadge value={o.personalData} />
        </>
      }
      description={[o.domain ? (o.domain.hidden ? t('hidden.domain') : o.domain.name) : null, o.key, o.owner && t('objects.ownerLine', { owner: subject(`user:${o.owner}`) })].filter(Boolean).join(' · ')}
      actions={
        canEdit && (
          <Button size="xs" leftSection={<IconPencil size={14} />} onClick={() => setEditing('object')} data-testid="object-edit">
            {t('common:edit')}
          </Button>
        )
      }
      menu={{
        items: [
          { label: t('objects.rate'), icon: IconShieldHalf, onClick: () => setEditing('rating'), disabled: !canEdit, testId: 'object-rate' },
          ...(canManage ? [{ label: t('common:delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'object-delete' }] : []),
        ],
      }}
      tabs={
        <LinkTabs
          label={t('objects.tabs.label')}
          active={tab ? `${base}/${tab}` : base}
          tabs={TABS.map((x) => ({ to: x ? `${base}/${x}` : base, label: t(`objects.tabs.${x || 'overview'}`), icon: x ? IconLink : IconInfoCircle }))}
        />
      }
    >
      {tab === 'links' && <LinksTab kind="data-object" id={o.id} />}
      {tab === '' && (
        <Grid gap="md">
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Stack gap="md">
              <Section title={t('objects.definition')}>
                {o.definition ? <Markdown text={o.definition} /> : <Text size="sm" c="dimmed">{t('objects.noDefinition')}</Text>}
                {o.synonyms.length > 0 && (
                  <Text size="sm" mt="xs">
                    {t('objects.synonymsLine', { list: o.synonyms.join(', ') })}
                  </Text>
                )}
              </Section>
              <Section title={t('objects.personalData')} testId="object-personal">
                <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
                  <Fact label={t('objects.personalData')}>{t(`personalData.${o.personalData}`)}</Fact>
                  {o.personalData !== 'none' && <Fact label={t('objects.categories')}>{categories(o.categories)}</Fact>}
                  {o.personalData === 'special' && <Fact label={t('objects.special')}>{o.specialCategories.map((k) => t(`objects.specialNames.${k}`)).join(', ') || '–'}</Fact>}
                  {o.personalData !== 'none' && <Fact label={t('objects.subjects')}>{subjects(o.subjects)}</Fact>}
                  {o.personalData !== 'none' && (
                    <Fact label={t('objects.legalBasis')}>
                      {o.legalBasis ? t(`objects.legalBases.${o.legalBasis}`) : '–'}
                      {o.legalNote && ` – ${o.legalNote}`}
                    </Fact>
                  )}
                  <Fact label={t('objects.purposes')}>{o.purposes.join(', ') || '–'}</Fact>
                  <Fact label={t('objects.retention')}>{o.retention || '–'}</Fact>
                  <Fact label={t('objects.deletionRule')}>{o.deletionRule || '–'}</Fact>
                  <Fact label={t('objects.flags')}>
                    {o.regulatoryFlags.length ? (
                      <Group gap={4}>
                        {o.regulatoryFlags.map((x) => (
                          <Badge key={x} size="sm" variant="outline" tt="none">
                            {x}
                          </Badge>
                        ))}
                      </Group>
                    ) : (
                      '–'
                    )}
                  </Fact>
                </SimpleGrid>
              </Section>
              {o.attributes.length > 0 && (
                <Section title={t('objects.attributes')}>
                  <List size="sm" spacing={2}>
                    {o.attributes.map((a) => (
                      <List.Item key={a.name}>
                        <Text span fw={500} size="sm">
                          {a.name}
                        </Text>
                        {a.personal && (
                          <Badge size="xs" ml={6} color="yellow" variant="light" tt="none">
                            {t('objects.attributePersonal')}
                          </Badge>
                        )}
                        {a.description && ` – ${a.description}`}
                      </List.Item>
                    ))}
                  </List>
                </Section>
              )}
              <ObjectElements o={o} />
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Stack gap="md">
              <RatingPanelReadOnly rating={o.rating} onRate={canEdit ? () => setEditing('rating') : undefined} />
              <Section title={t('objects.roles')} testId="object-roles">
                <SimpleGrid cols={1} spacing="xs">
                  <Fact label={t('objects.owner')}>{o.owner ? subject(`user:${o.owner}`) : '–'}</Fact>
                  <Fact label={t('objects.stewards')}>{o.stewards.map(subject).join(', ') || '–'}</Fact>
                  <Fact label={t('objects.custodians')}>{o.custodians.map(subject).join(', ') || '–'}</Fact>
                </SimpleGrid>
                <Text size="xs" c="dimmed" mt="xs">
                  {t('objects.rolesHint')}
                </Text>
              </Section>
              <Section title={t('objects.products')} testId="object-products">
                {o.products.items.length || o.products.hidden ? (
                  <Stack gap={4}>
                    {o.products.items.map((r, i) => (
                      <RefLink key={r.id ?? i} r={r} base="/data-products" />
                    ))}
                    <HiddenCount count={o.products.hidden} />
                  </Stack>
                ) : (
                  <Text size="sm" c="dimmed">
                    {t('objects.noProducts')}
                  </Text>
                )}
              </Section>
              {o.externalRefs.length > 0 && (
                <Section title={t('form.externalRefs')}>
                  <List size="sm" spacing={2}>
                    {o.externalRefs.map((r, i) => (
                      <List.Item key={i}>
                        <Anchor href={r.url} target="_blank" rel="noopener noreferrer" size="sm">
                          {r.label || r.url}
                        </Anchor>
                      </List.Item>
                    ))}
                  </List>
                </Section>
              )}
              <OwningTeams kind="data_object" id={o.id} />
              <Text size="xs" c="dimmed">
                {t('history.updated', { user: o.updatedBy, date: fmtDate(o.updatedAt), revision: o.revision })}
              </Text>
            </Stack>
          </Grid.Col>
        </Grid>
      )}
      {editing === 'object' && <ObjectForm object={o} domains={domains.data} onClose={() => setEditing(null)} onSaved={saved} />}
      {editing === 'rating' && <RatingForm title={t('rating.objectTitle', { name: o.name })} url={`${base}/rating`} rating={o.rating} onClose={() => setEditing(null)} onSaved={saved} />}
    </DetailPage>
  );
}

/** The elements that implement a data object (paged; those the reader may not see counted). */
function ObjectElements({ o }: { o: DataObject }) {
  const { t } = useTranslation('dataProducts');
  const kindLabel = useKindLabel();
  const q = useObjectElements(o.id);
  const rows = pagesOf(q.data);
  const hidden = q.data?.pages[0]?.hidden ?? o.elements.hidden;
  return (
    <Section title={t('objects.elements')} testId="object-elements">
      {rows.length ? (
        <Stack gap={4}>
          {rows.map((e) => (
            <Group key={e.id} gap="xs" wrap="wrap">
              <Anchor component={Link} to={`/data-elements/${enc(e.id)}`} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {e.qualifiedName}
              </Anchor>
              <Text size="xs" c="dimmed">
                {[kindLabel(e.kind), e.environment].filter(Boolean).join(' · ')}
              </Text>
              <MissingBadge since={e.missingSince} />
            </Group>
          ))}
          {q.hasNextPage && (
            <Button size="compact-xs" variant="subtle" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
              {t('table.more')}
            </Button>
          )}
        </Stack>
      ) : (
        q.isSuccess && (
          <Text size="sm" c="dimmed">
            {t('objects.noElements')}
          </Text>
        )
      )}
      <HiddenCount count={hidden} />
      <Text size="xs" c="dimmed" mt="xs">
        {t('objects.elementsHint')}
      </Text>
    </Section>
  );
}
