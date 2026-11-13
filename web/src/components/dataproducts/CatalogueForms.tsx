import { useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Button, Group, MultiSelect, Paper, Select, SimpleGrid, Stack, Switch, TagsInput, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_DISCOVERY_LIMITS as DL,
  DATA_DISCOVERY_MODES,
  DATA_ELEMENT_KINDS,
  DATA_ELEMENT_KIND_DEFS,
  DATA_PRODUCT_LIMITS as L,
  DEFAULT_DATA_LAYERS,
  elementKindFits,
  type DataDiscoveryMode,
  type DataDiscoverySource,
  type DataDiscoverySourceInput,
  type DataElement,
  type DataElementInput,
  type DataElementKind,
  type DataEnvironmentRule,
  type Platform,
  type Team,
} from '@sm/shared';
import { get, getOptional, post, put } from '../../api';
import { FormModal } from '../FormModal';
import { useFieldErrors } from '../common';
import { ApplicationSelect } from '../catalogue/ApplicationSelect';
import { EnvironmentInput, useEnvironmentList } from '../catalogue/environments';
import { FormButtons, isHttpUrl, useBusy } from './form';

const enc = encodeURIComponent;

/** The platforms discovery reads (Confluent Cloud clusters are read as Kafka platforms). */
export const DISCOVERABLE_PLATFORM_KINDS = ['snowflake', 'kafka', 'database'] as const;

/**
 * An element of the catalogue entered by hand (ADR 0036 part 5) – for what discovery does not read (APIs, file paths,
 * Insights Hub aspects, a Power BI dataset), or before a source reads a platform. Changing a discovered element changes
 * only people's fields: its name and environment are the platform's.
 */
