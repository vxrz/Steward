import { useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Drawer,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconCheck, IconCopy, IconFilePlus, IconKey, IconLink, IconSearch, IconTransfer } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  dbSchemaChangesMarkdown,
  qualifiedTable,
  type DbSchemaChange,
  type DbSchemaCheck,
  type DbSchemaDiff,
  type DbSchemaSnapshot,
  type DbSchemaSnapshotSummary,
  type DbSchemaTable,
  type RecordDetail,
} from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { EmptyState, QueryState } from '../common';
import { fmtDate, fmtNumber } from '../../format';
import { dbSchemaKeys } from '../../queryKeys';
import { useRecordTypes } from '../records/common';
import { typeTemplate } from '../records/builtin';
import type { SchemaSubject } from './SchemaView';

/** The panels of the schema view (#222): tables with their detail, changes, history, lint findings. */

const SHOWN = 200;
const usePhone = () => useMediaQuery('(max-width: 48em)');

// ---------- tables ----------

export function TablesPanel({ snapshot, schemas }: { snapshot: DbSchemaSnapshot; schemas: string[] }) {
  const { t } = useTranslation('platforms');
  const phone = usePhone();
  const [q, setQ] = useState('');
  const [schema, setSchema] = useState<string | null>(null);
  const [limit, setLimit] = useState(SHOWN);
  const [open, setOpen] = useState<DbSchemaTable | null>(null);
  const tables = snapshot.schema.tables;
  const found = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tables.filter(
      (x) =>
        (schema === null || (x.schema ?? '') === schema) &&
        (!needle ||
          qualifiedTable(x).toLowerCase().includes(needle) ||
          (x.comment ?? '').toLowerCase().includes(needle) ||
          x.columns.some((c) => c.name.toLowerCase().includes(needle))),
    );
  }, [tables, q, schema]);
  const shown = found.slice(0, limit);
  const keyBadges = (x: DbSchemaTable) => (
    <Group gap={4} wrap="wrap">
      {x.primaryKey && (
        <Badge size="xs" variant="light" color="yellow" leftSection={<IconKey size={10} />}>
          {t('schema.pk')}
        </Badge>
      )}
      {x.foreignKeys.length > 0 && (
        <Badge size="xs" variant="light" color="blue" leftSection={<IconLink size={10} />}>
          {t('schema.fkCount', { count: x.foreignKeys.length })}
        </Badge>
      )}
      {x.type !== 'table' && (
        <Badge size="xs" variant="default">
          {x.type}
        </Badge>
      )}
    </Group>
  );
  const name = (x: DbSchemaTable) => (
    <UnstyledButton onClick={() => setOpen(x)} className="mono" style={{ wordBreak: 'break-all' }} data-testid="schema-table-open">
      <Text span size="sm" c="var(--mantine-primary-color-filled)" fw={500}>
        {qualifiedTable(x)}
      </Text>
    </UnstyledButton>
  );
  return (
    <Stack gap="sm" data-testid="schema-tables">
      <Group gap="sm" wrap="wrap" align="flex-end">
        <TextInput
          style={{ flex: 1, minWidth: 200 }}
          leftSection={<IconSearch size={14} />}
          placeholder={t('schema.searchPlaceholder')}
          aria-label={t('schema.search')}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            setLimit(SHOWN);
          }}
          data-testid="schema-search"
        />
        {schemas.length > 1 && (
          <Select
            aria-label={t('schema.schemaFilter')}
            placeholder={t('schema.allSchemas')}
            clearable
            data={schemas.map((x) => ({ value: x, label: x || t('schema.noSchema') }))}
            value={schema}
            onChange={setSchema}
            w={200}
          />
        )}
      </Group>
      {!found.length && (
        <EmptyState compact icon={IconSearch} title={t('schema.noTables')}>
          {q ? t('schema.noTablesHint') : undefined}
        </EmptyState>
      )}
      {found.length > 0 && phone && (
        <Stack gap="xs">
          {shown.map((x) => (
            <Paper key={qualifiedTable(x)} withBorder p="sm">
              <Stack gap={4}>
                {name(x)}
                <Group gap="xs" wrap="wrap">
                  <Text size="xs" c="dimmed">
                    {t('schema.columnCount', { count: x.columns.length, n: fmtNumber(x.columns.length) })}
                  </Text>
                  {keyBadges(x)}
                </Group>
                {x.comment && (
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {x.comment}
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}
      {found.length > 0 && !phone && (
        <div className="table-scroll">
          <Table fz="sm" highlightOnHover aria-label={t('schema.tabs.tables')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('schema.table')}</Table.Th>
                <Table.Th>{t('schema.columns')}</Table.Th>
                <Table.Th>{t('schema.keys')}</Table.Th>
                <Table.Th>{t('schema.comment')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((x) => (
                <Table.Tr key={qualifiedTable(x)}>
                  <Table.Td>{name(x)}</Table.Td>
                  <Table.Td>{x.columns.length}</Table.Td>
                  <Table.Td>{keyBadges(x)}</Table.Td>
                  <Table.Td maw={380}>
                    <Text size="sm" c={x.comment ? undefined : 'dimmed'} lineClamp={2}>
                      {x.comment || '–'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {found.length > shown.length && (
        <Group justify="center">
          <Button size="xs" variant="default" onClick={() => setLimit((n) => n + SHOWN)}>
            {t('schema.showMore', { shown: shown.length, total: fmtNumber(found.length) })}
          </Button>
        </Group>
      )}
      <TableDrawer table={open} all={tables} onClose={() => setOpen(null)} onOpen={setOpen} />
    </Stack>
  );
}

/** One table: its columns, keys, the foreign keys of other tables that point to it, its indexes. */
function TableDrawer({
  table,
  all,
  onClose,
  onOpen,
}: {
  table: DbSchemaTable | null;
  all: DbSchemaTable[];
  onClose: () => void;
  onOpen: (t: DbSchemaTable) => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const phone = usePhone();
  const x = table;
  const pk = new Set(x?.primaryKey?.columns ?? []);
  const fkCols = new Set((x?.foreignKeys ?? []).flatMap((f) => f.columns));
  const referencedBy = x
    ? all.flatMap((o) => o.foreignKeys.filter((f) => f.refTable === x.name && (f.refSchema ?? o.schema) === x.schema).map((f) => ({ from: o, fk: f })))
    : [];
  const find = (schema: string | null, name: string) => all.find((o) => o.name === name && (o.schema ?? null) === (schema ?? null));
  const ref = (schema: string | null, name: string, cols: string[]) => {
    const target = find(schema, name);
    const label = `${schema ? `${schema}.` : ''}${name} (${cols.join(', ')})`;
    return target ? (
      <Anchor component="button" type="button" size="sm" className="mono" onClick={() => onOpen(target)}>
        {label}
      </Anchor>
    ) : (
      <Text span size="sm" className="mono">
        {label}
      </Text>
    );
  };
  return (
    <Drawer
      opened={!!x}
      onClose={onClose}
      position="right"
      size={phone ? '100%' : 'xl'}
      title={
        x && (
          <Group gap="xs" wrap="wrap">
            <Text fw={600} className="mono" style={{ wordBreak: 'break-all' }}>
              {qualifiedTable(x)}
            </Text>
            <Badge size="sm" variant="default">
              {x.type}
            </Badge>
          </Group>
        )
      }
      closeButtonProps={{ 'aria-label': t('common:close') }}
    >
      {x && (
        <Stack gap="md" data-testid="schema-table-detail">
          {x.comment && <Text size="sm">{x.comment}</Text>}
          <div>
            <Text fw={600} size="sm" mb={4} id="schema-columns-title">
              {t('schema.columns')}
            </Text>
            <div className="table-scroll">
              <Table fz="sm" aria-labelledby="schema-columns-title">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('schema.column')}</Table.Th>
                    <Table.Th>{t('schema.type')}</Table.Th>
                    <Table.Th>{t('schema.nullable')}</Table.Th>
                    <Table.Th>{t('schema.default')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {x.columns.map((c) => (
                    <Table.Tr key={c.name}>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <Text size="sm" className="mono">
                            {c.name}
                          </Text>
                          {pk.has(c.name) && (
                            <Tooltip label={t('schema.pkLong')}>
                              <Badge size="xs" variant="light" color="yellow" aria-label={t('schema.pkLong')}>
                                {t('schema.pk')}
                              </Badge>
                            </Tooltip>
                          )}
                          {fkCols.has(c.name) && (
                            <Tooltip label={t('schema.fkLong')}>
                              <Badge size="xs" variant="light" color="blue" aria-label={t('schema.fkLong')}>
                                {t('schema.fk')}
                              </Badge>
                            </Tooltip>
                          )}
                        </Group>
                        {c.comment && (
                          <Text size="xs" c="dimmed">
                            {c.comment}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td className="mono">{c.type}</Table.Td>
                      <Table.Td className="nowrap">{c.nullable ? t('schema.null') : t('schema.notNull')}</Table.Td>
                      <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                        {c.default ?? '–'}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </div>
          <div>
            <Text fw={600} size="sm" mb={4}>
              {t('schema.keys')}
            </Text>
            <Stack gap={4}>
              <Text size="sm">
                {t('schema.pkLong')}:{' '}
                {x.primaryKey ? (
                  <Code>{x.primaryKey.columns.join(', ')}</Code>
                ) : (
                  <Text span c="dimmed" size="sm">
                    {t('schema.none')}
                  </Text>
                )}
              </Text>
              {x.foreignKeys.map((f, i) => (
                <Text size="sm" key={`${f.name ?? ''}${i}`}>
                  <Code>{f.columns.join(', ')}</Code> → {ref(f.refSchema, f.refTable, f.refColumns)}
                  {f.onDelete && f.onDelete !== 'NO ACTION' ? (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      ON DELETE {f.onDelete}
                    </Text>
                  ) : null}
                </Text>
              ))}
              {referencedBy.length > 0 && (
                <>
                  <Text size="sm" c="dimmed" mt={4}>
                    {t('schema.referencedBy')}
                  </Text>
                  {referencedBy.map(({ from, fk }, i) => (
                    <Text size="sm" key={i}>
                      {ref(from.schema, from.name, fk.columns)}
                    </Text>
                  ))}
                </>
              )}
            </Stack>
          </div>
          {x.indexes.length > 0 && (
            <div>
              <Text fw={600} size="sm" mb={4}>
                {t('schema.indexes')}
              </Text>
              <Stack gap={4}>
                {x.indexes.map((i) => (
                  <Group key={i.name} gap="xs" wrap="wrap">
                    <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
                      {i.name}
                    </Text>
                    <Code>{i.columns.join(', ') || i.definition || '–'}</Code>
                    {i.primary ? (
                      <Badge size="xs" variant="light" color="yellow">
                        {t('schema.pk')}
                      </Badge>
                    ) : i.unique ? (
                      <Badge size="xs" variant="light">
                        {t('schema.unique')}
                      </Badge>
                    ) : null}
                  </Group>
                ))}
              </Stack>
            </div>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

// ---------- changes ----------

export function ChangesPanel({ subject, snapshot, snapshots }: { subject: SchemaSubject; snapshot: DbSchemaSnapshot; snapshots: DbSchemaSnapshotSummary[] }) {
  const { t } = useTranslation(['platforms', 'common']);
  const phone = usePhone();
  const navigate = useNavigate();
  const types = useRecordTypes();
  const [other, setOther] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'breaking'>('all');
  const [creating, setCreating] = useState(false);
  const base = other ?? snapshot.previousId;
  const others = snapshots.filter((x) => x.id !== snapshot.id);
  const cmp = useQuery({
    queryKey: dbSchemaKeys.compare(subject.kind, subject.id, base, snapshot.id),
    queryFn: () => get<DbSchemaDiff>(`/db-schemas/${subject.kind}/${subject.id}/compare?from=${base}&to=${snapshot.id}`),
    enabled: !!base && base !== snapshot.previousId,
  });
  const diff = base && base === snapshot.previousId ? snapshot.diff : cmp.data;
  const baseSnap = snapshots.find((x) => x.id === base);
  const cr = types.data?.find((x) => x.key === 'CR' && !x.archived) ?? types.data?.find((x) => x.workflow === 'change' && !x.archived);
  const when = baseSnap ? `${fmtDate(baseSnap.takenAt)} → ${fmtDate(snapshot.takenAt)}` : fmtDate(snapshot.takenAt);
  // the Markdown is built from dynamic keys: a plain function of key and values
  const tx = (k: string, o?: Record<string, unknown>): string => String(t(k as never, o as never));
  const md = diff ? dbSchemaChangesMarkdown(tx, subject.name, diff, when) : '';

  const newChangeRecord = async () => {
    if (!cr || !diff) return;
    setCreating(true);
    try {
      const r = await post<RecordDetail>('/records', {
        type: cr.id,
        title: t('schema.crTitle', { name: subject.name }).slice(0, 300),
        body: `${typeTemplate(cr)}\n${md}\n`.slice(0, 100_000),
        links: [{ kind: subject.kind, id: subject.id, note: t('schema.crLinkNote') }],
      });
      navigate(`/records/${r.id}/edit`);
    } catch (e) {
      notifyError(e);
      setCreating(false);
    }
  };

  if (!others.length)
    return (
      <EmptyState compact icon={IconTransfer} title={t('schema.noChangesYet')}>
        {t('schema.noChangesYetHint')}
      </EmptyState>
    );
  const list = (diff?.changes ?? []).filter((c) => only === 'all' || c.breaking);
  return (
    <Stack gap="sm" data-testid="schema-changes">
      <Group gap="sm" wrap="wrap" align="flex-end">
        <Select
          label={t('schema.compareWith')}
          data={others.map((x) => ({
            value: x.id,
            label: `${fmtDate(x.takenAt)} · ${t(`schema.sources.${x.source}`)}${x.id === snapshot.previousId ? ` · ${t('schema.previous')}` : ''}`,
          }))}
          value={base}
          onChange={(v) => setOther(v)}
          allowDeselect={false}
          placeholder={t('schema.choosePrevious')}
          w={phone ? '100%' : 360}
          data-testid="schema-compare"
        />
        <SegmentedControl
          size="xs"
          aria-label={t('schema.filterChanges')}
          value={only}
          onChange={(v) => setOnly(v as 'all' | 'breaking')}
          data={[
            { value: 'all', label: t('schema.allChanges') },
            { value: 'breaking', label: t('schema.onlyBreaking') },
          ]}
        />
      </Group>
      {!base && (
        <Text size="sm" c="dimmed">
          {t('schema.firstSnapshot')}
        </Text>
      )}
      <QueryState query={cmp} rows={2} />
      {diff && (
        <>
          <Group justify="space-between" gap="xs" wrap="wrap">
            <Group gap="xs">
              <Text size="sm" fw={500} data-testid="schema-change-summary">
                {t('schema.changeSummary', { count: diff.total })}
              </Text>
              {diff.breaking > 0 ? (
                <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                  {t('schema.breakingCount', { count: diff.breaking })}
                </Badge>
              ) : (
                diff.total > 0 && (
                  <Badge color="green" variant="light">
                    {t('schema.noBreaking')}
                  </Badge>
                )
              )}
            </Group>
            {diff.total > 0 && (
              <Group gap="xs">
                <CopyButton value={md}>
                  {({ copied, copy }) => (
                    <Button size="xs" variant="default" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
                      {copied ? t('common:copied') : t('schema.copyMarkdown')}
                    </Button>
                  )}
                </CopyButton>
                {cr && (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconFilePlus size={14} />}
                    loading={creating}
                    onClick={() => void newChangeRecord()}
                    data-testid="schema-new-cr"
                  >
                    {t('schema.newChangeRecord')}
                  </Button>
                )}
              </Group>
            )}
          </Group>
          {diff.incomplete && (
            <Alert color="orange" variant="light" p="xs">
              <Text size="sm">{t('schema.incomplete')}</Text>
            </Alert>
          )}
          {diff.total === 0 && (
            <Text size="sm" c="dimmed">
              {t('schema.sameSchema')}
            </Text>
          )}
          {list.length > 0 && phone && (
            <Stack gap="xs">
              {list.map((c, i) => (
                <Paper key={i} withBorder p="sm">
                  <Stack gap={2}>
                    <Group gap="xs" wrap="wrap">
                      <Text size="sm" fw={500}>
                        {t(`schema.changeKinds.${c.kind}`)}
                      </Text>
                      {c.breaking && <BreakingBadge c={c} />}
                    </Group>
                    <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
                      {c.table}
                      {c.column ? `.${c.column}` : ''}
                      {c.name ? ` (${c.name})` : ''}
                    </Text>
                    {(c.before || c.after) && (
                      <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
                        {c.before ?? '–'} → {c.after ?? '–'}
                      </Text>
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
          {list.length > 0 && !phone && (
            <div className="table-scroll">
              <Table fz="sm" aria-label={t('schema.tabs.changes')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('schema.where')}</Table.Th>
                    <Table.Th>{t('schema.change')}</Table.Th>
                    <Table.Th>{t('schema.beforeAfter')}</Table.Th>
                    <Table.Th>{t('schema.breaking')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.map((c, i) => (
                    <Table.Tr key={i}>
                      <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                        {c.table}
                        {c.column ? `.${c.column}` : ''}
                        {c.name ? (
                          <Text span size="xs" c="dimmed">
                            {' '}
                            ({c.name})
                          </Text>
                        ) : null}
                      </Table.Td>
                      <Table.Td>{t(`schema.changeKinds.${c.kind}`)}</Table.Td>
                      <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                        {c.before || c.after ? `${c.before ?? '–'} → ${c.after ?? '–'}` : '–'}
                      </Table.Td>
                      <Table.Td>
                        {c.breaking ? (
                          <BreakingBadge c={c} />
                        ) : (
                          <Text size="sm" c="dimmed">
                            {t('schema.no')}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
          {diff.total > diff.changes.length && (
            <Text size="xs" c="dimmed">
              {t('schema.mdMore', { count: diff.total - diff.changes.length })}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

function BreakingBadge({ c }: { c: DbSchemaChange }) {
  const { t } = useTranslation('platforms');
  return (
    <Badge color="red" variant="light" size="sm" style={{ textTransform: 'none' }}>
      {c.reason ? t(`schema.reasons.${c.reason}`) : t('schema.breaking')}
    </Badge>
  );
}

// ---------- history ----------

export function HistoryPanel({ snapshots, current, onShow }: { snapshots: DbSchemaSnapshotSummary[]; current: string | null; onShow: (id: string) => void }) {
  const { t } = useTranslation('platforms');
  const phone = usePhone();
  const changes = (x: DbSchemaSnapshotSummary) =>
    !x.previousId ? (
      <Text size="sm" c="dimmed">
        {t('schema.first')}
      </Text>
    ) : (
      <Group gap={4} wrap="wrap">
        <Text size="sm">{fmtNumber(x.changes)}</Text>
        {x.breaking > 0 && (
          <Badge size="xs" color="red" variant="light">
            {t('schema.breakingCount', { count: x.breaking })}
          </Badge>
        )}
      </Group>
    );
  const show = (x: DbSchemaSnapshotSummary) =>
    x.id === current ? (
      <Badge size="sm" variant="outline">
        {t('schema.shown')}
      </Badge>
    ) : (
      <Button size="compact-xs" variant="subtle" onClick={() => onShow(x.id)} aria-label={t('schema.showSnapshot', { when: fmtDate(x.takenAt) })}>
        {t('schema.show')}
      </Button>
    );
  if (phone)
    return (
      <Stack gap="xs" data-testid="schema-history">
        {snapshots.map((x) => (
          <Paper key={x.id} withBorder p="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={2}>
                <Text size="sm" fw={500}>
                  {fmtDate(x.takenAt)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`schema.sources.${x.source}`)} · {x.actor} · {t('schema.tableCount', { count: x.tables, n: fmtNumber(x.tables) })}
                </Text>
                {changes(x)}
              </Stack>
              {show(x)}
            </Group>
          </Paper>
        ))}
      </Stack>
    );
  return (
    <div className="table-scroll" data-testid="schema-history">
      <Table fz="sm" highlightOnHover aria-label={t('schema.tabs.history')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('schema.takenAt')}</Table.Th>
            <Table.Th>{t('schema.source')}</Table.Th>
            <Table.Th>{t('schema.tabs.tables')}</Table.Th>
            <Table.Th>{t('schema.tabs.changes')}</Table.Th>
            <Table.Th>{t('schema.by')}</Table.Th>
            <Table.Th>
              <VisuallyHidden>{t('schema.show')}</VisuallyHidden>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {snapshots.map((x) => (
            <Table.Tr key={x.id}>
              <Table.Td className="nowrap">{fmtDate(x.takenAt)}</Table.Td>
              <Table.Td>
                {t(`schema.sources.${x.source}`)}
                {x.fileName ? (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    ({x.fileName})
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>{fmtNumber(x.tables)}</Table.Td>
              <Table.Td>{changes(x)}</Table.Td>
              <Table.Td>{x.actor}</Table.Td>
              <Table.Td>{show(x)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

// ---------- tbls lint ----------

export function ChecksPanel({ checks }: { checks: DbSchemaCheck[] }) {
  const { t } = useTranslation('platforms');
  return (
    <Stack gap="xs" data-testid="schema-checks">
      <Text size="sm" c="dimmed">
        {t('schema.checksHint')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('schema.tabs.checks')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('schema.rule')}</Table.Th>
              <Table.Th>{t('schema.target')}</Table.Th>
              <Table.Th>{t('schema.message')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {checks.map((c, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <Code>{c.rule}</Code>
                </Table.Td>
                <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                  {c.target || '–'}
                </Table.Td>
                <Table.Td>{c.message}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
