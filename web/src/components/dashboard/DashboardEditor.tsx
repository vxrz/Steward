import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Badge,
  Button,
  Group,
  Menu,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import YAML from 'yaml';
import { useTranslation } from 'react-i18next';
import {
  WIDGET_INFO,
  WIDGET_TYPES,
  dashboardDefinitionSchema,
  type DashboardDefinition,
  type DashboardWidget,
  type DatasetMeta,
  type ProcessSummary,
  type WidgetType,
} from '@sm/shared';
import { get } from '../../api';
import { defaultWidth } from './widgets';
import i18n from '../../i18n';

/** Widget type name and description in the UI language (descriptions default to WIDGET_INFO in shared/). */
export const widgetLabel = (type: WidgetType): string => i18n.t(`dashboards:widgets.${type}.label`);
export const widgetInfo = (type: WidgetType): string => i18n.t(`dashboards:widgets.${type}.info`, { defaultValue: WIDGET_INFO[type] });

const WIDTHS = ['3', '4', '6', '8', '12'] as const;

function newWidget(type: WidgetType, existing: DashboardWidget[]): DashboardWidget {
  let i = existing.length + 1;
  while (existing.some((w) => w.id === `w${i}`)) i++;
  const w: DashboardWidget = { id: `w${i}`, type, width: defaultWidth(type) };
  // Default texts in the UI language – they become part of the dashboard like anything typed.
  if (type === 'markdown') w.text = i18n.t('dashboards:editor.defaultNotes');
  if (type === 'freshness') w.title = widgetLabel('freshness');
  return w;
}

/** Strip undefined/empty fields so the YAML stays tidy. */
function clean(w: DashboardWidget): DashboardWidget {
  return Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))) as DashboardWidget;
}

