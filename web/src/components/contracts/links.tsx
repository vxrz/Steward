import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Paper, Select, Stack, Text, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconLink, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_CONTRACT_LINK_KINDS,
  DATABASE_KIND,
  qualifiedTable,
  type ApiOperation,
  type ApplicationSummary,
  type DataContractDetail,
  type DataContractLink,
  type DataContractLinkKind,
  type DatasetMeta,
  type DbSchemaSnapshot,
  type Platform,
  type PlatformSpec,
  type SystemSummary,
} from '@sm/shared';
import { del, get, getOptional, notifyError, post } from '../../api';
import { EmptyState } from '../common';
import { confirmDanger } from '../confirm';
import { dataContractKeys, platformKeys } from '../../queryKeys';
import { fmtDate } from '../../format';

/** Where a link's target lives in Steward (null: no page of its own). */
function targetPath(l: DataContractLink): string | null {
  if (l.name === null) return null;
  if (l.kind === 'application') return `/applications/${encodeURIComponent(l.targetId)}`;
  if (l.kind === 'system') return `/systems/${encodeURIComponent(l.targetId)}`;
  if (l.kind === 'server') return `/platforms/${encodeURIComponent(l.targetId)}`;
  if (l.kind === 'table')
    return l.targetKind === 'system' ? `/systems/${encodeURIComponent(l.targetId)}/schema` : `/platforms/${encodeURIComponent(l.targetId)}?tab=schema`;
  return null;
}

