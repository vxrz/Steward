import { useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconEdit, IconGauge, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_DIMENSIONS,
  SCORECARD_LIMITS,
  type CiaDimension,
  type RecordType,
  type ScorecardOverview,
  type ScorecardRule,
  type ScorecardTrendPoint,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, subjectLabel, useFieldErrors } from '../components/common';
import { confirmDanger } from '../components/confirm';
import { useCiaScale, useLevel } from '../components/catalogue/cia';
import { AttentionBadge, PartBadge, shownParts } from '../components/scorecard/common';
import { fmtNumber } from '../format';

/**
 * The service scorecard: every service (not archived) with its four parts – duties, availability, documentation,
 * protection need – each with its own status, the rollup overall and per owner, the trend of the stored days, and the
 * expected-document rules (administrators change them). The start page tile links here (?attention=1).
 */
export function ScorecardPage() {
  const { t } = useTranslation(['scorecard', 'common']);
  const [params, setParams] = useSearchParams();
  const attentionOnly = params.get('attention') === '1';
  const owner = params.get('owner');
  const q = useQuery({ queryKey: ['scorecard', 'overview'], queryFn: () => get<ScorecardOverview>('/scorecard') });
  const trend = useQuery({
    queryKey: ['scorecard', 'trend', owner],
    queryFn: () => get<ScorecardTrendPoint[]>(`/scorecard/trend?days=90${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`),
  });
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const o = q.data;
  const ownerOf = (key: string) => o?.rollup.owners.find((g) => g.key === key);
  const services = (o?.services ?? []).filter(
    (c) => (!attentionOnly || c.attention) && (!owner || (owner === 'none' ? !c.owners.length : c.owners.includes(owner))),
  );
  const group = owner ? ownerOf(owner) : o?.rollup.overall;
  const parts = shownParts(o?.services ?? []);
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <QueryState query={q} />
      {o && (
        <Stack gap="lg">
          {group && (
            <SimpleGrid cols={{ base: 2, sm: 3, lg: parts.length + 2 }} spacing="sm" data-testid="scorecard-rollup">
              <Stat label={t('rollup.services')} value={group.services} />
              <Stat label={t('rollup.attention')} value={group.attention} tone={group.attention ? TONE.bad : TONE.ok} />
              {parts.map((p) => (
                <Stat
                  key={p}
                  label={t(`parts.${p}`)}
                  value={group.parts[p].attention}
                  hint={t('rollup.partHint')}
                  tone={group.parts[p].attention ? TONE.bad : null}
                />
              ))}
            </SimpleGrid>
          )}
          <Trend points={trend.data ?? []} />
          <Group gap="sm" align="flex-end" wrap="wrap">
            <Select
              label={t('filters.owner')}
              placeholder={t('filters.allOwners')}
              data={o.rollup.owners.map((g) => ({ value: g.key, label: g.owner ? subjectLabel(g.owner) : t('rollup.noOwner') }))}
              value={owner}
              onChange={(v) => set('owner', v)}
              clearable
              searchable
              w={240}
            />
            <Switch
              size="sm"
              mb={8}
              label={t('filters.attentionOnly')}
              checked={attentionOnly}
              onChange={(e) => set('attention', e.currentTarget.checked ? '1' : null)}
            />
          </Group>
          {services.length === 0 ? (
            <EmptyState icon={IconGauge} title={attentionOnly ? t('emptyAttention') : t('empty')}>
              {t('emptyHint')}
            </EmptyState>
          ) : narrow ? (
            <Stack gap="xs" role="list" aria-label={t('servicesTable')} data-testid="scorecard-table">
              {services.map((c) => (
                <Paper key={c.serviceId} withBorder p="sm" role="listitem" data-testid={`scorecard-${c.serviceId}`}>
                  <Group justify="space-between" wrap="nowrap" align="flex-start" mb={6}>
                    <Anchor component={Link} to={`/services/${c.serviceId}`} fw={600} size="sm">
                      {c.serviceName}
                    </Anchor>
                    <AttentionBadge attention={c.attention} size="xs" />
                  </Group>
                  <SimpleGrid cols={2} spacing={6} verticalSpacing={4}>
                    {parts.map((p) => (
                      <Stack key={p} gap={2} align="flex-start">
                        <Text size="xs" c="dimmed">
                          {t(`parts.${p}`)}
                        </Text>
                        <PartBadge status={c[p].status} size="xs" />
                      </Stack>
                    ))}
                  </SimpleGrid>
                </Paper>
              ))}
            </Stack>
          ) : (
            <div className="table-scroll">
              <Table highlightOnHover fz="sm" aria-label={t('servicesTable')} data-testid="scorecard-table">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('service')}</Table.Th>
                    <Table.Th>{t('overall')}</Table.Th>
                    {parts.map((p) => (
                      <Table.Th key={p}>{t(`parts.${p}`)}</Table.Th>
                    ))}
                    <Table.Th>{t('owners')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {services.map((c) => (
                    <Table.Tr key={c.serviceId} data-testid={`scorecard-${c.serviceId}`}>
                      <Table.Td>
                        <Anchor component={Link} to={`/services/${c.serviceId}`} fw={500} size="sm">
                          {c.serviceName}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <AttentionBadge attention={c.attention} size="xs" />
                      </Table.Td>
                      {parts.map((p) => (
                        <Table.Td key={p}>
                          <PartBadge status={c[p].status} size="xs" />
                        </Table.Td>
                      ))}
                      <Table.Td>
                        <Text size="xs">{c.owners.map(subjectLabel).join(', ') || '–'}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
          <OwnersTable overview={o} onPick={(k) => set('owner', k)} />
          <RulesPanel />
        </Stack>
      )}
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: string | null }) {
  return (
    <Paper withBorder p="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xl" fw={700} c={tone ? `${tone}.8` : undefined}>
        {fmtNumber(value)}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Paper>
  );
}

/** Services needing attention per stored day (bars relative to the number of services that day). */
function Trend({ points }: { points: ScorecardTrendPoint[] }) {
  const { t } = useTranslation('scorecard');
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <Stack gap={4}>
      <Title order={3} size="h5">
        {t('trend.title')}
      </Title>
      {!first || !last ? (
        <Text size="sm" c="dimmed">
          {t('trend.none')}
        </Text>
      ) : (
        <>
          <Text size="xs" c="dimmed" id="scorecard-trend">
            {t('trend.summary', { from: first.day, to: last.day, first: first.attention, last: last.attention, services: last.services })}
          </Text>
          <Group
            gap={2}
            align="flex-end"
            h={48}
            wrap="nowrap"
            style={{ overflow: 'hidden' }}
            role="img"
            aria-labelledby="scorecard-trend"
            data-testid="scorecard-trend"
          >
            {points.map((p) => (
              <Tooltip key={p.day} label={t('trend.day', { day: p.day, attention: p.attention, services: p.services })}>
                <Box
                  w={6}
                  h={Math.max(2, Math.round((p.services ? p.attention / p.services : 0) * 48))}
                  bg={`var(--mantine-color-${p.attention ? TONE.bad : TONE.ok}-filled)`}
                  style={{ borderRadius: 1, flexShrink: 0 }}
                />
              </Tooltip>
            ))}
          </Group>
        </>
      )}
    </Stack>
  );
}

function OwnersTable({ overview, onPick }: { overview: ScorecardOverview; onPick: (key: string) => void }) {
  const { t } = useTranslation('scorecard');
  const parts = shownParts(overview.services);
  if (!overview.rollup.owners.length) return null;
  return (
    <Stack gap={4}>
      <Title order={3} size="h5">
        {t('rollup.perOwner')}
      </Title>
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('rollup.perOwner')} data-testid="scorecard-owners">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('rollup.owner')}</Table.Th>
              <Table.Th>{t('rollup.services')}</Table.Th>
              <Table.Th>{t('rollup.attention')}</Table.Th>
              {parts.map((p) => (
                <Table.Th key={p}>{t(`parts.${p}`)}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {overview.rollup.owners.map((g) => (
              <Table.Tr key={g.key}>
                <Table.Td>
                  <Anchor component="button" type="button" size="sm" onClick={() => onPick(g.key)}>
                    {g.owner ? subjectLabel(g.owner) : t('rollup.noOwner')}
                  </Anchor>
                </Table.Td>
                <Table.Td>{fmtNumber(g.services)}</Table.Td>
                <Table.Td>{fmtNumber(g.attention)}</Table.Td>
                {parts.map((p) => (
                  <Table.Td key={p}>{fmtNumber(g.parts[p].attention)}</Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

/** The expected-document rules on the CIA rating: everyone reads them, administrators change them (also in Settings → Catalogue). */
export function RulesPanel() {
  const { t } = useTranslation(['scorecard', 'applications']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ['scorecard', 'rules'], queryFn: () => get<ScorecardRule[]>('/scorecard/rules') });
  const level = useLevel();
  const [editing, setEditing] = useState<ScorecardRule | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['scorecard'] });
  const remove = async (r: ScorecardRule) => {
    if (!(await confirmDanger({ action: 'delete', message: t('rules.deleteConfirm', { type: r.typeName ?? r.typeId }) }))) return;
    try {
      await del(`/scorecard/rules/${r.id}`);
      notifyOk(t('rules.deleted'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = rules.data ?? [];
  return (
    <Stack gap={4} data-testid="scorecard-rules">
      <Group justify="space-between">
        <Title order={3} size="h5">
          {t('rules.title')}
        </Title>
        {isAdmin && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('rules.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('rules.hint')}
      </Text>
      <QueryState query={rules} rows={1} />
      {rules.isSuccess && !list.length && (
        <Text size="sm" c="dimmed">
          {t('rules.empty')}
        </Text>
      )}
      {list.length > 0 && (
        <Stack gap={4} role="list" aria-label={t('rules.title')}>
          {list.map((r) => (
            <Paper key={r.id} withBorder p="xs" role="listitem">
              <Group justify="space-between" wrap="nowrap">
                <Group gap={6} wrap="wrap">
                  <Text size="sm">
                    {t('rules.line', {
                      type: r.typeName ?? r.typeId,
                      key: r.typeKey ?? '?',
                      dimension: t(`applications:cia.dimensions.${r.dimension}`),
                      level: level(r.dimension, r.minLevel)?.label ?? r.minLevel,
                    })}
                  </Text>
                  {!r.enabled && (
                    <Badge size="xs" variant="default" tt="none">
                      {t('rules.off')}
                    </Badge>
                  )}
                  {!r.valid && (
                    <Badge size="xs" color="orange" variant="light" tt="none">
                      {t('rules.invalid')}
                    </Badge>
                  )}
                  {r.note && (
                    <Text size="xs" c="dimmed">
                      {r.note}
                    </Text>
                  )}
                </Group>
                {isAdmin && (
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon variant="subtle" aria-label={t('rules.editOf', { type: r.typeName ?? r.typeId })} onClick={() => setEditing(r)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="red" aria-label={t('rules.deleteOf', { type: r.typeName ?? r.typeId })} onClick={() => void remove(r)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {editing && <RuleModal rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </Stack>
  );
}

function RuleModal({ rule, onClose, onSaved }: { rule?: ScorecardRule; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['scorecard', 'applications', 'common']);
  const types = useQuery({ queryKey: ['record-types'], queryFn: () => get<RecordType[]>('/record-types') });
  const scale = useCiaScale().data;
  const level = useLevel();
  const [typeKey, setTypeKey] = useState<string | null>(rule?.typeKey ?? null);
  const [dimension, setDimension] = useState<CiaDimension>(rule?.dimension ?? 'confidentiality');
  const [minLevel, setMinLevel] = useState<string | null>(rule?.minLevel ?? null);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [note, setNote] = useState(rule?.note ?? '');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ type: !typeKey && t('common:validation.required'), level: !minLevel && t('common:validation.required') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = { typeKey, dimension, minLevel, enabled, note };
    try {
      if (rule) await put(`/scorecard/rules/${rule.id}`, body);
      else await post('/scorecard/rules', body);
      notifyOk(t('rules.saved'));
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={rule ? t('rules.editOf', { type: rule.typeName ?? rule.typeId }) : t('rules.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('rules.type')}
            description={t('rules.typeHint')}
            data={(types.data ?? []).filter((x) => x.workflow === 'document' && !x.archived).map((x) => ({ value: x.key, label: `${x.name} (${x.key})` }))}
            value={typeKey}
            onChange={setTypeKey}
            required
            error={v.error('type')}
            data-autofocus
          />
          <Group grow align="flex-start">
            <Select
              label={t('rules.dimension')}
              data={CIA_DIMENSIONS.map((d) => ({ value: d, label: t(`applications:cia.dimensions.${d}`) }))}
              value={dimension}
              onChange={(x) => {
                if (!x) return;
                setDimension(x as CiaDimension);
                setMinLevel(null);
              }}
              allowDeselect={false}
            />
            <Select
              label={t('rules.minLevel')}
              data={(scale?.levels[dimension] ?? []).map((l) => ({ value: l.key, label: level(dimension, l.key)?.label ?? l.key }))}
              value={minLevel}
              onChange={setMinLevel}
              required
              error={v.error('level')}
            />
          </Group>
          <TextInput label={t('rules.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={SCORECARD_LIMITS.note} />
          <Checkbox label={t('rules.enabled')} checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