export function DashboardEditor({ value, onChange }: { value: DashboardDefinition; onChange: (d: DashboardDefinition) => void }) {
  const { t } = useTranslation(['dashboards', 'common']);
  const [editing, setEditing] = useState<DashboardWidget | null>(null);
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>('widgets');
  useEffect(() => {
    if (tab === 'yaml') {
      setYaml(YAML.stringify(value, { lineWidth: 0 }));
      setYamlError(null);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const widgets = value.widgets;
  const setWidgets = (ws: DashboardWidget[]) => onChange({ ...value, widgets: ws });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= widgets.length) return;
    const copy = [...widgets];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    setWidgets(copy);
  };

  return (
    <Paper withBorder p="sm" mb="md">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="widgets">{t('editor.widgets', { count: widgets.length })}</Tabs.Tab>
          <Tabs.Tab value="settings">{t('editor.settings')}</Tabs.Tab>
          <Tabs.Tab value="yaml">YAML</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="widgets" pt="sm">
          <Stack gap={6}>
            {widgets.map((w, i) => (
              <Group
                key={w.id}
                justify="space-between"
                wrap="nowrap"
                gap="xs"
                style={{ borderBottom: '1px solid var(--mantine-color-default-border)', paddingBottom: 6 }}
              >
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Badge variant="light" size="sm" style={{ flexShrink: 0 }}>
                    {widgetLabel(w.type)}
                  </Badge>
                  <Text size="sm" truncate>
                    {w.title || w.dataset || w.process || w.id}
                  </Text>
                  <Text size="xs" c="dimmed" className="nowrap" visibleFrom="xs">
                    {w.width ?? defaultWidth(w.type)}/12
                  </Text>
                </Group>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" size="sm" aria-label={t('editor.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}>
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" size="sm" aria-label={t('editor.moveDown')} disabled={i === widgets.length - 1} onClick={() => move(i, 1)}>
                    <IconArrowDown size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" size="sm" aria-label={t('common:edit')} onClick={() => setEditing(w)}>
                    <IconEdit size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    aria-label={t('common:remove')}
                    onClick={() => setWidgets(widgets.filter((x) => x.id !== w.id))}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Group>
              </Group>
            ))}
            <Menu position="bottom-start" width={340}>
              <Menu.Target>
                <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} w="fit-content">
                  {t('editor.addWidget')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {WIDGET_TYPES.map((type) => (
                  <Menu.Item
                    key={type}
                    onClick={() => {
                      const w = newWidget(type, widgets);
                      setWidgets([...widgets, w]);
                      if (type !== 'freshness') setEditing(w);
                    }}
                  >
                    <Text size="sm" fw={500}>
                      {widgetLabel(type)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {widgetInfo(type)}
                    </Text>
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="settings" pt="sm">
          <Stack gap="sm" maw={560}>
            <TextInput label={t('common:name')} required value={value.name} onChange={(e) => onChange({ ...value, name: e.currentTarget.value })} />
            <Textarea
              label={t('editor.description')}
              autosize
              minRows={2}
              value={value.description ?? ''}
              onChange={(e) => onChange({ ...value, description: e.currentTarget.value || undefined })}
            />
            <NumberInput
              label={t('editor.refreshSeconds')}
              description={t('editor.refreshSecondsHint')}
              min={10}
              max={3600}
              value={value.refreshSeconds ?? 60}
              onChange={(v) => onChange({ ...value, refreshSeconds: Number(v) || undefined })}
            />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="yaml" pt="sm">
          <Stack gap="xs">
            <Textarea classNames={{ input: 'mono' }} autosize minRows={12} maxRows={30} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} />
            {yamlError && <Alert color="red">{yamlError}</Alert>}
            <Group>
              <Button
                size="xs"
                onClick={() => {
                  try {
                    const parsed = dashboardDefinitionSchema.safeParse(YAML.parse(yaml));
                    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
                    onChange(parsed.data);
                    setYamlError(null);
                    setTab('widgets');
                  } catch (e) {
                    setYamlError((e as Error).message);
                  }
                }}
              >
                {t('editor.applyYaml')}
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>

      {editing && (
        <WidgetForm
          widget={editing}
          onClose={() => setEditing(null)}
          onSave={(w) => {
            setWidgets(widgets.map((x) => (x.id === editing.id ? clean(w) : x)));
            setEditing(null);
          }}
        />
      )}
    </Paper>
  );
}

function WidgetForm({ widget, onClose, onSave }: { widget: DashboardWidget; onClose: () => void; onSave: (w: DashboardWidget) => void }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const [w, setW] = useState<DashboardWidget>(widget);
  const set = (patch: Partial<DashboardWidget>) => setW((x) => ({ ...x, ...patch }));
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets') });
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes'), enabled: w.type === 'checks' });
  const meta = datasets.data?.find((d) => d.key === w.dataset);
  const metricNames = Object.keys(meta?.metrics ?? {});
  const usesDataset = ['kpi', 'trend', 'status', 'table'].includes(w.type);

  return (
    <Modal opened onClose={onClose} title={t('form.title', { type: widgetLabel(w.type) })} size="lg">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          {widgetInfo(w.type)}
        </Text>
        <Group grow align="flex-start">
          <TextInput
            label={t('form.widgetTitle')}
            placeholder={t('form.automatic')}
            value={w.title ?? ''}
            onChange={(e) => set({ title: e.currentTarget.value || undefined })}
          />
          <Select
            label={t('form.width')}
            data={WIDTHS.map((v) => ({ value: v, label: t(`form.widths.w${v}`) }))}
            value={String(w.width ?? defaultWidth(w.type))}
            onChange={(v) => set({ width: Number(v) || undefined })}
            allowDeselect={false}
          />
        </Group>
        {usesDataset && (
          <Autocomplete
            label={t('form.dataset')}
            description={t('form.datasetHint', { node: t('editor:steps.publish.label') })}
            data={(datasets.data ?? []).map((d) => ({ value: d.key, label: `${d.key} – ${d.title}` }))}
            value={w.dataset ?? ''}
            onChange={(v) => set({ dataset: v || undefined })}
            placeholder={t('form.datasetPlaceholder')}
          />
        )}
        {usesDataset && (meta?.sources?.length ?? 0) > 1 && (
          <MultiSelect
            label={t('form.sources')}
            description={t('form.sourcesHint')}
            placeholder={t('form.sourcesAll')}
            data={(meta?.sources ?? []).map((x) => ({ value: x.id, label: x.environment ? `${x.name} (${x.environment})` : x.name }))}
            value={w.source ?? []}
            onChange={(v) => set({ source: v.length ? v : undefined })}
            clearable
          />
        )}
        {w.type === 'kpi' && (
          <>
            <Select
              label={t('form.value')}
              data={[{ value: '_rows', label: t('form.rowCount') }, ...metricNames.map((m) => ({ value: m, label: t('form.metric', { name: m }) }))]}
              value={w.metric ?? '_rows'}
              onChange={(v) => set({ metric: v ?? undefined })}
              searchable
            />
            <Group grow>
              <Select
                label={t('form.increaseIs')}
                data={[
                  { value: '', label: t('form.neutral') },
                  { value: 'up', label: t('form.good') },
                  { value: 'down', label: t('form.bad') },
                ]}
                value={w.goodWhen ?? ''}
                onChange={(v) => set({ goodWhen: (v || undefined) as DashboardWidget['goodWhen'] })}
              />
              <NumberInput
                label={t('form.trendDays')}
                description={t('form.trendDaysHint')}
                min={1}
                max={365}
                value={w.days ?? 30}
                onChange={(v) => set({ days: Number(v) || undefined })}
              />
            </Group>
            <Group grow align="flex-start">
              <NumberInput
                label={t('form.threshold')}
                description={t('form.thresholdHint')}
                value={w.threshold ?? ''}
                onChange={(v) => set({ threshold: typeof v === 'number' ? v : undefined })}
                allowDecimal
              />
              <Select
                label={t('form.thresholdKind')}
                data={[
                  { value: 'upper', label: t('form.thresholdUpper') },
                  { value: 'lower', label: t('form.thresholdLower') },
                ]}
                value={w.thresholdLower ? 'lower' : 'upper'}
                allowDeselect={false}
                disabled={w.threshold === undefined}
                onChange={(v) => set({ thresholdLower: v === 'lower' || undefined })}
              />
            </Group>
          </>
        )}
        {w.type === 'trend' && (
          <>
            <MultiSelect
              label={t('form.metrics')}
              data={metricNames}
              value={w.metrics ?? []}
              onChange={(v) => set({ metrics: v.slice(0, 3) })}
              maxValues={3}
              placeholder={metricNames.length ? t('form.pickMetrics') : t('form.noMetrics')}
            />
            <NumberInput label={t('form.days')} min={1} max={365} value={w.days ?? 30} onChange={(v) => set({ days: Number(v) || undefined })} />
            <Switch
              label={t('form.trendLine')}
              description={t('form.trendLineHint')}
              checked={!!w.trendLine}
              onChange={(e) => set({ trendLine: e.currentTarget.checked || undefined })}
            />
          </>
        )}
        {w.type === 'table' && (
          <>
            <MultiSelect
              label={t('form.columns')}
              placeholder={t('form.allColumns')}
              data={meta?.columns ?? []}
              value={w.columns ?? []}
              onChange={(v) => set({ columns: v })}
              searchable
            />
            <Group grow align="flex-end">
              <Switch label={t('form.problemsOnly')} checked={!!w.problemsOnly} onChange={(e) => set({ problemsOnly: e.currentTarget.checked || undefined })} />
              <NumberInput label={t('form.rowsShown')} min={5} max={5000} value={w.limit ?? 50} onChange={(v) => set({ limit: Number(v) || undefined })} />
            </Group>
          </>
        )}
        {w.type === 'checks' && (
          <Select
            label={t('form.process')}
            searchable
            data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={w.process ?? null}
            onChange={(v) => set({ process: v ?? undefined })}
          />
        )}
        {w.type === 'markdown' && (
          <Textarea label={t('form.text')} autosize minRows={4} value={w.text ?? ''} onChange={(e) => set({ text: e.currentTarget.value })} />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => onSave(w)}>{t('form.apply')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
