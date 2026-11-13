import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Group, MultiSelect, Paper, Select, SimpleGrid, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconCheck, IconDownload, IconClipboardText, IconPlus, IconSearch, IconSend, IconSettings, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SOA_PARTIES, SOA_STATUSES, type Soa, type SoaEntry, type SoaList, type SoaSummary } from '@sm/shared';
import { apiUrl, confirmedDownload, get, notifyError, notifyOk, post } from '../api';
import { DetailState, FilterPanel, QueryState, useCreateParam } from '../components/common';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { ListPage } from '../components/page/ListPage';
import { DetailHeader } from '../components/page/DetailPage';
import { CollapsibleSection } from '../components/page/CollapsibleSection';
import { MaturityBadge } from '../components/modules/MaturityBadge';
import {
  ApplicableBadge,
  CoverageBadge,
  NewSoaModal,
  SoaDecisionModal,
  SoaEntryDrawer,
  SoaSettingsModal,
  SoaStatusBadge,
  SoaVersionModal,
  usePartyLabel,
} from '../components/compliance/soa';
import { capFirst, fmtDate, fmtDay } from '../format';
import { soaKeys } from '../queryKeys';
import { TableScroll } from '../components/TableScroll';
import { useSubjectLabel } from '../components/SubjectsInput';

/**
 * The statement of applicability (ISO/IEC 27001 clause 6.1.3 d, ADR 0029 part 2; Compliance module, preview): the
 * statements per catalogue, and one statement with its rows, the suggestion of the responsibility matrix, the
 * evidence Steward holds, its versions with the approval by a second person and the signed export.
 */

const BASE = '/compliance/soa';

const Title = ({ text }: { text: string }) => (
  <Group gap="xs" component="span" wrap="nowrap">
    <span>{text}</span>
    <MaturityBadge maturity="preview" />
  </Group>
);

// ---------- the list ----------

export function SoaListPage() {
  const { t } = useTranslation(['soa', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: soaKeys.list, queryFn: () => get<SoaList>('/compliance/soa') });
  const [creating, setCreating] = useState(false);
  const canCreate = !!list.data?.canCreate && (list.data?.catalogues.length ?? 0) > 0;
  useCreateParam(canCreate, () => setCreating(true));
  const items = list.data?.items ?? [];
  const href = (x: SoaSummary) => `${BASE}/${encodeURIComponent(x.catalogueKey)}`;
  const columns: DataColumn<SoaSummary>[] = [
    {
      key: 'catalogue',
      header: t('table.catalogue'),
      sortValue: (x) => x.catalogueKey,
      cell: (x) => (
        <>
          <Anchor component={Link} to={href(x)} fw={600} size="sm" onClick={(e) => e.stopPropagation()}>
            {x.catalogueName}
          </Anchor>
          <Text size="xs" c="dimmed">
            {x.scopeName || t('allServices')}
          </Text>
        </>
      ),
    },
    {
      key: 'decided',
      header: t('table.decided'),
      sortValue: (x) => x.counts.undecided,
      cell: (x) => t('counts.decided', { decided: x.counts.controls - x.counts.undecided, total: x.counts.controls }),
    },
    {
      key: 'applicable',
      header: t('table.applicable'),
      sortValue: (x) => x.counts.applicable,
      cell: (x) => t('counts.applicableShort', { applicable: x.counts.applicable, implemented: x.counts.implemented }),
    },
    {
      key: 'version',
      header: t('table.version'),
      sortValue: (x) => x.latestApproved?.number ?? 0,
      cell: (x) => <VersionState s={x} />,
    },
  ];
  return (
    <ListPage
      title={<Title text={t('title')} />}
      description={t('description')}
      view="soa"
      primaryAction={
        canCreate && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="soa-new">
            {t('new.button')}
          </Button>
        )
      }
      empty={{
        show: list.isSuccess && items.length === 0,
        icon: IconClipboardText,
        title: t('empty.title'),
        text: t('empty.text'),
        whoCanAct: t('whoCanAct'),
        action: canCreate && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            {t('new.button')}
          </Button>
        ),
      }}
    >
      <QueryState query={list} />
      {items.length > 0 && (
        <DataTable
          rows={items}
          columns={columns}
          rowKey={(x) => x.id}
          ariaLabel={t('title')}
          rowHref={href}
          footer={<ListFooter shown={items.length} />}
          testId="soa-list"
          card={(x) => (
            <Paper withBorder p="sm">
              <Anchor component={Link} to={href(x)} fw={600} size="sm">
                {x.catalogueName}
              </Anchor>
              <Text size="xs" c="dimmed">
                {x.scopeName || t('allServices')} · {t('counts.decided', { decided: x.counts.controls - x.counts.undecided, total: x.counts.controls })}
              </Text>
              <VersionState s={x} />
            </Paper>
          )}
        />
      )}
      {creating && list.data && (
        <NewSoaModal
          catalogues={list.data.catalogues}
          fourEyesOff={list.data.fourEyesOff}
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: soaKeys.all });
            navigate(`${BASE}/${encodeURIComponent(s.catalogueKey)}`);
          }}
        />
      )}
    </ListPage>
  );
}

