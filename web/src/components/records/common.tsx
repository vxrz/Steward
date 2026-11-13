import './builtin';
import { useEffect, useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconExternalLink, IconLink, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ACCESS_RECORD_TYPE,
  DOCUMENT_RECORD_TYPE,
  DEFAULT_RECORD_TYPES,
  LINK_KINDS,
  PLANT_LINK_KINDS,
  DATA_PRODUCT_LINK_KINDS,
  PLANT_SOURCE_RECORD_TYPE,
  RECORD_STATUS_COLORS,
  type Backlink,
  type ItemLink,
  type LinkKind,
  type LinkTarget,
  type RecordType,
  INCIDENT_RECORD_TYPE,
} from '@sm/shared';
import { get, notifyError } from '../../api';
import { useMe } from '../../auth';
import { confirmDanger } from '../confirm';
import { useFieldErrors } from '../common';
import { useRemoteSelect } from '../remoteSelect';
import { LinkTypeIconView, linkTypeOf, useLinkTypeName, useLinkTypes } from './linkTypes';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { ShowAll, useShowMore } from '../page/ShowAll';
import { TableScroll } from '../TableScroll';

/** Links listed before "Show all"; more backlinks than this start folded. */
const LINKS_FIRST = 10;

export const useRecordTypes = (archived = false) =>
  useQuery({ queryKey: ['record-types', archived], queryFn: () => get<RecordType[]>(`/record-types${archived ? '?archived=1' : ''}`), staleTime: 30_000 });

