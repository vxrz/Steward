import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Group, Paper, Radio, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_COLORS,
  CIA_DIMENSIONS,
  CIA_LEVEL_KEY_RE,
  CIA_LIMITS,
  DEFAULT_CIA_LEVELS,
  type CiaColor,
  type CiaDimension,
  type CiaLevel,
  type CiaScale,
  type CiaScaleMode,
} from '@sm/shared';
import { notifyError, notifyOk, put } from '../api';
import { DetailState, PageHeader } from '../components/common';
import { fmtDate } from '../format';
import { levelText, useCiaScale } from '../components/catalogue/cia';

type Levels = Record<CiaDimension, CiaLevel[]>;
const FLAG = '__flag';

/** The CIA scale: everyone reads it; administrators choose the BSI default or their own levels, and map removed ones. */
export function CiaScalePage() {
  const { t } = useTranslation(['applications', 'common']);
  const q = useCiaScale();
  const [editing, setEditing] = useState(false);
  const s = q.data;
  if (!s) return <DetailState query={q} back="applications" />;
  return (
    <>
      <PageHeader
        back="applications"
        title={t('scale.title')}
        description={t('scale.description')}
        actions={
          s.canEdit &&
          !editing && (
            <Button size="xs" onClick={() => setEditing(true)}>
              {t('scale.edit')}
            </Button>
          )
        }
      />
      {editing ? (
        <ScaleEditor scale={s} onDone={() => setEditing(false)} />
      ) : (
        <Stack gap="md">
          <Text size="sm">
            {t('scale.mode')}: {t(`scale.modes.${s.mode}`)}
            {s.updatedBy && s.updatedAt && ` · ${t('scale.updated', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}`}
          </Text>
          {!s.canEdit && (
            <Text size="xs" c="dimmed">
              {t('scale.readOnly')}
            </Text>
          )}
          {(s.mode === 'perDimension' ? CIA_DIMENSIONS : (['confidentiality'] as const)).map((d) => (
            <Stack key={d} gap="xs">
              {s.mode === 'perDimension' && <Text fw={600}>{t(`cia.dimensions.${d}`)}</Text>}
              <div className="table-scroll">
                <Table fz="sm" aria-label={s.mode === 'perDimension' ? t(`cia.dimensions.${d}`) : t('scale.levels')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('scale.label')}</Table.Th>
                      <Table.Th>{t('scale.key')}</Table.Th>
                      <Table.Th>{t('scale.levelDescription')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {s.levels[d].map((l) => {
                      const x = levelText(t, s, l);
                      return (
                        <Table.Tr key={l.key}>
                          <Table.Td>
                            <Badge color={l.color} variant="light" tt="none">
                              {x.label}
                            </Badge>
                          </Table.Td>
                          <Table.Td className="mono">{l.key}</Table.Td>
                          <Table.Td>{x.description || '–'}</Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </div>
            </Stack>
          ))}
          <Text size="xs" c="dimmed">
            {t('scale.lowestFirst')}
          </Text>
        </Stack>
      )}
    </>
  );
}

const copy = (ls: readonly CiaLevel[]) => ls.map((l) => ({ ...l }));

function ScaleEditor({ scale, onDone }: { scale: CiaScale; onDone: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const [mode, setMode] = useState<CiaScaleMode>(scale.mode);
  // custom levels start from what is in use (the default levels in their stored, English form)
  const [shared, setShared] = useState<CiaLevel[]>(copy(scale.levels.confidentiality));
  const [dims, setDims] = useState<Levels>({
    confidentiality: copy(scale.levels.confidentiality),
    integrity: copy(scale.levels.integrity),
    availability: copy(scale.levels.availability),
  });
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const next: Levels =
    mode === 'default'
      ? { confidentiality: copy(DEFAULT_CIA_LEVELS), integrity: copy(DEFAULT_CIA_LEVELS), availability: copy(DEFAULT_CIA_LEVELS) }
      : mode === 'shared'
        ? { confidentiality: shared, integrity: shared, availability: shared }
        : dims;
  // levels in use that the new scale no longer has: map them or flag their ratings
  const removed = CIA_DIMENSIONS.flatMap((d) =>
    Object.entries(scale.usage[d])
      .filter(([key, n]) => n > 0 && !next[d].some((l) => l.key === key))
      .map(([key, n]) => ({
        d,
        key,
        n,
        label: scale.levels[d].find((l) => l.key === key)
          ? levelText(
              t,
              scale,
              scale.levels[d].find((l) => l.key === key)!,
            ).label
          : key,
      })),
  );
  const valid = (ls: CiaLevel[]) =>
    ls.length >= CIA_LIMITS.minLevels && ls.every((l) => CIA_LEVEL_KEY_RE.test(l.key) && l.label.trim()) && new Set(ls.map((l) => l.key)).size === ls.length;
  const ok = mode === 'default' || (mode === 'shared' ? valid(shared) : CIA_DIMENSIONS.every((d) => valid(dims[d])));
  const save = async () => {
    if (!ok) return;
    setBusy(true);
    // removed levels mapped to a new one; the others are flagged for re-rating by the server
    const target = (d: CiaDimension, key: string) => mapping[`${d}:${key}`];
    const map = Object.fromEntries(
      CIA_DIMENSIONS.map((d) => [
        d,
        Object.fromEntries(removed.filter((r) => r.d === d && target(d, r.key) && target(d, r.key) !== FLAG).map((r) => [r.key, target(d, r.key)!])),
      ]),
    );
    const clean = (ls: CiaLevel[]) => ls.map((l) => ({ key: l.key.trim(), label: l.label.trim(), description: l.description.trim(), color: l.color }));
    try {
      const body =
        mode === 'default'
          ? { mode, mapping: map }
          : mode === 'shared'
            ? { mode, levels: clean(shared), mapping: map }
            : {
                mode,
                dimensions: { confidentiality: clean(dims.confidentiality), integrity: clean(dims.integrity), availability: clean(dims.availability) },
                mapping: map,
              };
      qc.setQueryData(['cia-scale'], await put<CiaScale>('/catalogue/cia-scale', body));
      void qc.invalidateQueries({ queryKey: ['applications'] });
      void qc.invalidateQueries({ queryKey: ['application'] });
      void qc.invalidateQueries({ queryKey: ['services'] });
      void qc.invalidateQueries({ queryKey: ['service'] });
      notifyOk(t('scale.saved'));
      onDone();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Stack gap="md">
        <Radio.Group label={t('scale.mode')} value={mode} onChange={(v) => setMode(v as CiaScaleMode)}>
          <Stack gap={6} mt={4}>
            {(['default', 'shared', 'perDimension'] as const).map((m) => (
              <Radio key={m} value={m} label={t(`scale.modes.${m}`)} />
            ))}
          </Stack>
        </Radio.Group>
        {mode === 'shared' && <LevelsEditor title={t('scale.levels')} levels={shared} onChange={setShared} />}
        {mode === 'perDimension' &&
          CIA_DIMENSIONS.map((d) => (
            <LevelsEditor key={d} title={t(`cia.dimensions.${d}`)} levels={dims[d]} onChange={(ls) => setDims((x) => ({ ...x, [d]: ls }))} />
          ))}
        {!ok && (
          <Alert color="red" variant="light">
            {t('scale.invalid')}
          </Alert>
        )}
        {removed.length > 0 && (
          <Paper withBorder p="sm" data-testid="scale-mapping">
            <Stack gap="xs">
              <Text fw={600}>{t('scale.mappingTitle')}</Text>
              <Text size="xs" c="dimmed">
                {t('scale.mappingHelp')}
              </Text>
              {removed.map((r) => (
                <Select
                  key={`${r.d}:${r.key}`}
                  label={t('scale.mapTo', { label: r.label, dimension: t(`cia.dimensions.${r.d}`) })}
                  description={t('scale.usage', { count: r.n })}
                  data={[
                    { value: FLAG, label: t('scale.flag') },
                    ...next[r.d]
                      .filter((l) => l.key)
                      .map((l) => ({ value: l.key, label: mode === 'default' ? levelText(t, { mode }, l).label : l.label || l.key })),
                  ]}
                  value={mapping[`${r.d}:${r.key}`] ?? FLAG}
                  onChange={(v) => setMapping((m) => ({ ...m, [`${r.d}:${r.key}`]: v ?? FLAG }))}
                  allowDeselect={false}
                />
              ))}
            </Stack>
          </Paper>
        )}
        <Text size="xs" c="dimmed">
          {t('scale.lowestFirst')}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onDone}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={!ok}>
            {t('scale.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

function LevelsEditor({ title, levels, onChange }: { title: string; levels: CiaLevel[]; onChange: (ls: CiaLevel[]) => void }) {
  const { t } = useTranslation('applications');
  const set = (i: number, patch: Partial<CiaLevel>) => onChange(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, by: number) => {
    const out = [...levels];
    const [x] = out.splice(i, 1);
    out.splice(i + by, 0, x!);
    onChange(out);
  };
  return (
    <Paper withBorder p="sm">
      <Stack gap="xs">
        <Text fw={600}>{title}</Text>
        {levels.map((l, i) => {
          const name = l.label || l.key || String(i + 1);
          return (
            <Group key={i} align="flex-end" gap="xs" wrap="wrap">
              <TextInput
                size="xs"
                label={t('scale.label')}
                value={l.label}
                onChange={(e) => set(i, { label: e.currentTarget.value })}
                maxLength={CIA_LIMITS.label}
                required
                style={{ flex: '2 1 140px' }}
              />
              <TextInput
                size="xs"
                label={t('scale.key')}
                description={i === 0 ? t('scale.keyHelp') : undefined}
                value={l.key}
                onChange={(e) => set(i, { key: e.currentTarget.value.toLowerCase() })}
                maxLength={32}
                required
                error={l.key && !CIA_LEVEL_KEY_RE.test(l.key) ? true : undefined}
                style={{ flex: '1 1 110px' }}
              />
              <TextInput
                size="xs"
                label={t('scale.levelDescription')}
                value={l.description}
                onChange={(e) => set(i, { description: e.currentTarget.value })}
                maxLength={CIA_LIMITS.description}
                style={{ flex: '3 1 200px' }}
              />
              <Select
                size="xs"
                label={t('scale.color')}
                data={CIA_COLORS.map((c) => ({ value: c, label: t(`scale.colors.${c}`) }))}
                value={l.color}
                onChange={(v) => v && set(i, { color: v as CiaColor })}
                allowDeselect={false}
                style={{ flex: '1 1 110px' }}
              />
              <Group gap={2} wrap="nowrap" mb={2}>
                <ActionIcon variant="subtle" aria-label={t('scale.moveUp', { label: name })} disabled={i === 0} onClick={() => move(i, -1)}>
                  <IconArrowUp size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" aria-label={t('scale.moveDown', { label: name })} disabled={i === levels.length - 1} onClick={() => move(i, 1)}>
                  <IconArrowDown size={16} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('scale.removeLevel', { label: name })}
                  disabled={levels.length <= CIA_LIMITS.minLevels}
                  onClick={() => onChange(levels.filter((_, j) => j !== i))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
          );
        })}
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          w="fit-content"
          disabled={levels.length >= CIA_LIMITS.maxLevels}
          onClick={() => onChange([...levels, { key: '', label: '', description: '', color: 'gray' }])}
        >
          {t('scale.addLevel')}
        </Button>
      </Stack>
    </Paper>
  );
}
