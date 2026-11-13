import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  Drawer,
  FileButton,
  Group,
  Modal,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconChecklist, IconChevronDown, IconFileImport, IconPackageExport, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ControlCatalogue, ControlCoverage, ControlTagKind, ControlsMeta, EvidenceItem } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE } from '../components/common';
import { useRemoteSelect } from '../components/remoteSelect';
import { CoverageBadge, PeriodPicker, periodRange, presetPeriod, validPeriod, type Period } from '../components/compliance/common';
import { capFirst, fmtDate } from '../format';
import { ControlFindings } from '../components/compliance/corrective';
import { TableScroll } from '../components/TableScroll';

/** Compliance → Controls: the control catalogues, what is mapped to each control and the evidence in a period (gaps highlighted). */
export function ComplianceControlsPage() {
  const { t } = useTranslation(['compliance', 'common']);
  const { caps } = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState<Period>(presetPeriod('90'));
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const meta = useQuery({ queryKey: ['compliance-meta'], queryFn: () => get<ControlsMeta>('/compliance/meta') });
  const catalogues = useQuery({ queryKey: ['control-catalogues'], queryFn: () => get<ControlCatalogue[]>('/compliance/catalogues') });
  const catalogue = params.get('catalogue') ?? catalogues.data?.find((c) => c.key === 'ISO27001')?.key ?? catalogues.data?.[0]?.key ?? '';
  const range = validPeriod(period) ? periodRange(period) : null;
  const coverage = useQuery({
    queryKey: ['control-coverage', catalogue, range?.from, range?.to],
    queryFn: () =>
      get<ControlCoverage[]>(
        `/compliance/coverage?catalogue=${encodeURIComponent(catalogue)}&from=${encodeURIComponent(range!.from)}&to=${encodeURIComponent(range!.to)}`,
      ),
    enabled: !!catalogue && !!range,
  });
  const list = (coverage.data ?? []).filter((c) => !onlyGaps || c.status === 'gap');
  const counts = useMemo(() => countOf(coverage.data ?? []), [coverage.data]);
  const open = params.get('control');
  const openCoverage = coverage.data?.find((c) => c.control.id === open);
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('control', id);
    else next.delete('control');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title={t('controls.title')}
        description={t('controls.description')}
        actions={
          <>
            {meta.data?.canManageCatalogues && (
              <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)}>
                {t('controls.import')}
              </Button>
            )}
            {caps.exportEvidence && (
              <Button
                size="xs"
                leftSection={<IconPackageExport size={14} />}
                disabled={!selected.length || !range}
                onClick={() =>
                  navigate(`/compliance/evidence-packs?new=1&controls=${encodeURIComponent(selected.join(','))}&from=${period.from}&to=${period.to}`)
                }
              >
                {t('controls.exportSelected', { count: selected.length })}
              </Button>
            )}
          </>
        }
      />
      <Alert color="gray" variant="light" mb="md">
        <Text size="sm">{t('controls.disclaimer')}</Text>
      </Alert>
      <Group gap="sm" align="flex-end" mb="md" wrap="wrap">
        <Select
          size="xs"
          label={t('controls.catalogue')}
          w={{ base: '100%', xs: 280 }}
          allowDeselect={false}
          data={(catalogues.data ?? []).map((c) => ({ value: c.key, label: `${c.name}${c.builtin ? '' : ` (${t('controls.custom')})`}` }))}
          value={catalogue || null}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v) next.set('catalogue', v);
            next.delete('control');
            setParams(next, { replace: true });
            setSelected([]);
          }}
        />
        <PeriodPicker value={period} onChange={setPeriod} />
        <Checkbox label={t('controls.onlyGaps')} checked={onlyGaps} onChange={(e) => setOnlyGaps(e.currentTarget.checked)} mb={6} />
      </Group>
      {coverage.data && coverage.data.length > 0 && (
        <Paper withBorder p="sm" mb="md" data-testid="controls-summary">
          <Group justify="space-between" gap="xs" mb={6} wrap="wrap">
            <Text size="sm" fw={600}>
              {t('controls.summary', { covered: counts.covered, total: coverage.data.length })}
            </Text>
            <Group gap="xs" aria-live="polite">
              <Badge color={TONE.ok} variant="light">
                {t('controls.countCovered', { count: counts.covered })}
              </Badge>
              <Badge color={TONE.bad} variant={counts.gap ? 'filled' : 'light'}>
                {t('controls.countGap', { count: counts.gap })}
              </Badge>
              {counts.notVisible > 0 && (
                <Badge color={TONE.attention} variant="light">
                  {t('controls.countNotVisible', { count: counts.notVisible })}
                </Badge>
              )}
              <Badge color={TONE.soon} variant="light">
                {t('controls.countUnmapped', { count: counts.unmapped })}
              </Badge>
            </Group>
          </Group>
          <CoverageBar counts={counts} label={t('controls.title')} />
          {counts.unmapped > 0 && (
            <Text size="xs" c="dimmed" mt={6}>
              {t('controls.unmappedHint')}
            </Text>
          )}
        </Paper>
      )}
      <QueryState query={catalogues} />
      <QueryState query={coverage} />
      {coverage.isSuccess && list.length === 0 && (
        <EmptyState icon={IconChecklist} title={onlyGaps ? t('controls.noGaps') : t('controls.empty')}>
          {onlyGaps ? t('controls.noGapsText') : null}
        </EmptyState>
      )}
      {list.length > 0 && (
        <CoverageTable
          rows={list}
          selected={selected}
          onSelect={caps.exportEvidence ? setSelected : undefined}
          onOpen={(id) => setOpen(id)}
          catalogueParam={catalogue}
          onlyGaps={onlyGaps}
        />
      )}
      {openCoverage && <ControlDrawer cov={openCoverage} meta={meta.data} onClose={() => setOpen(null)} />}
      {importing && <ImportModal catalogues={catalogues.data ?? []} onClose={() => setImporting(false)} />}
    </>
  );
}

