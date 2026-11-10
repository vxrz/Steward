import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconFolders, IconLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  BACKUP_OPTIONAL_PARTS,
  BACKUP_PARTS,
  isBackupOptionalPart,
  type BackupContents,
  type BackupOptionalPart,
  type BackupPart,
  type BackupStatus,
} from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { TONE } from '../common';
import { fmtBytes } from '../../format';

/**
 * Settings → Backups → Contents (0.16.0, docs/BACKUPS.md#contents): which parts of the data folder a backup holds.
 * The required parts are shown locked; the optional ones (run artifacts, archived reports, evidence packs) are evidence,
 * included by default – leaving one out shows what a restore then lacks.
 */
export function BackupContentsCard({ status }: { status: BackupStatus }) {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const [exclude, setExclude] = useState<BackupOptionalPart[]>(status.settings.exclude);
  const [busy, setBusy] = useState(false);
  // the sizes walk the data folder: read on demand
  const [sizes, setSizes] = useState(false);
  const contents = useQuery({ queryKey: ['backups', 'contents'], queryFn: () => get<BackupContents>('/backups/contents'), enabled: sizes });
  const saved = status.settings.exclude;
  useEffect(() => setExclude(saved), [saved]);
  const changed = exclude.length !== saved.length || exclude.some((p) => !saved.includes(p));
  const label = (p: BackupPart) => t(`backups.contents.parts.${p}.label`);
  const byId = new Map((contents.data?.parts ?? []).map((p) => [p.id, p]));

  const save = async () => {
    setBusy(true);
    try {
      await put<BackupStatus>('/backups/settings', { ...status.settings, exclude });
      notifyOk(t('backups.contents.saved'));
      await qc.invalidateQueries({ queryKey: ['backups'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const sizeOf = (p: BackupPart) => {
    const c = byId.get(p);
    if (!c) return null;
    return (
      <Text size="xs" c="dimmed">
        {t('backups.contents.size', { size: fmtBytes(c.bytes), count: c.files })}
      </Text>
    );
  };

  return (
    <Card withBorder data-testid="backup-contents">
      <Group justify="space-between" mb="xs" wrap="wrap">
        <Group gap="xs" wrap="nowrap">
          <IconFolders size={18} aria-hidden />
          <Title order={5}>{t('backups.contents.title')}</Title>
        </Group>
        <Button size="xs" variant="light" loading={contents.isFetching} onClick={() => (sizes ? void contents.refetch() : setSizes(true))}>
          {t('backups.contents.load')}
        </Button>
      </Group>
      <Text size="sm" mb="sm">
        {t('backups.contents.intro')}
      </Text>
      <Stack gap="xs">
        {BACKUP_PARTS.filter((p) => !isBackupOptionalPart(p)).map((p) => (
          <Paper key={p} withBorder p="xs">
            <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                  {label(p)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t(`backups.contents.parts.${p}.lacks`)}
                </Text>
                {sizeOf(p)}
              </div>
              <Badge variant="light" color={TONE.neutral} leftSection={<IconLock size={12} aria-hidden />} style={{ flexShrink: 0 }}>
                {t('backups.contents.always')}
              </Badge>
            </Group>
          </Paper>
        ))}
        {BACKUP_OPTIONAL_PARTS.map((p) => {
          const included = !exclude.includes(p);
          return (
            <Paper key={p} withBorder p="xs" style={included ? undefined : { borderColor: 'var(--mantine-color-orange-6)' }}>
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                <Checkbox
                  checked={included}
                  aria-label={t('backups.contents.include', { part: label(p) })}
                  label={label(p)}
                  description={t(`backups.contents.parts.${p}.lacks`)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setExclude((x) => (on ? x.filter((y) => y !== p) : BACKUP_OPTIONAL_PARTS.filter((y) => y === p || x.includes(y))));
                  }}
                  data-testid={`backup-part-${p}`}
                />
                <Badge variant="light" color={TONE.attention} style={{ flexShrink: 0 }}>
                  {t('backups.contents.evidence')}
                </Badge>
              </Group>
              <div style={{ paddingLeft: 32 }}>{sizeOf(p)}</div>
            </Paper>
          );
        })}
      </Stack>
      {exclude.length > 0 && (
        <Alert
          mt="sm"
          color={TONE.attention}
          icon={<IconAlertTriangle size={18} />}
          title={t('backups.contents.warningTitle')}
          data-testid="backup-contents-warning"
        >
          {t('backups.contents.warning', { parts: exclude.map((p) => label(p)).join(', ') })}
        </Alert>
      )}
      <Group mt="sm">
        <Button size="xs" disabled={!changed} loading={busy} onClick={() => void save()}>
          {t('backups.contents.save')}
        </Button>
      </Group>
    </Card>
  );
}
