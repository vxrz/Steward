import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconEdit, IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  AI_FORMATS,
  AI_FORMAT_PATHS,
  AI_MODELS_PATH,
  ANTHROPIC_VERSION,
  emptyAiSettings,
  modelInputCeiling,
  type AiAllowedData,
  type AiDiscoveredModel,
  type AiFormat,
  type AiGatewaySettings,
  type AiModel,
  type Platform,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { fmtNumber } from '../../format';
import { platformKeys } from '../../queryKeys';
import { DataTable, type DataColumn } from '../DataTable';
import { EmptyState } from '../common';
import { confirmDialog } from '../confirm';

/**
 * Platform → AI models (LLM gateways, 0.6.0, docs/AI.md): the models processes may ask – each with its request format,
 * limits and optional prices – read from the gateway's model list or entered by hand, and the data the gateway may be
 * sent. Saved with the platform's "manage" right; part of its sealed connection settings.
 */
export function AiModelsTab({ platform, readOnly }: { platform: Platform; readOnly: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const settings: AiGatewaySettings = platform.config.ai ?? emptyAiSettings();
  const [editing, setEditing] = useState<{ model: AiModel | null; index: number | null } | null>(null);
  const [discover, setDiscover] = useState(false);

  const save = async (next: AiGatewaySettings, ok: string) => {
    try {
      await put(`/platforms/${platform.id}/ai`, next);
      await qc.invalidateQueries({ queryKey: platformKeys.detail(platform.id) });
      await qc.invalidateQueries({ queryKey: platformKeys.all });
      notifyOk(ok);
      return true;
    } catch (e) {
      notifyError(e, t('ai.notSaved'));
      return false;
    }
  };
  const remove = async (m: AiModel) => {
    if (!(await confirmDialog({ action: 'remove', title: t('ai.removeModel'), message: t('ai.removeModelText', { model: m.label || m.id }) }))) return;
    await save({ ...settings, models: settings.models.filter((x) => x.id !== m.id) }, t('ai.modelRemoved', { model: m.id }));
  };

  const columns: DataColumn<AiModel>[] = [
    {
      key: 'model',
      header: t('ai.columns.model'),
      sortValue: (m) => m.label || m.id,
      cell: (m) => (
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {m.label || m.id}
          </Text>
          {m.label && (
            <Text size="xs" c="dimmed" className="mono">
              {m.id}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: 'format', header: t('ai.columns.format'), sortValue: (m) => m.format, nowrap: true, cell: (m) => <FormatBadge format={m.format} /> },
    { key: 'context', header: t('ai.columns.context'), sortValue: (m) => m.contextTokens, nowrap: true, cell: (m) => fmtNumber(m.contextTokens) },
    {
      key: 'limits',
      header: t('ai.columns.limits'),
      nowrap: true,
      cell: (m) => t('ai.limitsCell', { input: fmtNumber(modelInputCeiling(m)), output: fmtNumber(m.maxOutputTokens) }),
    },
    { key: 'price', header: t('ai.columns.price'), nowrap: true, cell: (m) => <Price model={m} /> },
    ...(readOnly
      ? []
      : [
          {
            key: 'actions',
            header: <VisuallyHidden>{t('ai.columns.actions')}</VisuallyHidden>,
            label: t('ai.columns.actions'),
            cell: (m: AiModel) => actions(m),
          },
        ]),
  ];
  const actions = (m: AiModel) => (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      <Tooltip label={t('ai.editModel')}>
        <ActionIcon
          variant="subtle"
          aria-label={t('ai.editModelNamed', { model: m.id })}
          onClick={() => setEditing({ model: m, index: settings.models.indexOf(m) })}
        >
          <IconEdit size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('ai.removeModel')}>
        <ActionIcon variant="subtle" color="red" aria-label={t('ai.removeModelNamed', { model: m.id })} onClick={() => remove(m)}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  return (
    <Stack maw={1100} data-testid="ai-models-tab">
      <Text size="sm">{t('ai.intro')}</Text>
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Title order={4}>{t('ai.models')}</Title>
        {!readOnly && (
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={() => setDiscover(true)}>
              {t('ai.discover')}
            </Button>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({ model: null, index: null })}>
              {t('ai.addModel')}
            </Button>
          </Group>
        )}
      </Group>
      {settings.models.length === 0 ? (
        <EmptyState title={t('ai.noModels')} whoCanAct={readOnly ? t('ai.noModelsReadOnly') : undefined}>
          {t('ai.noModelsHint')}
        </EmptyState>
      ) : (
        <DataTable
          rows={settings.models}
          columns={columns}
          rowKey={(m) => m.id}
          ariaLabel={t('ai.models')}
          testId="ai-models"
          card={(m) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Text fw={500} style={{ wordBreak: 'break-word' }}>
                    {m.label || m.id}
                  </Text>
                  {m.label && (
                    <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
                      {m.id}
                    </Text>
                  )}
                  <Group gap={6}>
                    <FormatBadge format={m.format} />
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t('ai.cardLimits', {
                      window: fmtNumber(m.contextTokens),
                      input: fmtNumber(modelInputCeiling(m)),
                      output: fmtNumber(m.maxOutputTokens),
                    })}
                  </Text>
                  <Text size="xs" c="dimmed">
                    <Price model={m} />
                  </Text>
                </Stack>
                {!readOnly && actions(m)}
              </Group>
            </Paper>
          )}
        />
      )}
      <AllowedDataCard
        platform={platform}
        settings={settings}
        readOnly={readOnly}
        onSave={(a) => save({ ...settings, allowedData: a }, t('ai.allowedSaved'))}
      />
      <Accordion variant="contained" chevronPosition="left">
        <Accordion.Item value="advanced">
          <Accordion.Control>
            <Text size="sm" fw={500}>
              {t('ai.advanced')}
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <AdvancedForm settings={settings} readOnly={readOnly} onSave={(s) => save(s, t('ai.saved'))} />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {editing && (
        <ModelModal
          model={editing.model}
          isNew={editing.index === null}
          taken={settings.models.filter((_, i) => i !== editing.index).map((m) => m.id)}
          onClose={() => setEditing(null)}
          onSave={async (m) => {
            const models = editing.index === null ? [...settings.models, m] : settings.models.map((x, i) => (i === editing.index ? m : x));
            if (await save({ ...settings, models }, t('ai.modelSaved', { model: m.id }))) setEditing(null);
          }}
        />
      )}
      {discover && (
        <DiscoverModal
          platform={platform}
          onClose={() => setDiscover(false)}
          onPick={(d) => {
            setDiscover(false);
            setEditing({ model: { id: d.id, format: d.suggestedFormat, contextTokens: 128_000, maxOutputTokens: 4_000 }, index: null });
          }}
        />
      )}
    </Stack>
  );
}

const FORMAT_COLORS: Record<AiFormat, string> = { 'chat-completions': 'teal', responses: 'cyan', 'anthropic-messages': 'grape', 'bedrock-converse': 'orange' };

export function FormatBadge({ format }: { format: AiFormat }) {
  const { t } = useTranslation('platforms');
  return (
    <Badge size="sm" variant="light" color={FORMAT_COLORS[format]} style={{ textTransform: 'none' }}>
      {t(`ai.formats.${format}`)}
    </Badge>
  );
}

function Price({ model: m }: { model: AiModel }) {
  const { t } = useTranslation('platforms');
  if (m.priceInputPer1k === undefined && m.priceOutputPer1k === undefined) return <>{t('ai.noPrice')}</>;
  const p = (v: number | undefined) => fmtNumber(v ?? 0, { maximumFractionDigits: 6 });
  return <>{t('ai.priceCell', { input: p(m.priceInputPer1k), output: p(m.priceOutputPer1k) })}</>;
}

/** Add or change one model. */
function ModelModal({
  model,
  isNew,
  taken,
  onClose,
  onSave,
}: {
  model: AiModel | null;
  /** A model that is not saved yet (empty, or picked from the gateway's list) */
  isNew: boolean;
  taken: string[];
  onClose: () => void;
  onSave: (m: AiModel) => Promise<void>;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const [m, setM] = useState<AiModel>(model ?? { id: '', format: 'chat-completions', contextTokens: 128_000, maxOutputTokens: 4_000 });
  const [busy, setBusy] = useState(false);
  const num = (v: string | number) => (v === '' ? undefined : Number(v));
  const idError = !m.id.trim() ? null : /[\s{}]/.test(m.id) ? t('ai.idInvalid') : taken.includes(m.id.trim()) ? t('ai.idTaken') : null;
  const outError = m.maxOutputTokens >= m.contextTokens ? t('ai.outputTooLarge') : null;
  const pathError = m.path && !/^\/[^\s?#]*$/.test(m.path) ? t('ai.pathInvalid') : null;
  const ok = !!m.id.trim() && !idError && !outError && !pathError && m.contextTokens >= 256 && m.maxOutputTokens >= 1;
  const clean = (x: AiModel): AiModel =>
    Object.fromEntries(
      Object.entries({ ...x, id: x.id.trim(), label: x.label?.trim() || undefined, path: x.path?.trim() || undefined }).filter(([, v]) => v !== undefined),
    ) as AiModel;
  return (
    <Modal opened onClose={onClose} title={!isNew && model ? t('ai.editModelTitle', { model: model.id }) : t('ai.addModel')} size="lg">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('ai.fields.id')}
            description={t('ai.fields.idHint')}
            required
            data-autofocus
            classNames={{ input: 'mono' }}
            value={m.id}
            error={idError}
            onChange={(e) => setM({ ...m, id: e.currentTarget.value })}
          />
          <TextInput
            label={t('ai.fields.label')}
            description={t('ai.fields.labelHint')}
            value={m.label ?? ''}
            onChange={(e) => setM({ ...m, label: e.currentTarget.value })}
          />
        </SimpleGrid>
        <Select
          label={t('ai.fields.format')}
          description={t('ai.fields.formatHint')}
          allowDeselect={false}
          data={AI_FORMATS.map((f) => ({ value: f, label: `${t(`ai.formats.${f}`)} – POST ${AI_FORMAT_PATHS[f]}` }))}
          value={m.format}
          onChange={(v) => v && setM({ ...m, format: v as AiFormat })}
        />
        <TextInput
          label={t('ai.fields.path')}
          description={t('ai.fields.pathHint')}
          placeholder={AI_FORMAT_PATHS[m.format]}
          classNames={{ input: 'mono' }}
          value={m.path ?? ''}
          error={pathError}
          onChange={(e) => setM({ ...m, path: e.currentTarget.value })}
        />
        <Divider label={t('ai.fields.limits')} labelPosition="left" />
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <NumberInput
            label={t('ai.fields.context')}
            description={t('ai.fields.contextHint')}
            required
            min={256}
            thousandSeparator
            value={m.contextTokens}
            onChange={(v) => setM({ ...m, contextTokens: Number(v) || 0 })}
          />
          <NumberInput
            label={t('ai.fields.maxOutput')}
            description={t('ai.fields.maxOutputHint')}
            required
            min={1}
            thousandSeparator
            value={m.maxOutputTokens}
            error={outError}
            onChange={(v) => setM({ ...m, maxOutputTokens: Number(v) || 0 })}
          />
          <NumberInput
            label={t('ai.fields.maxInput')}
            description={t('ai.fields.maxInputHint')}
            min={1}
            thousandSeparator
            placeholder={fmtNumber(Math.max(0, m.contextTokens - m.maxOutputTokens))}
            value={m.maxInputTokens ?? ''}
            onChange={(v) => setM({ ...m, maxInputTokens: num(v) })}
          />
          <NumberInput
            label={t('ai.fields.charsPerToken')}
            description={t('ai.fields.charsPerTokenHint')}
            min={1}
            max={10}
            step={0.5}
            decimalScale={2}
            placeholder="3.5"
            value={m.charsPerToken ?? ''}
            onChange={(v) => setM({ ...m, charsPerToken: num(v) })}
          />
        </SimpleGrid>
        <Divider label={t('ai.fields.prices')} labelPosition="left" />
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <NumberInput
            label={t('ai.fields.priceInput')}
            min={0}
            decimalScale={6}
            value={m.priceInputPer1k ?? ''}
            onChange={(v) => setM({ ...m, priceInputPer1k: num(v) })}
          />
          <NumberInput
            label={t('ai.fields.priceOutput')}
            min={0}
            decimalScale={6}
            value={m.priceOutputPer1k ?? ''}
            onChange={(v) => setM({ ...m, priceOutputPer1k: num(v) })}
          />
        </SimpleGrid>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            disabled={!ok}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(clean(m));
              setBusy(false);
            }}
          >
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The gateway's model list (GET /v1/models): pick one to set it up. */
function DiscoverModal({ platform, onClose, onPick }: { platform: Platform; onClose: () => void; onPick: (m: AiDiscoveredModel) => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const list = useQuery({
    queryKey: [...platformKeys.detail(platform.id), 'ai-discover'],
    queryFn: () => post<{ models: AiDiscoveredModel[] }>(`/platforms/${platform.id}/ai/discover`),
    retry: false,
    gcTime: 0,
  });
  const [filter, setFilter] = useState('');
  const shown = (list.data?.models ?? []).filter((m) => !filter.trim() || m.id.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <Modal opened onClose={onClose} title={t('ai.discoverTitle')} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('ai.discoverHint', { path: platform.config.ai?.modelsPath || AI_MODELS_PATH })}
        </Text>
        {list.isLoading && <Loader size="sm" />}
        {list.error && (
          <Alert color="red" title={t('ai.discoverFailed')}>
            {(list.error as Error).message}
          </Alert>
        )}
        {list.isSuccess && (
          <>
            <TextInput label={t('ai.discoverFilter')} value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
            {shown.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('ai.discoverNone')}
              </Text>
            ) : (
              <Stack gap={6} data-testid="ai-discovered">
                {shown.map((m) => (
                  <Paper key={m.id} withBorder p="xs">
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2} style={{ minWidth: 0 }}>
                        <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
                          {m.id}
                        </Text>
                        <Group gap={6}>
                          <FormatBadge format={m.suggestedFormat} />
                          {m.ownedBy && (
                            <Text size="xs" c="dimmed">
                              {m.ownedBy}
                            </Text>
                          )}
                        </Group>
                      </Stack>
                      {m.configured ? (
                        <Badge variant="outline" color="gray" style={{ flexShrink: 0 }}>
                          {t('ai.configured')}
                        </Badge>
                      ) : (
                        <Button size="xs" variant="light" onClick={() => onPick(m)} aria-label={t('ai.setUpNamed', { model: m.id })} style={{ flexShrink: 0 }}>
                          {t('ai.setUp')}
                        </Button>
                      )}
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}

/** What the gateway may be sent: data of these platforms, these datasets, the inputs of a run. Default: nothing. */
function AllowedDataCard({
  platform,
  settings,
  readOnly,
  onSave,
}: {
  platform: Platform;
  settings: AiGatewaySettings;
  readOnly: boolean;
  onSave: (a: AiAllowedData) => Promise<boolean>;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const [d, setD] = useState<AiAllowedData>(settings.allowedData);
  const [busy, setBusy] = useState(false);
  useEffect(() => setD(settings.allowedData), [settings.allowedData]);
  const every = d.platforms.includes('*');
  const options = useMemo(
    () => (platforms.data ?? []).filter((p) => p.id !== platform.id).map((p) => ({ value: p.id, label: `${p.name} (${p.kind})` })),
    [platforms.data, platform.id],
  );
  // ids of platforms the reader cannot see (or that are gone) stay as they are
  const known = new Set(options.map((o) => o.value));
  const unknown = d.platforms.filter((id) => id !== '*' && !known.has(id));
  const changed = JSON.stringify(d) !== JSON.stringify(settings.allowedData);
  const nothing = !d.platforms.length && !d.datasets.length && !d.inputs;
  return (
    <Paper withBorder p="md" data-testid="ai-allowed-data">
      <Stack gap="sm">
        <Title order={5}>{t('ai.allowed.title')}</Title>
        <Text size="sm" c="dimmed">
          {t('ai.allowed.intro')}
        </Text>
        {nothing && (
          <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
            {t('ai.allowed.nothing')}
          </Alert>
        )}
        <Switch
          label={t('ai.allowed.every')}
          description={t('ai.allowed.everyHint')}
          checked={every}
          disabled={readOnly}
          onChange={(e) => setD({ ...d, platforms: e.currentTarget.checked ? ['*'] : [] })}
        />
        {!every && (
          <MultiSelect
            label={t('ai.allowed.platforms')}
            description={t('ai.allowed.platformsHint')}
            searchable
            data={options}
            value={d.platforms.filter((id) => known.has(id))}
            disabled={readOnly}
            onChange={(v) => setD({ ...d, platforms: [...v, ...unknown] })}
            nothingFoundMessage={t('ai.allowed.noPlatforms')}
          />
        )}
        <TagsInput
          label={t('ai.allowed.datasets')}
          description={t('ai.allowed.datasetsHint')}
          // i18n-ignore: a dataset key pattern, the same in every language
          placeholder={d.datasets.length ? undefined : 'checkmk.*'}
          value={d.datasets}
          disabled={readOnly}
          onChange={(v) => setD({ ...d, datasets: v })}
          classNames={{ input: 'mono' }}
        />
        <Switch
          label={t('ai.allowed.inputs')}
          description={t('ai.allowed.inputsHint')}
          checked={d.inputs}
          disabled={readOnly}
          onChange={(e) => setD({ ...d, inputs: e.currentTarget.checked })}
        />
        {!readOnly && (
          <Group>
            <Button
              disabled={!changed}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                await onSave(d);
                setBusy(false);
              }}
            >
              {t('ai.allowed.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function AdvancedForm({ settings, readOnly, onSave }: { settings: AiGatewaySettings; readOnly: boolean; onSave: (s: AiGatewaySettings) => Promise<boolean> }) {
  const { t } = useTranslation(['platforms', 'common']);
  const [version, setVersion] = useState(settings.anthropicVersion ?? '');
  const [models, setModels] = useState(settings.modelsPath ?? '');
  useEffect(() => {
    setVersion(settings.anthropicVersion ?? '');
    setModels(settings.modelsPath ?? '');
  }, [settings.anthropicVersion, settings.modelsPath]);
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('ai.fields.modelsPath')}
          description={t('ai.fields.modelsPathHint')}
          placeholder={AI_MODELS_PATH}
          classNames={{ input: 'mono' }}
          value={models}
          disabled={readOnly}
          onChange={(e) => setModels(e.currentTarget.value)}
        />
        <TextInput
          label={t('ai.fields.anthropicVersion')}
          description={t('ai.fields.anthropicVersionHint')}
          placeholder={ANTHROPIC_VERSION}
          classNames={{ input: 'mono' }}
          value={version}
          disabled={readOnly}
          onChange={(e) => setVersion(e.currentTarget.value)}
        />
      </SimpleGrid>
      {!readOnly && (
        <Group>
          <Button
            variant="default"
            onClick={() => {
              const { anthropicVersion: _a, modelsPath: _m, ...rest } = settings;
              void onSave({
                ...rest,
                ...(version.trim() ? { anthropicVersion: version.trim() } : {}),
                ...(models.trim() ? { modelsPath: models.trim() } : {}),
              });
            }}
          >
            {t('common:save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
