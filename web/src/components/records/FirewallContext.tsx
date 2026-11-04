import { Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RecordDetail } from '@sm/shared';
import { get } from '../../api';
import { EditionBadge } from './DocumentPanel';
import { RecordStatusBadge } from './common';

type Comparison = 'new' | 'changed' | 'same' | 'removes' | 'notFound';
interface FirewallContext {
  items: {
    system: { id: string; name: string };
    document: { id: string; number: string; edition: string | null; status: string } | null;
    comparison: Comparison[];
  }[];
}

export const COMPARISON_COLORS: Record<Comparison, string> = { new: 'green', changed: 'orange', same: 'gray', removes: 'red', notFound: 'yellow' };

/**
 * A firewall change (#208) against the approved rules of what it affects: per segment or system its "Approved firewall
 * rules" document (the edition valid now) and what each rule line does to them. Closing the change drafts the next
 * edition of each document, which an approver confirms.
 */
export function FirewallContextPanel({ rec }: { rec: RecordDetail }) {
  const { t } = useTranslation('records');
  const q = useQuery({
    queryKey: ['record-firewall', rec.id, rec.version, rec.status],
    queryFn: () => get<FirewallContext>(`/records/${rec.id}/firewall`),
  });
  const items = q.data?.items ?? [];
  return (
    <Paper withBorder p="sm" mt="md" data-testid="firewall-context">
      <Stack gap="xs">
        <Text fw={600} size="sm">
          {t('firewall.title')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('firewall.help')}
        </Text>
        {q.isSuccess && items.length === 0 && (
          <Text size="sm" c="orange">
            {t('firewall.noSystems')}
          </Text>
        )}
        {items.map((x) => (
          <Stack key={x.system.id} gap={4}>
            <Group gap="xs" wrap="wrap">
              <Anchor component={Link} to={`/systems/${x.system.id}`} size="sm" fw={500}>
                {x.system.name}
              </Anchor>
              <Text size="sm" c="dimmed">
                ·
              </Text>
              {x.document ? (
                <>
                  <Anchor component={Link} to={`/records/${x.document.id}`} size="sm" className="mono">
                    {x.document.number}
                  </Anchor>
                  {x.document.edition ? <EditionBadge edition={x.document.edition} /> : <RecordStatusBadge status={x.document.status} />}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {t('firewall.noDocument')}
                </Text>
              )}
            </Group>
            {x.comparison.length > 0 && (
              <Group gap={4} wrap="wrap" aria-label={t('firewall.against', { name: x.system.name })}>
                {x.comparison.map((c, i) => (
                  <Badge key={i} size="sm" variant="light" color={COMPARISON_COLORS[c]}>
                    {t('firewall.row', { n: i + 1 })}: {t(`firewall.comparison.${c}`)}
                  </Badge>
                ))}
              </Group>
            )}
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}
