import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Group, Modal, NumberInput, Paper, SegmentedControl, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconEdit, IconFileImport, IconKey, IconLayoutGrid, IconPlus, IconTrash } from '@tabler/icons-react';
import { MONITOR_STATUSES, type MonitorDetail, type MonitorGateway, type MonitorSaveResult, type MonitorSummary } from '@sm/shared';
import { Trans, useTranslation } from 'react-i18next';
import { del, get, notifyError, post, put } from '../api';
import { Hint, PageHeader } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { MONITOR_COLORS, MonitorStatusBadge, causeText, fmtUptime, monitorStatusLabel, monitorStatusLower } from '../components/monitors/status';
import { CopyBlock, ImportModal, InstantiateModal, SecretsModal, gatewayCurl } from '../components/monitors/dialogs';

export function MonitorsPage() {
  const { t } = useTranslation(['monitors', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'monitors';
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors'), refetchInterval: 10000 });
  const [importing, setImporting] = useState(false);
  const [secrets, setSecrets] = useState<MonitorSaveResult | null>(null);
  const canCreate = useMe().caps.createMonitors;
  const list = monitors.data ?? [];
  const counts = Object.fromEntries(MONITOR_STATUSES.map((s) => [s, list.filter((m) => m.status === s).length]));

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => navigate('/monitors/new')}>
              {t('new')}
            </Button>
          )
        }
      />
      <Group justify="space-between" mb="md" gap="xs">
        <SegmentedControl
          size="xs"
          value={tab}
          onChange={(v) => setParams(v === 'monitors' ? {} : { tab: v })}
          data={[
            { value: 'monitors', label: t('tabs.monitors') },
            { value: 'templates', label: t('tabs.templates') },
            ...(canCreate ? [{ value: 'gateways', label: t('tabs.gateways') }] : []),
          ]}
        />
        <Group gap="xs">
          <Button size="xs" variant="default" leftSection={<IconLayoutGrid size={14} />} component={Link} to="/monitors/wall">
            {t('wall.title')}
          </Button>
          {canCreate && (
            <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)}>
              {t('import')}
            </Button>
          )}
        </Group>
      </Group>
      {tab === 'monitors' && (
        <>
          <Group gap="xs" mb="sm">
            {MONITOR_STATUSES.filter((s) => counts[s]).map((s) => (
              <Badge key={s} color={MONITOR_COLORS[s]} variant="light">
                {t('list.count', { count: counts[s], status: monitorStatusLabel(s) })}
              </Badge>
            ))}
          </Group>
          {monitors.isSuccess && list.length === 0 && (
            <Text c="dimmed" size="sm">
              {canCreate ? t('list.emptyCreate') : t('list.empty')}
            </Text>
          )}
          {list.length > 0 && <MonitorTable monitors={list} />}
        </>
      )}
      {tab === 'templates' && <TemplatesTab canCreate={canCreate} onCreated={(r) => (setSecrets({ monitor: r[0]!.monitor, secrets: r.flatMap((x) => x.secrets) }), qc.invalidateQueries({ queryKey: ['monitors'] }))} />}
      {tab === 'gateways' && canCreate && <GatewaysTab />}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={(r) => {
            qc.invalidateQueries({ queryKey: ['monitors'] });
            if (r.secrets.length) setSecrets(r);
            navigate(`/monitors/${r.monitor.id}`);
          }}
        />
      )}
      {secrets && <SecretsModal result={secrets} onClose={() => setSecrets(null)} />}
    </>
  );
}