function VersionState({ s }: { s: SoaSummary }) {
  const { t } = useTranslation('soa');
  return (
    <Group gap={4} wrap="wrap">
      {s.latestApproved ? (
        <Badge color="teal" variant="light" size="sm">
          {t('versions.approvedShort', { number: s.latestApproved.number })}
        </Badge>
      ) : (
        <Badge color="gray" variant="light" size="sm">
          {t('versions.draft')}
        </Badge>
      )}
      {s.waiting && (
        <Badge color="violet" variant="light" size="sm">
          {t('versions.waitingShort', { number: s.waiting.number })}
        </Badge>
      )}
      {s.latestApproved && s.changedSinceApproved > 0 && (
        <Badge color="orange" variant="outline" size="sm">
          {t('versions.changed', { count: s.changedSinceApproved })}
        </Badge>
      )}
    </Group>
  );
}

// ---------- one statement ----------

type Applies = 'all' | 'yes' | 'no' | 'undecided';

export function SoaDetailPage() {
  const { t } = useTranslation(['soa', 'common']);
  const subjectName = useSubjectLabel();
  const { key = '' } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: soaKeys.detail(key), queryFn: () => get<Soa>(`/compliance/soa/${encodeURIComponent(key)}`), retry: false });
  const partyLabel = usePartyLabel();
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 200);
  const [applies, setApplies] = useState<Applies>('all');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [parties, setParties] = useState<string[]>([]);
  const [owner, setOwner] = useState<string | null>(null);
  const [noEvidence, setNoEvidence] = useState(false);
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [deciding, setDeciding] = useState<'approve' | 'return' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const soa = q.data;
  const owners = useMemo(() => [...new Set((soa?.entries ?? []).map((e) => e.owner).filter((x): x is string => !!x))].sort(), [soa]);
  const rows = useMemo(() => {
    const needle = debounced.trim().toLowerCase();
    return (soa?.entries ?? []).filter(
      (e) =>
        (!needle || `${e.ref} ${e.title}`.toLowerCase().includes(needle)) &&
        (applies === 'all' || (applies === 'undecided' ? e.applicable === null : e.applicable === (applies === 'yes'))) &&
        (!statuses.length || statuses.includes(e.status ?? '')) &&
        (!parties.length || parties.includes(e.party ?? '')) &&
        (!owner || e.owner === owner) &&
        (!open || !e.decided) &&
        (!noEvidence || e.noEvidence),
    );
  }, [soa, debounced, applies, statuses, parties, owner, open, noEvidence]);
  if (!soa) return <DetailState query={q} back="soa" />;
  const selected = params.get('control');
  const entry = selected ? soa.entries.find((e) => e.controlId === selected) : undefined;
  const select = (e: SoaEntry | null) => {
    const next = new URLSearchParams(params);
    if (e) next.set('control', e.controlId);
    else next.delete('control');
    setParams(next, { replace: true });
  };
  const set = (s: Soa) => {
    qc.setQueryData(soaKeys.detail(key), s);
    void qc.invalidateQueries({ queryKey: soaKeys.list });
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: soaKeys.all });
  const submit = async () => {
    setSubmitting(true);
    try {
      set(await post<Soa>(`/compliance/soa/${encodeURIComponent(soa.catalogueKey)}/versions`));
      notifyOk(t('versions.submitted'));
    } catch (e) {
      notifyError(e);
    } finally {
      setSubmitting(false);
    }
  };
  const c = soa.counts;
  const active = [debounced.trim(), applies !== 'all', statuses.length, parties.length, owner, open, noEvidence].filter(Boolean).length;
  const columns: DataColumn<SoaEntry>[] = [
    {
      key: 'control',
      header: t('table.control'),
      sortValue: (x) => soa.entries.indexOf(x),
      cell: (x) => (
        <>
          <Anchor component="button" type="button" fw={600} size="sm" onClick={() => select(x)} style={{ textAlign: 'left' }}>
            {x.ref} {capFirst(x.title)}
          </Anchor>
          {x.changed && (
            <Badge color="orange" variant="outline" size="xs" ml={4}>
              {t('entry.changed')}
            </Badge>
          )}
        </>
      ),
    },
    {
      key: 'applicable',
      header: t('table.applies'),
      sortValue: (x) => (x.applicable === null ? 2 : x.applicable ? 0 : 1),
      cell: (x) => <ApplicableBadge applicable={x.applicable} size="xs" />,
    },
    {
      key: 'status',
      header: t('table.status'),
      sortValue: (x) => (x.status ? SOA_STATUSES.indexOf(x.status) : 9),
      cell: (x) => (x.applicable === false ? '–' : <SoaStatusBadge status={x.status} size="xs" />),
    },
    {
      key: 'party',
      header: t('table.party'),
      sortValue: (x) => x.party ?? 'z',
      cell: (x) => (
        <>
          <Text size="sm">{partyLabel(x)}</Text>
          {x.suggestion?.party && x.suggestion.party !== x.party && (
            <Text size="xs" c="dimmed">
              {t('suggestion.short', { party: t(`parties.${x.suggestion.party}`) })}
            </Text>
          )}
        </>
      ),
    },
    { key: 'owner', header: t('table.owner'), sortValue: (x) => x.owner ?? '~', cell: (x) => (x.owner ? subjectName(x.owner) : '–') },
    {
      key: 'evidence',
      header: t('table.evidence'),
      sortValue: (x) => x.evidence.items,
      cell: (x) => (
        <Group gap={4} wrap="wrap">
          <CoverageBadge status={x.evidence.status} />
          {x.noEvidence && (
            <Badge color="red" variant="light" size="xs">
              {t('evidence.none')}
            </Badge>
          )}
          {x.findings.open > 0 && (
            <Anchor
              component={Link}
              to={`/compliance/corrective-actions?controlId=${encodeURIComponent(x.controlId)}`}
              size="xs"
              onClick={(e) => e.stopPropagation()}
            >
              {t('evidence.openFindings', { count: x.findings.open })}
            </Anchor>
          )}
        </Group>
      ),
    },
    {
      key: 'review',
      header: t('table.review'),
      sortValue: (x) => x.reviewedAt ?? '',
      nowrap: true,
      cell: (x) => (
        <Text size="sm" c={x.reviewDue ? 'orange' : undefined}>
          {x.reviewedAt ? fmtDay(x.reviewedAt) : x.decided ? t('entry.never') : '–'}
        </Text>
      ),
    },
  ];
  return (
    <>
      <DetailHeader
        recent={{ label: `${t('title')} ${soa.catalogueKey}`, kind: 'record' }}
        back="soa"
        title={<Title text={soa.catalogueName} />}
        status={<VersionState s={soa} />}
        description={[soa.scopeName, soa.scopeServices.length ? soa.scopeServices.map((s) => s.name).join(', ') : t('allServices')].filter(Boolean).join(' – ')}
        actions={
          <>
            {soa.permissions.edit && (
              <Tooltip label={soa.permissions.submitBlocked ? t(`versions.blocked.${soa.permissions.submitBlocked}`) : t('versions.submitHint')} withArrow>
                <Button
                  size="xs"
                  leftSection={<IconSend size={14} />}
                  onClick={() => void submit()}
                  loading={submitting}
                  disabled={!soa.permissions.submit}
                  data-testid="soa-submit"
                >
                  {t('versions.submit')}
                </Button>
              </Tooltip>
            )}
            {soa.permissions.edit && (
              <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setSettings(true)} data-testid="soa-settings">
                {t('settings.button')}
              </Button>
            )}
          </>
        }
      />
      {soa.waiting && (
        <Alert color="violet" variant="light" mb="md" data-testid="soa-waiting">
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Text size="sm">
              {t('versions.waiting', { number: soa.waiting.number, user: soa.waiting.submittedBy, date: fmtDate(soa.waiting.submittedAt) })}
            </Text>
            <Group gap="xs">
              <Button size="compact-sm" variant="subtle" onClick={() => setViewing(soa.waiting!.number)} data-testid="soa-view-waiting">
                {t('versionView.show')}
              </Button>
              {soa.permissions.decide && (
                <>
                  <Button size="compact-sm" leftSection={<IconCheck size={14} />} onClick={() => setDeciding('approve')} data-testid="soa-approve">
                    {t('decision.approve')}
                  </Button>
                  <Button size="compact-sm" variant="default" leftSection={<IconX size={14} />} onClick={() => setDeciding('return')} data-testid="soa-return">
                    {t('decision.return')}
                  </Button>
                </>
              )}
            </Group>
          </Group>
          {soa.permissions.decideBlocked === 'ownSubmission' && (
            <Text size="xs" mt={4}>
              {t('decision.ownSubmission')}
            </Text>
          )}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs" mb="md" data-testid="soa-counts">
        <Stat label={t('counts.decidedLabel')} value={`${c.controls - c.undecided} / ${c.controls}`} tone={c.undecided ? 'orange' : undefined} />
        <Stat label={t('counts.applicable')} value={String(c.applicable)} hint={t('counts.notApplicable', { count: c.notApplicable })} />
        <Stat
          label={t('statuses.implemented')}
          value={String(c.implemented)}
          hint={t('counts.partlyPlanned', { partly: c.partly, planned: c.planned, notStarted: c.notStarted })}
        />
        <Stat
          label={t('counts.attention')}
          value={String(c.noEvidence + c.reviewDue)}
          hint={t('counts.attentionHint', { noEvidence: c.noEvidence, reviewDue: c.reviewDue })}
        />
      </SimpleGrid>
      <FilterPanel active={active}>
        <Group gap="xs" mb="xs" wrap="wrap" align="flex-end">
          <TextInput
            size="xs"
            label={t('filters.search')}
            placeholder={t('filters.searchPlaceholder')}
            leftSection={<IconSearch size={14} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            w={200}
            data-testid="soa-search"
          />
          <Select
            size="xs"
            label={t('filters.applicable')}
            allowDeselect={false}
            data={(['all', 'yes', 'no', 'undecided'] as const).map((x) => ({ value: x, label: t(`filters.applicableValues.${x}`) }))}
            value={applies}
            onChange={(v) => setApplies((v as Applies) ?? 'all')}
            w={150}
            data-testid="soa-filter-applicable"
          />
          <MultiSelect
            size="xs"
            label={t('filters.status')}
            placeholder={statuses.length ? undefined : t('filters.all')}
            data={SOA_STATUSES.map((x) => ({ value: x, label: t(`statuses.${x}`) }))}
            value={statuses}
            onChange={setStatuses}
            clearable
            w={200}
          />
          <MultiSelect
            size="xs"
            label={t('filters.party')}
            placeholder={parties.length ? undefined : t('filters.all')}
            data={SOA_PARTIES.map((x) => ({ value: x, label: t(`parties.${x}`) }))}
            value={parties}
            onChange={setParties}
            clearable
            w={200}
          />
          <Select
            size="xs"
            label={t('filters.owner')}
            placeholder={t('filters.all')}
            data={owners.map((o) => ({ value: o, label: subjectName(o) }))}
            value={owner}
            onChange={setOwner}
            clearable
            w={170}
          />
          <Checkbox size="xs" label={t('filters.open')} checked={open} onChange={(e) => setOpen(e.currentTarget.checked)} mb={6} />
          <Checkbox
            size="xs"
            label={t('filters.noEvidence')}
            checked={noEvidence}
            onChange={(e) => setNoEvidence(e.currentTarget.checked)}
            mb={6}
            data-testid="soa-filter-no-evidence"
          />
        </Group>
      </FilterPanel>
      {rows.length === 0 ? (
        <Text c="dimmed" size="sm" mb="md">
          {active ? t('empty.filtered') : t('empty.noControls')}
        </Text>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(x) => x.controlId}
          ariaLabel={t('table.label', { catalogue: soa.catalogueName })}
          onRowClick={select}
          footer={<ListFooter shown={rows.length} total={soa.entries.length} />}
          testId="soa-entries"
          card={(x) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Anchor component="button" type="button" fw={600} size="sm" onClick={() => select(x)} style={{ textAlign: 'left' }}>
                    {x.ref} {capFirst(x.title)}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {[partyLabel(x), x.owner && subjectName(x.owner)].filter((v) => v && v !== '–').join(' · ') || t('entry.notDecided')}
                  </Text>
                </div>
                <Stack gap={4} align="flex-end">
                  <ApplicableBadge applicable={x.applicable} size="xs" />
                  {x.applicable !== false && x.status && <SoaStatusBadge status={x.status} size="xs" />}
                  {x.noEvidence && (
                    <Badge color="red" variant="light" size="xs">
                      {t('evidence.none')}
                    </Badge>
                  )}
                </Stack>
              </Group>
            </Paper>
          )}
        />
      )}
      <CollapsibleSection id="soa-versions" title={t('versions.title')} count={soa.versions.length} remember="soa.versions">
        {soa.versions.length === 0 ? (
          <Text c="dimmed" size="sm">
            {t('versions.none')}
          </Text>
        ) : (
          <TableScroll>
            <Table fz="sm" data-testid="soa-versions" aria-label={t('versions.title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('versions.number')}</Table.Th>
                  <Table.Th>{t('versions.state')}</Table.Th>
                  <Table.Th>{t('versions.submittedCol')}</Table.Th>
                  <Table.Th>{t('versions.decidedCol')}</Table.Th>
                  <Table.Th>{t('versions.sha')}</Table.Th>
                  <Table.Th>{t('versions.export')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {soa.versions.map((v) => {
                  const url = (format: string) =>
                    apiUrl(`/compliance/soa/${encodeURIComponent(soa.catalogueKey)}/versions/${v.number}/export?format=${format}`);
                  return (
                    <Table.Tr key={v.number}>
                      <Table.Td>
                        <Anchor
                          component="button"
                          type="button"
                          size="sm"
                          onClick={() => setViewing(v.number)}
                          aria-label={t('versionView.open', { number: v.number })}
                        >
                          {v.number}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="sm"
                          variant="light"
                          color={v.status === 'approved' ? 'teal' : v.status === 'submitted' ? 'violet' : v.status === 'returned' ? 'orange' : 'gray'}
                        >
                          {t(`versions.statuses.${v.status}`)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{t('versions.by', { user: v.submittedBy, date: fmtDate(v.submittedAt) })}</Text>
                      </Table.Td>
                      <Table.Td>
                        {v.decidedAt ? <Text size="xs">{t('versions.by', { user: v.decidedBy ?? '', date: fmtDate(v.decidedAt) })}</Text> : '–'}
                        {v.comment && (
                          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                            {v.comment}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={v.contentSha256}>
                          <Text size="xs" className="mono">
                            {v.contentSha256.slice(0, 12)}…
                          </Text>
                        </Tooltip>
                      </Table.Td>
                      <Table.Td>
                        {v.canExport ? (
                          <Group gap={4} wrap="nowrap">
                            <Button
                              size="compact-xs"
                              variant="light"
                              component="a"
                              href={url('zip')}
                              // signed with the installation's key, like an evidence pack: a fresh confirmation first
                              onClick={confirmedDownload('exportEvidencePack')}
                              leftSection={<IconDownload size={12} />}
                              data-testid={`soa-export-zip-${v.number}`}
                            >
                              {t('versions.signed')}
                            </Button>
                            <Button size="compact-xs" variant="subtle" component="a" href={url('pdf')}>
                              PDF
                            </Button>
                            <Button size="compact-xs" variant="subtle" component="a" href={url('csv')}>
                              CSV
                            </Button>
                          </Group>
                        ) : (
                          '–'
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
        <Text size="xs" c="dimmed" mt="xs">
          {soa.permissions.fourEyes ? t('versions.fourEyesOn') : t('versions.fourEyesOff')} {t('versions.verifyHint')}
        </Text>
      </CollapsibleSection>
      {entry && (
        <SoaEntryDrawer
          key={entry.controlId}
          soa={soa}
          entry={entry}
          onClose={() => select(null)}
          onSaved={() => {
            select(null);
            refresh();
          }}
        />
      )}
      {viewing !== null && <SoaVersionModal catalogueKey={soa.catalogueKey} number={viewing} onClose={() => setViewing(null)} />}
      {settings && (
        <SoaSettingsModal
          soa={soa}
          onClose={() => setSettings(false)}
          onSaved={(s) => {
            setSettings(false);
            set(s);
          }}
        />
      )}
      {deciding && (
        <SoaDecisionModal
          soa={soa}
          approve={deciding === 'approve'}
          onClose={() => setDeciding(null)}
          onSaved={(s) => {
            setDeciding(null);
            set(s);
          }}
        />
      )}
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <Paper withBorder p="xs">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" c={tone}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Paper>
  );
}
