import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, Code, Group, NumberInput, Progress, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArchive, IconDownload, IconShieldCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AuditArchiveStatus, AuditVerificationRecord } from '@sm/shared';
import { apiUrl, confirmedDownload, get, notifyError, notifyOk, post, put } from '../../api';
import { fmtBytes, fmtDate } from '../../format';

type RunResult = AuditArchiveStatus & { run: { archived: number; uploaded: number; deleted: number; problems: string[] } };

/**
 * Epochs, archives and retention of the audit log (auditors and administrators): what is archived and deleted, the last
 * incremental and full verification, a full verification in the background; administrators change the settings.
 */
export function AuditArchivePanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation('audit');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['audit-archive'],
    queryFn: () => get<AuditArchiveStatus>('/audit/archive'),
    refetchInterval: (query) => (query.state.data?.verification.running ? 2000 : false),
  });
  const [archive, setArchive] = useState(false);
  const [upload, setUpload] = useState(false);
  const [days, setDays] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) {
      setArchive(q.data.settings.archive);
      setUpload(q.data.settings.upload);
      setDays(q.data.settings.retentionDays);
    }
  }, [q.data]);
  const s = q.data;
  if (!s) return null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['audit-archive'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
  };
  const save = async () => {
    try {
      await put('/audit/archive', { archive, upload: archive && upload, retentionDays: archive ? days : 0 });
      notifyOk(t('archive.saved'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const r = await post<RunResult>('/audit/archive/run');
      if (r.run.problems.length) notifyError(new Error(r.run.problems.join(' · ')));
      else notifyOk(t('archive.ran', { archived: r.run.archived, deleted: r.run.deleted }));
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const verifyFull = async () => {
    try {
      await post('/audit/verify/full');
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const running = s.verification.running;
  const verification = (label: string, v: AuditVerificationRecord | null) => (
    <Text size="sm">
      {label}{' '}
      {v ? (
        <>
          <Badge size="sm" color={v.ok ? 'green' : 'red'} variant="light">
            {v.ok ? t('archive.ok') : t('archive.failed')}
          </Badge>{' '}
          {t('archive.verifiedAt', { date: fmtDate(v.at), by: v.by, from: v.fromSeq ?? '–', to: v.toSeq ?? '–' })}
          {!v.ok && (
            <Text span size="sm" c="red">
              {' '}
              {v.message}
            </Text>
          )}
        </>
      ) : (
        t('archive.never')
      )}
    </Text>
  );

  return (
    <Card withBorder mb="md">
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconArchive size={18} />
        <Title order={5}>{t('archive.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('archive.hint')}
      </Text>
      <Stack gap={6}>
        <Text size="sm">
          {t('archive.epochs', { closed: s.epochs.closed, archived: s.epochs.archived })}
          {s.latestCheckpoint && ` · ${t('archive.latest', { seq: s.latestCheckpoint.seq, date: fmtDate(s.latestCheckpoint.ts) })}`}
        </Text>
        <Text size="sm">
          {s.archivedThrough ? t('archive.archivedThrough', { seq: s.archivedThrough.seq, date: fmtDate(s.archivedThrough.ts) }) : t('archive.nothingArchived')}
          {' · '}
          {s.deletedThrough ? t('archive.deletedThrough', { seq: s.deletedThrough.seq, date: fmtDate(s.deletedThrough.ts) }) : t('archive.nothingDeleted')}
          {' · '}
          {t('archive.inDatabase', { count: s.entriesInDatabase })}
        </Text>
        {verification(t('archive.lastIncremental'), s.verification.incremental)}
        {verification(t('archive.lastFull'), s.verification.full)}
        {running ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">{t('archive.running', { checked: running.checked, total: running.total || '…' })}</Text>
            <Progress
              value={running.total ? (running.checked / running.total) * 100 : 0}
              size="sm"
              style={{ flex: 1 }}
              aria-label={t('archive.progress')}
              animated
            />
          </Group>
        ) : (
          s.verification.fullIntervalDays > 0 && (
            <Text size="xs" c="dimmed">
              {t('archive.fullInterval', { days: s.verification.fullIntervalDays })}
            </Text>
          )
        )}
        {canManage && (
          <Group gap="xs" mt={4}>
            <Button size="xs" variant="light" leftSection={<IconShieldCheck size={14} />} onClick={verifyFull} disabled={!!running}>
              {t('archive.verifyFull')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconArchive size={14} />} onClick={runNow} loading={busy} disabled={!s.settings.archive}>
              {t('archive.runNow')}
            </Button>
          </Group>
        )}
        {canManage && (
          <Stack gap="xs" mt="xs">
            <Switch
              label={t('archive.archiveSwitch')}
              description={t('archive.archiveSwitchHint')}
              checked={archive}
              onChange={(e) => setArchive(e.currentTarget.checked)}
            />
            <Switch
              label={t('archive.uploadSwitch')}
              description={s.canUpload ? t('archive.uploadSwitchHint') : t('archive.uploadUnavailable')}
              checked={archive && upload}
              disabled={!archive || (!s.canUpload && !upload)}
              onChange={(e) => setUpload(e.currentTarget.checked)}
            />
            <Group align="end" gap="xs">
              <NumberInput
                label={t('archive.retention')}
                description={t('archive.retentionHint')}
                value={days}
                onChange={(v) => setDays(Number(v) || 0)}
                min={0}
                max={36500}
                w={360}
                disabled={!archive}
              />
              <Button size="sm" onClick={save}>
                {t('archive.save')}
              </Button>
            </Group>
            {archive && days > 0 && (
              <Alert color="yellow" p="xs">
                <Text size="sm">{t('archive.retentionWarning', { days })}</Text>
              </Alert>
            )}
          </Stack>
        )}
        {s.archives.length > 0 && (
          <div className="table-scroll">
            <Table fz="sm" mt="xs" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('archive.table.entries')}</Table.Th>
                  <Table.Th>{t('archive.table.period')}</Table.Th>
                  <Table.Th>{t('archive.table.epochs')}</Table.Th>
                  <Table.Th>{t('archive.table.file')}</Table.Th>
                  <Table.Th>{t('archive.table.state')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {s.archives.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td className="nowrap">
                      #{a.firstSeq}–#{a.lastSeq}
                    </Table.Td>
                    <Table.Td className="nowrap">
                      {fmtDate(a.firstTs)} – {fmtDate(a.lastTs)}
                    </Table.Td>
                    <Table.Td>{a.epochs}</Table.Td>
                    <Table.Td>
                      {a.fileMissing ? (
                        <Text size="sm" c="dimmed">
                          {t('archive.fileMissing', { file: a.file })}
                        </Text>
                      ) : (
                        <Anchor size="sm" href={apiUrl(`/audit/archives/${a.id}/file`)} onClick={confirmedDownload('exportAuditLog')}>
                          <IconDownload size={12} /> {a.file}
                        </Anchor>
                      )}{' '}
                      <Text span size="xs" c="dimmed">
                        {fmtBytes(a.size)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {a.uploadedAt && (
                          <Badge size="sm" variant="light">
                            {t('archive.uploaded')}
                          </Badge>
                        )}
                        {a.prunedAt ? (
                          <Badge size="sm" variant="light" color="gray">
                            {t('archive.deleted', { count: a.prunedEntries ?? 0 })}
                          </Badge>
                        ) : a.pruning ? (
                          <Badge size="sm" variant="light" color="yellow">
                            {t('archive.deleting')}
                          </Badge>
                        ) : (
                          <Badge size="sm" variant="light" color="green">
                            {t('archive.inDb')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
        <Text size="xs" c="dimmed">
          {t('archive.offline')} <Code>npm run audit:verify-archive -- archive.zip --public-key steward-audit-public-key.pem</Code>
        </Text>
      </Stack>
    </Card>
  );
}