type Counts = Record<ControlCoverage['status'], number>;
const countOf = (rows: ControlCoverage[]): Counts => {
  const out: Counts = { covered: 0, gap: 0, unmapped: 0, notVisible: 0 };
  for (const c of rows) out[c.status]++;
  return out;
};

/** Covered, gaps, not visible and not mapped as one bar (the share of controls in each state). */
function CoverageBar({ counts, label }: { counts: Counts; label: string }) {
  const { t } = useTranslation('compliance');
  const total = counts.covered + counts.gap + counts.unmapped + counts.notVisible;
  if (!total) return null;
  const parts: [keyof Counts, string][] = [
    ['covered', 'var(--mantine-color-green-6)'],
    ['gap', 'var(--mantine-color-red-6)'],
    ['notVisible', 'var(--mantine-color-orange-5)'],
    ['unmapped', 'var(--mantine-color-gray-3)'],
  ];
  return (
    <Progress.Root size="md">
      {parts.map(([k, color]) =>
        counts[k] ? (
          <Tooltip key={k} label={`${t(`coverage.${k}`)}: ${counts[k]}`}>
            <Progress.Section
              value={(counts[k] / total) * 100}
              color={color}
              aria-label={`${t('controls.coverageOf', { name: label })} – ${t(`coverage.${k}`)}: ${counts[k]}`}
            />
          </Tooltip>
        ) : null,
      )}
    </Progress.Root>
  );
}

/**
 * The section of a control in its catalogue: everything before the last part of the reference
 * (ISO/IEC 27001 "5.15" → "5", IEC 62443-2-1 "4.3.3.5" → "4.3.3"); references without parts have none.
 */
const sectionOf = (ref: string) => {
  const parts = ref.split('.');
  return parts.length > 1 ? parts.slice(0, -1).join('.') : '';
};

interface Section {
  key: string;
  title: string;
  rows: ControlCoverage[];
  counts: Counts;
}

