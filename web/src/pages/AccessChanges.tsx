import { useState } from 'react';
import { Anchor, Badge, Box, Button, Checkbox, Group, Modal, Paper, Select, Stack, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconPlus, IconSearch, IconUserShield } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ACCESS_CHANGE_KINDS, type AccessChange, type Platform, type RecordsMeta } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { useMe } from '../auth';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { EmptyState, FilterPanel, PageHeader, QueryState, useCreateParam } from '../components/common';
import { RecordStatusBadge } from '../components/records/common';
import { KindBadge, RightsDiff } from '../components/compliance/common';
import { fmtDate } from '../format';

/** Compliance → Access changes: every documented grant, revocation and change of access rights (records of the type "Access change"). */
export function AccessChangesPage() {
  const { t } = useTranslation(['compliance', 'records', 'common']);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('subject') ?? '');
  const [subject] = useDebouncedValue(text, 300);
  const platform = params.get('platform');
  const status = params.get('status');
  const [creating, setCreating] = useState(false);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const q = new URLSearchParams();
  if (platform) q.set('platformId', platform);
  if (status) q.set('status', status);
  if (subject.trim()) q.set('subject', subject.trim());
  const list = useQuery({ queryKey: ['access-changes', q.toString()], queryFn: () => get<AccessChange[]>(`/compliance/access-changes?${q}`) });
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const canCreate = meta.data?.canCreate ?? false;
  useCreateParam(meta.data?.canCreate, () => setCreating(true));
  const rows = list.data ?? [];
  const active = [platform, status, subject.trim()].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title={t('accessChanges.title')}
        description={t('accessChanges.description')}
        actions={
          canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('accessChanges.new')}
            </Button>
          )
        }
      />
      <FilterPanel active={active}>
        <Group gap="xs" mb="md" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label={t('accessChanges.subject')}
            leftSection={<IconSearch size={14} />}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('accessChanges.platform')}
            placeholder={t('accessChanges.allPlatforms')}
            clearable
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={platform}
            onChange={(v) => set('platform', v)}
            w={{ base: '100%', xs: 240 }}
          />
          <Select
            size="xs"
            label={t('accessChanges.status')}
            placeholder={t('accessChanges.allStatuses')}
            clearable
            data={['draft', 'documented', 'verified', 'cancelled'].map((s) => ({ value: s, label: t(`records:status.${s as 'draft'}`) }))}
            value={status}
            onChange={(v) => set('status', v)}
            w={{ base: '100%', xs: 180 }}
          />
        </Group>
      </FilterPanel>
      <QueryState query={list} />
      {list.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={IconUserShield}
          title={active ? t('accessChanges.noMatch') : t('accessChanges.emptyTitle')}
          action={
            canCreate &&
            !active && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('accessChanges.new')}
              </Button>
            )
          }
        >
          {!active && t('accessChanges.emptyText')}
        </EmptyState>
      )}
      {rows.length > 0 && <AccessChangeTable rows={rows} />}
      {creating && <AccessChangeModal platforms={platforms.data ?? []} onClose={() => setCreating(false)} />}
    </>
  );
}

function OriginBadge({ a }: { a: AccessChange }) {
  const { t } = useTranslation('compliance');
  // content changed outside Steward: the entry does not count for the reconciliation
  if (a.tampered)
    return (
      <Badge size="xs" color="red" variant="filled" title={t('accessChanges.tamperedHint')}>
        {t('accessChanges.tampered')}
      </Badge>
    );
  if (a.afterTheFact)
    return (
      <Badge size="xs" color="orange" variant="light">
        {t('accessChanges.afterTheFact')}
      </Badge>
    );
  return (
    <Badge size="xs" color={a.origin === 'run' ? 'blue' : 'gray'} variant="light">
      {t(`origins.${a.origin as 'manual'}`, { defaultValue: a.origin })}
    </Badge>
  );
}