/** The links of a contract (#221): what it describes and which database platform answers for its servers. */
export function LinksPanel({ c, canEdit }: { c: DataContractDetail; canEdit: boolean }) {
  const { t } = useTranslation(['contracts', 'common']);
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const remove = async (l: DataContractLink) => {
    if (!(await confirmDanger({ action: 'remove', message: t('links.removeConfirm') }))) return;
    try {
      await del(`/data-contracts/${c.id}/links/${l.id}`);
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="md" maw={1000}>
      <Text size="sm" c="dimmed">
        {t('links.intro')}
      </Text>
      {!c.links.length && !adding && (
        <EmptyState
          compact
          icon={IconLink}
          title={t('links.emptyTitle')}
          whoCanAct={canEdit ? undefined : t('links.whoCanAct')}
          action={
            canEdit && (
              <Button size="xs" onClick={() => setAdding(true)}>
                {t('links.add')}
              </Button>
            )
          }
        >
          {t('links.emptyText')}
        </EmptyState>
      )}
      {c.links.length > 0 && (
        <Stack gap="xs" data-testid="contract-links">
          {c.links.map((l) => {
            const to = targetPath(l);
            return (
              <Paper key={l.id} withBorder p="sm">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="wrap">
                      <Badge variant="light" size="sm">
                        {t(`links.kinds.${l.kind}`)}
                      </Badge>
                      {l.name === null ? (
                        <Text size="sm" c="dimmed" fs="italic">
                          {t('links.hidden')}
                        </Text>
                      ) : to ? (
                        <Anchor component={Link} to={to} size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                          {l.name}
                        </Anchor>
                      ) : (
                        <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                          {l.name}
                        </Text>
                      )}
                      {l.detail && (
                        <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {l.kind === 'server' ? t('links.forServer', { server: l.detail }) : l.detail}
                        </Text>
                      )}
                    </Group>
                    <Text size="xs" c="dimmed">
                      {l.schema ? t('links.forSchema', { schema: l.schema }) : t('links.wholeContract')} ·{' '}
                      {t('links.by', { user: l.createdBy, date: fmtDate(l.createdAt) })}
                    </Text>
                  </Stack>
                  {canEdit && (
                    <Tooltip label={t('links.remove')} withArrow>
                      <ActionIcon variant="subtle" color="red" aria-label={t('links.remove')} onClick={() => void remove(l)}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}
      {canEdit && c.links.length > 0 && !adding && (
        <Group>
          <Button size="xs" variant="default" onClick={() => setAdding(true)} data-testid="contract-link-add">
            {t('links.add')}
          </Button>
        </Group>
      )}
      {adding && <AddLink c={c} onDone={() => setAdding(false)} />}
    </Stack>
  );
}

function AddLink({ c, onDone }: { c: DataContractDetail; onDone: () => void }) {
  const { t } = useTranslation(['contracts', 'common']);
  const qc = useQueryClient();
  const [kind, setKind] = useState<DataContractLinkKind>('table');
  const [target, setTarget] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [schema, setSchema] = useState<string | null>(c.facts.schemas.length === 1 ? c.facts.schemas[0]!.name : null);
  const [busy, setBusy] = useState(false);
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications'), enabled: kind === 'application' });
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems'), enabled: kind === 'system' || kind === 'table' });
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets'), enabled: kind === 'dataset' });
  // spec: a platform, then one of its specifications (target) and optionally an operation (detail)
  const [specPlatform, setSpecPlatform] = useState<string | null>(null);
  const specs = useQuery({
    queryKey: ['platform', specPlatform, 'specs'],
    queryFn: () => get<PlatformSpec[]>(`/platforms/${specPlatform}/specs`),
    enabled: kind === 'spec' && !!specPlatform,
  });
  const ops = useQuery({
    queryKey: ['platform', specPlatform, 'operations'],
    queryFn: () => get<ApiOperation[]>(`/platforms/${specPlatform}/operations`),
    enabled: kind === 'spec' && !!specPlatform,
  });
  const [tKind, tId] = kind === 'table' && target ? (target.split(':') as ['platform' | 'system', string]) : [null, null];
  const snap = useQuery({
    queryKey: ['db-schema', tKind, tId, 'snapshot', 'latest'],
    queryFn: () => getOptional<DbSchemaSnapshot | null>(`/db-schemas/${tKind}/${tId}/snapshots/latest`, null),
    enabled: !!tKind,
  });
  const all = platforms.data ?? [];
  const databases = all.filter((p) => p.kind === DATABASE_KIND);
  const targets: { value: string; label: string }[] =
    kind === 'application'
      ? (apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))
      : kind === 'system'
        ? (systems.data ?? []).map((s) => ({ value: s.id, label: s.name }))
        : kind === 'dataset'
          ? (datasets.data ?? []).map((d) => ({ value: d.key, label: `${d.title || d.key} (${d.key})` }))
          : kind === 'spec'
            ? (specs.data ?? []).map((s) => ({ value: s.id, label: s.name }))
            : kind === 'table'
              ? [
                  ...databases.map((p) => ({ value: `platform:${p.id}`, label: p.name })),
                  ...(systems.data ?? []).map((s) => ({ value: `system:${s.id}`, label: s.name })),
                ]
              : databases.filter((p) => p.permissions.includes('use')).map((p) => ({ value: p.id, label: p.name }));
  const details: { value: string; label: string }[] | null =
    kind === 'table'
      ? (snap.data?.schema.tables ?? []).map((x) => ({ value: qualifiedTable(x), label: qualifiedTable(x) }))
      : kind === 'spec'
        ? (ops.data ?? [])
            .filter((o) => o.specId === target)
            .map((o) => ({ value: `${o.method.toUpperCase()} ${o.specPath ?? o.path}`, label: `${o.method.toUpperCase()} ${o.path}` }))
        : kind === 'server'
          ? c.facts.servers.map((s) => ({ value: s.server, label: `${s.server} (${s.type})` }))
          : null;
  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await post(`/data-contracts/${c.id}/links`, {
        kind,
        targetId: kind === 'table' ? tId : target,
        ...(kind === 'table' ? { targetKind: tKind } : {}),
        ...(detail ? { detail } : {}),
        ...(schema && kind !== 'server' ? { schema } : {}),
      });
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
      onDone();
    } catch (e) {
      notifyError(e, t('links.notAdded'));
    } finally {
      setBusy(false);
    }
  };
  const needsDetail = kind === 'table' || kind === 'server';
  return (
    <Paper withBorder p="md" data-testid="contract-link-form">
      <Stack gap="sm">
        <Text fw={600} size="sm">
          {t('links.add')}
        </Text>
        <Select
          label={t('links.kind')}
          data={DATA_CONTRACT_LINK_KINDS.map((k) => ({ value: k, label: t(`links.kinds.${k}`) }))}
          value={kind}
          onChange={(v) => {
            setKind((v as DataContractLinkKind) ?? 'table');
            setTarget(null);
            setDetail(null);
            setSpecPlatform(null);
          }}
          allowDeselect={false}
          description={t(`links.kindHints.${kind}`)}
          data-testid="link-kind"
        />
        {kind === 'spec' && (
          <Select
            label={t('links.platform')}
            data={all.filter((p) => p.kind !== DATABASE_KIND).map((p) => ({ value: p.id, label: p.name }))}
            value={specPlatform}
            onChange={(v) => {
              setSpecPlatform(v);
              setTarget(null);
              setDetail(null);
            }}
            searchable
          />
        )}
        <Select
          label={t(`links.targets.${kind}`)}
          data={targets}
          value={target}
          onChange={(v) => {
            setTarget(v);
            setDetail(null);
          }}
          searchable
          nothingFoundMessage={t('links.nothing')}
          data-testid="link-target"
        />
        {details && (
          <Select
            label={t(`links.details.${kind as 'table' | 'spec' | 'server'}`)}
            data={details}
            value={detail}
            onChange={setDetail}
            searchable
            clearable={!needsDetail}
            required={needsDetail}
            nothingFoundMessage={kind === 'table' ? t('links.noTables') : t('links.nothing')}
            data-testid="link-detail"
          />
        )}
        {kind !== 'server' && c.facts.schemas.length > 0 && (
          <Select
            label={t('links.schema')}
            description={t('links.schemaHint')}
            data={c.facts.schemas.map((s) => ({ value: s.name, label: s.name }))}
            value={schema}
            onChange={setSchema}
            clearable
          />
        )}
        <Group>
          <Button size="xs" onClick={() => void save()} loading={busy} disabled={!target || (needsDetail && !detail)} data-testid="link-save">
            {t('links.save')}
          </Button>
          <Button size="xs" variant="default" onClick={onDone}>
            {t('common:cancel')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
