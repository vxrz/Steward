import { useEffect, useState } from 'react';
import { ActionIcon, Autocomplete, Badge, Button, Card, Checkbox, Group, Select, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_COLORS,
  DEFAULT_ENVIRONMENTS,
  ENVIRONMENT_LIMITS,
  environmentRank,
  isProductionEnvironment,
  type CatalogueEnvironment,
  type CiaColor,
  type EnvironmentSettings,
} from '@sm/shared';
import { get, notifyError, put } from '../../api';

/**
 * The environments of the catalogue (#129): the ordered list from the settings, a badge in the environment's colour,
 * an input that offers the list and keeps free text, and the editor for administrators.
 */

export function useEnvironments() {
  return useQuery({ queryKey: ['catalogue-environments'], queryFn: () => get<EnvironmentSettings>('/catalogue/environments'), staleTime: 60_000 });
}

/** The list in use (the defaults until it is loaded). */
export function useEnvironmentList(): CatalogueEnvironment[] {
  return useEnvironments().data?.environments ?? [...DEFAULT_ENVIRONMENTS];
}

/** Sorts in list order; '' (all environments) last. */
export function sortByEnvironment<T>(list: readonly CatalogueEnvironment[], xs: T[], env: (x: T) => string): T[] {
  return [...xs].sort((a, b) => environmentRank(list, env(a)) - environmentRank(list, env(b)) || env(a).localeCompare(env(b)));
}

/** An environment as a badge; empty: "all environments" (or nothing with `hideEmpty`). */
export function EnvironmentBadge({ value, hideEmpty, size = 'sm' }: { value: string; hideEmpty?: boolean; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('applications');
  const list = useEnvironmentList();
  if (!value) {
    if (hideEmpty) return null;
    return (
      <Badge size={size} variant="outline" color="gray" data-testid="environment-badge">
        {t('environments.all')}
      </Badge>
    );
  }
  const e = list.find((x) => x.name.toLowerCase() === value.toLowerCase());
  const production = isProductionEnvironment(list, value);
  const badge = (
    <Badge size={size} variant={production ? 'filled' : 'light'} color={e?.color ?? 'gray'} data-testid="environment-badge">
      {value}
    </Badge>
  );
  return production ? <Tooltip label={t('environments.production')}>{badge}</Tooltip> : badge;
}

/** Choose an environment from the list or type another one. */
export function EnvironmentInput({
  value,
  onChange,
  label,
  description,
  allowAll,
  size,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  description?: string;
  /** Empty means "all environments" (components) */
  allowAll?: boolean;
  size?: 'xs' | 'sm';
}) {
  const { t } = useTranslation('applications');
  const list = useEnvironmentList();
  return (
    <Autocomplete
      size={size}
      label={label ?? t('environments.label')}
      description={description}
      placeholder={allowAll ? t('environments.allPlaceholder') : t('environments.placeholder')}
      data={list.map((e) => e.name)}
      value={value}
      maxLength={ENVIRONMENT_LIMITS.name}
      onChange={onChange}
    />
  );
}

/** Settings → Environments: the ordered list, its colours and which ones count as production. */
export function EnvironmentsCard() {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const q = useEnvironments();
  const [rows, setRows] = useState<CatalogueEnvironment[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && rows === null) setRows(q.data.environments);
  }, [q.data, rows]);
  if (!q.data || !rows) return null;
  const canEdit = q.data.canEdit;
  const patchRow = (i: number, p: Partial<CatalogueEnvironment>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setRows(next);
  };
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const twice = (i: number) => !!names[i] && names.indexOf(names[i]!) !== i;
  const invalid = rows.some((r, i) => !r.name.trim() || twice(i));
  const save = async () => {
    setBusy(true);
    try {
      const r = await put<EnvironmentSettings>('/catalogue/environments', { environments: rows.map((x) => ({ ...x, name: x.name.trim() })) });
      qc.setQueryData(['catalogue-environments'], r);
      setRows(r.environments);
      notifications.show({ color: 'green', message: t('environments.saved') });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const adopt = (name: string) => setRows([...rows, { name, color: null, production: false }]);
  const listed = new Set(names);
  return (
    <Card withBorder id="environments" data-testid="environments-card">
      <Title order={5} mb={4}>
        {t('environments.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('environments.help')}
      </Text>
      <Stack gap="xs">
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('environments.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('environments.name')}</Table.Th>
                <Table.Th>{t('environments.color')}</Table.Th>
                <Table.Th>{t('environments.productionColumn')}</Table.Th>
                {canEdit && <Table.Th aria-label={t('components.actions')} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      aria-label={t('environments.name')}
                      value={r.name}
                      maxLength={ENVIRONMENT_LIMITS.name}
                      readOnly={!canEdit}
                      error={!r.name.trim() ? t('common:validation.required') : twice(i) ? t('environments.twice') : undefined}
                      onChange={(e) => patchRow(i, { name: e.currentTarget.value })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      aria-label={t('environments.color')}
                      placeholder={t('environments.noColor')}
                      data={CIA_COLORS.map((c) => ({ value: c, label: c }))}
                      value={r.color}
                      clearable
                      clearButtonProps={{ 'aria-label': t('environments.clearColor', { name: r.name }) }}
                      disabled={!canEdit}
                      onChange={(c) => patchRow(i, { color: (c as CiaColor | null) ?? null })}
                      leftSection={r.color ? <Badge size="xs" circle color={r.color} aria-hidden /> : undefined}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Checkbox
                      aria-label={t('environments.productionFor', { name: r.name })}
                      checked={r.production}
                      disabled={!canEdit}
                      onChange={(e) => patchRow(i, { production: e.currentTarget.checked })}
                    />
                  </Table.Td>
                  {canEdit && (
                    <Table.Td className="nowrap">
                      <Group gap={0} wrap="nowrap">
                        <ActionIcon variant="subtle" aria-label={t('environments.up', { name: r.name })} disabled={i === 0} onClick={() => move(i, -1)}>
                          <IconArrowUp size={14} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          aria-label={t('environments.down', { name: r.name })}
                          disabled={i === rows.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <IconArrowDown size={14} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('environments.remove', { name: r.name })}
                          onClick={() => setRows(rows.filter((_, j) => j !== i))}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {q.data.unlisted.filter((u) => !listed.has(u.name.toLowerCase())).length > 0 && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('environments.unlisted')}
            </Text>
            <Group gap={6}>
              {q.data.unlisted
                .filter((u) => !listed.has(u.name.toLowerCase()))
                .map((u) => (
                  <Button key={u.name} size="compact-xs" variant="light" disabled={!canEdit} leftSection={<IconPlus size={12} />} onClick={() => adopt(u.name)}>
                    {t('environments.adopt', { name: u.name, count: u.count })}
                  </Button>
                ))}
            </Group>
          </Stack>
        )}
        {canEdit && (
          <Group justify="space-between">
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              disabled={rows.length >= ENVIRONMENT_LIMITS.max}
              onClick={() => setRows([...rows, { name: '', color: null, production: false }])}
            >
              {t('environments.add')}
            </Button>
            <Button size="xs" loading={busy} disabled={invalid} onClick={() => void save()}>
              {t('environments.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