function AccessChangeTable({ rows }: { rows: AccessChange[] }) {
  const { t } = useTranslation('compliance');
  const columns: DataColumn<AccessChange>[] = [
    {
      key: 'number',
      header: t('accessChanges.number'),
      sortValue: (a) => a.number,
      cell: (a) => (
        <Anchor component={Link} to={`/records/${a.recordId}`} className="mono" size="sm">
          {a.number}
        </Anchor>
      ),
    },
    { key: 'performedAt', header: t('accessChanges.performedAt'), sortValue: (a) => a.performedAt, cell: (a) => fmtDate(a.performedAt) },
    {
      key: 'subject',
      header: t('accessChanges.subject'),
      sortValue: (a) => a.subjectName || a.subjectId,
      cell: (a) => (
        <>
          <Text size="sm">{a.subjectName || a.subjectId}</Text>
          {a.subjectName && (
            <Text size="xs" c="dimmed" className="mono">
              {a.subjectId}
            </Text>
          )}
        </>
      ),
    },
    {
      key: 'platform',
      header: t('accessChanges.platform'),
      sortValue: (a) => a.platformName,
      cell: (a) =>
        a.platformName ?? (
          <Text c="dimmed" size="sm">
            {t('accessChanges.platformHidden')}
          </Text>
        ),
    },
    {
      key: 'change',
      header: t('accessChanges.change'),
      sortValue: (a) => a.kind,
      cell: (a) => (
        <Group gap={4}>
          <KindBadge kind={a.kind} />
          <OriginBadge a={a} />
        </Group>
      ),
    },
    { key: 'rights', header: t('accessChanges.rights'), cell: (a) => <RightsDiff granted={a.granted} revoked={a.revoked} /> },
    { key: 'status', header: t('accessChanges.status'), sortValue: (a) => a.status, cell: (a) => <RecordStatusBadge status={a.status} size="xs" /> },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(a) => a.recordId}
      ariaLabel={t('accessChanges.title')}
      footer={<ListFooter shown={rows.length} />}
      testId="access-change-list"
      card={(a) => (
        <Paper withBorder p="sm">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Box style={{ minWidth: 0 }}>
              <Anchor component={Link} to={`/records/${a.recordId}`} fw={600} size="sm">
                {a.subjectName || a.subjectId}
              </Anchor>
              <Text size="xs" c="dimmed">
                {a.number} · {fmtDate(a.performedAt)} · {a.platformName ?? a.platformId}
              </Text>
            </Box>
            <RecordStatusBadge status={a.status} size="xs" />
          </Group>
          <Group gap={4} mt={4}>
            <KindBadge kind={a.kind} />
            <OriginBadge a={a} />
          </Group>
          <Box mt={4}>
            <RightsDiff granted={a.granted} revoked={a.revoked} />
          </Box>
        </Paper>
      )}
    />
  );
}

