import { useRef, useState } from 'react';
import { Alert, Anchor, Badge, Box, Button, FileButton, Group, Modal, Paper, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconCheck, IconFileCertificate, IconFileImport, IconPlus, IconSearch, IconSettings, IconUpload, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { RECORD_STATUSES, type RecordDetail, type RecordImportItem, type RecordSummary, type RecordsMeta } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { EmptyState, FilterPanel, PageHeader, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { RecordStatusBadge, useRecordTypes, useTypeName } from '../components/records/common';
import { fmtDate, fmtRelative } from '../format';
import { codeText, errorText } from '../i18n/errors';
import { fieldLabelByKey, typeDescription, typeTemplate } from '../components/records/builtin';

/** Records per request; "Load more" raises the limit by this much. */
const RECORDS_PAGE = 500;

export function RecordsPage() {
  const { t } = useTranslation(['records', 'common']);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type = params.get('type');
  const status = params.get('status');
  const tag = params.get('tag');
  const [text, setText] = useState(params.get('q') ?? '');
  const [q] = useDebouncedValue(text, 300);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const types = useRecordTypes();
  const typeName = useTypeName();
  const query = new URLSearchParams();
  if (type) query.set('type', type);
  if (status) query.set('status', status);
  if (tag) query.set('tag', tag);
  if (q.trim()) query.set('q', q.trim());
  // one more than shown tells whether there are more ("Load more" raises the limit)
  const [limit, setLimit] = useState(RECORDS_PAGE);
  const records = useQuery({
    queryKey: ['records', query.toString(), limit],
    queryFn: () => get<RecordSummary[]>(`/records?${query}${query.toString() ? '&' : ''}limit=${limit + 1}`),
    placeholderData: keepPreviousData,
  });
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const all = records.data ?? [];
  const list = all.slice(0, limit);
  const canCreate = meta.data?.canCreate ?? false;
  useCreateParam(meta.data?.canCreate, () => setCreating(true));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            {meta.data?.canManageTypes && (
              <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} component={Link} to="/records/types">
                {t('types.title')}
              </Button>
            )}
            {canCreate && (
              <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)}>
                {t('import')}
              </Button>
            )}
            {canCreate && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                {t('new')}
              </Button>
            )}
          </>
        }
      />
      <FilterPanel active={[type, status, tag, q.trim()].filter(Boolean).length}>
        <Group gap="xs" mb="md" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label={t('list.search')}
            leftSection={<IconSearch size={14} />}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('list.type')}
            placeholder={t('list.allTypes')}
            clearable
            data={(types.data ?? []).map((x) => ({ value: x.key, label: `${x.key} – ${typeName(x)}` }))}
            value={type}
            onChange={(v) => set('type', v)}
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('list.status')}
            placeholder={t('list.allStatuses')}
            clearable
            data={RECORD_STATUSES.map((s) => ({ value: s, label: t(`status.${s as 'draft'}`) }))}
            value={status}
            onChange={(v) => set('status', v)}
            w={{ base: '100%', xs: 180 }}
          />
          {tag && (
            <Badge
              variant="light"
              rightSection={<IconX size={12} aria-hidden />}
              style={{ cursor: 'pointer' }}
              onClick={() => set('tag', null)}
              component="button"
              aria-label={t('list.clearTag', { tag })}
            >
              {tag}
            </Badge>
          )}
        </Group>
      </FilterPanel>
      <QueryState query={records} />
      {records.isSuccess &&
        list.length === 0 &&
        (query.toString() ? (
          <Text c="dimmed" size="sm">
            {t('list.noMatch')}
          </Text>
        ) : (
          <EmptyState
            icon={IconFileCertificate}
            title={t('list.emptyTitle')}
            action={
              canCreate && (
                <>
                  <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                    {t('list.emptyAction')}
                  </Button>
                  <Button variant="default" leftSection={<IconFileImport size={16} />} onClick={() => setImporting(true)}>
                    {t('list.emptyImport')}
                  </Button>
                </>
              )
            }
          >
            {canCreate ? t('list.emptyCreateText') : t('list.emptyText')}
          </EmptyState>
        ))}
      {list.length > 0 && (
        <RecordTable
          records={list}
          onTag={(x) => set('tag', x)}
          footer={
            <ListFooter
              shown={list.length}
              hasMore={all.length > limit}
              onLoadMore={() => setLimit((n) => n + RECORDS_PAGE)}
              loading={records.isFetching && records.isPlaceholderData}
            />
          }
        />
      )}
      {creating && <NewRecordModal onClose={() => setCreating(false)} onCreated={(r) => navigate(`/records/${r.id}/edit`)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </>
  );
}

