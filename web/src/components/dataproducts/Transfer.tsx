import { useState } from 'react';
import { Alert, Anchor, Autocomplete, Badge, Button, FileInput, Group, List, Menu, SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDownload, IconFileExport, IconFileImport, IconFileUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_PRODUCT_IMPORT_MODES,
  DATA_PRODUCT_IMPORT_ORIGIN_RE,
  type DataProductImportChange,
  type DataProductImportMode,
  type DataProductImportOrigin,
  type DataProductImportPreview,
  type DataProductImportResult,
} from '@sm/shared';
import { apiUrl, get, notifyOk, post } from '../../api';
import { confirmDanger } from '../confirm';
import { fmtRelative } from '../../format';
import { FormModal, FormModalCancel } from '../FormModal';
import { Breakable, CardTable } from '../../pages/dataproducts/parts';
import { useBusy } from './form';

/**
 * Import and export of the data products module on the pages (ADR 0036 part 15, docs/DATA-PRODUCTS.md "File format,
 * import and export"): downloads of Steward's file format (YAML or JSON) and of ODPS, and the import dialog – files,
 * mode, a preview of what it adds, changes and skips, then the import with the preview's fingerprint (a change in
 * between is refused). Imports are made in a signed-in session; owners named from outside the owning teams ask for
 * the confirmation (step-up) as on the forms.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const enc = encodeURIComponent;

/** Download addresses of the module's files. */
export const transferUrls = {
  all: (format: 'yaml' | 'json', domain?: string) => apiUrl(`/data-products/export?format=${format}${domain ? `&domain=${enc(domain)}` : ''}`),
  product: (id: string, format: 'yaml' | 'json') => apiUrl(`/data-products/${enc(id)}/export?format=${format}`),
  odps: (id: string) => apiUrl(`/data-products/${enc(id)}/odps`),
  openLineage: (id: string) => apiUrl(`/data-products/${enc(id)}/openlineage`),
  schema: () => apiUrl('/data-products/schema'),
  /** The data objects the reader may see as an Apache Ossie semantic model (phase 2) */
  ossie: (format: 'yaml' | 'json', version: '0.1.1' | '0.2.0.dev0' = '0.1.1') => apiUrl(`/data-objects/semantic-model?format=${format}&version=${version}`),
};

