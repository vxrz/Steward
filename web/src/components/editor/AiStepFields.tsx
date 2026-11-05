import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ActionIcon,
  Autocomplete,
  Box,
  Button,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  AI_LIMITS,
  LLM_GATEWAY_KIND,
  promptVariables,
  type AiContextFrom,
  type AiContextSource,
  type DatasetMeta,
  type FlowNode,
  type Platform,
} from '@sm/shared';
import { get } from '../../api';
import { datasetKeys, platformKeys } from '../../queryKeys';
import { useExprContext } from './ExprContext';
import type { LocalizedField } from '../../i18n/meta';

/**
 * Fields of "Ask an AI model" (0.6.0, docs/AI.md): the model (from the gateways the person may use), the prompt
 * template with its {{ name }} placeholders, and the context sources.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function Label({ field }: { field: LocalizedField }) {
  return (
    <>
      {field.label}
      {field.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
    </>
  );
}

/** Every model of the LLM gateways the person may use, with its gateway and format. */
function useGatewayModels() {
  return useQuery({
    queryKey: platformKeys.ofKind(LLM_GATEWAY_KIND),
    queryFn: async () => (await get<Platform[]>('/platforms')).filter((p) => p.kind === LLM_GATEWAY_KIND),
    staleTime: 60_000,
  });
}

