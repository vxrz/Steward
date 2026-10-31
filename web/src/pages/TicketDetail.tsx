import { useState } from 'react';
import { Anchor, Button, Grid, Group, Menu, Modal, Paper, Stack, Text, TextInput, Timeline } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconCheck, IconChevronDown, IconEdit, IconExternalLink, IconReportMedical, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { TICKET_LIMITS, isTicketOpen, type TicketDetail, type TicketEvent, type TicketStatus } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { DetailState, PageHeader, subjectLabel } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field } from '../components/records/common';
import { TICKET_STATUS_IDS, TicketStatusBadge, useSourceLabel, useTicketSettings } from '../components/tickets/common';
import { TicketForm } from '../components/tickets/TicketForm';
import { fmtDate, fmtDay, fmtRelative } from '../format';
import { confirmDanger } from '../components/confirm';
import { useCanStartReview, useStartReview } from '../components/records/IncidentReview';
import { OwningTeams } from '../components/OwningTeams';

export function TicketDetailPage() {
  const { t } = useTranslation(['tickets', 'records', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['ticket', id], queryFn: () => get<TicketDetail>(`/ticket-references/${id}`), retry: false });
  const sourceLabel = useSourceLabel();
  const settings = useTicketSettings();
  const [editing, setEditing] = useState(false);
  const [statusTo, setStatusTo] = useState<TicketStatus | 'checked' | null>(null);
  const canStartReview = useCanStartReview();
  const startReview = useStartReview();
  const { t: tr } = useTranslation('records');
  const x = q.data;
  if (!x) return <DetailState query={q} back="tickets" />;
  const canEdit = x.permissions.includes('edit');
  const refresh = (next?: TicketDetail) => {
    if (next) qc.setQueryData(['ticket', id], next);
    void qc.invalidateQueries({ queryKey: ['ticket-references'] });
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('deleteConfirm', { number: x.externalNumber }) }))) return;
    try {
      await del(`/ticket-references/${x.id}`);
      notifyOk(t('deleted'));
      refresh();
      navigate('/tickets');
    } catch (e) {
      notifyError(e);
    }
  };
  const reminder = x.effectiveReminderDays ? t('reminder.summary', { count: x.effectiveReminderDays }) : t('reminder.none');
  return (
    <>
      <PageHeader
        back="tickets"
        title={
          <Group gap="sm" wrap="wrap">
            <span className="mono">{x.externalNumber}</span>
            <span>{x.title}</span>
            <TicketStatusBadge status={x.status} size="md" />
          </Group>
        }
        description={[sourceLabel(x.source), x.vendor].filter(Boolean).join(' · ')}
        actions={
          <>
            {x.externalUrl && /^https?:\/\//i.test(x.externalUrl) && (
              <Button
                size="xs"
                variant="default"
                component="a"
                href={x.externalUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                leftSection={<IconExternalLink size={14} />}
              >
                {t('actions.openExternal')}
              </Button>
            )}
            {canEdit && (
              <>
                <Button size="xs" variant="light" leftSection={<IconCheck size={14} />} onClick={() => setStatusTo('checked')}>
                  {t('actions.markChecked')}
                </Button>
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button
                      size="xs"
                      variant="light"
                      rightSection={<IconChevronDown size={14} />}
                      aria-label={t('actions.statusMenu', { number: x.externalNumber })}
                    >
                      {t('actions.changeStatus')}
                    </Button>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {TICKET_STATUS_IDS.filter((s) => s !== x.status).map((s) => (
                      <Menu.Item key={s} onClick={() => setStatusTo(s)}>
                        {t(`status.${s}`)}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
                <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                  {t('common:edit')}
                </Button>
              </>
            )}
            {!isTicketOpen(x.status) && canStartReview && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconReportMedical size={14} />}
                onClick={() => void startReview({ source: 'ticket', ticketId: x.id })}
              >
                {tr('review.start')}
              </Button>
            )}
            {x.permissions.includes('delete') && (
              <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={remove}>
                {t('common:delete')}
              </Button>
            )}
          </>
        }
      />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {x.note.trim() ? (
              <MarkdownView text={x.note} />
            ) : (
              <Text c="dimmed" size="sm">
                {t('detail.noNote')}
              </Text>
            )}
            <div>
              <Text fw={600} mb={4}>
                {t('fields.affected')}
              </Text>
              {x.links.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('detail.noAffected')}
                </Text>
              ) : (
                <Stack gap={2}>
                  {x.links.map((l) => (
                    <Text key={l.id} size="sm">
                      {t(`records:links.kinds.${l.kind ?? 'external'}`)}:{' '}
                      {l.visible && l.path ? (
                        <Anchor component={Link} to={l.path} size="sm">
                          {l.label}
                        </Anchor>
                      ) : (
                        <Text span c="dimmed" size="sm">
                          {t('detail.notVisible')}
                        </Text>
                      )}
                    </Text>
                  ))}
                </Stack>
              )}
            </div>
            <div>
              <Text fw={600} mb="xs">
                {t('detail.history')}
              </Text>
              <Timeline bulletSize={14} lineWidth={2} active={x.events.length}>
                {x.events.map((e) => (
                  <Timeline.Item key={e.id} title={<EventTitle e={e} />}>
                    <Text size="xs" c="dimmed">
                      {e.actor} · {fmtDate(e.ts)}
                    </Text>
                    {e.comment && (
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {e.comment}
                      </Text>
                    )}
                    {e.kind === 'updated' && Array.isArray(e.details.fields) && (
                      <Text size="xs" c="dimmed">
                        {t('detail.fieldsChanged', { fields: (e.details.fields as string[]).join(', ') })}
                      </Text>
                    )}
                  </Timeline.Item>
                ))}
              </Timeline>
            </div>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('fields.status')}>
                <TicketStatusBadge status={x.status} />
              </Field>
              <Field label={t('fields.responsible')}>
                <Text size="sm">{x.responsible.map(subjectLabel).join(', ') || '–'}</Text>
              </Field>
              <Field label={t('fields.openedAt')}>
                <Text size="sm">
                  {fmtDay(x.openedAt)} · {t('ageDays', { count: x.ageDays })}
                </Text>
              </Field>
              {x.resolvedAt && (
                <Field label={t('fields.resolvedAt')}>
                  <Text size="sm">{fmtDay(x.resolvedAt)}</Text>
                </Field>
              )}
              <Field label={t('fields.lastCheckedAt')}>
                <Text size="sm" title={x.lastCheckedAt ? fmtDate(x.lastCheckedAt) : undefined}>
                  {x.lastCheckedAt ? fmtRelative(x.lastCheckedAt) : t('neverChecked')}
                </Text>
              </Field>
              <Field label={t('fields.reminder')}>
                <Text size="sm">{settings.data ? reminder : '…'}</Text>
              </Field>
              <Text size="xs" c="dimmed">
                {t('detail.createdBy', { user: x.createdBy, date: fmtDate(x.createdAt) })}
                <br />
                {t('detail.updatedBy', { user: x.updatedBy, when: fmtRelative(x.updatedAt) })}
              </Text>
            </Stack>
          </Paper>
          <OwningTeams kind="ticket" id={x.id} mt="md" />
        </Grid.Col>
      </Grid>
      {editing && (
        <TicketForm
          ticket={x}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            setEditing(false);
            notifyOk(t('saved'));
            refresh(n);
          }}
        />
      )}
      {statusTo && (
        <StatusModal
          ticket={x}
          to={statusTo}
          onClose={() => setStatusTo(null)}
          onDone={(n) => {
            setStatusTo(null);
            refresh(n);
          }}
        />
      )}
    </>
  );
}

