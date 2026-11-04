import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, NumberInput, Paper, Select, Stack, Table, TagsInput, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  FIREWALL_MANAGERS,
  FIREWALL_RULES_RECORD_TYPE,
  FIREWALL_TYPE_ID,
  NETWORK_LIMITS,
  isCidr,
  isNetworkAddress,
  type FirewallManager,
  type NetworkAttributes,
  type RecordDetail,
  type SystemAttributes,
  type SystemDetail,
  type SystemSegmentLink,
  type SystemSummary,
} from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { confirmDanger } from '../confirm';
import { Field, RecordStatusBadge, useRecordTypes } from '../records/common';
import { EditionBadge, ReviewStatusBadge } from '../records/DocumentPanel';
import { TableFieldView } from '../records/TableField';
import { typeTemplate } from '../records/builtin';
import { TicketsPanel } from '../tickets/TicketsPanel';
import { fmtDay, fmtRelative } from '../../format';

/**
 * Network segments and firewall changes (#208), opt-in: the attributes of a segment (a system of kind "network"), the
 * segments a system is in with its address, and the "Firewall & network" panel of the system page.
 */

export const emptyNetwork = (a?: SystemAttributes): NetworkAttributes => ({
  vlanId: a?.vlanId ?? null,
  subnets: a?.subnets ?? [],
  zone: a?.zone ?? '',
  site: a?.site ?? '',
  firewallManagedBy: a?.firewallManagedBy ?? null,
  firewallProvider: a?.firewallProvider ?? '',
});

/** Problems of the attributes the server would refuse too (shown at the fields). */
export function networkErrors(a: NetworkAttributes): { vlanId?: boolean; subnets?: string[] } {
  const bad = a.subnets.filter((s) => !isCidr(s));
  return {
    ...(a.vlanId !== null && (a.vlanId < 1 || a.vlanId > 4094) ? { vlanId: true } : {}),
    ...(bad.length ? { subnets: bad } : {}),
  };
}

