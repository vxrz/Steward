import { Anchor, Badge } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_TICKET_SOURCES, type TicketReference, type TicketSettings, type TicketStatus } from '@sm/shared';
import { get } from '../../api';
import { TONE } from '../common';

export const TICKET_STATUS_IDS: TicketStatus[] = ['open', 'waitingVendor', 'waitingUs', 'resolved', 'closed'];
export const TICKET_STATUS_COLOR: Record<TicketStatus, string> = {
  open: TONE.active,
  waitingVendor: TONE.soon,
  waitingUs: TONE.attention,
  resolved: TONE.ok,
  closed: TONE.neutral,
};

export function TicketStatusBadge({ status, size = 'sm' }: { status: TicketStatus; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('tickets');
  return (
    <Badge color={TICKET_STATUS_COLOR[status]} variant={status === 'closed' ? 'outline' : 'light'} size={size}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export const useTicketSettings = () =>
  useQuery({ queryKey: ['ticket-settings'], queryFn: () => get<TicketSettings>('/ticket-references/settings'), staleTime: 60_000 });

/** Name of a source: the built-in ones in the UI language until an administrator renames them. */
export function useSourceLabel() {
  const { t } = useTranslation('tickets');
  const settings = useTicketSettings();
  return (key: string): string => {
    const s = settings.data?.sources.find((x) => x.key === key);
    const builtin = DEFAULT_TICKET_SOURCES.find((x) => x.key === key);
    if (builtin && (!s || s.label === builtin.label)) return t(`sources.${key as 'vendor'}`, { defaultValue: builtin.label });
    return s?.label ?? key;
  };
}

/** Link to the ticket in the other system (http(s) only, checked on the server as well). */
export function ExternalTicketLink({ ticket, size = 'sm' }: { ticket: Pick<TicketReference, 'externalUrl' | 'externalNumber'>; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('tickets');
  if (!ticket.externalUrl || !/^https?:\/\//i.test(ticket.externalUrl)) return null;
  return (
    <Anchor
      href={ticket.externalUrl}
      target="_blank"
      rel="noopener noreferrer nofollow"
      size={size}
      aria-label={`${t('actions.openExternal')}: ${ticket.externalNumber}`}
    >
      <IconExternalLink size={14} aria-hidden style={{ verticalAlign: 'middle' }} />
    </Anchor>
  );
}