/** The data objects list's export: the business vocabulary as an Apache Ossie semantic model (phase 2). */
export function OssieMenu() {
  const { t } = useTranslation('dataProducts');
  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <Button size="xs" variant="default" leftSection={<IconFileExport size={14} />} data-testid="objects-ossie">
          {t('ossie.menu')}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('ossie.label')}</Menu.Label>
        <Menu.Item component="a" href={transferUrls.ossie('yaml')} leftSection={<IconDownload size={14} />} data-testid="objects-ossie-yaml">
          {t('ossie.yaml')}
        </Menu.Item>
        <Menu.Item component="a" href={transferUrls.ossie('json')} leftSection={<IconDownload size={14} />} data-testid="objects-ossie-json">
          {t('ossie.json')}
        </Menu.Item>
        <Menu.Item component="a" href={transferUrls.ossie('yaml', '0.2.0.dev0')} leftSection={<IconDownload size={14} />}>
          {t('ossie.dev')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** The products list's _Import and export_ menu: everything the reader may see (or the filtered domain), and Import. */
export function TransferMenu({ domain, canImport, onImport }: { domain?: string; canImport: boolean; onImport: () => void }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <Button size="xs" variant="default" leftSection={<IconFileExport size={14} />} data-testid="products-transfer">
          {t('transfer.menu')}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{domain ? t('transfer.exportDomain') : t('transfer.exportAll')}</Menu.Label>
        <Menu.Item component="a" href={transferUrls.all('yaml', domain)} leftSection={<IconDownload size={14} />} data-testid="products-export-yaml">
          {t('transfer.yaml')}
        </Menu.Item>
        <Menu.Item component="a" href={transferUrls.all('json', domain)} leftSection={<IconDownload size={14} />} data-testid="products-export-json">
          {t('transfer.json')}
        </Menu.Item>
        {canImport && (
          <>
            <Menu.Divider />
            <Menu.Item leftSection={<IconFileImport size={14} />} onClick={onImport} data-testid="products-import">
              {t('transfer.import')}
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** The product page's menu entries: the product as YAML or JSON, and as ODPS. */
export function ProductTransferItems({ id }: { id: string }) {
  const { t } = useTranslation('dataProducts');
  return (
    <>
      <Menu.Divider />
      <Menu.Label>{t('transfer.exportProduct')}</Menu.Label>
      <Menu.Item component="a" href={transferUrls.product(id, 'yaml')} leftSection={<IconDownload size={14} />} data-testid="product-export-yaml">
        {t('transfer.yaml')}
      </Menu.Item>
      <Menu.Item component="a" href={transferUrls.product(id, 'json')} leftSection={<IconDownload size={14} />} data-testid="product-export-json">
        {t('transfer.json')}
      </Menu.Item>
      <Menu.Item component="a" href={transferUrls.odps(id)} leftSection={<IconDownload size={14} />} data-testid="product-export-odps">
        {t('transfer.odps')}
      </Menu.Item>
      {/* 0.25.0 (ADR 0037 part 5): the static lineage as OpenLineage events (JSON Lines) */}
      <Menu.Item component="a" href={transferUrls.openLineage(id)} leftSection={<IconDownload size={14} />} data-testid="product-export-openlineage">
        {t('openLineage.export')}
      </Menu.Item>
    </>
  );
}

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '–';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

const ACTION_COLOR = { add: 'green', change: 'blue', unchanged: 'gray', skip: 'orange', remove: 'red' } as const;

/** The changes of an import's preview (and of an assistant's proposal): a table, a card per change on phones. */
export function ChangeTable({ changes, label, testId }: { changes: DataProductImportChange[]; label: string; testId?: string }) {
  const { t } = useTranslation('dataProducts');
  return (
    <CardTable
      ariaLabel={label}
      testId={testId}
      rows={changes.map((c, i) => ({ ...c, i }))}
      rowKey={(c) => String(c.i)}
      columns={[
        {
          key: 'key',
          header: t('transfer.key'),
          cell: (c) => (
            <span className="mono" style={{ overflowWrap: 'break-word' }}>
              <Breakable text={c.key} />
            </span>
          ),
        },
        { key: 'what', header: t('transfer.what'), cell: (c) => t(`transfer.kinds.${c.kind}`) },
        {
          key: 'action',
          header: t('transfer.action'),
          cell: (c) => (
            <Badge size="sm" color={ACTION_COLOR[c.action]} variant="light" tt="none">
              {t(`transfer.actions.${c.action}`)}
            </Badge>
          ),
        },
        {
          key: 'detail',
          header: t('transfer.detail'),
          cell: (c) => (
            <div style={{ overflowWrap: 'break-word' }}>
              {c.action === 'skip'
                ? (c.reason ?? '')
                : c.fields.map((f) => (
                    <Text key={f.field} size="xs">
                      <span className="mono">{f.field}</span>: {show(f.before)} → {show(f.after)}
                    </Text>
                  ))}
            </div>
          ),
        },
      ]}
    />
  );
}

/** Import files of Steward's format: choose, preview, import. */
export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<DataProductImportMode>('add');
  const [origin, setOrigin] = useState('');
  const [preview, setPreview] = useState<DataProductImportPreview | null>(null);
  const [busy, run] = useBusy();
  const tooLarge = files.reduce((n, f) => n + f.size, 0) > MAX_BYTES;
  const originError =
    mode === 'replace' && !origin.trim()
      ? t('transfer.originRequired')
      : origin.trim() && !DATA_PRODUCT_IMPORT_ORIGIN_RE.test(origin.trim())
        ? t('transfer.originInvalid')
        : undefined;
  const body = async () => ({
    mode,
    ...(origin.trim() ? { origin: origin.trim() } : {}),
    files: await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))),
  });
  const check = () =>
    run(async () => {
      setPreview(await post<DataProductImportPreview>('/data-products/import/preview', await body()));
    }, t('transfer.previewFailed'));
  // the origins of earlier imports with entries the reader may see: what a replace can name
  const origins = useQuery({
    queryKey: ['dataProducts', 'importOrigins'],
    queryFn: () => get<{ items: DataProductImportOrigin[] }>('/data-products/import-origins'),
    staleTime: 60_000,
  });
  const originInfo = new Map((origins.data?.items ?? []).map((o) => [o.origin, o]));
  const REMOVALS_NAMED = 10;
  /** A replace that removes something says what before it runs: the entries by name, the list items counted. */
  const confirmRemovals = async (): Promise<boolean> => {
    const gone = preview?.changes.filter((c) => c.action === 'remove') ?? [];
    const items = preview?.counts.removedItems ?? 0;
    if (!gone.length && !items) return true;
    return confirmDanger({
      action: 'remove',
      title: t('transfer.removeTitle'),
      confirmLabel: t('transfer.removeButton'),
      message: (
        <Stack gap={4}>
          <Text size="sm">{t('transfer.removeConfirm', { origin: origin.trim() })}</Text>
          {gone.length > 0 && (
            <List size="sm" spacing={2} data-testid="import-remove-list">
              {gone.slice(0, REMOVALS_NAMED).map((c, i) => (
                <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                  {t(`transfer.kinds.${c.kind}`)}: <span className="mono">{c.key}</span>
                </List.Item>
              ))}
            </List>
          )}
          {gone.length > REMOVALS_NAMED && <Text size="sm">{t('transfer.removeMore', { count: gone.length - REMOVALS_NAMED })}</Text>}
          {items > 0 && <Text size="sm">{t('transfer.removeItems', { count: items })}</Text>}
        </Stack>
      ),
    });
  };
  const apply = async () => {
    if (!(await confirmRemovals())) return;
    await applyNow();
  };
  const applyNow = () =>
    run(async () => {
      const r = await post<DataProductImportResult>('/data-products/import', { ...(await body()), fingerprint: preview?.fingerprint });
      notifyOk(
        t(r.counts.remove !== undefined ? 'transfer.doneReplace' : 'transfer.done', {
          add: r.counts.add,
          change: r.counts.change,
          unchanged: r.counts.unchanged,
          skip: r.counts.skip,
          remove: r.counts.remove ?? 0,
          items: r.counts.removedItems ?? 0,
        }),
      );
      onDone();
    }, t('transfer.failed'));
  const changed = (next: () => void) => {
    next();
    setPreview(null);
  };
  const shown = preview?.changes.filter((c) => c.action !== 'unchanged') ?? [];
  return (
    <FormModal title={t('transfer.importTitle')} onClose={onClose} size="xl" dirty={files.length > 0}>
      <Stack gap="sm">
        <Text size="sm">
          {t('transfer.importIntro')}{' '}
          <Anchor href={transferUrls.schema()} target="_blank" size="sm">
            {t('transfer.schema')}
          </Anchor>
        </Text>
        <FileInput
          label={t('transfer.files')}
          description={t('transfer.filesHint')}
          multiple
          clearable
          clearButtonProps={{ 'aria-label': t('transfer.clearFiles') }}
          accept=".yaml,.yml,.json,application/yaml,application/json"
          leftSection={<IconFileUpload size={16} />}
          value={files}
          onChange={(v) => changed(() => setFiles(v ?? []))}
          error={tooLarge ? t('transfer.tooLarge') : undefined}
          data-testid="import-files"
        />
        <div>
          <Text size="sm" fw={500} mb={4} id="import-mode-label">
            {t('transfer.mode')}
          </Text>
          <SegmentedControl
            aria-labelledby="import-mode-label"
            size="xs"
            value={mode}
            onChange={(v) => changed(() => setMode(v as DataProductImportMode))}
            data={DATA_PRODUCT_IMPORT_MODES.map((m) => ({ value: m, label: t(`transfer.modes.${m}`) }))}
            data-testid="import-mode"
          />
          <Text size="xs" c="dimmed" mt={4}>
            {t(`transfer.modeHints.${mode}`)}
          </Text>
        </div>
        <Autocomplete
          label={t('transfer.origin')}
          description={t('transfer.originHint')}
          value={origin}
          onChange={(v) => changed(() => setOrigin(v))}
          // the value is the origin itself; the option says how many entries it holds and when it was last imported
          data={[{ group: t('transfer.originsLabel'), items: (origins.data?.items ?? []).map((o) => o.origin) }]}
          renderOption={({ option }) => {
            const o = originInfo.get(option.value);
            return (
              <Stack gap={0}>
                <Text size="sm" className="mono">
                  {option.value}
                </Text>
                {o && (
                  <Text size="xs" c="dimmed">
                    {t('transfer.originEntries', { count: o.entries })} · {fmtRelative(o.lastAt)}
                  </Text>
                )}
              </Stack>
            );
          }}
          maxLength={100}
          withAsterisk={mode === 'replace'}
          error={files.length || origin ? originError : undefined}
          // the value in monospace, the label and its hint as every other field's
          classNames={{ input: 'mono' }}
          data-testid="import-origin"
        />
        {preview && (
          <Stack gap="xs" data-testid="import-preview">
            <Group gap="xs">
              {(['add', 'change', 'unchanged', 'skip'] as const).map((a) => (
                <Badge key={a} color={ACTION_COLOR[a]} variant="light" tt="none" data-testid={`import-count-${a}`}>
                  {t(`transfer.counts.${a}`, { count: preview.counts[a] })}
                </Badge>
              ))}
              {preview.counts.remove !== undefined && (
                <Badge color="red" variant="light" tt="none" data-testid="import-count-remove">
                  {t('transfer.counts.remove', { count: preview.counts.remove })}
                </Badge>
              )}
              {!!preview.counts.removedItems && (
                <Badge color="red" variant="light" tt="none" data-testid="import-count-removed-items">
                  {t('transfer.counts.removedItems', { count: preview.counts.removedItems })}
                </Badge>
              )}
              {!!preview.counts.keptHidden && (
                <Badge color="gray" variant="light" tt="none" data-testid="import-count-kept-hidden">
                  {t('transfer.counts.keptHidden', { count: preview.counts.keptHidden })}
                </Badge>
              )}
            </Group>
            {!!preview.odps && (
              <Text size="sm" c="dimmed">
                {t('transfer.odpsRead', { count: preview.odps })}
              </Text>
            )}
            {preview.stepUp && (
              <Alert color="orange" variant="light" data-testid="import-step-up">
                {t('transfer.stepUp')}
              </Alert>
            )}
            {preview.problems.length > 0 && (
              <Alert color="red" variant="light" title={t('transfer.problems', { count: preview.problems.length })} data-testid="import-problems">
                <List size="sm" spacing={2}>
                  {preview.problems.map((p, i) => (
                    <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                      {[p.file, p.path].filter(Boolean).join(' · ')}: {p.message}
                    </List.Item>
                  ))}
                </List>
              </Alert>
            )}
            {preview.warnings.length > 0 && (
              <Alert color="yellow" variant="light" title={t('transfer.warnings')}>
                <List size="sm" spacing={2}>
                  {preview.warnings.map((w) => (
                    <List.Item key={w}>{w}</List.Item>
                  ))}
                </List>
              </Alert>
            )}
            {shown.length > 0 && (
              // a long preview scrolls in its box – reachable with the keyboard, named for screen readers
              <div style={{ maxHeight: 360, overflowY: 'auto' }} tabIndex={0} role="region" aria-label={t('transfer.changes')}>
                <ChangeTable changes={shown} label={t('transfer.changes')} />
              </div>
            )}
          </Stack>
        )}
        <Group justify="flex-end" mt="sm">
          <FormModalCancel />
          <Button
            variant={preview ? 'default' : 'filled'}
            onClick={() => void check()}
            loading={busy && !preview}
            disabled={!files.length || tooLarge || !!originError}
            data-testid="import-preview-run"
          >
            {t('transfer.preview')}
          </Button>
          {preview && (
            <Button
              onClick={() => void apply()}
              loading={busy}
              disabled={
                preview.problems.length > 0 ||
                preview.counts.add + preview.counts.change + (preview.counts.remove ?? 0) + (preview.counts.removedItems ?? 0) === 0
              }
              data-testid="import-run"
            >
              {t('transfer.run')}
            </Button>
          )}
        </Group>
      </Stack>
    </FormModal>
  );
}