/** Name of a record type; the built-in defaults are shown in the UI language until an administrator renames them. */
export function useTypeName() {
  const { t } = useTranslation('records');
  return (type: Pick<RecordType, 'key' | 'name' | 'builtin'> | undefined | null, fallback = ''): string => {
    if (!type) return fallback;
    const def = [...DEFAULT_RECORD_TYPES, ACCESS_RECORD_TYPE, DOCUMENT_RECORD_TYPE, INCIDENT_RECORD_TYPE, PLANT_SOURCE_RECORD_TYPE].find(
      (d) => d.key === type.key,
    );
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

export type LinkInput = { kind: LinkKind; id: string; note: string } | { url: string; label: string; note: string; linkType: string | null };
/** Changes to an existing link: internal links only take a note. */
export type LinkUpdate = { note: string } | { label?: string; note: string; linkType: string | null };

/** Links of a record or service, with backlinks from other records and services. */
export function LinksPanel({
  links,
  backlinks,
  canEdit,
  onAdd,
  onUpdate,
  onRemove,
  self,
}: {
  links: ItemLink[];
  backlinks: Backlink[];
  canEdit: boolean;
  onAdd: (l: LinkInput) => Promise<void>;
  /** Without it, links cannot be edited (only added and removed). */
  onUpdate?: (id: string, l: LinkUpdate) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  self?: { kind: LinkKind; id: string };
}) {
  const { t } = useTranslation('records');
  const { t: tm } = useTranslation('modules');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ItemLink | null>(null);
  const types = useLinkTypes();
  const typeName = useLinkTypeName();
  const internal = links.filter((l) => l.kind !== null || !!l.module);
  // external links grouped by type, in the order of the types (built-in first); untyped ones under "Other"
  const groups = new Map<string, { type: ReturnType<typeof linkTypeOf>; links: ItemLink[] }>();
  for (const l of links.filter((x) => x.kind === null)) {
    const type = linkTypeOf(types.data, l.linkType);
    groups.set(type.key, { type, links: [...(groups.get(type.key)?.links ?? []), l] });
  }
  const order = (key: string) => {
    const i = (types.data ?? []).findIndex((x) => x.key === key);
    return key === 'other' ? Number.MAX_SAFE_INTEGER : i < 0 ? Number.MAX_SAFE_INTEGER - 1 : i;
  };
  const sorted = [...groups.values()].sort((a, b) => order(a.type.key) - order(b.type.key));
  // the first 10 links (internal ones first, then by type), "Show all N" for the rest
  const more = useShowMore([...internal, ...sorted.flatMap((g) => g.links)], LINKS_FIRST);
  const visible = new Set(more.items.map((l) => l.id));
  const internalShown = internal.filter((l) => visible.has(l.id));
  const external = sorted.map((g) => ({ ...g, shown: g.links.filter((l) => visible.has(l.id)) })).filter((g) => g.shown.length);
  const linkName = (l: ItemLink) => l.label || l.url || t('links.notVisible');
  // links to items the reader cannot see can be removed, not edited
  const editButton = (l: ItemLink) =>
    onUpdate &&
    (l.kind === null || l.visible) && (
      <Tooltip label={t('links.edit')}>
        <ActionIcon variant="subtle" color="gray" aria-label={t('links.editNamed', { name: linkName(l) })} onClick={() => setEditing(l)}>
          <IconPencil size={16} />
        </ActionIcon>
      </Tooltip>
    );
  const actions = (l: ItemLink) => (
    <Group gap={2} wrap="nowrap">
      {editButton(l)}
      {removeButton(l)}
    </Group>
  );
  const removeButton = (l: ItemLink) => (
    <Tooltip label={t('links.remove')}>
      <ActionIcon
        variant="subtle"
        color="red"
        aria-label={t('links.removeNamed', { name: linkName(l) })}
        onClick={async () => {
          if (await confirmDanger({ action: 'remove', message: t('links.removeConfirm') })) await onRemove(l.id).catch(notifyError);
        }}
      >
        <IconTrash size={16} />
      </ActionIcon>
    </Tooltip>
  );
  return (
    <CollapsibleSection
      id="links"
      collapseOnPhone
      onlyInGroup
      size="h5"
      title={t('links.title')}
      count={links.length}
      defaultOpen={links.length + backlinks.length > 0}
      actions={
        canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
            {t('links.add')}
          </Button>
        )
      }
    >
      <Stack gap="md">
        {links.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('links.empty')}
          </Text>
        )}
        {internalShown.length > 0 && (
          <TableScroll>
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
                {internalShown.map((l) => (
                  <Table.Tr key={l.id}>
                    <Table.Td className="nowrap">{l.module ? tm(`items.${l.module}.name`) : t(`links.kinds.${l.kind ?? 'external'}`)}</Table.Td>
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>
                      {l.module ? (
                        // an item of a module the reader does not use (ADR 0034): counted, not named
                        <Text size="sm" c="dimmed">
                          {t('links.otherModule', { module: tm(`items.${l.module}.name`) })}
                        </Text>
                      ) : l.kind === null ? (
                        <Anchor href={l.url ?? undefined} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                          {l.label || l.url} <IconExternalLink size={12} aria-hidden />
                        </Anchor>
                      ) : l.visible && l.path ? (
                        <>
                          <Anchor component={Link} to={l.path} size="sm">
                            {l.label}
                          </Anchor>
                          {l.edition && (
                            <Badge size="xs" variant="light" color="green" ml={6}>
                              {t('document.editionShort', { edition: l.edition })}
                            </Badge>
                          )}
                        </>
                      ) : l.visible ? (
                        // a name without a page to open (a plant viewer's view of linked systems, #218)
                        <Text size="sm">{l.label}</Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {t('links.notVisible')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{l.note}</Table.Td>
                    {canEdit && <Table.Td>{actions(l)}</Table.Td>}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        )}
        {external.length > 0 && (
          <Stack gap="sm" data-testid="external-links">
            <Text fw={600}>{t('links.external')}</Text>
            {external.map(({ type, links: group, shown }) => {
              const name = typeName(type);
              return (
                <div key={type.key} data-link-type={type.key}>
                  <Group gap={6} mb={4} wrap="nowrap">
                    <LinkTypeIconView icon={type.icon} />
                    <Text size="sm" fw={500}>
                      {name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      ({group.length})
                    </Text>
                  </Group>
                  <Stack gap={4} role="list" aria-label={t('links.typeGroup', { type: name })} pl={22}>
                    {shown.map((l) => (
                      <Group key={l.id} role="listitem" gap={6} wrap="nowrap" justify="space-between">
                        <Text size="sm" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                          <Anchor href={l.url ?? undefined} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                            {l.label || l.url} <IconExternalLink size={12} aria-hidden />
                          </Anchor>
                          {l.note && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              · {l.note}
                            </Text>
                          )}
                        </Text>
                        {canEdit && actions(l)}
                      </Group>
                    ))}
                  </Stack>
                </div>
              );
            })}
          </Stack>
        )}
        <ShowAll state={more} id="links" />
        <CollapsibleSection
          id="backlinks"
          order={3}
          title={t('links.backlinks')}
          count={backlinks.length}
          // the same choice on every page with links; long lists start folded
          remember="section.links.backlinks"
          defaultOpen={backlinks.length > 0 && backlinks.length <= LINKS_FIRST}
        >
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
        </CollapsibleSection>
        {adding && <LinkModal self={self} onClose={() => setAdding(false)} onSave={(l) => onAdd(l as LinkInput)} />}
        {editing && onUpdate && <LinkModal link={editing} onClose={() => setEditing(null)} onSave={(l) => onUpdate(editing.id, l)} />}
      </Stack>
    </CollapsibleSection>
  );
}

/**
 * Adds a link, or edits one (`link`): the kind and the target (URL or item) stay as they are; external
 * links take label, type and note, internal links only the note.
 */
function LinkModal({
  link,
  onClose,
  onSave,
  self,
}: {
  link?: ItemLink;
  onClose: () => void;
  onSave: (l: LinkInput | LinkUpdate) => Promise<void>;
  self?: { kind: LinkKind; id: string };
}) {
  const { t } = useTranslation(['records', 'common']);
  const editing = !!link;
  const [kind, setKind] = useState<LinkKind | 'external'>(link ? (link.kind ?? 'external') : 'service');
  const [target, setTarget] = useState<string | null>(null);
  const pick = useRemoteSelect({ value: target });
  const [url, setUrl] = useState(link?.url ?? 'https://');
  // the stored label of an external link (the panel shows the URL when it is empty)
  const initialLabel = link && link.kind === null && link.label !== link.url ? link.label : '';
  const [label, setLabel] = useState(initialLabel);
  const [linkType, setLinkType] = useState<string | null>(link?.linkType ?? null);
  const [note, setNote] = useState(link?.note ?? '');
  const [busy, setBusy] = useState(false);
  const types = useLinkTypes();
  // sites and assets only while the plant registry module is on (#218); data products and objects while theirs is (ADR 0036)
  const { caps } = useMe();
  const linkKinds = LINK_KINDS.filter(
    (k) =>
      (caps.plant || !(PLANT_LINK_KINDS as readonly string[]).includes(k)) &&
      (caps.modules?.dataProducts === true || !(DATA_PRODUCT_LINK_KINDS as readonly string[]).includes(k)),
  );
  const typeName = useLinkTypeName();
  const targets = useQuery({
    queryKey: ['link-targets', kind, pick.term],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=${kind}&q=${encodeURIComponent(pick.term)}`),
    // while the next search loads, the list keeps the last results of the same kind (no flicker of the options)
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === kind ? prev : undefined),
    enabled: kind !== 'external' && !editing,
  });
  useEffect(() => setTarget(null), [kind]);
  const options = pick.options(
    (targets.data ?? [])
      // the previous kind's answer while the new one loads is no choice
      .filter((x) => x.kind === kind && !(self && x.kind === self.kind && x.id === self.id))
      .map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label })),
  );
  // archived types cannot be chosen, but a link keeps the one it has
  const typeOptions = (types.data ?? [])
    .filter((x) => !x.archived || x.key === link?.linkType)
    .map((x) => ({ value: x.key, label: x.archived ? t('links.linkTypeArchived', { type: typeName(x) }) : typeName(x) }));
  const v = useFieldErrors({
    url: !editing && kind === 'external' && !/^https?:\/\/\S+\.\S+/.test(url) && (url.trim() ? t('common:validation.url') : t('common:validation.required')),
    target: !editing && kind !== 'external' && !target && t('common:validation.required'),
  });
  const submit = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      // the label only when it changed (an unchanged one may be the URL itself, see above)
      if (editing)
        await onSave(kind === 'external' ? { ...(label !== initialLabel ? { label: label.trim() } : {}), note: note.trim(), linkType } : { note: note.trim() });
      else await onSave(kind === 'external' ? { url: url.trim(), label: label.trim(), note: note.trim(), linkType } : { kind, id: target!, note: note.trim() });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={editing ? t('links.edit') : t('links.add')}>
      <Stack gap="sm">
        <Select
          label={t('links.kind')}
          data={[...linkKinds, 'external' as const].map((k) => ({ value: k, label: t(`links.kinds.${k}`) }))}
          value={kind}
          onChange={(v) => v && setKind(v as LinkKind | 'external')}
          allowDeselect={false}
          disabled={editing}
        />
        {kind === 'external' ? (
          <>
            {editing ? (
              <TextInput label={t('links.url')} value={url} readOnly disabled />
            ) : (
              <TextInput
                label={t('links.url')}
                description={t('links.urlHelp')}
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                required
                error={v.error('url')}
              />
            )}
            <TextInput
              label={t('links.label')}
              placeholder={t('links.labelPlaceholder')}
              value={label}
              onChange={(e) => setLabel(e.currentTarget.value)}
              maxLength={200}
            />
            <Select
              label={t('links.linkType')}
              placeholder={t('links.linkTypeNone')}
              data={typeOptions}
              value={linkType}
              onChange={setLinkType}
              clearable
              renderOption={({ option }) => {
                const lt = types.data?.find((x) => x.key === option.value);
                return (
                  <Group gap={8} wrap="nowrap">
                    {lt && <LinkTypeIconView icon={lt.icon} />}
                    <span>{option.label}</span>
                  </Group>
                );
              }}
            />
          </>
        ) : editing ? (
          <TextInput label={t('links.target')} value={link.label} readOnly disabled />
        ) : (
          <Select
            label={t('links.target')}
            placeholder={t('links.search')}
            searchable
            searchValue={pick.search}
            onSearchChange={pick.setSearch}
            data={options}
            value={target}
            onChange={setTarget}
            nothingFoundMessage={targets.isFetching ? t('links.searching') : t('links.nothingFound')}
            filter={({ options: o }) => o}
            required
            error={v.error('target')}
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
          <Button onClick={submit} loading={busy}>
            {editing ? t('common:save') : t('links.add')}
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
