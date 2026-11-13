import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Grid, Group, List, Modal, Select, SimpleGrid, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { IconBinaryTree, IconContract, IconHeartbeat, IconInfoCircle, IconLink, IconLinkOff, IconPencil, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_CHECK_PURPOSES,
  type DataCheckPurpose,
  type DataContractDetail,
  type DataContractDraft,
  type DataCostMatch,
  type DataElement,
  type DataElementCheck,
  type DataObjectSummary,
  type DataPage,
  type MonitorDetail,
  type MonitorSummary,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../../api';
import { DetailState } from '../../components/common';
import { DetailPage } from '../../components/page/DetailPage';
import { LinkTabs } from '../../components/page/LinkTabs';
import { confirmDanger } from '../../components/confirm';
import { OwningTeams } from '../../components/OwningTeams';
import { TableScroll } from '../../components/TableScroll';
import { ContractYamlEditor } from '../../components/contracts/parts';
import { ElementForm } from '../../components/dataproducts/CatalogueForms';
import { FormModal } from '../../components/FormModal';
import { FormButtons, useBusy } from '../../components/dataproducts/form';
import { useModuleOn } from '../../modules';
import { errorText } from '../../i18n/errors';
import { fmtBytes, fmtDate, fmtNumber } from '../../format';
import { ElementLineageView, HealthBadge } from './views';
import { dpKeys, useElement, useElementChecks, useElementCostMatches, useInvalidateDataProducts } from './api';
import { CostMatchForm, MatchTable, useMatchText } from './ProductCosts';
import { Fact, HiddenCount, PlatformName, RefLink, RoleBadge, Section, useKindLabel } from './parts';
import { MissingBadge } from './ElementsPage';

const enc = encodeURIComponent;
const TABS = ['', 'lineage', 'checks'] as const;
const TAB_ICONS = { '': IconInfoCircle, lineage: IconBinaryTree, checks: IconHeartbeat } as const;
/** Kinds a contract can be drafted from (Snowflake columns, a Kafka subject, a database snapshot). */
const DRAFTABLE = new Set(['snowflake.table', 'snowflake.view', 'snowflake.dynamicTable', 'kafka.topic', 'sql.table', 'sql.view']);

/**
 * An element of the catalogue (ADR 0036 part 13): its readout, the products it is part of (with its role; those the
 * reader may not see are counted, never named), the data objects it implements, its lineage and the checks that watch
 * it – linked, made by _Create monitor_, or found by their fields and offered to link.
 */
export function DataElementPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const { id = '', tab: tabParam = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const kindLabel = useKindLabel();
  const contractsOn = useModuleOn('dataContracts');
  const q = useElement(id);
  const [editing, setEditing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const tab = TABS.find((x) => x === tabParam);
  if (tab === undefined) return <Navigate to={`/data-elements/${enc(id)}`} replace />;
  const e = q.data;
  if (!e) return <DetailState query={q} back={{ to: '/data-elements', label: t('elements.title') }} />;
  const base = `/data-elements/${enc(e.id)}`;
  const canEdit = e.permissions.includes('edit');
  const canManage = e.permissions.includes('manage');
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('elements.deleteConfirm', { name: e.qualifiedName }) }))) return;
    try {
      await del(base);
      invalidate();
      navigate('/data-elements');
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <DetailPage
      back={{ to: '/data-elements', label: t('elements.title') }}
      title={
        <span className="mono" style={{ overflowWrap: 'anywhere' }}>
          {e.displayName || e.qualifiedName}
        </span>
      }
      status={
        <>
          <Badge variant="light" color="gray" tt="none">
            {e.kind === 'other' && e.typeLabel ? e.typeLabel : kindLabel(e.kind)}
          </Badge>
          <MissingBadge since={e.missingSince} />
        </>
      }
      description={[
        e.qualifiedName,
        e.platformHidden ? t('hidden.platform') : e.platformName,
        e.environment,
        e.layer && t('elements.layerNamed', { layer: e.layer }),
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        <>
          {contractsOn && DRAFTABLE.has(e.kind) && (
            <Button size="xs" variant="default" leftSection={<IconContract size={14} />} onClick={() => setDrafting(true)} data-testid="element-draft-contract">
              {t('elements.draftContract')}
            </Button>
          )}
          {canEdit && (
            <Button size="xs" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="element-edit">
              {t('common:edit')}
            </Button>
          )}
        </>
      }
      menu={{
        items: [
          { label: t('elements.lineagePage'), icon: IconBinaryTree, to: `${base}/views/lineage` },
          ...(canManage ? [{ label: t('common:delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'element-delete' }] : []),
        ],
      }}
      tabs={
        <LinkTabs
          label={t('elements.tabs.label')}
          active={tab ? `${base}/${tab}` : base}
          tabs={TABS.map((x) => ({
            to: x ? `${base}/${x}` : base,
            label: t(`elements.tabs.${x || 'overview'}`),
            icon: TAB_ICONS[x],
            testId: `element-tab-${x || 'overview'}`,
          }))}
        />
      }
    >
      {tab === '' && <ElementOverview e={e} />}
      {tab === 'lineage' && <ElementLineageView elementId={e.id} />}
      {tab === 'checks' && <ElementChecks e={e} />}
      {editing && (
        <ElementForm
          element={e}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            qc.setQueryData(dpKeys.element(e.id), x);
            invalidate();
            setEditing(false);
          }}
        />
      )}
      {drafting && <DraftContract e={e} onClose={() => setDrafting(false)} />}
    </DetailPage>
  );
}

function ElementOverview({ e }: { e: DataElement }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const r = e.readout;
  const flags = Object.entries(e.flags);
  return (
    <Grid gap="md">
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Stack gap="md">
          {e.missingSince && (
            <Alert color="orange" variant="light" data-testid="element-missing-note">
              {t('elements.missingNote', { date: fmtDate(e.missingSince) })}
            </Alert>
          )}
          <Section title={t('elements.partOf')} testId="element-products">
            {e.productRefs.length || e.products.hidden ? (
              <Stack gap={4}>
                {e.productRefs
                  .filter((x) => !x.product.hidden)
                  .map((x) => (
                    <Group key={x.product.id} gap="xs">
                      <RefLink r={x.product} base="/data-products" />
                      <RoleBadge role={x.role} size="xs" />
                    </Group>
                  ))}
                <HiddenCount count={e.products.hidden} />
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {t('elements.inNoProduct')}
              </Text>
            )}
          </Section>
          <ObjectsOfElement e={e} />
          <Section title={t('elements.readout')} testId="element-readout">
            {r ? (
              <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="sm">
                <Fact label={t('elements.readAt')}>{fmtDate(r.readAt)}</Fact>
                {r.rowCount !== undefined && r.rowCount !== null && <Fact label={t('elements.rows')}>{fmtNumber(r.rowCount)}</Fact>}
                {r.bytes !== undefined && r.bytes !== null && <Fact label={t('elements.bytes')}>{fmtBytes(r.bytes)}</Fact>}
                {r.lastAltered && <Fact label={t('elements.lastAltered')}>{fmtDate(r.lastAltered)}</Fact>}
                {r.partitions !== undefined && r.partitions !== null && <Fact label={t('elements.partitions')}>{fmtNumber(r.partitions)}</Fact>}
                {r.retentionMs !== undefined && r.retentionMs !== null && (
                  <Fact label={t('elements.retention')}>{t('elements.retentionDays', { count: Math.round(r.retentionMs / 86_400_000) })}</Fact>
                )}
                {r.schemaVersion !== undefined && r.schemaVersion !== null && <Fact label={t('elements.schemaVersion')}>{fmtNumber(r.schemaVersion)}</Fact>}
              </SimpleGrid>
            ) : (
              <Text size="sm" c="dimmed">
                {e.source === 'discovered' ? t('elements.noReadoutYet') : t('elements.noReadout')}
              </Text>
            )}
          </Section>
        </Stack>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Stack gap="md">
          <Section title={t('elements.facts')}>
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
              <Fact label={t('elements.qualifiedName')}>
                <span className="mono">{e.qualifiedName}</span>
              </Fact>
              <Fact label={t('elements.platform')}>
                {e.platformId && !e.platformHidden ? (
                  <Anchor component={Link} to={`/platforms/${enc(e.platformId)}`} size="sm">
                    {e.platformName}
                  </Anchor>
                ) : (
                  <PlatformName name={e.platformName} hidden={e.platformHidden} />
                )}
              </Fact>
              <Fact label={t('elements.environment')}>{e.environment || '–'}</Fact>
              <Fact label={t('elements.layer')}>{e.layer || '–'}</Fact>
              <Fact label={t('elements.source')}>{t(`elements.sources.${e.source}`)}</Fact>
              <Fact label={t('elements.application')}>
                {e.applicationId ? (
                  <Anchor component={Link} to={`/applications/${enc(e.applicationId)}`} size="sm">
                    {t('elements.openApplication')}
                  </Anchor>
                ) : (
                  '–'
                )}
              </Fact>
              {e.externalId && (
                <Fact label={t('elements.externalId')}>
                  <span className="mono">{e.externalId}</span>
                </Fact>
              )}
              {e.olNamespace && (
                <Fact label={t('elements.openLineage')}>
                  <span className="mono">
                    {e.olNamespace} · {e.olName}
                  </span>
                </Fact>
              )}
              {e.apiRef?.url && (
                <Fact label={t('elements.apiUrl')}>
                  <Anchor href={e.apiRef.url} target="_blank" rel="noopener noreferrer" size="sm">
                    {e.apiRef.url}
                  </Anchor>
                </Fact>
              )}
              {!!e.apiRef?.operations?.length && <Fact label={t('elements.operations')}>{e.apiRef.operations.join(', ')}</Fact>}
              <Fact label={t('elements.updated')}>{t('history.by', { user: e.updatedBy, date: fmtDate(e.updatedAt) })}</Fact>
            </SimpleGrid>
            {e.description && (
              <Text size="sm" mt="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {e.description}
              </Text>
            )}
            {flags.length > 0 && (
              <Group gap={4} mt="sm">
                {flags.map(([k, v]) => (
                  <Badge key={k} size="sm" variant="outline" color="gray" tt="none">
                    {v === true ? k : `${k}: ${String(v)}`}
                  </Badge>
                ))}
              </Group>
            )}
          </Section>
          <ElementCostMatches e={e} />
          <OwningTeams kind="data_element" id={e.id} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}

/** An element's cost matches: the products it is part of inherit them in its environment (ADR 0036 part 11). */
function ElementCostMatches({ e }: { e: DataElement }) {
  const { t } = useTranslation('dataProducts');
  const q = useElementCostMatches(e.id);
  const invalidate = useInvalidateDataProducts();
  const matchText = useMatchText();
  const [adding, setAdding] = useState(false);
  const canEdit = e.permissions.includes('edit');
  const remove = async (m: DataCostMatch) => {
    if (!(await confirmDanger({ action: 'remove', message: t('costs.removeMatchConfirm', { match: matchText(m) }) }))) return;
    try {
      await del(`/data-elements/${enc(e.id)}/cost-matches/${enc(m.id)}`);
      invalidate();
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <Section
      title={t('costs.matches')}
      testId="element-cost-matches"
      actions={
        canEdit && (
          <Button size="xs" variant="default" onClick={() => setAdding(true)}>
            {t('costs.addMatch')}
          </Button>
        )
      }
    >
      <Text size="xs" c="dimmed" mb="xs">
        {t('costs.elementMatchesHelp')}
      </Text>
      {q.data && <MatchTable matches={q.data} onRemove={(m) => void remove(m)} />}
      {adding && (
        <CostMatchForm
          target={{ kind: 'element', id: e.id }}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            invalidate();
          }}
        />
      )}
    </Section>
  );
}

/** The data objects an element implements, and linking one (who may change the data object). */
function ObjectsOfElement({ e }: { e: DataElement }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const invalidate = useInvalidateDataProducts();
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const objects = useQuery({
    queryKey: ['dataProducts', 'objects', 'options'],
    queryFn: () => get<DataPage<DataObjectSummary>>('/data-objects?limit=100'),
    enabled: adding,
  });
  const editable = (objects.data?.items ?? []).filter((o) => o.permissions.includes('edit') && !e.objects.some((x) => x.id === o.id));
  const link = async () => {
    if (!pick) return;
    try {
      await post(`/data-objects/${enc(pick)}/elements`, { elementId: e.id });
      invalidate();
      setAdding(false);
      setPick(null);
    } catch (err) {
      notifyError(err);
    }
  };
  const unlink = async (objectId: string, name: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t('elements.unlinkObjectConfirm', { name }) }))) return;
    try {
      await del(`/data-objects/${enc(objectId)}/elements/${enc(e.id)}`);
      invalidate();
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <Section
      title={t('elements.objects')}
      testId="element-objects"
      actions={
        !adding && (
          <Button size="xs" variant="default" leftSection={<IconLink size={14} />} onClick={() => setAdding(true)}>
            {t('elements.linkObject')}
          </Button>
        )
      }
    >
      {e.objects.length ? (
        <Stack gap={4}>
          {e.objects.map((o, i) =>
            o.hidden ? (
              <Text key={`h${i}`} size="sm" c="dimmed" fs="italic">
                {t('hidden.item')}
              </Text>
            ) : (
              <Group key={o.id} gap="xs">
                <RefLink r={o} base="/data-objects" />
                <Tooltip label={t('elements.unlinkObject')}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    aria-label={t('elements.unlinkObjectNamed', { name: o.name })}
                    onClick={() => void unlink(o.id, o.name)}
                  >
                    <IconLinkOff size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ),
          )}
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          {t('elements.noObjects')}
        </Text>
      )}
      {adding && (
        <Group gap="xs" mt="sm" align="flex-end">
          <Select
            size="xs"
            label={t('elements.object')}
            data={editable.map((o) => ({ value: o.id, label: o.name }))}
            value={pick}
            onChange={setPick}
            searchable
            nothingFoundMessage={t('elements.noEditableObjects')}
            w={240}
          />
          <Button size="xs" onClick={() => void link()} disabled={!pick}>
            {t('elements.link')}
          </Button>
          <Button size="xs" variant="default" onClick={() => setAdding(false)}>
            {t('common:cancel')}
          </Button>
        </Group>
      )}
    </Section>
  );
}

