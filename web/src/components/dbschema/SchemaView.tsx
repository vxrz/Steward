import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, Menu, Paper, Stack, Tabs, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconDatabaseImport,
  IconDownload,
  IconHistory,
  IconListCheck,
  IconRefresh,
  IconSchema,
  IconSettings,
  IconTable,
  IconTransfer,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DbSchemaOverview, DbSchemaSnapshot, DbSchemaSubjectKind } from '@sm/shared';
import { apiUrl, get, notifyError, notifyOk, post } from '../../api';
import { EmptyState, Hint, QueryState } from '../common';
import { fmtDate, fmtNumber, fmtRelative } from '../../format';
import { dbSchemaKeys } from '../../queryKeys';
import { ChangesPanel, ChecksPanel, HistoryPanel, TablesPanel } from './parts';
import { ImportModal, SettingsModal } from './dialogs';

/**
 * The schema of a database (#222, docs/DATABASES.md#database-schemas): on a database platform (its Schema tab) and on
 * a system without a platform (its schema page). The newest snapshot – or one chosen from the history – with its
 * tables, the changes against the snapshot before (or any other), the history and the findings of tbls lint; read
 * the database now, import a tbls schema.json, export DBML, SQL or JSON, and the settings.
 */

export interface SchemaSubject {
  kind: DbSchemaSubjectKind;
  id: string;
  name: string;
}

