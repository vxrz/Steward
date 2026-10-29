import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Box,
  Button,
  FileButton,
  Group,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { IconEdit, IconExternalLink, IconFileImport, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  COMPONENT_TYPES,
  type ApplicationComponent,
  type ApplicationDetail,
  type ComponentType,
  type SbomChange,
  type SbomPreview,
  type StackEntry,
  type StackProduct,
} from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { fmtDate } from '../../format';
import { LifecycleBadge } from './lifecycle';
import { EnvironmentBadge, EnvironmentInput, sortByEnvironment, useEnvironmentList } from './environments';

export const formatLabel = (f: string) => (f === 'cyclonedx' ? 'CycloneDX' : 'SPDX');

export function useStackProducts() {
  return useQuery({
    queryKey: ['stack-products'],
    queryFn: () => get<{ source: string; products: StackProduct[] }>('/catalogue/stack-products'),
    staleTime: Infinity,
  });
}

/** What the application consists of, with the tech stack of each component; editors add, change and remove them. */
export function ComponentsPanel({ app, onSaved }: { app: ApplicationDetail; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const [editing, setEditing] = useState<ApplicationComponent | 'new' | null>(null);
  const [importing, setImporting] = useState<ApplicationComponent | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const envList = useEnvironmentList();
  const editable = app.canEdit && !app.archived;
  const envs = sortByEnvironment(envList, [...new Set(app.components.map((c) => c.environment))], (x) => x);
  const withEnv = envs.some((e) => e !== '');
  // the components of all environments ('') show in every environment
  const shown = env === null ? app.components : app.components.filter((c) => c.environment === env || c.environment === '');
  const remove = async (c: ApplicationComponent) => {
    if (!(await confirmDanger({ action: 'remove', message: t('components.removeConfirm', { name: c.name }) }))) return;
    try {
      onSaved(await del<ApplicationDetail>(`/applications/${app.id}/components/${c.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="application-components">
      <Group justify="space-between">
        <Text fw={600} id="components-title">
          {t('components.title')}
        </Text>
        {editable && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('components.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('components.help')}
      </Text>
      {withEnv && (
        <SegmentedControl
          size="xs"
          style={{ alignSelf: 'flex-start' }}
          aria-label={t('environments.filter')}
          data-testid="components-environment-filter"
          value={env ?? '*'}
          onChange={(v) => setEnv(v === '*' ? null : v)}
          data={[{ value: '*', label: t('environments.any') }, ...envs.filter((e) => e).map((e) => ({ value: e, label: e }))]}
        />
      )}
      {app.components.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('components.empty')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="components-title">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('components.type')}</Table.Th>
                <Table.Th>{t('components.name')}</Table.Th>
                {withEnv && <Table.Th>{t('environments.label')}</Table.Th>}
                <Table.Th>{t('components.stack')}</Table.Th>
                {editable && <Table.Th aria-label={t('components.actions')} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td className="nowrap">
                    <Badge size="sm" variant="default">
                      {t(`components.types.${c.type}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {c.url ? (
                      <Anchor href={c.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                        {c.name} <IconExternalLink size={12} aria-hidden />
                      </Anchor>
                    ) : (
                      <Text span size="sm">
                        {c.name}
                      </Text>
                    )}
                    {c.note && (
                      <Text size="xs" c="dimmed">
                        {c.note}
                      </Text>
                    )}
                    {c.sbom && <SbomLine sbom={c.sbom} />}
                  </Table.Td>
                  {withEnv && (
                    <Table.Td className="nowrap">
                      <EnvironmentBadge value={c.environment} />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <StackBadges stack={c.stack} />
                  </Table.Td>
                  {editable && (
                    <Table.Td className="nowrap">
                      <Group gap={0} wrap="nowrap">
                        <ActionIcon variant="subtle" aria-label={t('components.edit', { name: c.name })} onClick={() => setEditing(c)}>
                          <IconEdit size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" aria-label={t('components.sbom.import', { name: c.name })} onClick={() => setImporting(c)}>
                          <IconFileImport size={16} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" aria-label={t('components.remove', { name: c.name })} onClick={() => void remove(c)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {app.stack.length > 0 && <StackRollup app={app} />}
      {editing && <ComponentFormModal app={app} component={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
      {importing && (
        <SbomImportModal
          title={t('components.sbom.title', { name: importing.name })}
          base={`/applications/${app.id}/components/${importing.id}/sbom`}
          onClose={() => setImporting(null)}
          onApplied={(r: { preview: SbomPreview; application: ApplicationDetail }) => onSaved(r.application)}
        />
      )}
    </Stack>
  );
}

/** "CycloneDX "orders" imported by … on …" */
export function SbomLine({ sbom }: { sbom: NonNullable<ApplicationComponent['sbom']> }) {
  const { t } = useTranslation('applications');
  return (
    <Text size="xs" c="dimmed">
      {t(sbom.name ? 'components.sbom.last' : 'components.sbom.lastNoName', {
        format: formatLabel(sbom.format),
        name: sbom.name,
        user: sbom.importedBy,
        date: fmtDate(sbom.importedAt),
      })}
    </Text>
  );
}

/** The stack of a component or system as end-of-life badges. */
export function StackBadges({ stack }: { stack: StackEntry[] }) {
  const { t } = useTranslation('applications');
  if (stack.length === 0)
    return (
      <Text span size="sm" c="dimmed">
        {t('components.noStack')}
      </Text>
    );
  return (
    <Group gap={4}>
      {stack.map((s) => (
        <LifecycleBadge
          key={s.product}
          text={[s.label, s.version].filter(Boolean).join(' ')}
          lifecycle={s.lifecycle}
          variant={s.source === 'sbom' ? 'light' : 'outline'}
          extra={s.source === 'sbom' ? `${t('components.stackEditor.fromSbom')}: ${s.sbomRef}` : t('components.stackEditor.manual')}
        />
      ))}
    </Group>
  );
}

/** The tech stack of all components and systems together. */
function StackRollup({ app }: { app: ApplicationDetail }) {
  const { t } = useTranslation('applications');
  const named = (x: { name: string; environment: string }) => (x.environment ? `${x.name} (${x.environment})` : x.name);
  return (
    <Stack gap={4} mt="xs" data-testid="application-stack">
      <Text fw={600} size="sm" id="stack-title">
        {t('components.rollup.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('components.rollup.help')}
      </Text>
      <Group gap={6} role="list" aria-labelledby="stack-title">
        {app.stack.map((s) => (
          <LifecycleBadge
            key={`${s.product} ${s.version}`}
            role="listitem"
            text={`${[s.label, s.version].filter(Boolean).join(' ')} · ${t('components.rollup.used', { count: s.components.length + s.systems.length })}`}
            lifecycle={s.lifecycle}
            extra={[...s.components.map(named), ...s.systems.map(named)].join(', ')}
          />
        ))}
      </Group>
    </Stack>
  );
}

export type StackRow = { product: string | null; version: string; source?: 'manual' | 'sbom'; was?: string };

export const stackRowsOf = (stack: StackEntry[]): StackRow[] =>
  stack.map((s) => ({ product: s.product, version: s.version, source: s.source, was: s.version }));
export const stackBody = (rows: StackRow[]) => rows.filter((r) => r.product).map((r) => ({ product: r.product!, version: r.version.trim() }));

/** The stack editor: endoflife.date products with the version in use. */
export function StackFields({ stack, onChange }: { stack: StackRow[]; onChange: (rows: StackRow[]) => void }) {
  const { t } = useTranslation('applications');
  const products = useStackProducts();
  const byId = useMemo(() => new Map((products.data?.products ?? []).map((p) => [p.id, p])), [products.data]);
  const productData = useMemo(() => (products.data?.products ?? []).map((p) => ({ value: p.id, label: p.label })), [products.data]);
  const patchRow = (i: number, p: Partial<StackRow>) => onChange(stack.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const chosen = new Set(stack.map((r) => r.product));
  return (
    <Stack gap={6}>
      <Text fw={500} size="sm">
        {t('components.stack')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('components.stackEditor.help')}
      </Text>
      {stack.map((r, i) => {
        const p = r.product ? byId.get(r.product) : undefined;
        const fromSbom = r.source === 'sbom' && r.version === r.was;
        return (
          <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
            <Select
              style={{ flex: 2 }}
              size="xs"
              label={i === 0 ? t('components.stackEditor.product') : undefined}
              aria-label={t('components.stackEditor.product')}
              placeholder={t('components.stackEditor.productSearch')}
              data={productData.filter((d) => d.value === r.product || !chosen.has(d.value))}
              value={r.product}
              onChange={(x) => patchRow(i, { product: x, source: undefined })}
              searchable
              limit={50}
            />
            <Autocomplete
              style={{ flex: 1 }}
              size="xs"
              label={i === 0 ? t('components.stackEditor.version') : undefined}
              aria-label={t('components.stackEditor.version')}
              data={p?.cycles ?? []}
              value={r.version}
              onChange={(x) => patchRow(i, { version: x })}
            />
            <Box w={90}>
              <Text size="xs" c="dimmed">
                {fromSbom ? t('components.stackEditor.fromSbom') : ''}
              </Text>
            </Box>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('components.stackEditor.remove', { product: p?.label ?? r.product ?? '' })}
              onClick={() => onChange(stack.filter((_, j) => j !== i))}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        );
      })}
      <Group>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => onChange([...stack, { product: null, version: '' }])}>
          {t('components.stackEditor.add')}
        </Button>
      </Group>
    </Stack>
  );
}

function ComponentFormModal({
  app,
  component,
  onClose,
  onSaved,
}: {
  app: ApplicationDetail;
  component: ApplicationComponent | null;
  onClose: () => void;
  onSaved: (a: ApplicationDetail) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const [type, setType] = useState<ComponentType>(component?.type ?? 'repository');
  const [name, setName] = useState(component?.name ?? '');
  const [url, setUrl] = useState(component?.url ?? '');
  const [note, setNote] = useState(component?.note ?? '');
  const [environment, setEnvironment] = useState(component?.environment ?? '');
  const [stack, setStack] = useState<StackRow[]>(stackRowsOf(component?.stack ?? []));
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    url: !!url.trim() && !/^https?:\/\/\S+$/i.test(url.trim()) && t('common:validation.invalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = { type, name: name.trim(), url: url.trim(), note, environment: environment.trim(), stack: stackBody(stack) };
    try {
      onSaved(
        component
          ? await put<ApplicationDetail>(`/applications/${app.id}/components/${component.id}`, body)
          : await post<ApplicationDetail>(`/applications/${app.id}/components`, body),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      title={component ? t('components.editTitle', { name: component.name }) : t('components.addTitle', { name: app.name })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label={t('components.type')}
              data={COMPONENT_TYPES.map((x) => ({ value: x, label: t(`components.types.${x}`) }))}
              value={type}
              allowDeselect={false}
              onChange={(x) => x && setType(x as ComponentType)}
            />
            <TextInput
              label={t('components.name')}
              description={t('components.nameHint')}
              required
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
            />
          </Group>
          <EnvironmentInput value={environment} onChange={setEnvironment} allowAll description={t('environments.componentHint')} />
          <TextInput label={t('components.url')} placeholder="https://" value={url} onChange={(e) => setUrl(e.currentTarget.value)} error={v.error('url')} />
          <Textarea label={t('components.note')} autosize minRows={1} maxRows={4} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <StackFields stack={stack} onChange={setStack} />
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

const ACTION_COLORS: Record<SbomChange['action'], string> = { add: 'green', update: 'blue', remove: 'red', keep: 'gray', manual: 'yellow' };

/** Upload or fetch an SBOM, show what it changes, then import it (into a component or a system: `base`). */
export function SbomImportModal<R extends { preview: SbomPreview }>({
  title,
  base,
  onClose,
  onApplied,
}: {
  title: string;
  base: string;
  onClose: () => void;
  onApplied: (r: R) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const [mode, setMode] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<SbomPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const body = mode === 'file' ? (file ? { sbom: file.text } : null) : url.trim() ? { url: url.trim() } : null;
  const show = async () => {
    if (!body) return;
    setBusy(true);
    try {
      setPreview(await post<SbomPreview>(`${base}/preview`, body));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await post<R>(base, body);
      const n = (a: SbomChange['action']) => r.preview.changes.filter((c) => c.action === a).length;
      notifications.show({ color: 'green', message: t('components.sbom.done', { added: n('add'), updated: n('update'), removed: n('remove') }) });
      onApplied(r);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const reset = () => setPreview(null);
  const changing = preview?.changes.filter((c) => c.action !== 'keep') ?? [];
  return (
    <Modal opened onClose={onClose} size="lg" title={title}>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('components.sbom.help')}
        </Text>
        <SegmentedControl
          value={mode}
          onChange={(x) => {
            setMode(x as 'file' | 'url');
            reset();
          }}
          data={[
            { value: 'file', label: t('components.sbom.file') },
            { value: 'url', label: t('components.sbom.url') },
          ]}
        />
        {mode === 'file' ? (
          <Group>
            <FileButton
              accept=".json,application/json,application/vnd.cyclonedx+json,application/spdx+json"
              onChange={(f) => {
                if (!f) return;
                void f.text().then((text) => {
                  setFile({ name: f.name, text });
                  reset();
                });
              }}
            >
              {(props) => (
                <Button {...props} variant="default" leftSection={<IconFileImport size={14} />}>
                  {t('components.sbom.chooseFile')}
                </Button>
              )}
            </FileButton>
            {file && (
              <Text size="sm" c="dimmed">
                {t('components.sbom.fileChosen', { name: file.name, size: Math.ceil(file.text.length / 1024) })}
              </Text>
            )}
          </Group>
        ) : (
          <TextInput
            label={t('components.sbom.urlLabel')}
            description={t('components.sbom.urlHint')}
            placeholder="https://"
            value={url}
            onChange={(e) => {
              setUrl(e.currentTarget.value);
              reset();
            }}
          />
        )}
        {preview && (
          <Stack gap="xs" data-testid="sbom-preview">
            <Text size="sm">
              {t(preview.name ? 'components.sbom.summary' : 'components.sbom.summaryNoName', {
                format: formatLabel(preview.format),
                name: preview.name,
                matched: preview.matched,
                total: preview.total,
              })}
            </Text>
            {changing.length === 0 ? (
              <Alert color="gray">{t('components.sbom.nothing')}</Alert>
            ) : (
              <div className="table-scroll">
                <Table fz="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('components.sbom.change')}</Table.Th>
                      <Table.Th>{t('components.stackEditor.product')}</Table.Th>
                      <Table.Th>{t('components.stackEditor.version')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {changing.map((c) => (
                      <Table.Tr key={c.product}>
                        <Table.Td className="nowrap">
                          <Badge size="sm" variant="light" color={ACTION_COLORS[c.action]}>
                            {t(`components.sbom.actions.${c.action}`)}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Tooltip label={c.sbomRef} disabled={!c.sbomRef}>
                            <span>{c.label}</span>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          {c.action === 'update'
                            ? t('components.sbom.versionChange', { from: c.other || '–', to: c.version || '–' })
                            : c.action === 'manual'
                              ? `${c.version || '–'} (${t('components.sbom.manualKept', { version: c.other || '–' })})`
                              : c.version || '–'}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {preview ? (
            <Button onClick={() => void apply()} loading={busy} disabled={!body}>
              {t('components.sbom.apply')}
            </Button>
          ) : (
            <Button onClick={() => void show()} loading={busy} disabled={!body}>
              {t('components.sbom.preview')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