function EventTitle({ e }: { e: TicketEvent }) {
  const { t } = useTranslation('tickets');
  if (e.kind === 'status' && e.fromStatus && e.toStatus)
    return <>{t('detail.events.status', { from: t(`status.${e.fromStatus}`), to: t(`status.${e.toStatus}`) })}</>;
  return <>{t(`detail.events.${e.kind}`)}</>;
}

/** Change the status or mark the ticket as checked, with an optional comment for the history. */
function StatusModal({
  ticket,
  to,
  onClose,
  onDone,
}: {
  ticket: TicketDetail;
  to: TicketStatus | 'checked';
  onClose: () => void;
  onDone: (t: TicketDetail) => void;
}) {
  const { t } = useTranslation(['tickets', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const n =
        to === 'checked'
          ? await post<TicketDetail>(`/ticket-references/${ticket.id}/checked`, { comment: comment.trim() })
          : await post<TicketDetail>(`/ticket-references/${ticket.id}/status`, { status: to, comment: comment.trim() });
      notifyOk(to === 'checked' ? t('actions.checkedDone') : t('actions.statusChanged'));
      onDone(n);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={to === 'checked' ? t('actions.markChecked') : `${t('actions.changeStatus')}: ${t(`status.${to}`)}`}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('fields.comment')}
            description={t('hints.statusComment')}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            maxLength={TICKET_LIMITS.comment}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