/** Local date and time for a datetime-local input. */
export function localNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function AccessChangeModal({ platforms, onClose }: { platforms: Platform[]; onClose: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const { username } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({
    platformId: platforms.length === 1 ? platforms[0]!.id : '',
    subjectId: '',
    subjectName: '',
    subjectType: 'user',
    kind: 'grant',
    rightsBefore: [] as string[],
    rightsAfter: [] as string[],
    reason: '',
    requestedBy: '',
    requestRef: '',
    requestUrl: '',
    approvedBy: '',
    performedBy: username,
    performedAt: localNow(),
    document: true,
  });
  const [busy, setBusy] = useState(false);
  const up = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const valid = f.platformId && f.subjectId.trim() && f.reason.trim() && f.performedBy.trim() && f.performedAt;
  const submit = async () => {
    setBusy(true);
    try {
      const a = await post<AccessChange>('/compliance/access-changes', {
        platformId: f.platformId,
        subjectId: f.subjectId.trim(),
        subjectName: f.subjectName.trim() || undefined,
        subjectType: f.subjectType || undefined,
        kind: f.kind,
        rightsBefore: f.rightsBefore,
        rightsAfter: f.rightsAfter,
        reason: f.reason.trim(),
        requestedBy: f.requestedBy.trim() || undefined,
        requestRef: f.requestRef.trim() || undefined,
        requestUrl: f.requestUrl.trim() || undefined,
        approvedBy: f.approvedBy.trim() || undefined,
        performedBy: f.performedBy.trim(),
        performedAt: new Date(f.performedAt).toISOString(),
        document: f.document,
      });
      await qc.invalidateQueries({ queryKey: ['access-changes'] });
      onClose();
      navigate(`/records/${a.recordId}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('accessChanges.new')} size="lg">
      <Stack gap="sm">
        <Select
          label={t('accessChanges.platform')}
          required
          data={platforms.map((p) => ({ value: p.id, label: p.name }))}
          value={f.platformId || null}
          onChange={(v) => up('platformId', v ?? '')}
        />
        <Group grow wrap="wrap" align="flex-start">
          <TextInput
            label={t('accessChanges.subjectId')}
            description={t('accessChanges.subjectIdHelp')}
            required
            value={f.subjectId}
            onChange={(e) => up('subjectId', e.currentTarget.value)}
            maxLength={300}
          />
          <TextInput label={t('accessChanges.subjectName')} value={f.subjectName} onChange={(e) => up('subjectName', e.currentTarget.value)} maxLength={300} />
        </Group>
        <Group grow wrap="wrap">
          <Select
            label={t('accessChanges.subjectType')}
            allowDeselect={false}
            data={[
              { value: 'user', label: t('subjectTypes.user') },
              { value: 'technical', label: t('subjectTypes.technical') },
            ]}
            value={f.subjectType}
            onChange={(v) => up('subjectType', v ?? 'user')}
          />
          <Select
            label={t('accessChanges.change')}
            required
            allowDeselect={false}
            data={ACCESS_CHANGE_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
            value={f.kind}
            onChange={(v) => up('kind', v ?? 'grant')}
          />
        </Group>
        <TagsInput
          label={t('accessChanges.rightsBefore')}
          description={t('accessChanges.rightsHelp')}
          value={f.rightsBefore}
          onChange={(v) => up('rightsBefore', v)}
          maxTags={500}
        />
        <TagsInput label={t('accessChanges.rightsAfter')} value={f.rightsAfter} onChange={(v) => up('rightsAfter', v)} maxTags={500} />
        <Textarea
          label={t('accessChanges.reason')}
          required
          autosize
          minRows={2}
          value={f.reason}
          onChange={(e) => up('reason', e.currentTarget.value)}
          maxLength={4000}
        />
        <Group grow wrap="wrap">
          <TextInput label={t('accessChanges.requestedBy')} value={f.requestedBy} onChange={(e) => up('requestedBy', e.currentTarget.value)} maxLength={200} />
          <TextInput
            label={t('accessChanges.requestRef')}
            description={t('accessChanges.requestRefHelp')}
            value={f.requestRef}
            onChange={(e) => up('requestRef', e.currentTarget.value)}
            maxLength={500}
          />
        </Group>
        <TextInput
          label={t('accessChanges.requestUrl')}
          type="url"
          value={f.requestUrl}
          onChange={(e) => up('requestUrl', e.currentTarget.value)}
          maxLength={2000}
        />
        <Group grow wrap="wrap">
          <TextInput label={t('accessChanges.approvedBy')} value={f.approvedBy} onChange={(e) => up('approvedBy', e.currentTarget.value)} maxLength={200} />
          <TextInput
            label={t('accessChanges.performedBy')}
            required
            value={f.performedBy}
            onChange={(e) => up('performedBy', e.currentTarget.value)}
            maxLength={200}
          />
        </Group>
        <TextInput
          label={t('accessChanges.performedAt')}
          type="datetime-local"
          required
          value={f.performedAt}
          onChange={(e) => up('performedAt', e.currentTarget.value)}
        />
        <Checkbox
          label={t('accessChanges.documentNow')}
          description={t('accessChanges.documentNowHelp')}
          checked={f.document}
          onChange={(e) => up('document', e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>
            {f.document ? t('accessChanges.createDocumented') : t('accessChanges.createDraft')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