/** The fields of a network segment in the system form (all optional). */
export function NetworkFields({ value, onChange, showErrors }: { value: NetworkAttributes; onChange: (a: NetworkAttributes) => void; showErrors: boolean }) {
  const { t } = useTranslation('applications');
  const set = (patch: Partial<NetworkAttributes>) => onChange({ ...value, ...patch });
  const errors = showErrors ? networkErrors(value) : {};
  return (
    <Paper withBorder p="sm" data-testid="network-fields">
      <Stack gap="sm">
        <Text size="sm" fw={600}>
          {t('network.attributes')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('network.attributesHelp')}
        </Text>
        <Group grow align="flex-start" wrap="wrap">
          <NumberInput
            label={t('network.vlanId')}
            min={1}
            max={4094}
            allowDecimal={false}
            allowNegative={false}
            value={value.vlanId ?? ''}
            onChange={(v) => set({ vlanId: typeof v === 'number' ? v : null })}
            error={errors.vlanId ? t('network.vlanInvalid') : undefined}
            miw={140}
          />
          <TextInput
            label={t('network.site')}
            maxLength={NETWORK_LIMITS.site}
            value={value.site}
            onChange={(e) => set({ site: e.currentTarget.value })}
            miw={160}
          />
        </Group>
        <TagsInput
          label={t('network.subnets')}
          description={t('network.subnetsHelp')}
          placeholder="10.20.30.0/24"
          value={value.subnets}
          onChange={(v) => set({ subnets: v.map((s) => s.trim()).filter(Boolean) })}
          maxTags={NETWORK_LIMITS.subnets}
          splitChars={[',', ' ', ';']}
          error={errors.subnets ? t('network.subnetsInvalid', { values: errors.subnets.join(', ') }) : undefined}
        />
        <TextInput
          label={t('network.zone')}
          description={t('network.zoneHelp')}
          maxLength={NETWORK_LIMITS.zone}
          value={value.zone}
          onChange={(e) => set({ zone: e.currentTarget.value })}
        />
        <Group grow align="flex-start" wrap="wrap">
          <Select
            label={t('network.firewallManagedBy')}
            data={FIREWALL_MANAGERS.map((m) => ({ value: m, label: t(`network.managers.${m}`) }))}
            value={value.firewallManagedBy}
            onChange={(v) => set({ firewallManagedBy: (v as FirewallManager | null) ?? null })}
            clearable
            miw={160}
          />
          {value.firewallManagedBy === 'provider' && (
            <TextInput
              label={t('network.provider')}
              maxLength={NETWORK_LIMITS.provider}
              value={value.firewallProvider}
              onChange={(e) => set({ firewallProvider: e.currentTarget.value })}
              miw={160}
            />
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

/** A segment's attributes on its page (side panel). */
export function NetworkAttributesView({ attributes }: { attributes: SystemAttributes }) {
  const { t } = useTranslation('applications');
  const a = emptyNetwork(attributes);
  return (
    <>
      <Field label={t('network.vlanId')}>{a.vlanId ?? '–'}</Field>
      <Field label={t('network.subnets')}>
        {a.subnets.length ? (
          <Group gap={4}>
            {a.subnets.map((s) => (
              <Badge key={s} variant="default" className="mono" tt="none">
                {s}
              </Badge>
            ))}
          </Group>
        ) : (
          '–'
        )}
      </Field>
      <Field label={t('network.zone')}>{a.zone || '–'}</Field>
      <Field label={t('network.site')}>{a.site || '–'}</Field>
      <Field label={t('network.firewallManagedBy')}>
        {a.firewallManagedBy === 'provider'
          ? a.firewallProvider
            ? t('network.byProvider', { name: a.firewallProvider })
            : t('network.managers.provider')
          : a.firewallManagedBy
            ? t(`network.managers.${a.firewallManagedBy}`)
            : '–'}
      </Field>
    </>
  );
}

/** Put the system into a segment, or change its address there. */
function SegmentModal({ system, link, onClose, onSaved }: { system: SystemDetail; link: SystemSegmentLink | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems'), enabled: !link });
  const [segmentId, setSegmentId] = useState<string | null>(link?.segmentId ?? null);
  const [address, setAddress] = useState(link?.address ?? '');
  const [note, setNote] = useState(link?.note ?? '');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const taken = new Set(system.segments.map((s) => s.segmentId));
  const options = (systems.data ?? []).filter((s) => s.kind === 'network' && s.id !== system.id && !taken.has(s.id));
  const addressBad = !!address.trim() && !isNetworkAddress(address.trim());
  const save = async () => {
    setShown(true);
    if (addressBad || (!link && !segmentId)) return;
    setBusy(true);
    try {
      if (link) await put(`/systems/${system.id}/segments/${link.id}`, { address: address.trim(), note: note.trim() });
      else await post(`/systems/${system.id}/segments`, { segmentId, address: address.trim(), note: note.trim() });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={link ? t('firewall.editSegment', { name: link.segmentName }) : t('firewall.addSegment')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {!link && (
            <Select
              label={t('firewall.segment')}
              data={options.map((s) => ({ value: s.id, label: s.name }))}
              value={segmentId}
              onChange={setSegmentId}
              searchable
              required
              nothingFoundMessage={t('firewall.noSegmentsToChoose')}
              error={shown && !segmentId ? t('common:validation.required') : undefined}
              data-autofocus
            />
          )}
          <TextInput
            label={t('firewall.address')}
            description={t('firewall.addressHelp')}
            maxLength={NETWORK_LIMITS.address}
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            error={shown && addressBad ? t('firewall.addressInvalid') : undefined}
            className="mono"
          />
          <TextInput label={t('firewall.note')} maxLength={NETWORK_LIMITS.note} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
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

/** A new firewall change that names this system as affected. */
function NewChangeModal({ system, onClose }: { system: SystemDetail; onClose: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const navigate = useNavigate();
  const types = useRecordTypes();
  const type = types.data?.find((x) => x.id === FIREWALL_TYPE_ID);
  const [title, setTitle] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setShown(true);
    if (!title.trim() || !type) return;
    setBusy(true);
    try {
      const r = await post<RecordDetail>('/records', {
        type: type.id,
        title: title.trim(),
        body: typeTemplate(type),
        links: [{ kind: 'system', id: system.id, note: 'affected' }],
      });
      navigate(`/records/${r.id}/edit`);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('firewall.newChangeTitle', { name: system.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('firewall.newChangeHelp')}
          </Text>
          <TextInput
            label={t('firewall.changeTitle')}
            required
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={shown && !title.trim() ? t('common:validation.required') : undefined}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!type}>
              {t('firewall.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

const rulesField = FIREWALL_RULES_RECORD_TYPE.fields[0]!;

/**
 * "Firewall & network" on a system page: the segments it is in (with its address), for a segment the systems in it,
 * the approved firewall rules (edition, next review), the firewall changes that name it and the tickets.
 */
export function FirewallNetworkPanel({ system }: { system: SystemDetail }) {
  const { t } = useTranslation(['applications', 'records', 'common']);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SystemSegmentLink | 'new' | null>(null);
  const [creating, setCreating] = useState(false);
  const types = useRecordTypes();
  const canCreateChange = !!types.data?.some((x) => x.id === FIREWALL_TYPE_ID);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['system', system.id] });
  const fw = system.firewall;
  const open = fw.changes.filter((c) => !c.done);
  const done = fw.changes.filter((c) => c.done);
  const remove = async (l: SystemSegmentLink) => {
    if (!(await confirmDanger({ action: 'remove', message: t('firewall.removeSegmentConfirm', { name: l.segmentName }) }))) return;
    try {
      await del(`/systems/${system.id}/segments/${l.id}`);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Paper withBorder p="md" data-testid="firewall-panel">
      <Stack gap="md">
        <div>
          <Text fw={600} id="firewall-panel-title">
            {t('firewall.title')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('firewall.help')}
          </Text>
        </div>

        <Stack gap={6} data-testid="system-segments">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {t('firewall.segments')}
            </Text>
            {system.canEdit && (
              <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
                {t('firewall.addSegment')}
              </Button>
            )}
          </Group>
          {system.segments.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('firewall.noSegments')}
            </Text>
          ) : (
            <div className="table-scroll">
              <Table fz="sm" aria-label={t('firewall.segments')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('firewall.segment')}</Table.Th>
                    <Table.Th>{t('firewall.address')}</Table.Th>
                    <Table.Th>{t('network.vlanId')}</Table.Th>
                    <Table.Th>{t('firewall.note')}</Table.Th>
                    {system.canEdit && <Table.Th aria-label={t('firewall.actions')} />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {system.segments.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/systems/${l.segmentId}`} size="sm">
                          {l.segmentName}
                        </Anchor>
                        {l.zone && (
                          <Text size="xs" c="dimmed">
                            {l.zone}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td className="mono">{l.address || '–'}</Table.Td>
                      <Table.Td>{l.vlanId ?? '–'}</Table.Td>
                      <Table.Td>{l.note || '–'}</Table.Td>
                      {system.canEdit && (
                        <Table.Td className="nowrap">
                          <ActionIcon variant="subtle" aria-label={t('firewall.editSegment', { name: l.segmentName })} onClick={() => setEditing(l)}>
                            <IconEdit size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={t('firewall.removeSegment', { name: l.segmentName })}
                            onClick={() => void remove(l)}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>

        {system.kind === 'network' && (
          <Stack gap={6} data-testid="segment-members">
            <Text size="sm" fw={600}>
              {t('firewall.members')}
            </Text>
            {system.members.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('firewall.noMembers')}
              </Text>
            ) : (
              <div className="table-scroll">
                <Table fz="sm" aria-label={t('firewall.members')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('name')}</Table.Th>
                      <Table.Th>{t('systems.kind')}</Table.Th>
                      <Table.Th>{t('firewall.address')}</Table.Th>
                      <Table.Th>{t('firewall.note')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {system.members.map((m) => (
                      <Table.Tr key={m.linkId}>
                        <Table.Td>
                          <Anchor component={Link} to={`/systems/${m.systemId}`} size="sm">
                            {m.name}
                          </Anchor>
                        </Table.Td>
                        <Table.Td>{t(`systems.kinds.${m.kind as 'server'}`, { defaultValue: m.kind })}</Table.Td>
                        <Table.Td className="mono">{m.address || '–'}</Table.Td>
                        <Table.Td>{m.note || '–'}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}
          </Stack>
        )}

        <Stack gap={6} data-testid="approved-rules">
          <Text size="sm" fw={600}>
            {t('firewall.rules')}
          </Text>
          {fw.documents.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('firewall.noRules')}
            </Text>
          ) : (
            fw.documents.map((d) => (
              <Stack key={d.id} gap={4}>
                <Group gap="xs" wrap="wrap">
                  <Anchor component={Link} to={`/records/${d.id}`} size="sm" fw={500}>
                    <span className="mono">{d.number}</span> {d.title}
                  </Anchor>
                  {d.edition ? <EditionBadge edition={d.edition} /> : <RecordStatusBadge status={d.status} />}
                  {d.pending && (
                    <Badge size="sm" variant="light" color="cyan">
                      {t('firewall.pendingEdition')}
                    </Badge>
                  )}
                  <ReviewStatusBadge status={d.reviewStatus} />
                  {d.nextReviewAt && (
                    <Text size="xs" c="dimmed">
                      {t('firewall.nextReview', { date: fmtDay(d.nextReviewAt) })}
                    </Text>
                  )}
                </Group>
                <TableFieldView typeKey={FIREWALL_RULES_RECORD_TYPE.key} def={rulesField} value={JSON.stringify(d.rules)} />
              </Stack>
            ))
          )}
        </Stack>

        <Stack gap={6} data-testid="firewall-changes">
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              {t('firewall.changes')}
            </Text>
            {canCreateChange && (
              <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                {t('firewall.newChange')}
              </Button>
            )}
          </Group>
          {fw.changes.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('firewall.noChanges')}
            </Text>
          ) : (
            [
              { label: t('firewall.open'), list: open },
              { label: t('firewall.done'), list: done },
            ]
              .filter((g) => g.list.length)
              .map((g) => (
                <Stack key={g.label} gap={2}>
                  <Text size="xs" c="dimmed" fw={600}>
                    {g.label}
                  </Text>
                  {g.list.map((c) => (
                    <Group key={c.id} gap="xs" wrap="wrap">
                      <Anchor component={Link} to={`/records/${c.id}`} size="sm">
                        <span className="mono">{c.number}</span> {c.title}
                      </Anchor>
                      <RecordStatusBadge status={c.status} />
                      <Text size="xs" c="dimmed">
                        {[
                          t('firewall.ruleCount', { count: c.ruleCount }),
                          c.implementer ? t(`records:builtin.options.implementer.${c.implementer as 'internal'}`, { defaultValue: c.implementer }) : null,
                          c.providerTicket,
                          fmtRelative(c.updatedAt),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </Group>
                  ))}
                </Stack>
              ))
          )}
        </Stack>

        <TicketsPanel kind="system" id={system.id} label={system.name} />
      </Stack>
      {editing && <SegmentModal system={system} link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {creating && <NewChangeModal system={system} onClose={() => setCreating(false)} />}
    </Paper>
  );
}