function useSections(rows: ControlCoverage[], catalogue: string): Section[] {
  const { t } = useTranslation('compliance');
  return useMemo(() => {
    const by = new Map<string, ControlCoverage[]>();
    for (const c of rows) {
      const k = sectionOf(c.control.ref);
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    // one section only (or references without parts): a flat list
    if (by.size < 2) return [{ key: '', title: '', rows, counts: countOf(rows) }];
    return [...by.entries()].map(([key, list]) => {
      const name = t(`controls.sections.${catalogue}.${key.replace(/\./g, '_')}`, { defaultValue: '' });
      return { key, title: name ? t('controls.sectionNamed', { ref: key, name }) : t('controls.section', { ref: key }), rows: list, counts: countOf(list) };
    });
  }, [rows, catalogue, t]);
}

function CoverageTable({
  rows,
  selected,
  onSelect,
  onOpen,
  catalogueParam,
  onlyGaps,
}: {
  rows: ControlCoverage[];
  selected: string[];
  onSelect?: (ids: string[]) => void;
  onOpen: (id: string) => void;
  catalogueParam: string;
  onlyGaps: boolean;
}) {
  const { t } = useTranslation('compliance');
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const sections = useSections(rows, catalogueParam);
  // sections with something mapped start open, the others closed; a click changes it for this page view
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (s: Section) => toggled[s.key] ?? (onlyGaps || !s.key || s.counts.unmapped < s.rows.length);
  const flip = (s: Section) => setToggled({ ...toggled, [s.key]: !isOpen(s) });
  const toggle = (id: string, on: boolean) => onSelect?.(on ? [...selected, id] : selected.filter((x) => x !== id));
  const link = (c: ControlCoverage) => `/compliance/controls?catalogue=${encodeURIComponent(catalogueParam)}&control=${encodeURIComponent(c.control.id)}`;
  const total = (c: ControlCoverage) => Object.values(c.counts).reduce((n, x) => n + (x ?? 0), 0);
  const header = (s: Section) =>
    s.key ? (
      <Group gap="sm" wrap="nowrap" w="100%">
        <UnstyledButton
          onClick={() => flip(s)}
          aria-expanded={isOpen(s)}
          aria-controls={`controls-section-${s.key}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 28, flex: '1 1 auto', minWidth: 0 }}
        >
          <IconChevronDown
            size={16}
            aria-hidden
            style={{ transform: isOpen(s) ? undefined : 'rotate(-90deg)', transition: 'transform 150ms ease', flexShrink: 0 }}
          />
          <Text fw={600} size="sm" style={{ overflowWrap: 'anywhere' }}>
            {s.title}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {t('controls.sectionCounts', { covered: s.counts.covered, gaps: s.counts.gap, unmapped: s.counts.unmapped, total: s.rows.length })}
          </Text>
        </UnstyledButton>
        <Box w={{ base: 80, sm: 160 }} style={{ flexShrink: 0 }}>
          <CoverageBar counts={s.counts} label={s.title} />
        </Box>
      </Group>
    ) : null;
  if (narrow) {
    return (
      <Stack gap="md">
        {sections.map((s) => (
          <Stack key={s.key || 'all'} gap="xs" role="group" aria-label={s.title || t('controls.title')}>
            {header(s)}
            {isOpen(s) && (
              <Stack gap="xs" role="list" id={`controls-section-${s.key}`} aria-label={s.title || t('controls.title')}>
                {s.rows.map((c) => (
                  <Paper
                    key={c.control.id}
                    withBorder
                    p="sm"
                    role="listitem"
                    style={c.status === 'gap' ? { borderColor: 'var(--mantine-color-red-6)' } : undefined}
                  >
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                        {onSelect && (
                          <Checkbox
                            aria-label={t('controls.select', { ref: c.control.ref })}
                            checked={selected.includes(c.control.id)}
                            onChange={(e) => toggle(c.control.id, e.currentTarget.checked)}
                          />
                        )}
                        <Box style={{ minWidth: 0 }}>
                          <Anchor component={Link} to={link(c)} onClick={() => onOpen(c.control.id)} fw={600} size="sm">
                            {c.control.ref} – {capFirst(c.control.title)}
                          </Anchor>
                          <Text size="xs" c="dimmed">
                            {t('controls.evidenceCount', { count: total(c) })} · {t('controls.mappedCount', { count: c.control.tags.length })}
                          </Text>
                        </Box>
                      </Group>
                      <CoverageBadge status={c.status} hidden={c.hidden} size="xs" />
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </Stack>
        ))}
      </Stack>
    );
  }
  const cols = onSelect ? 5 : 4;
  return (
    <TableScroll>
      <Table highlightOnHover fz="sm" aria-label={t('controls.title')}>
        <Table.Thead>
          <Table.Tr>
            {onSelect && <Table.Th w={36} />}
            <Table.Th>{t('controls.control')}</Table.Th>
            <Table.Th>{t('controls.coverage')}</Table.Th>
            <Table.Th>{t('controls.evidence')}</Table.Th>
            <Table.Th>{t('controls.mapped')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        {sections.map((s) => (
          <Table.Tbody key={s.key || 'all'} id={s.key ? `controls-section-${s.key}` : undefined}>
            {s.key && (
              <Table.Tr bg="var(--mantine-color-default-hover)">
                <Table.Th colSpan={cols} scope="rowgroup">
                  {header(s)}
                </Table.Th>
              </Table.Tr>
            )}
            {isOpen(s) &&
              s.rows.map((c) => (
                <Table.Tr key={c.control.id} bg={c.status === 'gap' ? 'var(--mantine-color-red-light)' : undefined}>
                  {onSelect && (
                    <Table.Td>
                      <Checkbox
                        aria-label={t('controls.select', { ref: c.control.ref })}
                        checked={selected.includes(c.control.id)}
                        onChange={(e) => toggle(c.control.id, e.currentTarget.checked)}
                      />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Anchor size="sm" component={Link} to={link(c)} onClick={() => onOpen(c.control.id)} fw={500}>
                      <Text span className="mono" size="sm">
                        {c.control.ref}
                      </Text>
                      {/* a table cell's link is a flex box (styles.css): a plain space after the number would collapse */}
                      {'\u00a0– '}
                      {capFirst(c.control.title)}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <CoverageBadge status={c.status} hidden={c.hidden} />
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {Object.entries(c.counts).map(([k, n]) => (
                        <Badge key={k} size="xs" variant="default">
                          {t(`evidenceKinds.${k as 'run'}`)}: {n}
                        </Badge>
                      ))}
                      {total(c) === 0 && (
                        <Text size="xs" c="dimmed">
                          –
                        </Text>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {c.control.tags
                        .filter((x) => x.visible)
                        .map((x) => x.label)
                        .join(', ') || '–'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
          </Table.Tbody>
        ))}
      </Table>
    </TableScroll>
  );
}

const TAG_KINDS: ControlTagKind[] = ['process', 'recordType', 'record', 'monitor', 'reportSchedule', 'accessCheck'];

function ControlDrawer({ cov, meta, onClose }: { cov: ControlCoverage; meta?: ControlsMeta; onClose: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const qc = useQueryClient();
  const [kind, setKind] = useState<ControlTagKind>('process');
  const [target, setTarget] = useState<string | null>(null);
  const pick = useRemoteSelect({ value: target });
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(cov.control.title);
  const [description, setDescription] = useState(cov.control.description);
  const targets = useQuery({
    queryKey: ['tag-targets', kind, pick.term],
    queryFn: () => get<{ id: string; label: string }[]>(`/compliance/tag-targets?kind=${kind}&q=${encodeURIComponent(pick.term)}`),
    // while the next search loads, the list keeps the last results of the same kind (no flicker of the options)
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === kind ? prev : undefined),
    enabled: !!meta?.canTag,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['control-coverage'] });
  const add = async () => {
    if (!target) return;
    try {
      await post(`/compliance/controls/${cov.control.id}/tags`, { kind, targetId: target });
      setTarget(null);
      await refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (k: ControlTagKind, id: string) => {
    try {
      await post(`/compliance/controls/${cov.control.id}/tags/remove`, { kind: k, targetId: id });
      await refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const save = async () => {
    try {
      await put(`/compliance/controls/${cov.control.id}`, { title, description });
      setEditing(false);
      await refresh();
      notifyOk(t('controls.saved'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={`${cov.control.catalogueKey} ${cov.control.ref} – ${capFirst(cov.control.title)}`}>
      <Stack gap="md">
        <Group gap="xs">
          <CoverageBadge status={cov.status} hidden={cov.hidden} />
          {meta?.canManageCatalogues && !editing && (
            <Button size="xs" variant="subtle" onClick={() => setEditing(true)}>
              {t('controls.editText')}
            </Button>
          )}
        </Group>
        {editing ? (
          <Stack gap="xs">
            <TextInput label={t('controls.titleLabel')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={300} />
            <Textarea
              label={t('controls.descriptionLabel')}
              description={t('controls.descriptionHelp')}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              autosize
              minRows={3}
              maxLength={4000}
            />
            <Group gap="xs">
              <Button size="xs" onClick={save}>
                {t('common:save')}
              </Button>
              <Button size="xs" variant="default" onClick={() => setEditing(false)}>
                {t('common:cancel')}
              </Button>
            </Group>
          </Stack>
        ) : (
          cov.control.description && (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {cov.control.description}
            </Text>
          )
        )}
        <Box>
          <Text fw={600} mb={4}>
            {t('controls.mapped')}
          </Text>
          {cov.control.tags.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('controls.noTags')}
            </Text>
          ) : (
            <Stack gap={4}>
              {cov.control.tags.map((tag, i) => (
                <Group key={`${tag.kind}:${tag.targetId ?? `hidden-${i}`}`} justify="space-between" wrap="nowrap">
                  <Text size="sm">
                    <Badge size="xs" variant="default" mr={6}>
                      {t(`tagKinds.${tag.kind}`)}
                    </Badge>
                    {tag.visible && tag.path ? (
                      <Anchor component={Link} to={tag.path} size="sm">
                        {tag.label}
                      </Anchor>
                    ) : (
                      <Text span c="dimmed" size="sm">
                        {t('controls.notVisible')}
                      </Text>
                    )}
                    {tag.suggestion && (
                      <Text span size="xs" c="dimmed" display="block">
                        {t('controls.suggested', { user: tag.suggestion.requestedBy, token: tag.suggestion.tokenName, by: tag.suggestion.acceptedBy })}
                      </Text>
                    )}
                  </Text>
                  {/* items the reader may not see have no id here and cannot be removed by them */}
                  {meta?.canTag && tag.targetId && (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('controls.removeTag', { label: tag.label || tag.targetId })}
                      onClick={() => remove(tag.kind, tag.targetId!)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  )}
                </Group>
              ))}
            </Stack>
          )}
          {meta?.canTag && (
            <Paper withBorder p="xs" mt="sm">
              <Stack gap="xs">
                <Select
                  size="xs"
                  label={t('controls.tagKind')}
                  allowDeselect={false}
                  data={TAG_KINDS.map((k) => ({ value: k, label: t(`tagKinds.${k}`) }))}
                  value={kind}
                  onChange={(v) => {
                    setKind((v as ControlTagKind) ?? 'process');
                    setTarget(null);
                  }}
                />
                <Select
                  size="xs"
                  label={t('controls.tagTarget')}
                  searchable
                  searchValue={pick.search}
                  onSearchChange={pick.setSearch}
                  data={pick.options((targets.data ?? []).map((x) => ({ value: x.id, label: x.label })))}
                  value={target}
                  onChange={setTarget}
                  nothingFoundMessage={t('controls.nothingFound')}
                />
                <Button size="xs" leftSection={<IconPlus size={14} />} disabled={!target} onClick={add}>
                  {t('controls.addTag')}
                </Button>
              </Stack>
            </Paper>
          )}
        </Box>
        {/* corrective actions (ADR 0029): the open findings that name this control */}
        <ControlFindings controlId={cov.control.id} />
        <Box>
          <Text fw={600} mb={4}>
            {t('controls.evidenceInPeriod')}
          </Text>
          {cov.status === 'notVisible' ? (
            <Text size="sm" c="orange">
              {t('controls.notVisibleText', { count: cov.hidden })}
            </Text>
          ) : cov.evidence.length === 0 ? (
            <Text size="sm" c={cov.status === 'gap' ? 'red' : 'dimmed'}>
              {cov.status === 'gap' ? t('controls.gapText') : t('controls.noEvidence')}
            </Text>
          ) : (
            <EvidenceList items={cov.evidence} />
          )}
          {cov.status === 'covered' && cov.hidden > 0 && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('controls.hiddenMore', { count: cov.hidden })}
            </Text>
          )}
          {cov.truncated > 0 && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('controls.truncated', { count: cov.truncated })}
            </Text>
          )}
        </Box>
      </Stack>
    </Drawer>
  );
}

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  const { t } = useTranslation('compliance');
  return (
    <TableScroll>
      <Table fz="xs" aria-label={t('controls.evidenceInPeriod')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('controls.kind')}</Table.Th>
            <Table.Th>{t('controls.item')}</Table.Th>
            <Table.Th>{t('controls.date')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((e) => (
            <Table.Tr key={`${e.kind}:${e.id}`}>
              <Table.Td>{t(`evidenceKinds.${e.kind}`)}</Table.Td>
              <Table.Td>
                {e.path ? (
                  <Anchor component={Link} to={e.path} size="xs">
                    {e.label}
                  </Anchor>
                ) : (
                  e.label
                )}
                {e.detail === 'afterTheFact' && (
                  <Badge size="xs" color="orange" variant="light" ml={4}>
                    {t('accessChanges.afterTheFact')}
                  </Badge>
                )}
                {e.document && (
                  <Badge size="xs" color="green" variant="light" ml={4} title={e.document.contentHash}>
                    {t('controls.documentEdition', { edition: e.document.edition })}
                  </Badge>
                )}
                {e.document && (
                  <Text span size="xs" c="dimmed" ml={4}>
                    {e.document.lastReviewedAt
                      ? t('controls.documentReviewed', { date: fmtDate(e.document.lastReviewedAt), reviewer: e.document.lastReviewedBy ?? '' })
                      : t('controls.documentApproved', { date: fmtDate(e.document.approvedAt), approver: e.document.approvedBy })}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{fmtDate(e.at)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </TableScroll>
  );
}

function ImportModal({ catalogues, onClose }: { catalogues: ControlCatalogue[]; onClose: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const qc = useQueryClient();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [catalogueId, setCatalogueId] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const content = await file.text();
      const r = await post<{ added: number; updated: number }>('/compliance/catalogues/import', {
        ...(mode === 'existing' ? { catalogueId } : { key: key || undefined, name: name || undefined }),
        filename: file.name,
        content,
      });
      notifyOk(t('controls.imported', { added: r.added, updated: r.updated }));
      await qc.invalidateQueries({ queryKey: ['control-catalogues'] });
      await qc.invalidateQueries({ queryKey: ['control-coverage'] });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('controls.import')} size="lg">
      <Stack gap="sm">
        <Text size="sm">{t('controls.importHelp')}</Text>
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as 'new')}
          data={[
            { value: 'new', label: t('controls.importNew') },
            { value: 'existing', label: t('controls.importExisting') },
          ]}
        />
        {mode === 'existing' ? (
          <Select
            label={t('controls.catalogue')}
            data={catalogues.map((c) => ({ value: c.id, label: c.name }))}
            value={catalogueId}
            onChange={setCatalogueId}
            required
          />
        ) : (
          <Group grow wrap="wrap">
            <TextInput
              label={t('controls.key')}
              description={t('controls.keyHelp')}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              maxLength={40}
            />
            <TextInput label={t('controls.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={120} />
          </Group>
        )}
        <Group gap="xs">
          <FileButton onChange={setFile} accept=".json,.yaml,.yml,.csv,.txt">
            {(props) => (
              <Button variant="default" leftSection={<IconFileImport size={14} />} {...props}>
                {t('controls.chooseFile')}
              </Button>
            )}
          </FileButton>
          {file && (
            <Text size="sm" className="mono">
              {file.name}
            </Text>
          )}
        </Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!file || (mode === 'existing' && !catalogueId)}>
            {t('controls.importAction')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
