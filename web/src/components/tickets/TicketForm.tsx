import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Autocomplete,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  TICKET_LIMITS,
  TICKET_LINK_KINDS,
  isTicketOpen,
  type ItemLink,
  type LinkTarget,
  type Subject,
  type TicketDetail,
  type TicketLinkKind,
  type TicketStatus,
} from '@sm/shared';
import { get, getOptional, notifyError, post, put } from '../../api';
import { useMe } from '../../auth';
import { TICKET_STATUS_IDS, useSourceLabel, useTicketSettings } from './common';

type Affected = { kind: TicketLinkKind; id: string; label: string };

interface Draft {
  source: string;
  externalNumber: string;
  externalUrl: string;
  title: string;
  note: string;
  vendor: string;
  responsible: string[];
  status: TicketStatus;
  openedAt: string;
  resolvedAt: string;
  reminder: 'default' | 'off' | 'days';
  reminderDays: number;
  links: Affected[];
  comment: string;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

function draftOf(t: TicketDetail | null, preset: Affected[], me: string): Draft {
  if (!t)
    return {
      source: 'vendor',
      externalNumber: '',
      externalUrl: '',
      title: '',
      note: '',
      vendor: '',
      responsible: me ? [`user:${me.toLowerCase()}`] : [],
      status: 'open',
      openedAt: day(new Date().toISOString()),
      resolvedAt: '',
      reminder: 'default',
      reminderDays: 7,
      links: preset,
      comment: '',
    };
  return {
    source: t.source,
    externalNumber: t.externalNumber,
    externalUrl: t.externalUrl ?? '',
    title: t.title,
    note: t.note,
    vendor: t.vendor,
    responsible: t.responsible,
    status: t.status,
    openedAt: day(t.openedAt),
    resolvedAt: day(t.resolvedAt),
    reminder: t.reminderDays === null ? 'default' : t.reminderDays === 0 ? 'off' : 'days',
    reminderDays: t.reminderDays || 7,
    links: t.links
      .filter((l): l is ItemLink & { kind: TicketLinkKind; targetId: string } => l.visible && !!l.kind && !!l.targetId)
      .map((l) => ({ kind: l.kind, id: l.targetId, label: l.label })),
    comment: '',
  };
}

/** Create or edit a ticket reference. `preset`: affected items to start with (from "Add ticket reference" on a service page). */
export function TicketForm({
  ticket,
  preset = [],
  onClose,
  onSaved,
}: {
  ticket: TicketDetail | null;
  preset?: Affected[];
  onClose: () => void;
  onSaved: (t: TicketDetail) => void;
}) {
  const { t } = useTranslation(['tickets', 'records', 'common']);
  const { username, hasRole } = useMe();
  const [d, setD] = useState<Draft>(() => draftOf(ticket, preset, username));
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const settings = useTicketSettings();
  const sourceLabel = useSourceLabel();
  const vendors = useQuery({ queryKey: ['ticket-vendors'], queryFn: () => get<string[]>('/ticket-references/vendors') });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []), retry: false });
  const hiddenLinks = ticket?.links.filter((l) => !l.visible).length ?? 0;
  const editorRole = hasRole('admin') || hasRole('designer') || hasRole('operator');
  const statusChanged = !!ticket && d.status !== ticket.status;
  const closedStatus = !isTicketOpen(d.status);
  const defaultLabel = settings.data?.reminderDays ? t('reminder.defaultDays', { count: settings.data.reminderDays }) : t('reminder.defaultOff');

  const subjectOptions = useMemo(() => {
    const list = (subjects.data ?? []).filter((s) => s.kind !== 'role').map((s) => ({ value: s.value, label: s.label }));
    for (const v of d.responsible) if (!list.some((o) => o.value === v)) list.push({ value: v, label: v });
    return list;
  }, [subjects.data, d.responsible]);

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        source: d.source,
        externalNumber: d.externalNumber.trim(),
        externalUrl: d.externalUrl.trim() || null,
        title: d.title.trim(),
        note: d.note,
        vendor: d.vendor.trim(),
        responsible: d.responsible.map((s) => (/^(user|team):/i.test(s) ? s : `user:${s}`)),
        status: d.status,
        openedAt: d.openedAt || undefined,
        resolvedAt: closedStatus && d.resolvedAt ? d.resolvedAt : null,
        reminderDays: d.reminder === 'default' ? null : d.reminder === 'off' ? 0 : d.reminderDays,
        links: d.links.map((l) => ({ kind: l.kind, id: l.id })),
        comment: d.comment.trim(),
        ...(ticket ? { version: ticket.version } : {}),
      };
      const saved = ticket ? await put<TicketDetail>(`/ticket-references/${ticket.id}`, body) : await post<TicketDetail>('/ticket-references', body);
      onSaved(saved);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const valid = d.externalNumber.trim() && d.title.trim() && (!d.externalUrl.trim() || /^https?:\/\/\S+$/i.test(d.externalUrl.trim()));
  return (
    <Modal opened onClose={onClose} title={ticket ? t('editTitle', { number: ticket.externalNumber }) : t('new')} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('fields.source')}
              data={(settings.data?.sources ?? []).map((s) => ({ value: s.key, label: sourceLabel(s.key) }))}
              value={d.source}
              onChange={(v) => v && set({ source: v })}
              allowDeselect={false}
              required
            />
            <TextInput
              label={t('fields.externalNumber')}
              description={t('hints.externalNumber')}
              value={d.externalNumber}
              onChange={(e) => set({ externalNumber: e.currentTarget.value })}
              maxLength={TICKET_LIMITS.number}
              required
              data-autofocus
              classNames={{ input: 'mono' }}
            />
          </SimpleGrid>
          <TextInput
            label={t('fields.title')}
            value={d.title}
            onChange={(e) => set({ title: e.currentTarget.value })}
            maxLength={TICKET_LIMITS.title}
            required
          />
          <TextInput
            label={t('fields.externalUrl')}
            description={t('hints.externalUrl')}
            placeholder="https://"
            value={d.externalUrl}
            onChange={(e) => set({ externalUrl: e.currentTarget.value })}
            maxLength={2000}
            error={d.externalUrl.trim() && !/^https?:\/\/\S+$/i.test(d.externalUrl.trim()) ? t('hints.externalUrl') : undefined}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Autocomplete
              label={t('fields.vendor')}
              description={t('hints.vendor')}
              data={vendors.data ?? []}
              value={d.vendor}
              onChange={(v) => set({ vendor: v })}
              maxLength={TICKET_LIMITS.vendor}
            />
            <Select
              label={t('fields.status')}
              data={TICKET_STATUS_IDS.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              value={d.status}
              onChange={(v) => v && set({ status: v as TicketStatus })}
              allowDeselect={false}
            />
          </SimpleGrid>
          {statusChanged && (
            <TextInput
              label={t('fields.comment')}
              description={t('hints.statusComment')}
              value={d.comment}
              onChange={(e) => set({ comment: e.currentTarget.value })}
              maxLength={TICKET_LIMITS.comment}
            />
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              type="date"
              label={t('fields.openedAt')}
              description={t('hints.openedAt')}
              value={d.openedAt}
              onChange={(e) => set({ openedAt: e.currentTarget.value })}
            />
            {closedStatus && (
              <TextInput type="date" label={t('fields.resolvedAt')} value={d.resolvedAt} onChange={(e) => set({ resolvedAt: e.currentTarget.value })} />
            )}
          </SimpleGrid>
          {subjects.data && subjects.data.length > 0 ? (
            <MultiSelect
              label={t('fields.responsible')}
              description={editorRole ? t('hints.responsible') : t('hints.responsibleSelf')}
              searchable
              data={subjectOptions}
              value={d.responsible}
              onChange={(v) => set({ responsible: v })}
              maxValues={TICKET_LIMITS.responsible}
            />
          ) : (
            <TagsInput
              label={t('fields.responsible')}
              description={editorRole ? t('hints.responsible') : t('hints.responsibleSelf')}
              value={d.responsible}
              onChange={(v) => set({ responsible: v })}
              maxTags={TICKET_LIMITS.responsible}
            />
          )}
          <Textarea
            label={t('fields.note')}
            description={t('hints.note')}
            value={d.note}
            onChange={(e) => set({ note: e.currentTarget.value })}
            autosize
            minRows={3}
            maxRows={10}
            maxLength={TICKET_LIMITS.note}
          />
          <AffectedPicker value={d.links} onChange={(links) => set({ links })} hidden={hiddenLinks} />
          <Stack gap={4}>
            <Text size="sm" fw={500} id="ticket-reminder-label">
              {t('fields.reminder')}
            </Text>
            <SegmentedControl
              aria-labelledby="ticket-reminder-label"
              data={[
                { value: 'default', label: t('reminder.default', { label: defaultLabel }) },
                { value: 'off', label: t('reminder.off') },
                { value: 'days', label: t('reminder.days') },
              ]}
              value={d.reminder}
              onChange={(v) => set({ reminder: v as Draft['reminder'] })}
              fullWidth
              size="xs"
              style={{ flexWrap: 'wrap' }}
            />
            {d.reminder === 'days' && (
              <NumberInput
                label={t('reminder.daysLabel')}
                min={1}
                max={365}
                value={d.reminderDays}
                onChange={(v) => set({ reminderDays: typeof v === 'number' ? v : 7 })}
                maw={260}
              />
            )}
          </Stack>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!valid}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Affected services, platforms, credentials, records, monitors and processes (only items the user can see can be picked). */
function AffectedPicker({ value, onChange, hidden }: { value: Affected[]; onChange: (v: Affected[]) => void; hidden: number }) {
  const { t } = useTranslation(['tickets', 'records']);
  const [kind, setKind] = useState<TicketLinkKind>('service');
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const [target, setTarget] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['link-targets', kind, debounced],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=${kind}&q=${encodeURIComponent(debounced)}`),
  });
  useEffect(() => setTarget(null), [kind]);
  const options = (targets.data ?? [])
    .filter((x) => !value.some((v) => v.kind === x.kind && v.id === x.id))
    .map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label }));
  const add = (id: string | null) => {
    if (!id) return;
    const found = targets.data?.find((x) => x.id === id);
    onChange([...value, { kind, id, label: found?.label ?? id }]);
    setTarget(null);
    setQ('');
  };
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        {t('fields.affected')}
      </Text>
      {(value.length > 0 || hidden > 0) && (
        <Group gap={6}>
          {value.map((l) => (
            <Badge
              key={`${l.kind}:${l.id}`}
              variant="light"
              color="gray"
              tt="none"
              rightSection={
                <ActionIcon
                  size="xs"
                  variant="transparent"
                  color="gray"
                  aria-label={t('affected.remove', { name: l.label })}
                  onClick={() => onChange(value.filter((x) => x !== l))}
                >
                  <IconX size={12} />
                </ActionIcon>
              }
            >
              {t(`records:links.kinds.${l.kind}`)}: {l.label}
            </Badge>
          ))}
          {Array.from({ length: hidden }, (_, i) => (
            <Badge key={`hidden${i}`} variant="outline" color="gray" tt="none">
              {t('detail.notVisible')}
            </Badge>
          ))}
        </Group>
      )}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Select
          size="xs"
          aria-label={t('affected.kind')}
          data={TICKET_LINK_KINDS.map((k) => ({ value: k, label: t(`records:links.kinds.${k}`) }))}
          value={kind}
          onChange={(v) => v && setKind(v as TicketLinkKind)}
          allowDeselect={false}
          style={{ flex: '1 1 140px' }}
        />
        <Select
          size="xs"
          aria-label={t('affected.item')}
          placeholder={t('affected.search')}
          searchable
          searchValue={q}
          onSearchChange={setQ}
          data={options}
          value={target}
          onChange={(v) => {
            setTarget(v);
            add(v);
          }}
          nothingFoundMessage={targets.isFetching ? '…' : t('affected.nothing')}
          filter={({ options: o }) => o}
          style={{ flex: '2 1 220px' }}
        />
      </Group>
      {value.length === 0 && hidden === 0 && (
        <Text size="xs" c="dimmed">
          {t('detail.noAffected')}
        </Text>
      )}
    </Stack>
  );
}