export function AiModelField({ field, value, onChange }: { field: LocalizedField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation(['editor', 'platforms']);
  const gateways = useGatewayModels();
  const groups = useMemo(
    () =>
      (gateways.data ?? []).map((g) => ({ group: g.name, items: [...new Set((g.config.ai?.models ?? []).map((m) => m.id))] })).filter((g) => g.items.length),
    [gateways.data],
  );
  const id = typeof value === 'string' ? value : '';
  const known = (gateways.data ?? []).flatMap((g) => (g.config.ai?.models ?? []).filter((m) => m.id === id).map((m) => ({ gateway: g.name, ...m })));
  return (
    <Box>
      <Autocomplete
        label={<Label field={field} />}
        description={field.help}
        placeholder={t('ai.modelPlaceholder')}
        data={groups}
        value={id}
        onChange={(v) => onChange(v.trim() || undefined)}
        classNames={{ input: 'mono' }}
        data-testid="ai-model"
      />
      {id && gateways.isSuccess && (
        <Stack gap={2} mt={4}>
          {known.length ? (
            known.map((m) => (
              <Text key={m.gateway} size="xs" c="dimmed">
                {t('ai.modelOn', {
                  gateway: m.gateway,
                  kind: t(`platforms:ai.formats.${m.format}`),
                  window: m.contextTokens.toLocaleString(),
                  output: m.maxOutputTokens.toLocaleString(),
                })}
              </Text>
            ))
          ) : (
            <Text size="xs" c="orange.8">
              {t('ai.modelUnknown')}
            </Text>
          )}
        </Stack>
      )}
    </Box>
  );
}

/** A prompt part: plain text with {{ name }} placeholders – shown with the names it may use. */
export function PromptField({ field, value, onChange }: { field: LocalizedField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('editor');
  const expr = useExprContext();
  const node = expr.def?.nodes.find((n) => n.id === expr.nodeId) as Extract<FlowNode, { type: 'ai' }> | undefined;
  const names = (node?.context ?? []).map((c) => c.name).filter(Boolean);
  const text = typeof value === 'string' ? value : '';
  const vars = promptVariables(text);
  const unknown = vars.names.filter((n) => !names.includes(n));
  const sample = field.key === 'sampleAnswer';
  return (
    <Textarea
      label={<Label field={field} />}
      description={
        sample
          ? field.help
          : [
              field.help,
              names.length ? t('ai.placeholders', { names: names.map((n) => `{{ ${n} }}`).join(', ') }) : t('ai.noPlaceholders', { example: '{{ name }}' }),
            ]
              .filter(Boolean)
              .join(' · ')
      }
      error={
        !sample && (unknown.length || vars.invalid.length)
          ? [
              unknown.length ? t('ai.unknownPlaceholders', { names: unknown.join(', ') }) : '',
              vars.invalid.length ? t('ai.invalidPlaceholders', { list: vars.invalid.join(' ') }) : '',
            ]
              .filter(Boolean)
              .join(' ')
          : undefined
      }
      placeholder={field.placeholder}
      autosize
      minRows={field.key === 'system' ? 2 : 4}
      maxRows={16}
      classNames={{ input: 'mono' }}
      value={text}
      maxLength={sample ? AI_LIMITS.sampleChars : AI_LIMITS.promptChars}
      onChange={(e) => onChange(e.currentTarget.value === '' ? undefined : e.currentTarget.value)}
    />
  );
}

/** The context sources: each one a name the prompt uses, where it comes from and how much of it may be sent. */
export function AiContextEditor({ field, value, onChange }: { field: LocalizedField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation(['editor', 'common']);
  const expr = useExprContext();
  const list = Array.isArray(value) ? (value as AiContextSource[]) : [];
  const datasets = useQuery({ queryKey: datasetKeys.all, queryFn: () => get<DatasetMeta[]>('/datasets'), staleTime: 60_000 });
  const steps = (expr.def?.nodes ?? []).filter((n) => n.id !== expr.nodeId && n.type !== 'start' && n.type !== 'note');
  const inputs = expr.def?.inputs ?? [];
  const set = (i: number, patch: Partial<AiContextSource>) => {
    const next = list
      .map((c, k) => (k === i ? { ...c, ...patch } : c))
      .map((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined && v !== '')) as unknown as AiContextSource);
    onChange(next);
  };
  const add = () => {
    let k = list.length + 1;
    while (list.some((c) => c.name === `data${k}`)) k++;
    onChange([...list, { name: list.length ? `data${k}` : 'data', from: 'step' }]);
  };
  const fromLabel: Record<AiContextFrom, string> = { step: t('ai.from.step'), dataset: t('ai.from.dataset'), input: t('ai.from.input') };
  return (
    <Box>
      <Text size="sm" fw={500}>
        <Label field={field} />
      </Text>
      <Text size="xs" c="dimmed" mb={6}>
        {t('ai.contextHint')}
      </Text>
      <Stack gap="xs">
        {list.map((c, i) => {
          const stepNode = c.step ? steps.find((s) => s.id === c.step) : undefined;
          const needsSaveAs = c.from === 'step' && stepNode && stepNode.type !== 'set' && !stepNode.saveAs;
          return (
            <Paper key={i} withBorder p="xs" data-testid="ai-context">
              <Stack gap={6}>
                <Group gap="xs" align="flex-end" wrap="nowrap">
                  <TextInput
                    label={t('ai.name')}
                    classNames={{ input: 'mono' }}
                    value={c.name}
                    error={!NAME_RE.test(c.name) ? t('ai.nameInvalid') : list.some((o, k) => k !== i && o.name === c.name) ? t('ai.nameUsed') : undefined}
                    onChange={(e) => set(i, { name: e.currentTarget.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Tooltip label={t('ai.remove')}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('ai.removeNamed', { name: c.name })}
                      onClick={() => onChange(list.filter((_, k) => k !== i))}
                      mb={4}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <SegmentedControl
                  size="xs"
                  fullWidth
                  value={c.from}
                  aria-label={t('ai.fromLabel')}
                  onChange={(v) => set(i, { from: v as AiContextFrom, step: undefined, dataset: undefined, input: undefined, columns: undefined })}
                  data={(['step', 'dataset', 'input'] as const).map((v) => ({ value: v, label: fromLabel[v] }))}
                />
                {c.from === 'step' && (
                  <Select
                    label={t('ai.step')}
                    searchable
                    data={steps.map((s) => ({ value: s.id, label: s.name ? `${s.name} (${s.id})` : s.id }))}
                    value={c.step ?? null}
                    onChange={(v) => set(i, { step: v ?? undefined })}
                    error={needsSaveAs ? t('ai.needsSaveAs') : undefined}
                  />
                )}
                {c.from === 'dataset' && (
                  <>
                    <Autocomplete
                      label={t('ai.dataset')}
                      classNames={{ input: 'mono' }}
                      data={(datasets.data ?? []).map((d) => d.key)}
                      value={c.dataset ?? ''}
                      onChange={(v) => set(i, { dataset: v.trim() || undefined })}
                    />
                    <TagsInput
                      label={t('ai.columns')}
                      description={t('ai.columnsHint')}
                      data={(datasets.data ?? []).find((d) => d.key === c.dataset)?.columns ?? []}
                      value={c.columns ?? []}
                      onChange={(v) => set(i, { columns: v.length ? v : undefined })}
                    />
                  </>
                )}
                {c.from === 'input' && (
                  <Select
                    label={t('ai.input')}
                    data={inputs.map((x) => ({ value: x.name, label: x.label ? `${x.label} (${x.name})` : x.name }))}
                    value={c.input ?? null}
                    onChange={(v) => set(i, { input: v ?? undefined })}
                  />
                )}
                <TextInput
                  label={t('ai.path')}
                  description={t('ai.pathHint')}
                  classNames={{ input: 'mono' }}
                  // i18n-ignore: example expressions, the same in every language
                  placeholder={c.from === 'dataset' ? "$[_status != 'good']" : c.from === 'step' ? 'body' : undefined}
                  value={c.path ?? ''}
                  onChange={(e) => set(i, { path: e.currentTarget.value || undefined })}
                />
                <NumberInput
                  label={t('ai.maxChars')}
                  description={t('ai.maxCharsHint', { value: AI_LIMITS.contextChars.default.toLocaleString() })}
                  min={100}
                  max={AI_LIMITS.contextChars.max}
                  step={1000}
                  thousandSeparator
                  maw={260}
                  value={c.maxChars ?? ''}
                  onChange={(v) => set(i, { maxChars: v === '' ? undefined : Number(v) })}
                />
              </Stack>
            </Paper>
          );
        })}
        <Group>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add} disabled={list.length >= AI_LIMITS.contextSources}>
            {t('ai.addContext')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