function MonitorTable({ monitors }: { monitors: MonitorSummary[] }) {
  const { t } = useTranslation('monitors');
  const navigate = useNavigate();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  if (narrow) {
    return (
      <Stack gap="xs" role="list" aria-label={t('title')}>
        {monitors.map((m) => (
          <Paper key={m.id} withBorder p="sm" role="listitem" style={{ borderLeft: `6px solid var(--mantine-color-${MONITOR_COLORS[m.status]}-filled)` }}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Anchor component={Link} to={`/monitors/${m.id}`} fw={600} size="sm">
                {m.name}
              </Anchor>
              <MonitorStatusBadge status={m.status} size="xs" />
            </Group>
            {m.rootCauses.length > 0 && (
              <Text size="xs" c="red">
                {t('list.rootCauseLine', { causes: m.rootCauses.map((c) => causeText(c, m.id)).join(', ') })}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {t('list.uptimeLine', { h24: fmtUptime(m.uptime.h24), d7: fmtUptime(m.uptime.d7), since: fmtRelative(m.since) })}
            </Text>
          </Paper>
        ))}
      </Stack>
    );
  }
  return (
    <div className="table-scroll">
      <Table highlightOnHover fz="sm" aria-label={t('title')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('list.status')}</Table.Th>
            <Table.Th>{t('list.monitor')}</Table.Th>
            <Table.Th>{t('list.rootCause')}</Table.Th>
            <Table.Th>{t('list.uptime24h')}</Table.Th>
            <Table.Th>{t('list.uptime7d')}</Table.Th>
            <Table.Th>{t('list.lastChange')}</Table.Th>
            <Table.Th>{t('list.checks')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {monitors.map((m) => (
            <Table.Tr key={m.id} className="clickable" onClick={() => navigate(`/monitors/${m.id}`)}>
              <Table.Td className="nowrap">
                <MonitorStatusBadge status={m.status} />
                {m.acknowledged && (
                  <Badge ml={4} size="xs" variant="outline">
                    {t('list.acknowledged')}
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Anchor component={Link} to={`/monitors/${m.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                  {m.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono">
                  {m.key}
                  {!m.enabled && ` · ${t('list.disabled')}`}
                  {m.templateId && ` · ${t('list.fromTemplate')}`}
                </Text>
                {m.tags.length > 0 && (
                  <Group gap={4} mt={2}>
                    {m.tags.map((tag) => (
                      <Badge key={tag} size="xs" variant="default">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Table.Td>
              <Table.Td maw={280}>
                <Text size="xs" c={m.rootCauses.length ? 'red' : 'dimmed'} lineClamp={2}>
                  {m.maintenance ? t('list.maintenanceLine', { reason: m.maintenance.reason }) : m.rootCauses.map((c) => causeText(c, m.id)).join(', ') || '–'}
                </Text>
              </Table.Td>
              <Table.Td>{fmtUptime(m.uptime.h24)}</Table.Td>
              <Table.Td>{fmtUptime(m.uptime.d7)}</Table.Td>
              <Table.Td className="nowrap">
                <Tooltip label={fmtDate(m.since)}>
                  <Text size="xs">{fmtRelative(m.since)}</Text>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {MONITOR_STATUSES.filter((s) => m.counts[s]).map((s) => (
                    <Badge key={s} size="xs" color={MONITOR_COLORS[s]} variant="light" title={monitorStatusLabel(s)}>
                      {t('list.count', { count: m.counts[s], status: monitorStatusLower(s) })}
                    </Badge>
                  ))}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function TemplatesTab({ canCreate, onCreated }: { canCreate: boolean; onCreated: (r: MonitorSaveResult[]) => void }) {
  const { t } = useTranslation('monitors');
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ['monitor-templates'], queryFn: () => get<MonitorSummary[]>('/monitors?templates=1') });
  const all = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const [using, setUsing] = useState<MonitorDetail | null>(null);
  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        {t('templates.intro')}
      </Text>
      {templates.data?.length === 0 && <Text size="sm">{t('templates.none', { example: 'PowerMeter with machine data' })}</Text>}
      {!!templates.data?.length && (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('tabs.templates')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('templates.template')}</Table.Th>
                <Table.Th>{t('templates.version')}</Table.Th>
                <Table.Th>{t('templates.instances')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {templates.data.map((tpl) => (
                <Table.Tr key={tpl.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {tpl.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {tpl.description}
                    </Text>
                  </Table.Td>
                  <Table.Td>{tpl.version}</Table.Td>
                  <Table.Td>{(all.data ?? []).filter((m) => m.templateId === tpl.id).length}</Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      {canCreate && (
                        <Button size="compact-xs" onClick={async () => setUsing(await get<MonitorDetail>(`/monitors/${tpl.id}`))}>
                          {t('templates.newMonitors')}
                        </Button>
                      )}
                      <ActionIcon variant="subtle" aria-label={t('templates.open', { name: tpl.name })} onClick={() => navigate(`/monitors/${tpl.id}`)}>
                        <IconEdit size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {using && <InstantiateModal template={using} onClose={() => setUsing(null)} onCreated={onCreated} />}
    </>
  );
}

const AUTH_MODES = ['token', 'hmac', 'either'] as const;

type GatewayDraft = { id?: string; name: string; description: string; enabled: boolean; authMode: 'token' | 'hmac' | 'either'; allowedCidrs: string[]; allowedKeys: string[]; rateLimitPerMinute: number };

function GatewaysTab() {
  const { t } = useTranslation(['monitors', 'common']);
  const qc = useQueryClient();
  const gateways = useQuery({ queryKey: ['monitor-gateways'], queryFn: () => get<MonitorGateway[]>('/monitor-gateways'), refetchInterval: 15000 });
  const [draft, setDraft] = useState<GatewayDraft | null>(null);
  const [secret, setSecret] = useState<{ gateway: MonitorGateway; secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['monitor-gateways'] });
  const save = async (d: GatewayDraft) => {
    const { id, ...body } = d;
    try {
      if (id) await put(`/monitor-gateways/${id}`, body);
      else setSecret(await post(`/monitor-gateways`, body));
      setDraft(null);
      refresh();
    } catch (e) {
      notifyError(e, t('gateways.notSaved'));
    }
  };
  return (
    <>
      <Group justify="space-between" mb="sm" align="flex-start">
        <Text size="sm" c="dimmed" maw={760}>
          <Trans t={t} i18nKey="gateways.intro" values={{ endpoint: 'POST /api/hooks/monitors' }} components={{ c: <span className="mono" /> }} />
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft({ name: '', description: '', enabled: true, authMode: 'token', allowedCidrs: [], allowedKeys: [], rateLimitPerMinute: 120 })}>
          {t('gateways.new')}
        </Button>
      </Group>
      {!!gateways.data?.length && (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('tabs.gateways')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('gateways.gateway')}</Table.Th>
                <Table.Th>{t('gateways.allowedKeys')}</Table.Th>
                <Table.Th>{t('gateways.lastReport')}</Table.Th>
                <Table.Th>{t('gateways.accepted')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {gateways.data.map((g) => (
                <Table.Tr key={g.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {g.name}
                      {!g.enabled && ` (${t('list.disabled')})`}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('gateways.line', { prefix: g.secretPrefix, auth: t(`auth.short.${g.authMode}`), rate: g.rateLimitPerMinute, owner: g.owner })}
                    </Text>
                  </Table.Td>
                  <Table.Td className="mono">{g.allowedKeys.join(', ') || t('gateways.anyKey')}</Table.Td>
                  <Table.Td>{fmtRelative(g.lastSeenAt)}</Table.Td>
                  <Table.Td>
                    {fmtNumber(g.acceptedCount)}
                    {g.rejectedCount > 0 && (
                      <Text size="xs" c="orange">
                        {t('gateways.rejected', { count: g.rejectedCount })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {g.canEdit && (
                      <Group gap={2} justify="flex-end" wrap="nowrap">
                        <Tooltip label={t('gateways.rotate')}>
                          <ActionIcon
                            variant="subtle"
                            aria-label={t('gateways.rotateFor', { name: g.name })}
                            onClick={async () => {
                              if (!confirm(t('gateways.rotateConfirm', { name: g.name }))) return;
                              setSecret(await post(`/monitor-gateways/${g.id}/rotate`));
                              refresh();
                            }}
                          >
                            <IconKey size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon variant="subtle" aria-label={t('gateways.editFor', { name: g.name })} onClick={() => setDraft({ ...g })}>
                          <IconEdit size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('gateways.deleteFor', { name: g.name })}
                          onClick={async () => {
                            if (!confirm(t('gateways.deleteConfirm', { name: g.name }))) return;
                            await del(`/monitor-gateways/${g.id}`).catch(notifyError);
                            refresh();
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {draft && <GatewayModal draft={draft} onClose={() => setDraft(null)} onSave={save} />}
      {secret && (
        <Modal opened onClose={() => setSecret(null)} title={t('gateways.secretTitle', { name: secret.gateway.name })} size="xl" closeOnClickOutside={false}>
          <Stack>
            <Alert color="orange" title={t('gateways.copyNow')}>
              {t('gateways.copyNowText')}
            </Alert>
            <CopyBlock label={t('secrets.secret')} text={secret.secret} />
            <CopyBlock label={t('secrets.url')} text={`${window.location.origin}/api/hooks/monitors`} />
            <CopyBlock label={t('gateways.manyInOneCall')} text={gatewayCurl(secret.gateway.allowedKeys.map((k) => k.replace('*', 'example')))} />
            <Hint>
              {t('gateways.reportFormat')}
            </Hint>
            <Group justify="flex-end">
              <Button onClick={() => setSecret(null)}>{t('gateways.stored')}</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </>
  );
}

function GatewayModal({ draft, onClose, onSave }: { draft: GatewayDraft; onClose: () => void; onSave: (d: GatewayDraft) => void }) {
  const { t } = useTranslation(['monitors', 'common']);
  const [d, setD] = useState(draft);
  return (
    <Modal opened onClose={onClose} title={draft.id ? t('gateways.editTitle') : t('gateways.new')} size="lg">
      <Stack>
        <TextInput label={t('form.name')} required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
        <Textarea label={t('form.description')} autosize minRows={1} value={d.description} onChange={(e) => setD({ ...d, description: e.currentTarget.value })} />
        <SegmentedControl
          size="xs"
          value={d.authMode}
          onChange={(v) => setD({ ...d, authMode: v as GatewayDraft['authMode'] })}
          data={AUTH_MODES.map((m) => ({ value: m, label: t(`auth.mode.${m}`) }))}
        />
        <TagsInput label={t('gateways.allowedCheckKeys')} description={t('gateways.allowedCheckKeysHint')} value={d.allowedKeys} onChange={(v) => setD({ ...d, allowedKeys: v })} />
        <TagsInput label={t('gateways.cidrs')} description={t('gateways.cidrsHint')} value={d.allowedCidrs} onChange={(v) => setD({ ...d, allowedCidrs: v })} />
        <NumberInput label={t('gateways.callsPerMinute')} min={1} max={6000} value={d.rateLimitPerMinute} onChange={(v) => setD({ ...d, rateLimitPerMinute: Number(v) || 1 })} />
        <Switch label={t('form.enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button disabled={!d.name.trim()} onClick={() => onSave(d)}>
            {draft.id ? t('common:save') : t('gateways.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
