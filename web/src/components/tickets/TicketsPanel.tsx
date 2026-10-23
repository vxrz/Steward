import { useState } from 'react';
import { Anchor, Button, Group, Paper, Stack, Switch, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlus, IconTicket } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TicketList } from '@sm/shared';
import { get } from '../../api';
import { EmptyState, QueryState } from '../common';
import { fmtRelative } from '../../format';
import { ExternalTicketLink, TicketStatusBadge, useSourceLabel } from './common';
import { TicketForm } from './TicketForm';

/**
 * "Open tickets" on a service, platform or record page: the ticket references that name the item as
 * affected (open ones first; resolved and closed on request).
 */
export function TicketsPanel({ kind, id, label }: { kind: 'service' | 'platform' | 'record' | 'credential'; id: string; label: string }) {
  const { t } = useTranslation('tickets');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['ticket-references', 'panel', kind, id, all],
    queryFn: () => get<TicketList>(`/ticket-references?link=${encodeURIComponent(`${kind}:${id}`)}&state=${all ? 'all' : 'open'}`),
  });
  const sourceLabel = useSourceLabel();
  const items = q.data?.items ?? [];
  return (
    <Stack gap="xs" data-testid="tickets-panel">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text fw={600}>{t('panel.title')}</Text>
        <Group gap="xs">
          <Switch size="xs" label={t('panel.showClosed')} checked={all} onChange={(e) => setAll(e.currentTarget.checked)} />
          {q.data?.canCreate && (
            <Button size="xs" variant="default" onClick={() => setCreating(true)} leftSection={<IconPlus size={14} />}>
              {t('panel.add')}
            </Button>
          )}
        </Group>
      </Group>
      <QueryState query={q} rows={2} />
      {q.isSuccess && items.length === 0 && <EmptyState compact icon={IconTicket} title={t('panel.none')} testId="tickets-panel-empty" />}
      {items.map((x) => (
        <Paper key={x.id} withBorder p="xs">
          <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="wrap">
                <Anchor component={Link} to={`/tickets/${x.id}`} size="sm" fw={600} className="mono">
                  {x.externalNumber}
                </Anchor>
                <ExternalTicketLink ticket={x} size="xs" />
                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {x.title}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {[sourceLabel(x.source), x.vendor, t('ageDays', { count: x.ageDays }), x.lastCheckedAt ? fmtRelative(x.lastCheckedAt) : null]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </div>
            <TicketStatusBadge status={x.status} size="xs" />
          </Group>
        </Paper>
      ))}
      <Anchor component={Link} to={`/tickets?link=${encodeURIComponent(`${kind}:${id}`)}`} size="xs">
        {t('panel.all')}
      </Anchor>
      {creating && (
        <TicketForm
          ticket={null}
          preset={[{ kind, id, label }]}
          onClose={() => setCreating(false)}
          onSaved={(x) => {
            setCreating(false);
            void qc.invalidateQueries({ queryKey: ['ticket-references'] });
            navigate(`/tickets/${x.id}`);
          }}
        />
      )}
    </Stack>
  );
}
