import { useEffect, useState } from 'react';
import { Button, Card, Code, Group, NumberInput, Stack, TagsInput, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAnchor, IconDownload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AuditAnchoring } from '@sm/shared';
import { apiUrl, get, notifyError, notifyOk, post, put } from '../../api';
import { fmtDate } from '../../format';

/** How the audit log is anchored outside the database: signing key, latest checkpoint, e-mail to auditors. */
export function AuditAnchoringPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation('audit');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audit-anchoring'], queryFn: () => get<AuditAnchoring>('/audit/anchoring') });
  const [emails, setEmails] = useState<string[]>([]);
  const [hours, setHours] = useState<number>(24);
  useEffect(() => {
    if (q.data) {
      setEmails(q.data.emailRecipients);
      setHours(q.data.emailIntervalHours);
    }
  }, [q.data]);
  const a = q.data;
  if (!a) return null;

  const checkpoint = async () => {
    try {
      const cp = await post<{ seq: number }>('/audit/checkpoint');
      notifyOk(t('anchoring.checkpointWritten', { seq: cp.seq }));
      void qc.invalidateQueries({ queryKey: ['audit-anchoring'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    } catch (e) {
      notifyError(e);
    }
  };
  const save = async () => {
    try {
      await put('/audit/anchoring', { emailRecipients: emails, emailIntervalHours: hours });
      notifyOk(t('anchoring.saved'));
      void qc.invalidateQueries({ queryKey: ['audit-anchoring'] });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <Card withBorder mb="md">
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconAnchor size={18} />
        <Title order={5}>{t('anchoring.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('anchoring.hint', { minutes: a.intervalMinutes })}
      </Text>
      <Stack gap={6}>
        <Text size="sm">
          {t('anchoring.fingerprint')} <Code>{a.fingerprint ?? '–'}</Code>
        </Text>
        <Text size="sm">{a.latest ? t('anchoring.latest', { seq: a.latest.seq, date: fmtDate(a.latest.ts) }) : t('anchoring.none')}</Text>
        {a.configuredAnchors.length > 0 && (
          <Text size="sm" c="dimmed">
            {t('anchoring.configured', { list: a.configuredAnchors.join(', ') })}
          </Text>
        )}
        <Group gap="xs" mt={4}>
          {a.publicKeyPem && (
            <Button size="xs" variant="default" component="a" href={apiUrl('/audit/public-key.pem')} leftSection={<IconDownload size={14} />}>
              {t('anchoring.downloadKey')}
            </Button>
          )}
          {a.latest && (
            <Button size="xs" variant="default" component="a" href={apiUrl('/audit/anchor.json')} leftSection={<IconDownload size={14} />}>
              {t('anchoring.downloadCheckpoint')}
            </Button>
          )}
          <Button size="xs" variant="light" onClick={checkpoint}>
            {t('anchoring.checkpointNow')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('anchoring.offline')} <Code>npm run audit:verify-export -- --file audit-log.json --public-key steward-audit-public-key.pem</Code>
        </Text>
        {canManage && (
          <Group align="end" mt="xs" gap="xs">
            <TagsInput
              label={t('anchoring.emails')}
              description={t('anchoring.emailsHint')}
              value={emails}
              onChange={setEmails}
              w={360}
              maxTags={20}
              splitChars={[',', ' ', ';']}
            />
            <NumberInput label={t('anchoring.interval')} value={hours} onChange={(v) => setHours(Number(v) || 24)} min={1} max={168} w={140} />
            <Button size="sm" onClick={save}>
              {t('anchoring.save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}
