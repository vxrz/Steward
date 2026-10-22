import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Anchor, Button, Group, Menu, Paper, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDots, IconDownload, IconEdit, IconRefresh, IconTrash, IconDeviceFloppy, IconX } from '@tabler/icons-react';
import type { Dashboard, DashboardDefinition, DatasetStatus } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { fmtRelative } from '../format';
import { DashboardContext, useDatasetMetas } from '../components/dashboard/data';
import { WidgetGrid } from '../components/dashboard/widgets';
import { DashboardEditor } from '../components/dashboard/DashboardEditor';
import '../components/dashboard/viz.css';

export function DashboardViewPage() {
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

  if (dash.error) return <Alert color="red">{(dash.error as Error).message}</Alert>;
  if (!d || !def) return null;

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await post<{ started: { processId: string; runId: string }[]; skipped: { processId: string; reason: string }[] }>(`/dashboards/${d.id}/refresh`);
      notifications.show({
        color: r.started.length ? 'blue' : 'yellow',
        title: r.started.length ? `Refreshing – ${r.started.length} run(s) started` : 'Nothing was started',
        message: [
          ...r.started.map((s) => `▶ ${s.processId}`),
          ...r.skipped.map((s) => `– ${s.processId}: ${s.reason}`),
        ].join('\n') || 'This dashboard has no data sources yet.',
        autoClose: 8000,
        style: { whiteSpace: 'pre-line' },
      });
      if (r.started.length) {
        setFastUntil(Date.now() + 90000);
        setTimeout(() => setFastUntil(0), 91000);
      }
    } catch (e) {
      notifyError(e, 'Refresh failed');
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
      notifyOk('Dashboard saved');
    } catch (e) {
      notifyError(e, 'Not saved');
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
                Cancel
              </Button>
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={busy} onClick={save} disabled={!draft.name.trim()}>
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} loading={busy} onClick={refresh}>
                Refresh data
              </Button>
              {d.canEdit && (
                <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => setDraft(structuredClone(d.definition))}>
                  Edit
                </Button>
              )}
              <Menu position="bottom-end">
                <Menu.Target>
                  <Button size="xs" variant="subtle" px={6} aria-label="More">
                    <IconDots size={16} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<IconDownload size={14} />} component="a" href={`/api/dashboards/${d.id}/export`}>
                    Export YAML
                  </Menu.Item>
                  {d.canEdit && (
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={async () => {
                        if (!confirm(`Delete dashboard "${d.name}"? The datasets stay.`)) return;
                        try {
                          await del(`/dashboards/${d.id}`);
                          qc.invalidateQueries({ queryKey: ['dashboards'] });
                          navigate('/dashboards');
                        } catch (e) {
                          notifyError(e);
                        }
                      }}
                    >
                      Delete
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
          <Text fw={600}>No widgets yet</Text>
          <Text size="sm" c="dimmed">
            {d.canEdit ? 'Click Edit and add widgets. ' : ''}Widgets show datasets published by processes with a “Publish to dashboard” node – see{' '}
            <Anchor component={Link} to="/dashboards">
              datasets
            </Anchor>
            .
          </Text>
        </Paper>
      ) : (
        <WidgetGrid widgets={def.widgets} />
      )}
    </DashboardContext.Provider>
  );
}

function LastUpdate({ keys }: { keys: string[] }) {
  const metas = useDatasetMetas();
  const latest = (metas.data ?? [])
    .filter((m) => keys.includes(m.key))
    .map((m) => m.updatedAt)
    .sort()
    .pop();
  return <span>{latest ? `data from ${fmtRelative(latest)}` : 'no data yet'}</span>;
}