export function ElementForm({ element, onClose, onSaved }: { element?: DataElement; onClose: () => void; onSaved: (e: DataElement) => void }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'common']);
  const e = element;
  const discovered = e?.source === 'discovered';
  const platforms = useQuery({ queryKey: ['dataProducts', 'platforms'], queryFn: () => get<Platform[]>('/platforms'), staleTime: 60_000 });
  const [kind, setKind] = useState<DataElementKind>(e?.kind ?? 'snowflake.table');
  const [platformId, setPlatformId] = useState<string | null>(e?.platformId ?? null);
  const [qualifiedName, setQualifiedName] = useState(e?.qualifiedName ?? '');
  const [displayName, setDisplayName] = useState(e?.displayName ?? '');
  const [environment, setEnvironment] = useState(e?.environment ?? '');
  const [layer, setLayer] = useState(e?.layer ?? '');
  const [description, setDescription] = useState(e?.description ?? '');
  const [typeLabel, setTypeLabel] = useState(e?.typeLabel ?? '');
  const [applicationId, setApplicationId] = useState<string | null>(e?.applicationId ?? null);
  const [apiUrl, setApiUrl] = useState(e?.apiRef?.url ?? '');
  const [operations, setOperations] = useState<string[]>(e?.apiRef?.operations ?? []);
  const [busy, run] = useBusy();
  const def = DATA_ELEMENT_KIND_DEFS[kind];
  const fitting = (platforms.data ?? []).filter((p) => elementKindFits(kind, p.kind));
  const isApi = kind.startsWith('api.');
  const v = useFieldErrors({
    name: !qualifiedName.trim() && t('common:validation.required'),
    platform: def.platformRequired && !platformId && t('elements.platformRequired'),
    apiUrl: !!apiUrl.trim() && !isHttpUrl(apiUrl) && t('common:validation.url'),
  });
  const save = () =>
    run(async () => {
      const apiRef = isApi && (apiUrl.trim() || operations.length) ? { ...(apiUrl.trim() ? { url: apiUrl.trim() } : {}), ...(operations.length ? { operations } : {}) } : null;
      if (e) {
        const body = {
          displayName,
          layer: layer.trim(),
          description,
          typeLabel,
          applicationId,
          apiRef,
          ...(discovered ? {} : { qualifiedName: qualifiedName.trim(), environment: environment.trim() }),
        };
        onSaved(await put<DataElement>(`/data-elements/${enc(e.id)}`, body));
      } else {
        const body: DataElementInput = {
          platformId,
          kind,
          qualifiedName: qualifiedName.trim(),
          displayName,
          environment: environment.trim(),
          layer: layer.trim(),
          description,
          typeLabel,
          applicationId,
          apiRef,
        };
        onSaved(await post<DataElement>('/data-elements', body));
      }
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} size="lg" title={e ? t('elements.editTitle', { name: e.displayName || e.qualifiedName }) : t('elements.newTitle')}>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          {discovered && (
            <Alert color="blue" variant="light">
              {t('elements.discoveredHint')}
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('elements.kind')}
              data={DATA_ELEMENT_KINDS.map((k) => ({ value: k, label: t(`dataProductViews:elementKinds.${k}`) }))}
              value={kind}
              onChange={(k) => {
                if (!k) return;
                setKind(k as DataElementKind);
                if (platformId && !elementKindFits(k as DataElementKind, platforms.data?.find((p) => p.id === platformId)?.kind ?? null)) setPlatformId(null);
              }}
              allowDeselect={false}
              searchable
              disabled={!!e}
              data-testid="element-kind"
            />
            <Select
              label={t('elements.platform')}
              description={def.platformRequired ? undefined : t('elements.platformOptional')}
              data={fitting.map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={(p) => {
                setPlatformId(p);
                const env = platforms.data?.find((x) => x.id === p)?.environment;
                if (env && !environment) setEnvironment(env);
              }}
              clearable={!def.platformRequired}
              searchable
              disabled={!!e}
              error={v.error('platform')}
              placeholder={e?.platformHidden ? t('hidden.platform') : undefined}
              nothingFoundMessage={t('elements.noFittingPlatform')}
              data-testid="element-platform"
            />
          </SimpleGrid>
          <TextInput
            label={t('elements.qualifiedName')}
            description={t(`elements.nameHints.${kind.split('.')[0] as 'snowflake'}`, { defaultValue: t('elements.nameHints.other') })}
            required
            maxLength={L.qualifiedName}
            value={qualifiedName}
            onChange={(x) => setQualifiedName(x.currentTarget.value)}
            error={v.error('name')}
            disabled={discovered}
            className="mono"
            data-autofocus
            data-testid="element-name"
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput label={t('elements.displayName')} maxLength={L.name} value={displayName} onChange={(x) => setDisplayName(x.currentTarget.value)} />
            {discovered ? (
              <TextInput label={t('elements.environment')} value={environment} disabled />
            ) : (
              <EnvironmentInput label={t('elements.environment')} value={environment} onChange={setEnvironment} />
            )}
            <Autocomplete label={t('elements.layer')} data={[...DEFAULT_DATA_LAYERS]} value={layer} onChange={setLayer} maxLength={60} data-testid="element-layer" />
          </SimpleGrid>
          {kind === 'other' && <TextInput label={t('elements.typeLabel')} description={t('elements.typeLabelHint')} maxLength={L.short} value={typeLabel} onChange={(x) => setTypeLabel(x.currentTarget.value)} />}
          {isApi && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  {t('elements.apiHint')}
                </Text>
                <TextInput label={t('elements.apiUrl')} maxLength={L.url} value={apiUrl} onChange={(x) => setApiUrl(x.currentTarget.value)} error={v.error('apiUrl')} />
                <TagsInput label={t('elements.operations')} description={t('elements.operationsHint')} value={operations} onChange={setOperations} maxTags={200} clearable />
              </Stack>
            </Paper>
          )}
          <Textarea label={t('form.description')} autosize minRows={2} maxRows={6} maxLength={L.description} value={description} onChange={(x) => setDescription(x.currentTarget.value)} />
          <ApplicationSelect label={t('elements.application')} description={t('elements.applicationHint')} value={applicationId} onChange={setApplicationId} by="id" />
          <FormButtons busy={busy} submit={e ? undefined : t('elements.create')} testId="element-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

const INTERVALS = [60, 360, 720, 1440, 10080] as const;

/**
 * A discovery source (ADR 0036 part 5): a platform the person may use, what to read (the scope; include and exclude
 * prefixes – plain comparisons, no patterns), environment rules, the Snowflake mode, the identity, the owning teams of
 * what it finds and how often. It runs as the person who saves it.
 */
export function SourceForm({ source, onClose, onSaved }: { source?: DataDiscoverySource; onClose: () => void; onSaved: (s: DataDiscoverySource) => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const s = source;
  const platforms = useQuery({ queryKey: ['dataProducts', 'platforms'], queryFn: () => get<Platform[]>('/platforms'), staleTime: 60_000 });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => getOptional<Team[]>('/teams', []) });
  const [name, setName] = useState(s?.name ?? '');
  const [platformId, setPlatformId] = useState<string | null>(s?.platformId ?? null);
  const [scope, setScope] = useState<string[]>(s?.scope ?? []);
  const [include, setInclude] = useState<string[]>(s?.includePrefixes ?? []);
  const [exclude, setExclude] = useState<string[]>(s?.excludePrefixes ?? []);
  const [rules, setRules] = useState<DataEnvironmentRule[]>(s?.environmentRules ?? []);
  const [mode, setMode] = useState<DataDiscoveryMode | null>(s?.mode ?? null);
  const [identityId, setIdentityId] = useState<string | null>(s?.identityId ?? null);
  const [teamIds, setTeamIds] = useState<string[]>(s?.elementTeamIds ?? []);
  const [interval, setInterval] = useState<string>(String(s?.intervalMinutes ?? DL.intervalMinutes.default));
  const [enabled, setEnabled] = useState(s?.enabled ?? true);
  const environments = useEnvironmentList();
  const [busy, run] = useBusy();
  const usable = (platforms.data ?? []).filter(
    (p) => (DISCOVERABLE_PLATFORM_KINDS as readonly string[]).includes(p.kind) && (p.permissions.includes('use') || p.id === s?.platformId),
  );
  const platform = (platforms.data ?? []).find((p) => p.id === platformId);
  const kind = platform?.kind;
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    platform: !platformId && t('common:validation.required'),
    scope: kind === 'snowflake' && !scope.length && t('discovery.scopeSnowflakeRequired'),
    rules: rules.some((r) => !r.value.trim() || !r.environment.trim()) && t('discovery.rulesIncomplete'),
  });
  const save = () =>
    run(async () => {
      const body: DataDiscoverySourceInput = {
        name: name.trim(),
        platformId: platformId!,
        scope,
        includePrefixes: include,
        excludePrefixes: exclude,
        environmentRules: rules.map((r) => ({ ...r, value: r.value.trim(), environment: r.environment.trim() })),
        mode: kind === 'snowflake' ? (mode ?? 'informationSchema') : null,
        identityId,
        elementTeamIds: teamIds,
        intervalMinutes: Number(interval),
        enabled,
      };
      onSaved(
        s
          ? await put<DataDiscoverySource>(`/data-products/discovery-sources/${enc(s.id)}`, body)
          : await post<DataDiscoverySource>('/data-products/discovery-sources', body),
      );
    }, t('form.notSaved'));
  const setRule = (i: number, patch: Partial<DataEnvironmentRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <FormModal onClose={onClose} size="lg" title={s ? t('discovery.editTitle', { name: s.name }) : t('discovery.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('discovery.formHelp')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('form.name')} required maxLength={L.name} value={name} onChange={(e) => setName(e.currentTarget.value)} error={v.error('name')} data-autofocus data-testid="source-name" />
            <Select
              label={t('discovery.platform')}
              description={t('discovery.platformHint')}
              data={usable.map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={(p) => {
                setPlatformId(p);
                setIdentityId(null);
              }}
              searchable
              disabled={!!s}
              error={v.error('platform')}
              nothingFoundMessage={t('discovery.noPlatform')}
              data-testid="source-platform"
            />
          </SimpleGrid>
          {kind && (
            <TagsInput
              label={t('discovery.scope')}
              description={t(`discovery.scopeHints.${kind as 'snowflake'}`)}
              value={scope}
              onChange={setScope}
              maxTags={DL.scope}
              clearable
              error={v.error('scope')}
              data-testid="source-scope"
            />
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TagsInput label={t('discovery.include')} description={t('discovery.includeHint')} value={include} onChange={setInclude} maxTags={DL.prefixes} clearable />
            <TagsInput label={t('discovery.exclude')} description={t('discovery.excludeHint')} value={exclude} onChange={setExclude} maxTags={DL.prefixes} clearable />
          </SimpleGrid>
          <Paper withBorder p="sm">
            <Text size="sm" fw={600}>
              {t('discovery.rules')}
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              {t('discovery.rulesHint')}
            </Text>
            <Stack gap={6}>
              {rules.map((r, i) => (
                <Group key={i} gap="xs" wrap="wrap" align="flex-start">
                  <Select
                    size="xs"
                    aria-label={t('discovery.ruleMatch')}
                    data={(['prefix', 'suffix'] as const).map((m) => ({ value: m, label: t(`discovery.ruleMatches.${m}`) }))}
                    value={r.match}
                    onChange={(m) => m && setRule(i, { match: m as 'prefix' | 'suffix' })}
                    allowDeselect={false}
                    w={120}
                  />
                  <TextInput size="xs" aria-label={t('discovery.ruleValue')} placeholder={t('discovery.ruleValue')} maxLength={100} value={r.value} onChange={(e) => setRule(i, { value: e.currentTarget.value })} style={{ flex: '1 1 120px' }} />
                  <Autocomplete
                    size="xs"
                    aria-label={t('discovery.ruleEnvironment')}
                    placeholder={t('discovery.ruleEnvironment')}
                    data={environments.map((x) => x.name)}
                    maxLength={60}
                    value={r.environment}
                    onChange={(env) => setRule(i, { environment: env })}
                    style={{ flex: '1 1 120px' }}
                  />
                  <Tooltip label={t('discovery.ruleRemove')}>
                    <ActionIcon variant="subtle" color="red" aria-label={t('discovery.ruleRemove')} onClick={() => setRules(rules.filter((_, j) => j !== i))} mt={2}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
              {v.error('rules') && (
                <Text size="xs" c="red">
                  {v.error('rules')}
                </Text>
              )}
              {rules.length < DL.environmentRules && (
                <Group>
                  <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setRules([...rules, { match: 'suffix', value: '', environment: '' }])}>
                    {t('discovery.ruleAdd')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Paper>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {kind === 'snowflake' && (
              <Select
                label={t('discovery.mode')}
                description={t(`discovery.modeHints.${mode ?? 'informationSchema'}`)}
                data={DATA_DISCOVERY_MODES.map((m) => ({ value: m, label: t(`discovery.modes.${m}`) }))}
                value={mode ?? 'informationSchema'}
                onChange={(m) => m && setMode(m as DataDiscoveryMode)}
                allowDeselect={false}
              />
            )}
            {platform && (platform.identities?.length ?? 0) > 1 && (
              <Select
                label={t('discovery.identity')}
                description={t('discovery.identityHint')}
                data={(platform.identities ?? []).filter((i) => !i.privileged).map((i) => ({ value: i.id, label: i.default ? t('discovery.identityDefault', { name: i.name }) : i.name }))}
                value={identityId}
                onChange={setIdentityId}
                clearable
                placeholder={t('discovery.identityPlatform')}
              />
            )}
            <MultiSelect
              label={t('discovery.teams')}
              description={t('discovery.teamsHint')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={teamIds}
              onChange={setTeamIds}
              searchable
              clearable
              maxValues={DL.elementTeams}
            />
            <Select
              label={t('discovery.interval')}
              data={INTERVALS.map((m) => ({ value: String(m), label: t(`discovery.intervals.${m}`) }))}
              value={INTERVALS.includes(Number(interval) as (typeof INTERVALS)[number]) ? interval : String(DL.intervalMinutes.default)}
              onChange={(m) => m && setInterval(m)}
              allowDeselect={false}
            />
          </SimpleGrid>
          <Switch label={t('discovery.enabled')} description={t('discovery.enabledHint')} checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <Text size="xs" c="dimmed">
            {t('discovery.runsAs')}
          </Text>
          <FormButtons busy={busy} testId="source-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