export function SchemaView({ subject, blockedNote }: { subject: SchemaSubject; blockedNote?: React.ReactNode }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const { kind, id } = subject;
  const q = useQuery({ queryKey: dbSchemaKeys.overview(kind, id), queryFn: () => get<DbSchemaOverview>(`/db-schemas/${kind}/${id}`) });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<string | null>('tables');
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [settings, setSettings] = useState(false);
  const o = q.data;
  const latest = o?.snapshots[0];
  const snapId = selected && o?.snapshots.some((s) => s.id === selected) ? selected : (latest?.id ?? null);
  const snap = useQuery({
    queryKey: dbSchemaKeys.snapshot(kind, id, snapId),
    queryFn: () => get<DbSchemaSnapshot>(`/db-schemas/${kind}/${id}/snapshots/${snapId}`),
    enabled: !!snapId,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: dbSchemaKeys.overview(kind, id) });

  const readNow = async () => {
    setReading(true);
    try {
      const r = await post<{ created: boolean; diff: { total: number; breaking: number } | null }>(`/db-schemas/${kind}/${id}/read`);
      setSelected(null);
      notifyOk(
        !r.created ? t('schema.readUnchanged') : r.diff ? t('schema.readChanged', { count: r.diff.total, breaking: r.diff.breaking }) : t('schema.readFirst'),
      );
    } catch (e) {
      notifyError(e, t('schema.readFailed'));
    } finally {
      setReading(false);
      await refresh();
    }
  };

  const schemas = useMemo(() => [...new Set((snap.data?.schema.tables ?? []).map((x) => x.schema ?? ''))], [snap.data]);
  if (!o) return <QueryState query={q} rows={3} />;
  const canImport = o.canImport && !o.importBlocked;
  const s = snap.data;

  const actions = (
    <Group gap="xs" wrap="wrap">
      {o.canRead && (
        <Button size="xs" leftSection={<IconRefresh size={14} />} loading={reading} onClick={() => void readNow()} data-testid="schema-read">
          {t('schema.readNow')}
        </Button>
      )}
      {canImport && (
        <Button
          size="xs"
          variant={o.canRead ? 'default' : 'filled'}
          leftSection={<IconDatabaseImport size={14} />}
          onClick={() => setImporting(true)}
          data-testid="schema-import"
        >
          {t('schema.importTbls')}
        </Button>
      )}
      {snapId && (
        <Menu position="bottom-end" withinPortal shadow="md">
          <Menu.Target>
            <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} data-testid="schema-export">
              {t('schema.export')}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {(['dbml', 'sql', 'json'] as const).map((f) => (
              <Menu.Item
                key={f}
                component="a"
                href={apiUrl(`/db-schemas/${kind}/${id}/snapshots/${snapId}/export?format=${f}`)}
                data-testid={`schema-export-${f}`}
              >
                {t(`schema.exportFormats.${f}`)}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Label maw={260} style={{ whiteSpace: 'normal' }}>
              {t('schema.exportHint')}
            </Menu.Label>
          </Menu.Dropdown>
        </Menu>
      )}
      {o.canImport && (
        <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setSettings(true)} data-testid="schema-settings">
          {t('schema.settings')}
        </Button>
      )}
    </Group>
  );

  return (
    <Stack gap="sm" data-testid="schema-view">
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <div style={{ flex: 1, minWidth: 220 }}>
            <Title order={5}>{t('schema.title')}</Title>
            <Hint>{kind === 'platform' ? t('schema.helpPlatform') : t('schema.helpSystem')}</Hint>
          </div>
          {actions}
        </Group>
        {o.settings.readIntervalHours > 0 && (
          <Text size="xs" c="dimmed" mt="xs">
            {t('schema.scheduled', { hours: o.settings.readIntervalHours, keep: o.settings.retention })}
          </Text>
        )}
      </Paper>
      {o.importBlocked && (
        <Alert color="blue" variant="light" icon={<IconSchema size={16} />}>
          {blockedNote ?? t('schema.systemIsPlatform')}
        </Alert>
      )}
      {o.lastRead?.error && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title={t('schema.lastReadFailed', { when: fmtRelative(o.lastRead.at) })}
          data-testid="schema-read-error"
        >
          <Text size="sm" style={{ wordBreak: 'break-word' }}>
            {o.lastRead.error}
          </Text>
        </Alert>
      )}
      {!latest && (
        <EmptyState
          icon={IconSchema}
          title={t('schema.empty')}
          whoCanAct={!o.canRead && !canImport ? (kind === 'platform' ? t('schema.whoPlatform') : t('schema.whoSystem')) : undefined}
          testId="schema-empty"
        >
          {kind === 'platform' ? t('schema.emptyPlatform') : t('schema.emptySystem')}
        </EmptyState>
      )}
      {latest && (
        <>
          <QueryState query={snap} rows={3} />
          {s && (
            <>
              <Group gap="xs" wrap="wrap" data-testid="schema-summary">
                <Badge variant="light" color={s.source === 'read' ? 'blue' : 'grape'}>
                  {t(`schema.sources.${s.source}`)}
                </Badge>
                <Text size="sm">
                  {t('schema.tableCount', { count: s.tables, n: fmtNumber(s.tables) })},{' '}
                  {t('schema.columnCount', { count: s.columns, n: fmtNumber(s.columns) })}
                  {s.product ? ` · ${s.product}${s.serverVersion ? ` ${s.serverVersion}` : ''}` : ''}
                </Text>
                <Text size="sm" c="dimmed">
                  {t('schema.taken', { when: fmtDate(s.takenAt), user: s.actor })}
                  {s.checkedAt !== s.takenAt ? ` · ${t('schema.checked', { when: fmtRelative(s.checkedAt) })}` : ''}
                </Text>
                {s.breaking > 0 && (
                  <Badge color="red" variant="light" leftSection={<IconAlertTriangle size={12} />}>
                    {t('schema.breakingCount', { count: s.breaking })}
                  </Badge>
                )}
              </Group>
              {snapId !== latest.id && (
                <Alert color="yellow" variant="light" p="xs" data-testid="schema-older">
                  <Group justify="space-between" gap="xs" wrap="wrap">
                    <Text size="sm">{t('schema.olderSnapshot', { when: fmtDate(s.takenAt) })}</Text>
                    <Button size="compact-xs" variant="subtle" onClick={() => setSelected(null)}>
                      {t('schema.showLatest')}
                    </Button>
                  </Group>
                </Alert>
              )}
              {s.truncated && (
                <Alert color="orange" variant="light" p="xs">
                  <Text size="sm">{t('schema.truncated')}</Text>
                </Alert>
              )}
              <Tabs value={view} onChange={setView} keepMounted={false}>
                <Tabs.List mb="sm" style={{ flexWrap: 'wrap' }}>
                  <Tabs.Tab value="tables" leftSection={<IconTable size={14} />}>
                    {t('schema.tabs.tables')} ({fmtNumber(s.tables)})
                  </Tabs.Tab>
                  <Tabs.Tab
                    value="changes"
                    leftSection={<IconTransfer size={14} />}
                    rightSection={
                      s.breaking > 0 ? (
                        <Badge size="xs" color="red" variant="filled" aria-label={t('schema.breakingCount', { count: s.breaking })}>
                          {s.breaking}
                        </Badge>
                      ) : undefined
                    }
                    data-testid="schema-tab-changes"
                  >
                    {t('schema.tabs.changes')} ({fmtNumber(s.changes)})
                  </Tabs.Tab>
                  <Tabs.Tab value="history" leftSection={<IconHistory size={14} />} data-testid="schema-tab-history">
                    {t('schema.tabs.history')} ({o.snapshots.length})
                  </Tabs.Tab>
                  {s.checks > 0 && (
                    <Tabs.Tab value="checks" leftSection={<IconListCheck size={14} />} data-testid="schema-tab-checks">
                      {t('schema.tabs.checks')} ({s.checks})
                    </Tabs.Tab>
                  )}
                </Tabs.List>
                <Tabs.Panel value="tables">
                  <TablesPanel snapshot={s} schemas={schemas} />
                </Tabs.Panel>
                <Tabs.Panel value="changes">
                  <ChangesPanel subject={subject} snapshot={s} snapshots={o.snapshots} />
                </Tabs.Panel>
                <Tabs.Panel value="history">
                  <HistoryPanel
                    snapshots={o.snapshots}
                    current={snapId}
                    onShow={(sid) => {
                      setSelected(sid);
                      setView('tables');
                    }}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="checks">
                  <ChecksPanel checks={s.lint} />
                </Tabs.Panel>
              </Tabs>
            </>
          )}
        </>
      )}
      {importing && (
        <ImportModal
          subject={subject}
          onClose={() => setImporting(false)}
          onImported={async () => {
            setImporting(false);
            setSelected(null);
            await refresh();
          }}
        />
      )}
      {settings && <SettingsModal subject={subject} settings={o.settings} onClose={() => setSettings(false)} onSaved={() => void refresh()} />}
    </Stack>
  );
}
