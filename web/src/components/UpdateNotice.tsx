import { Alert, Anchor, Code, Group, List, Stack, Text } from '@mantine/core';
import { IconExternalLink, IconRocket } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
// Direct imports: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../shared/src/brand';
import type { UpdateNotice as Notice } from '../../../shared/src/system';
import { get, notifyError, post } from '../api';
import { fmtDate } from '../format';

/** The release notes of a version: the CHANGELOG at its tag on GitHub (the top section is that release). */
export function releaseNotesUrl(version: string): string {
  return `${BRAND.repoUrl}/blob/v${encodeURIComponent(version)}/CHANGELOG.md`;
}

/** Migrations listed by name up to this many; more are summed up (an update across several releases). */
const LISTED = 8;

/**
 * "Steward was updated from X to Y" for administrators (only they get the notice from the server,
 * it names the path of the backup copy). Shown until the administrator dismisses it – stored on the
 * server, so it stays hidden in other browsers – or a newer update replaces it.
 */
export function UpdateNotice() {
  const { t } = useTranslation('system');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['update-notice'],
    queryFn: () => get<{ notice: Notice | null }>('/system/update-notice'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => post('/system/update-notice/dismiss', { id }),
    onSuccess: () => qc.setQueryData(['update-notice'], { notice: null }),
    onError: (e) => {
      notifyError(e);
      void qc.invalidateQueries({ queryKey: ['update-notice'] });
    },
  });
  const n = q.data?.notice;
  if (!n || dismiss.isPending) return null;
  const title = n.fromVersion
    ? t('updateNotice.titleFrom', { brand: BRAND.name, from: n.fromVersion, to: n.toVersion })
    : t('updateNotice.title', { brand: BRAND.name, to: n.toVersion });
  const listed = n.migrations.slice(0, LISTED);
  return (
    <Alert
      color="blue"
      variant="light"
      icon={<IconRocket size={18} aria-hidden />}
      title={title}
      mb="md"
      withCloseButton
      closeButtonLabel={t('updateNotice.dismiss')}
      onClose={() => dismiss.mutate(n.id)}
      data-testid="update-notice"
    >
      <Stack gap={6}>
        <Text size="sm">
          {n.migrations.length
            ? t('updateNotice.migrations', { count: n.migrations.length, when: fmtDate(n.at) })
            : t('updateNotice.noMigrations', { when: fmtDate(n.at) })}
        </Text>
        {listed.length > 0 && (
          <List size="sm" spacing={2}>
            {listed.map((m) => (
              <List.Item key={m}>
                <Code>{m}</Code>
              </List.Item>
            ))}
            {n.migrations.length > LISTED && <List.Item>{t('updateNotice.moreMigrations', { count: n.migrations.length - LISTED })}</List.Item>}
          </List>
        )}
        {n.backups.length > 0 ? (
          <Text size="sm" style={{ wordBreak: 'break-all' }}>
            {t('updateNotice.backup', { count: n.backups.length })}{' '}
            {n.backups.map((b, i) => (
              <span key={b}>
                {i > 0 && ', '}
                <Code>{b}</Code>
              </span>
            ))}
          </Text>
        ) : (
          n.noBackupReason && <Text size="sm">{t(`updateNotice.noBackup.${n.noBackupReason}`)}</Text>
        )}
        <Anchor href={releaseNotesUrl(n.toVersion)} target="_blank" rel="noopener" size="sm" w="fit-content">
          <Group gap={4} wrap="nowrap" component="span">
            <span>{t('updateNotice.releaseNotes', { version: n.toVersion })}</span>
            <IconExternalLink size={12} aria-hidden />
          </Group>
        </Anchor>
      </Stack>
    </Alert>
  );
}
