import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Menu, Paper, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDots, IconDownload, IconEdit, IconRefresh, IconTrash, IconDeviceFloppy, IconX } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { Dashboard, DashboardDefinition, DatasetStatus } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { fmtRelative } from '../format';
import { errorText } from '../i18n/errors';
import { DashboardContext, useDatasetMetas } from '../components/dashboard/data';
import { WidgetGrid } from '../components/dashboard/widgets';
import { DashboardEditor } from '../components/dashboard/DashboardEditor';
import '../components/dashboard/viz.css';

export function DashboardViewPage() {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dash = useQuery({ queryKey: ['dashboard', id], queryFn: () => get<Dashboard>(`/dashboards/${id}`), enabled: !!id });
  const [draft, setDraft] = useState<DashboardDefinition | null>(null);
  const [fastUntil, setFastUntil] = useState(0);
  const [statusFilter, setStatusFilter] = useState<{ dataset: string; status: DatasetStatus } | null>(null);
  const [busy, setBusy] = useState(false);

  const d = dash.data;
  const def = draft ?? d?.definition;
  const refreshMs = Date.now() < fastUntil ? 3000 : (def?.refreshSeconds ?? 60) * 1000;
  const ctx = useMemo(() => ({ refreshMs, statusFilter, setStatusFilter }), [refreshMs, statusFilter]);

  if (dash.error) return <Alert color="red">{errorText(dash.error)}</Alert>;
  if (!d || !def) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await post<{ started: { processId: string; runId: string }[]; skipped: { processId: string; reason: string }[] }>(`/dashboards/${d.id}/refresh`);
      notifications.show({
        color: r.started.length ? 'blue' : 'yellow',
        title: r.started.length ? t('view.refreshing', { count: r.started.length }) : t('view.nothingStarted'),
        message: [
          ...r.started.map((s) => `▶ ${s.processId}`),
          ...r.skipped.map((s) => `– ${s.processId}: ${s.reason}`),
        ].join('\n') || t('view.noSources'),
        autoClose: 8000,
        style: { whiteSpace: 'pre-line' },
      });
      if (r.started.length) {
        setFastUntil(Date.now() + 90000);
        setTimeout(() => setFastUntil(0), 91000);
      }
    } catch (e) {
      notifyError(e, t('view.refreshFailed'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await put<Dashboard>(`/dashboards/${d.id}`, { definition: draft });
      qc.setQueryData(['dashboard', id], saved);
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      setDraft(null);
      notifyOk(t('view.saved'));
    } catch (e) {
      notifyError(e, t('view.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DashboardContext.Provider value={ctx}>
      <PageHeader
        title={def.name}
        description={
          <>
            {def.description && <>{def.description} · </>}
            <LastUpdate keys={def.widgets.map((w) => w.dataset).filter((x): x is string => !!x)} />
          </>
        }
        actions={
          draft ? (
            <>
              <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => setDraft(null)}>
                {t('common:cancel')}
              </Button>
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={busy} onClick={save} disabled={!draft.name.trim()}>
                {t('common:save')}
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} loading={busy} onClick={refresh}>
                {t('view.refresh')}
              </Button>
              {d.canEdit && (
                <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => setDraft(structuredClone(d.definition))}>
                  {t('common:edit')}
                </Button>
              )}
              <Menu position="bottom-end">
                <Menu.Target>
                  <Button size="xs" variant="subtle" px={6} aria-label={t('view.more')}>
                    <IconDots size={16} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconDownload size={14} />} component="a" href={`/api/dashboards/${d.id}/export`}>
                    {t('view.exportYaml')}
                  </Menu.Item>
                  {d.canEdit && (
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={async () => {
                        if (!confirm(t('view.deleteConfirm', { name: d.name }))) return;
                        try {
                          await del(`/dashboards/${d.id}`);
                          qc.invalidateQueries({ queryKey: ['dashboards'] });
                          navigate('/dashboards');
                        } catch (e) {
                          notifyError(e);
                        }
                      }}
                    >
                      {t('common:delete')}
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            </>
          )
        }
      />
      {draft && <DashboardEditor value={draft} onChange={setDraft} />}
      {def.widgets.length === 0 ? (
        <Paper withBorder p="lg">
          <Text fw={600}>{t('view.noWidgets')}</Text>
          <Text size="sm" c="dimmed">
            {d.canEdit ? `${t('view.clickEdit')} ` : ''}
            <Trans
              t={t}
              i18nKey="view.widgetsHint"
              values={{ node: t('editor:steps.publish.label') }}
              components={{ a: <Anchor component={Link} to="/dashboards" /> }}
            />
          </Text>
        </Paper>
      ) : (
        <WidgetGrid widgets={def.widgets} />
      )}
    </DashboardContext.Provider>
  );
}

function LastUpdate({ keys }: { keys: string[] }) {
  const { t } = useTranslation('dashboards');
  const metas = useDatasetMetas();
  const latest = (metas.data ?? [])
    .filter((m) => keys.includes(m.key))
    .map((m) => m.updatedAt)
    .sort()
    .pop();
  return <span>{latest ? t('view.dataFrom', { when: fmtRelative(latest) }) : t('view.noData')}</span>;
}
