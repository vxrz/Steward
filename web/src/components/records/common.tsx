import { useEffect, useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconExternalLink, IconLink, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_RECORD_TYPES,
  LINK_KINDS,
  RECORD_STATUS_COLORS,
  type Backlink,
  type ItemLink,
  type LinkKind,
  type LinkTarget,
  type RecordType,
} from '@sm/shared';
import { get, notifyError } from '../../api';

export const useRecordTypes = (archived = false) =>
  useQuery({ queryKey: ['record-types', archived], queryFn: () => get<RecordType[]>(`/record-types${archived ? '?archived=1' : ''}`), staleTime: 30_000 });

/** Name of a record type; the built-in defaults are shown in the UI language until an administrator renames them. */
export function useTypeName() {
  const { t } = useTranslation('records');
  return (type: Pick<RecordType, 'key' | 'name' | 'builtin'> | undefined | null, fallback = ''): string => {
    if (!type) return fallback;
    const def = DEFAULT_RECORD_TYPES.find((d) => d.key === type.key);
    if (type.builtin && def && def.name === type.name) return t(`builtinTypes.${type.key as 'CR'}`, { defaultValue: type.name });
    return type.name;
  };
}

export function RecordStatusBadge({ status, size = 'sm' }: { status: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation('records');
  return (
    <Badge color={RECORD_STATUS_COLORS[status] ?? 'gray'} variant={status === 'draft' ? 'outline' : 'light'} size={size}>
      {t(`status.${status as 'draft'}`, { defaultValue: status })}
    </Badge>
  );
}

export type LinkInput = { kind: LinkKind; id: string; note: string } | { url: string; label: string; note: string };

/** Links of a record or service, with backlinks from other records and services. */
export function LinksPanel({
  links,
  backlinks,
  canEdit,
  onAdd,
  onRemove,
  self,
}: {
  links: ItemLink[];
  backlinks: Backlink[];
  canEdit: boolean;
  onAdd: (l: LinkInput) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  self?: { kind: LinkKind; id: string };
}) {
  const { t } = useTranslation('records');
  const [adding, setAdding] = useState(false);
  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text fw={600}>{t('links.title')}</Text>
        {canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
            {t('links.add')}
          </Button>
        )}
      </Group>
      {links.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('links.empty')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('links.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('links.kind')}</Table.Th>
                <Table.Th>{t('links.target')}</Table.Th>
                <Table.Th>{t('links.note')}</Table.Th>
                {canEdit && <Table.Th aria-label={t('links.actions')} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {links.map((l) => (
                <Table.Tr key={l.id}>
                  <Table.Td className="nowrap">{t(`links.kinds.${l.kind ?? 'external'}`)}</Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {l.kind === null ? (
                      <Anchor href={l.url ?? undefined} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                        {l.label || l.url} <IconExternalLink size={12} aria-hidden />
                      </Anchor>
                    ) : l.visible && l.path ? (
                      <Anchor component={Link} to={l.path} size="sm">
                        {l.label}
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('links.notVisible', { id: l.targetId })}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{l.note}</Table.Td>
                  {canEdit && (
                    <Table.Td>
                      <Tooltip label={t('links.remove')}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('links.removeNamed', { name: l.label || l.url || l.targetId })}
                          onClick={async () => {
                            if (confirm(t('links.removeConfirm'))) await onRemove(l.id).catch(notifyError);
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      <div>
        <Text fw={600} mb={4}>
          {t('links.backlinks')}
        </Text>
        {backlinks.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('links.noBacklinks')}
          </Text>
        ) : (
          <Stack gap={4}>
            {backlinks.map((b) => (
              <Group key={b.linkId} gap={6} wrap="nowrap">
                <IconLink size={14} aria-hidden />
                <Text size="sm">
                  {t(`links.kinds.${b.kind}`)}:{' '}
                  <Anchor component={Link} to={b.path} size="sm">
                    {b.label}
                  </Anchor>
                  {b.note && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      · {b.note}
                    </Text>
                  )}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </div>
      {adding && <AddLinkModal self={self} onClose={() => setAdding(false)} onAdd={onAdd} />}
    </Stack>
  );
}

function AddLinkModal({ onClose, onAdd, self }: { onClose: () => void; onAdd: (l: LinkInput) => Promise<void>; self?: { kind: LinkKind; id: string } }) {
  const { t } = useTranslation(['records', 'common']);
  const [kind, setKind] = useState<LinkKind | 'external'>('service');
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const [target, setTarget] = useState<string | null>(null);
  const [url, setUrl] = useState('https://');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const targets = useQuery({
    queryKey: ['link-targets', kind, debounced],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=${kind}&q=${encodeURIComponent(debounced)}`),
    enabled: kind !== 'external',
  });
  useEffect(() => setTarget(null), [kind]);
  const options = (targets.data ?? [])
    .filter((x) => !(self && x.kind === self.kind && x.id === self.id))
    .map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label }));
  const valid = kind === 'external' ? /^https?:\/\/\S+\.\S+/.test(url) : !!target;
  const submit = async () => {
    setBusy(true);
    try {
      await onAdd(kind === 'external' ? { url: url.trim(), label: label.trim(), note: note.trim() } : { kind, id: target!, note: note.trim() });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('links.add')}>
      <Stack gap="sm">
        <Select
          label={t('links.kind')}
          data={[...LINK_KINDS, 'external' as const].map((k) => ({ value: k, label: t(`links.kinds.${k}`) }))}
          value={kind}
          onChange={(v) => v && setKind(v as LinkKind | 'external')}
          allowDeselect={false}
        />
        {kind === 'external' ? (
          <>
            <TextInput label={t('links.url')} description={t('links.urlHelp')} value={url} onChange={(e) => setUrl(e.currentTarget.value)} required />
            <TextInput label={t('links.label')} placeholder={t('links.labelPlaceholder')} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
          </>
        ) : (
          <Select
            label={t('links.target')}
            placeholder={t('links.search')}
            searchable
            searchValue={q}
            onSearchChange={setQ}
            data={options}
            value={target}
            onChange={setTarget}
            nothingFoundMessage={targets.isFetching ? t('links.searching') : t('links.nothingFound')}
            filter={({ options: o }) => o}
          />
        )}
        <TextInput
          label={t('links.note')}
          placeholder={t('links.notePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          maxLength={200}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid}>
            {t('links.add')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A labelled block of text on a detail page. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Paper p={0} bg="transparent">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <div>{children}</div>
    </Paper>
  );
}