/**
 * The checks that watch an element: their stored status (never read from the platform here), where they come from
 * (made, linked, found), and _Link_ / _Unlink_. A check of a monitor the reader may not see shows its status only.
 */
function ElementChecks({ e }: { e: DataElement }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const q = useElementChecks(e.id);
  const invalidate = useInvalidateDataProducts();
  const [linking, setLinking] = useState(false);
  const c = q.data;
  const link = async (x: DataElementCheck) => {
    if (!x.monitor || !x.check) return;
    try {
      await post(`/data-elements/${enc(e.id)}/checks`, { monitor: x.monitor.id, checkId: x.check.id, purpose: x.purpose });
      invalidate();
      notifyOk(t('checks.linked'));
    } catch (err) {
      notifyError(err);
    }
  };
  const unlink = async (x: DataElementCheck) => {
    if (!x.linkId || !(await confirmDanger({ action: 'remove', message: t('checks.unlinkConfirm') }))) return;
    try {
      await del(`/data-elements/${enc(e.id)}/checks/${enc(x.linkId)}`);
      invalidate();
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <Stack gap="md">
      <Section
        title={t('checks.title')}
        testId="element-checks"
        actions={
          c?.canLink && (
            <Button size="xs" variant="default" leftSection={<IconLink size={14} />} onClick={() => setLinking(true)} data-testid="check-link">
              {t('checks.link')}
            </Button>
          )
        }
      >
        {c && (
          <Group gap="xs" mb="sm">
            <Text size="sm">{t('checks.health')}</Text>
            <HealthBadge status={c.health.status} />
          </Group>
        )}
        {c && !c.checks.length && (
          <Text size="sm" c="dimmed">
            {t('checks.none')}
          </Text>
        )}
        {c && c.checks.length > 0 && (
          <TableScroll>
            <Table fz="sm" aria-label={t('checks.title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('checks.check')}</Table.Th>
                  <Table.Th scope="col">{t('checks.status')}</Table.Th>
                  <Table.Th scope="col">{t('checks.purpose')}</Table.Th>
                  <Table.Th scope="col">{t('checks.origin')}</Table.Th>
                  <Table.Th scope="col">{t('checks.message')}</Table.Th>
                  <Table.Th scope="col">{t('table.actions')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {c.checks.map((x, i) => (
                  <Table.Tr key={x.linkId ?? `found-${i}`} data-testid={x.linkId ? 'check-row' : 'check-found'}>
                    <Table.Td>
                      {x.hidden ? (
                        <Text size="sm" c="dimmed" fs="italic">
                          {t('checks.hidden')}
                        </Text>
                      ) : (
                        <Stack gap={0}>
                          {x.monitor && (
                            <Anchor component={Link} to={`/monitors/${enc(x.monitor.id)}`} size="sm">
                              {x.monitor.name}
                            </Anchor>
                          )}
                          <Text size="xs" c="dimmed">
                            {x.check ? `${x.check.name} · ${x.check.type}` : ''}
                            {x.monitor && !x.monitor.enabled ? ` · ${t('checks.monitorOff')}` : ''}
                          </Text>
                        </Stack>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <HealthBadge status={x.status} size="xs" />
                      {!x.active && (
                        <Text size="xs" c="dimmed">
                          {t('checks.notRunning')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{t(`checks.purposes.${x.purpose}`)}</Table.Td>
                    <Table.Td>{t(`checks.origins.${x.origin}`)}</Table.Td>
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>{x.message ?? '–'}</Table.Td>
                    <Table.Td>
                      {c.canLink &&
                        !x.hidden &&
                        (x.linkId ? (
                          <Tooltip label={t('checks.unlink')}>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={t('checks.unlinkNamed', { name: x.check?.name ?? '' })}
                              onClick={() => void unlink(x)}
                            >
                              <IconLinkOff size={14} />
                            </ActionIcon>
                          </Tooltip>
                        ) : (
                          <Button size="compact-xs" variant="light" onClick={() => void link(x)} data-testid="check-link-found">
                            {t('checks.linkFound')}
                          </Button>
                        ))}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
        <Text size="xs" c="dimmed" mt="sm">
          {t('checks.help')}
        </Text>
      </Section>
      {linking && (
        <LinkCheck
          e={e}
          onClose={() => setLinking(false)}
          onDone={() => {
            invalidate();
            setLinking(false);
          }}
        />
      )}
    </Stack>
  );
}

/** Link an existing check of a monitor the person may see to the element, with its purpose. */
function LinkCheck({ e, onClose, onDone }: { e: DataElement; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const [monitor, setMonitor] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<DataCheckPurpose>('freshness');
  const [busy, run] = useBusy();
  const monitors = useQuery({ queryKey: ['dataProducts', 'monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const detail = useQuery({ queryKey: ['monitor', monitor], queryFn: () => get<MonitorDetail>(`/monitors/${enc(monitor!)}`), enabled: !!monitor });
  const save = () =>
    run(async () => {
      if (!monitor || !check) return;
      await post(`/data-elements/${enc(e.id)}/checks`, { monitor, checkId: check, purpose });
      notifyOk(t('checks.linked'));
      onDone();
    }, t('checks.notLinked'));
  return (
    <FormModal onClose={onClose} title={t('checks.linkTitle', { name: e.displayName || e.qualifiedName })}>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('checks.monitor')}
            data={(monitors.data ?? []).filter((m) => !m.isTemplate).map((m) => ({ value: m.id, label: m.name }))}
            value={monitor}
            onChange={(m) => {
              setMonitor(m);
              setCheck(null);
            }}
            searchable
            data-testid="check-link-monitor"
          />
          <Select
            label={t('checks.check')}
            data={(detail.data?.definition.checks ?? []).map((c) => ({ value: c.id, label: `${c.name ?? c.id} · ${c.type}` }))}
            value={check}
            onChange={setCheck}
            searchable
            disabled={!monitor}
            data-testid="check-link-check"
          />
          <Select
            label={t('checks.purpose')}
            data={DATA_CHECK_PURPOSES.map((p) => ({ value: p, label: t(`checks.purposes.${p}`) }))}
            value={purpose}
            onChange={(p) => p && setPurpose(p as DataCheckPurpose)}
            allowDeselect={false}
          />
          <FormButtons busy={busy} submit={t('checks.link')} testId="check-link-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * Draft a data contract from an element (WP3's draft sources): Snowflake columns, a Kafka subject or a database
 * snapshot – metadata only. The draft is shown for review and becomes a contract only when the person creates it.
 */
function DraftContract({ e, onClose }: { e: DataElement; onClose: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const navigate = useNavigate();
  const draft = useQuery({
    queryKey: ['dataProducts', 'draft', e.id],
    queryFn: () => post<DataContractDraft>('/data-contracts/draft', { source: 'element', elementId: e.id }),
    retry: false,
    gcTime: 0,
  });
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const text = yaml ?? draft.data?.yaml ?? '';
  const create = () =>
    run(async () => {
      const made = await post<DataContractDetail>('/data-contracts', { yaml: text, links: draft.data?.links ?? [] });
      navigate(`/data-contracts/${enc(made.id)}`);
    }, t('elements.draftNotCreated'));
  return (
    <Modal opened onClose={onClose} size="xl" title={t('elements.draftTitle', { name: e.qualifiedName })}>
      <Stack gap="sm" data-testid="element-draft">
        <Text size="sm" c="dimmed">
          {t('elements.draftHelp')}
        </Text>
        {draft.isLoading && <Text size="sm">{t('elements.drafting')}</Text>}
        {draft.error && (
          <Alert color="red" variant="light">
            {errorText(draft.error)}
          </Alert>
        )}
        {draft.data && draft.data.warnings.length > 0 && (
          <Alert color="yellow" variant="light" title={t('elements.draftReview')}>
            <List size="sm">
              {draft.data.warnings.map((w, i) => (
                <List.Item key={i}>{w}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        {draft.data && <ContractYamlEditor value={text} onChange={setYaml} />}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void create()} loading={busy} disabled={!draft.data} data-testid="element-draft-create">
            {t('elements.draftCreate')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
