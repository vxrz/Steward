import { Anchor, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconKey } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Credential } from '@sm/shared';
import { getOptional } from '../../api';
import { fmtDay, fmtRelative } from '../../format';
import { CredentialStatusBadge } from '../../pages/Credentials';

/** GET /api/credentials/summary (null for users who may not see the register). */
export interface CredentialDueSummary {
  expired: number;
  overdue: number;
  dueSoon: number;
  items: Credential[];
}

/** Home page: credentials that expired, are overdue for rotation/review or due soon (only when there are any). */
export function CredentialsDueCard() {
  const { t } = useTranslation('credentials');
  const s = useQuery({
    queryKey: ['credentials', 'summary'],
    queryFn: () => getOptional<CredentialDueSummary | null>('/credentials/summary', null),
    refetchInterval: 60000,
  });
  const d = s.data;
  if (!d || !d.items.length) return null;
  return (
    <Card withBorder data-testid="credentials-due">
      <Group mb="xs" gap="xs" wrap="nowrap" justify="space-between">
        <Group gap="xs" wrap="nowrap">
          <IconKey size={18} color="var(--mantine-color-orange-6)" />
          <Title order={5}>{t('home.title')}</Title>
        </Group>
        <Text size="xs" c="dimmed">
          {t('home.counts', { expired: d.expired, overdue: d.overdue, dueSoon: d.dueSoon })}
        </Text>
      </Group>
      <Stack gap={6}>
        {d.items.map((c) => (
          <Group key={c.id} justify="space-between" gap={4} wrap="wrap">
            <Group gap={6} style={{ minWidth: 0 }}>
              <CredentialStatusBadge status={c.status} size="xs" />
              <Anchor component={Link} to={`/credentials?open=${encodeURIComponent(c.id)}`} size="sm">
                {c.name}
              </Anchor>
            </Group>
            <Text size="xs" c="dimmed" className="nowrap">
              {c.nextDueAt ? `${fmtDay(c.nextDueAt)} · ${fmtRelative(c.nextDueAt)}` : ''}
            </Text>
          </Group>
        ))}
        <Anchor component={Link} to="/credentials" size="xs">
          {t('home.all')}
        </Anchor>
      </Stack>
    </Card>
  );
}
