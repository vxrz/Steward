import { useState } from 'react';
import { ActionIcon, Button, Group, MultiSelect, Paper, SegmentedControl, Select, Stack, Switch, Text, TextInput, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_LINEAGE_LIMITS as LL,
  DATA_LINEAGE_SOURCE_KINDS,
  type DataLineageNamespaceAlias,
  type DataLineageSource,
  type DataLineageSourceInput,
  type DataLineageSourceKind,
  type Platform,
  type Team,
} from '@sm/shared';
import { get, getOptional, post, put } from '../../../api';
import { FormModal } from '../../../components/FormModal';
import { useFieldErrors } from '../../../components/common';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';

const enc = encodeURIComponent;
const NAMESPACE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * A lineage source (0.24.0): its kind (OpenLineage or dbt – kept once saved), the platform of a dbt source, namespace
 * aliases for tools that name a platform differently from discovery, owning teams and whether it takes pushes.
 */
export function LineageSourceForm({ source, onClose, onSaved }: { source?: DataLineageSource; onClose: () => void; onSaved: (s: DataLineageSource) => void }) {
  const { t } = useTranslation(['dataLineage', 'common']);
  const s = source;
  const platforms = useQuery({ queryKey: ['dataProducts', 'platforms'], queryFn: () => get<Platform[]>('/platforms'), staleTime: 60_000 });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => getOptional<Team[]>('/teams', []) });
  const [name, setName] = useState(s?.name ?? '');
  const [kind, setKind] = useState<DataLineageSourceKind>(s?.kind ?? 'openlineage');
  const [platformId, setPlatformId] = useState<string | null>(s?.platformId ?? null);
  const [aliases, setAliases] = useState<DataLineageNamespaceAlias[]>(s?.namespaceAliases ?? []);
  const [teamIds, setTeamIds] = useState<string[] | null>(s ? s.teamIds : null);
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const [busy, run] = useBusy();
  const usable = (platforms.data ?? []).filter((p) => p.kind === 'snowflake' || p.kind === 'database');
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    platform: kind === 'dbt' && !platformId && t('common:validation.required'),
    aliases: aliases.some((a) => !NAMESPACE_RE.test(a.from.trim()) || !NAMESPACE_RE.test(a.to.trim())) && t('form.aliasInvalid'),
  });
  const save = () =>
    run(async () => {
      const body: DataLineageSourceInput = {
        name: name.trim(),
        kind,
        platformId: kind === 'dbt' ? platformId : null,
        namespaceAliases: aliases.map((a) => ({ from: a.from.trim(), to: a.to.trim() })),
        // left out on a new source: the creator's teams
        ...(teamIds ? { teamIds } : {}),
        enabled,
      };
      onSaved(
        s
          ? await put<DataLineageSource>(`/data-products/lineage-sources/${enc(s.id)}`, body)
          : await post<DataLineageSource>('/data-products/lineage-sources', body),
      );
    }, t('form.notSaved'));
  const setAlias = (i: number, patch: Partial<DataLineageNamespaceAlias>) => setAliases(aliases.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <FormModal onClose={onClose} size="lg" title={s ? t('form.editTitle', { name: s.name }) : t('form.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('form.name')}
            required
            maxLength={LL.name}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={v.error('name')}
            data-autofocus
            data-testid="lineage-source-name"
          />
          <Stack gap={4}>
            <Text size="sm" fw={500} id="lineage-kind-label">
              {t('form.kind')}
            </Text>
            <SegmentedControl
              aria-labelledby="lineage-kind-label"
              data={DATA_LINEAGE_SOURCE_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
              value={kind}
              onChange={(k) => setKind(k as DataLineageSourceKind)}
              disabled={!!s}
              data-testid="lineage-source-kind"
            />
            <Text size="xs" c="dimmed">
              {t(`kindHints.${kind}`)}
            </Text>
          </Stack>
          {kind === 'dbt' && (
            <Select
              label={t('form.platform')}
              description={t('form.platformHint')}
              required
              data={usable.map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              searchable
              error={v.error('platform')}
              nothingFoundMessage={t('form.noPlatform')}
              data-testid="lineage-source-platform"
            />
          )}
          <Paper withBorder p="sm">
            <Text size="sm" fw={600}>
              {t('form.aliases')}
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              {t('form.aliasesHint')}
            </Text>
            <Stack gap={6}>
              {aliases.map((a, i) => (
                <Group key={i} gap="xs" wrap="wrap" align="flex-start">
                  <TextInput
                    size="xs"
                    aria-label={t('form.aliasFrom')}
                    placeholder={t('form.aliasFrom')}
                    maxLength={500}
                    value={a.from}
                    onChange={(e) => setAlias(i, { from: e.currentTarget.value })}
                    style={{ flex: '1 1 200px' }}
                    className="mono"
                  />
                  <TextInput
                    size="xs"
                    aria-label={t('form.aliasTo')}
                    placeholder={t('form.aliasTo')}
                    maxLength={500}
                    value={a.to}
                    onChange={(e) => setAlias(i, { to: e.currentTarget.value })}
                    style={{ flex: '1 1 200px' }}
                    className="mono"
                  />
                  <Tooltip label={t('form.aliasRemove')}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('form.aliasRemove')}
                      onClick={() => setAliases(aliases.filter((_, j) => j !== i))}
                      mt={2}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
              {v.error('aliases') && (
                <Text size="xs" c="red">
                  {v.error('aliases')}
                </Text>
              )}
              {aliases.length < LL.namespaceAliases && (
                <Group>
                  <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setAliases([...aliases, { from: '', to: '' }])}>
                    {t('form.aliasAdd')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Paper>
          <MultiSelect
            label={t('form.teams')}
            description={t('form.teamsHint')}
            data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            value={teamIds ?? []}
            onChange={setTeamIds}
            searchable
            clearable
            maxValues={LL.teams}
          />
          <Switch label={t('form.enabled')} description={t('form.enabledHint')} checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <FormButtons busy={busy} testId="lineage-source-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