function RecordTable({ records, onTag, footer }: { records: RecordSummary[]; onTag: (tag: string) => void; footer?: React.ReactNode }) {
  const { t } = useTranslation('records');
  const tags = (r: RecordSummary) =>
    r.tags.length > 0 && (
      <Group gap={4} mt={2}>
        {r.tags.map((tag) => (
          <Badge
            key={tag}
            size="xs"
            variant="default"
            component="button"
            style={{ cursor: 'pointer' }}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onTag(tag);
            }}
          >
            {tag}
          </Badge>
        ))}
      </Group>
    );
  const columns: DataColumn<RecordSummary>[] = [
    { key: 'number', header: t('list.number'), sortValue: (r) => r.number, tdProps: () => ({ className: 'nowrap mono' }), cell: (r) => r.number },
    {
      key: 'title',
      header: t('list.record'),
      sortValue: (r) => r.title,
      cell: (r) => (
        <>
          <Anchor component={Link} to={`/records/${r.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
            {r.title}
          </Anchor>
          {tags(r)}
        </>
      ),
    },
    {
      key: 'status',
      header: t('list.status'),
      sortValue: (r) => t(`status.${r.status as 'draft'}`),
      nowrap: true,
      cell: (r) => (
        <>
          <RecordStatusBadge status={r.status} />
          {r.revision > 1 && (
            <Text span size="xs" c="dimmed" ml={6}>
              {t('list.revision', { n: r.revision })}
            </Text>
          )}
        </>
      ),
    },
    { key: 'owner', header: t('list.owner'), sortValue: (r) => r.owner, cell: (r) => r.owner },
    {
      key: 'updated',
      header: t('list.updated'),
      sortValue: (r) => r.updatedAt,
      nowrap: true,
      tdProps: (r) => ({ title: fmtDate(r.updatedAt) }),
      cell: (r) => fmtRelative(r.updatedAt),
    },
  ];
  return (
    <DataTable
      rows={records}
      columns={columns}
      rowKey={(r) => r.id}
      ariaLabel={t('title')}
      rowHref={(r) => `/records/${r.id}`}
      footer={footer}
      testId="record-list"
      card={(r) => (
        <Paper withBorder p="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Box style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed" className="mono">
                {r.number}
              </Text>
              <Anchor component={Link} to={`/records/${r.id}`} fw={600} size="sm">
                {r.title}
              </Anchor>
            </Box>
            <RecordStatusBadge status={r.status} size="xs" />
          </Group>
          <Text size="xs" c="dimmed">
            {t('list.ownerLine', { owner: r.owner, when: fmtRelative(r.updatedAt) })}
          </Text>
          {tags(r)}
        </Paper>
      )}
    />
  );
}

function NewRecordModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const types = useRecordTypes();
  const typeName = useTypeName();
  const qc = useQueryClient();
  const [type, setType] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = types.data?.find((x) => x.key === type);
  const v = useFieldErrors({ type: !type && t('common:validation.required'), title: !title.trim() && t('common:validation.required') });
  const submit = async () => {
    if (!v.validate() || !type) return;
    setBusy(true);
    try {
      // a built-in type starts with its template in the UI language (the server would use the stored, English one)
      const body = selected && typeTemplate(selected) !== selected.template ? typeTemplate(selected) : undefined;
      const r = await post<RecordDetail>('/records', { type, title: title.trim(), ...(body !== undefined ? { body } : {}) });
      qc.invalidateQueries({ queryKey: ['records'] });
      onCreated(r);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('create.title')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('create.type')}
            data={(types.data ?? []).map((x) => ({ value: x.key, label: `${x.key} – ${typeName(x)}` }))}
            value={type}
            onChange={setType}
            required
            data-autofocus
            error={v.error('type')}
          />
          {selected?.description && (
            <Text size="xs" c="dimmed">
              {typeDescription(selected)}
            </Text>
          )}
          <TextInput
            label={t('create.recordTitle')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            required
            maxLength={300}
            error={v.error('title')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('create.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The fields an import fills in, by their label in the UI language. */
function importedFields(it: RecordImportItem): string {
  const keys = Object.keys(it.fields ?? {});
  return keys.map((k) => (it.typeKey ? fieldLabelByKey(it.typeKey, k) : k)).join(', ');
}

interface Picked {
  filename: string;
  content: string;
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const qc = useQueryClient();
  const types = useRecordTypes();
  const typeName = useTypeName();
  const [files, setFiles] = useState<Picked[]>([]);
  const [type, setType] = useState<string | null>(null);
  const [preview, setPreview] = useState<RecordImportItem[] | null>(null);
  const [result, setResult] = useState<RecordImportItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const resetRef = useRef<() => void>(null);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const MAX_FILES = meta.data?.maxImportFiles ?? 20;
  const MAX_BYTES = meta.data?.maxImportBytes ?? 256 * 1024;

  const add = async (list: File[]) => {
    setProblem(null);
    setResult(null);
    const picked: Picked[] = [];
    for (const f of list) {
      if (f.size > MAX_BYTES) {
        setProblem(t('importer.tooLarge', { name: f.name }));
        continue;
      }
      picked.push({ filename: f.name, content: await f.text() });
    }
    const next = [...files.filter((x) => !picked.some((p) => p.filename === x.filename)), ...picked];
    if (next.length > MAX_FILES) setProblem(t('importer.tooMany', { max: MAX_FILES }));
    setFiles(next.slice(0, MAX_FILES));
    resetRef.current?.();
    await runPreview(next.slice(0, MAX_FILES), type);
  };
  const runPreview = async (list: Picked[], tp: string | null) => {
    if (!list.length) return setPreview(null);
    try {
      setPreview(await post<RecordImportItem[]>('/records/import', { files: list, type: tp ?? undefined, dryRun: true }));
    } catch (e) {
      setProblem(errorText(e));
    }
  };
  const doImport = async () => {
    setBusy(true);
    try {
      const r = await post<RecordImportItem[]>('/records/import', {
        files: files.filter((f) => preview?.find((p) => p.filename === f.filename)?.ok),
        type: type ?? undefined,
      });
      setResult(r);
      setPreview(null);
      setFiles([]);
      qc.invalidateQueries({ queryKey: ['records'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const items = result ?? preview ?? [];
  const okCount = (preview ?? []).filter((p) => p.ok).length;

  return (
    <Modal opened onClose={onClose} title={t('importer.title')} size="xl">
      <Stack gap="sm">
        <Text size="sm">{t('importer.help')}</Text>
        <Select
          label={t('importer.type')}
          description={t('importer.typeHelp')}
          placeholder={t('importer.typeFromFile')}
          clearable
          data={(types.data ?? []).map((x) => ({ value: x.key, label: `${x.key} – ${typeName(x)}` }))}
          value={type}
          onChange={(v) => {
            setType(v);
            void runPreview(files, v);
          }}
        />
        <Box
          data-testid="import-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void add([...e.dataTransfer.files]);
          }}
          p="lg"
          style={{
            border: `2px dashed var(--mantine-color-${drag ? 'blue-filled' : 'default-border'})`,
            borderRadius: 8,
            textAlign: 'center',
          }}
        >
          <Stack gap={6} align="center">
            <IconUpload size={28} aria-hidden />
            <Text size="sm">{t('importer.drop')}</Text>
            <FileButton onChange={(f) => void add(f)} accept=".md,.markdown,.txt,text/markdown,text/plain" multiple resetRef={resetRef}>
              {(props) => (
                <Button size="xs" variant="default" {...props}>
                  {t('importer.choose')}
                </Button>
              )}
            </FileButton>
          </Stack>
        </Box>
        {problem && <Alert color="orange">{problem}</Alert>}
        {items.length > 0 && (
          <div className="table-scroll">
            <Table fz="sm" aria-label={result ? t('importer.result') : t('importer.preview')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('importer.file')}</Table.Th>
                  <Table.Th>{t('importer.recordCol')}</Table.Th>
                  <Table.Th>{t('importer.details')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {items.map((it) => (
                  <Table.Tr key={it.filename}>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        {it.ok ? (
                          <IconCheck size={14} color="var(--mantine-color-green-text)" aria-label={t('importer.ok')} />
                        ) : (
                          <IconX size={14} color="var(--mantine-color-red-text)" aria-label={t('importer.error')} />
                        )}
                        <Text size="sm" className="mono">
                          {it.filename}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {it.ok ? (
                        <>
                          {it.record ? (
                            <Anchor component={Link} to={`/records/${it.record.id}`} size="sm" onClick={onClose}>
                              {it.record.number} {it.title}
                            </Anchor>
                          ) : (
                            <Text size="sm">
                              {it.typeKey} · {it.title}
                            </Text>
                          )}
                        </>
                      ) : (
                        <Text size="sm" c="red">
                          {codeText(it.errorCode, it.errorParams, it.error) ?? it.error}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {it.ok && (
                        <Stack gap={2}>
                          <Text size="xs">{t('importer.formatLine', { format: t(`importer.formats.${it.format ?? 'markdown'}`) })}</Text>
                          {it.originalStatus && <Text size="xs">{t('importer.originalStatus', { status: it.originalStatus })}</Text>}
                          {Object.keys(it.fields ?? {}).length > 0 && (
                            <Text size="xs" c="dimmed">
                              {t('importer.fieldsLine', { fields: importedFields(it) })}
                            </Text>
                          )}
                          {(it.warnings ?? []).map((w, i) => (
                            <Text key={i} size="xs" c="orange">
                              {codeText(it.warningCodes?.[i]?.code, it.warningCodes?.[i]?.params, w) ?? w}
                            </Text>
                          ))}
                        </Stack>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
        {result && <Alert color="green">{t('importer.done', { count: result.filter((r) => r.record).length })}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
          {!result && (
            <Button onClick={doImport} loading={busy} disabled={!okCount}>
              {t('importer.import', { count: okCount })}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
