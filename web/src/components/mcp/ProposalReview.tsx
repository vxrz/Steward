import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Group, Paper, SegmentedControl, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconPencil } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { McpCatalogueProposal, McpMappingsProposal, McpProposalSelection } from '@sm/shared';
import { TONE } from '../common';

const CHANGE_COLOR = { new: TONE.ok, changed: TONE.attention, same: TONE.neutral } as const;

/**
 * Reviewing a control catalogue an AI assistant proposed (#74): each control compared with the catalogue of that key,
 * editable, ticked to accept; controls of the catalogue the proposal leaves out are removed only when ticked.
 */
export function CatalogueProposalReview({
  p,
  editable,
  onChange,
}: {
  p: McpCatalogueProposal;
  editable: boolean;
  onChange: (selection: McpProposalSelection, count: number) => void;
}) {
  const { t } = useTranslation('mcp');
  const [show, setShow] = useState<'all' | 'changes'>('all');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(p.controls.map((c) => c.ref)));
  const [edits, setEdits] = useState<Record<string, { title: string; description: string }>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const rows = show === 'changes' ? p.controls.filter((c) => c.change !== 'same') : p.controls;
  const counts = useMemo(
    () => ({ new: p.controls.filter((c) => c.change === 'new').length, changed: p.controls.filter((c) => c.change === 'changed').length }),
    [p.controls],
  );

  useEffect(() => {
    // only what differs from the proposal: left-out refs and edited texts (small requests also for large catalogues)
    const skip = p.controls.filter((c) => !chosen.has(c.ref)).map((c) => c.ref);
    const changed = Object.entries(edits)
      .filter(([ref]) => chosen.has(ref))
      .map(([ref, e]) => ({ ref, ...e }));
    onChange({ catalogue: { skip, edits: changed, remove: [...remove] } }, p.controls.length - skip.length);
  }, [chosen, edits, remove, p.controls, onChange]);

  const toggle = (set: Set<string>, ref: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(ref);
    else next.delete(ref);
    return next;
  };

  return (
    <Stack gap="sm">
      <Paper withBorder p="sm">
        <Text size="sm" fw={600}>
          {p.key} – {p.name}
          {p.version ? ` · ${p.version}` : ''}
        </Text>
        <Text size="sm" c="dimmed">
          {p.existing ? t('proposals.updates', { name: p.existing.name, version: p.existing.version || '–' }) : t('proposals.creates')}
        </Text>
        <Group gap="xs" mt={6}>
          <Badge color={CHANGE_COLOR.new} variant="light">
            {t('proposals.countNew', { count: counts.new })}
          </Badge>
          <Badge color={CHANGE_COLOR.changed} variant="light">
            {t('proposals.countChanged', { count: counts.changed })}
          </Badge>
          {p.missing.length > 0 && (
            <Badge color="gray" variant="light">
              {t('proposals.countMissing', { count: p.missing.length })}
            </Badge>
          )}
        </Group>
      </Paper>
      {p.incomplete && (
        <Alert color="blue" variant="light" p="xs">
          {t('proposals.incomplete')}
        </Alert>
      )}
      {p.existing?.builtin && (
        <Alert color="yellow" variant="light" p="xs">
          {t('proposals.builtin')}
        </Alert>
      )}
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          value={show}
          onChange={(v) => setShow(v as 'all')}
          aria-label={t('proposals.show')}
          data={[
            { value: 'all', label: t('proposals.showAll', { count: p.controls.length }) },
            { value: 'changes', label: t('proposals.showChanges', { count: counts.new + counts.changed }) },
          ]}
        />
        {editable && (
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => setChosen(new Set(p.controls.map((c) => c.ref)))}>
              {t('proposals.selectAll')}
            </Button>
            <Button size="compact-xs" variant="subtle" onClick={() => setChosen(new Set())}>
              {t('proposals.selectNone')}
            </Button>
          </Group>
        )}
      </Group>
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('proposals.controls')} verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36} />
              <Table.Th>{t('proposals.ref')}</Table.Th>
              <Table.Th>{t('proposals.text')}</Table.Th>
              <Table.Th>{t('proposals.change')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((c) => {
              const e = edits[c.ref];
              const title = e?.title ?? c.title;
              const description = e?.description ?? c.description;
              return (
                <Table.Tr key={c.ref}>
                  <Table.Td>
                    <Checkbox
                      aria-label={t('proposals.accept', { ref: c.ref })}
                      checked={chosen.has(c.ref)}
                      disabled={!editable}
                      onChange={(ev) => setChosen((s) => toggle(s, c.ref, ev.currentTarget.checked))}
                    />
                  </Table.Td>
                  <Table.Td className="mono">{c.ref}</Table.Td>
                  <Table.Td>
                    {editing === c.ref ? (
                      <Stack gap={4}>
                        <TextInput
                          aria-label={t('proposals.titleOf', { ref: c.ref })}
                          size="xs"
                          value={title}
                          maxLength={300}
                          onChange={(ev) => setEdits((x) => ({ ...x, [c.ref]: { title: ev.currentTarget.value, description } }))}
                        />
                        <Textarea
                          aria-label={t('proposals.descriptionOf', { ref: c.ref })}
                          size="xs"
                          autosize
                          minRows={2}
                          maxLength={4000}
                          value={description}
                          onChange={(ev) => setEdits((x) => ({ ...x, [c.ref]: { title, description: ev.currentTarget.value } }))}
                        />
                        <Group justify="flex-end">
                          <Button size="compact-xs" variant="default" onClick={() => setEditing(null)}>
                            {t('proposals.done')}
                          </Button>
                        </Group>
                      </Stack>
                    ) : (
                      <Group gap={4} wrap="nowrap" align="flex-start" justify="space-between">
                        <div style={{ minWidth: 0 }}>
                          <Text size="sm" fw={500}>
                            {title}
                            {e ? (
                              <Badge size="xs" variant="light" ml={6}>
                                {t('proposals.edited')}
                              </Badge>
                            ) : null}
                          </Text>
                          {description && (
                            <Text size="xs" c="dimmed" lineClamp={3}>
                              {description}
                            </Text>
                          )}
                          {c.before && (
                            <Text size="xs" c="dimmed" mt={2}>
                              {t('proposals.before')}: <s>{c.before.title}</s>
                            </Text>
                          )}
                        </div>
                        {editable && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            leftSection={<IconPencil size={12} />}
                            aria-label={t('proposals.editOf', { ref: c.ref })}
                            onClick={() => setEditing(c.ref)}
                          >
                            {t('proposals.edit')}
                          </Button>
                        )}
                      </Group>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={CHANGE_COLOR[c.change]}>
                      {t(`proposals.changes.${c.change}`)}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </div>
      {p.missing.length > 0 && !p.existing?.builtin && (
        <Paper withBorder p="sm">
          <Text size="sm" fw={600}>
            {t('proposals.missingTitle', { count: p.missing.length })}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('proposals.missingText')}
          </Text>
          <Stack gap={4}>
            {p.missing.slice(0, 500).map((m) => (
              <Checkbox
                key={m.ref}
                size="xs"
                disabled={!editable}
                checked={remove.has(m.ref)}
                onChange={(ev) => setRemove((s) => toggle(s, m.ref, ev.currentTarget.checked))}
                label={`${t('proposals.removeLabel', { ref: m.ref, title: m.title })}${m.mapped ? ` · ${t('proposals.mappedItems', { count: m.mapped })}` : ''}`}
              />
            ))}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

const STATE_COLOR = { new: TONE.ok, mapped: TONE.neutral, noControl: TONE.bad, notVisible: TONE.neutral } as const;

/** Reviewing mappings an AI assistant proposed (#74): ticked mappings are applied, with the assistant's reason shown. */
export function MappingsProposalReview({
  p,
  editable,
  onChange,
}: {
  p: McpMappingsProposal;
  editable: boolean;
  onChange: (selection: McpProposalSelection, count: number) => void;
}) {
  const { t } = useTranslation('mcp');
  const { t: tc } = useTranslation('compliance');
  const open = p.mappings.filter((m) => m.state === 'new');
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(open.map((m) => m.index)));
  useEffect(() => onChange({ mappings: [...chosen] }, chosen.size), [chosen, onChange]);
  return (
    <Stack gap="sm">
      <Paper withBorder p="sm">
        <Text size="sm" fw={600}>
          {t('proposals.mappingsFor', { key: p.catalogueKey, count: p.mappings.length })}
        </Text>
        <Text size="xs" c="dimmed">
          {t('proposals.mappingsText')}
        </Text>
      </Paper>
      {p.incomplete && (
        <Alert color="blue" variant="light" p="xs">
          {t('proposals.incomplete')}
        </Alert>
      )}
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('proposals.mappings')} verticalSpacing={4}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={36} />
              <Table.Th>{t('proposals.control')}</Table.Th>
              <Table.Th>{t('proposals.item')}</Table.Th>
              <Table.Th>{t('proposals.why')}</Table.Th>
              <Table.Th>{t('proposals.state')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {p.mappings.map((m) => (
              <Table.Tr key={m.index}>
                <Table.Td>
                  <Checkbox
                    aria-label={t('proposals.acceptMapping', { ref: m.ref, item: m.label || m.kind })}
                    checked={chosen.has(m.index)}
                    disabled={!editable || m.state !== 'new'}
                    onChange={(ev) =>
                      setChosen((s) => {
                        const next = new Set(s);
                        if (ev.currentTarget.checked) next.add(m.index);
                        else next.delete(m.index);
                        return next;
                      })
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <Text size="sm" className="mono">
                    {m.ref}
                  </Text>
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {m.controlTitle}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="default" mr={6}>
                    {tc(`tagKinds.${m.kind}`)}
                  </Badge>
                  {m.path ? (
                    <Anchor component={Link} to={m.path} size="sm">
                      {m.label}
                    </Anchor>
                  ) : (
                    <Text span size="sm" c="dimmed">
                      {tc('controls.notVisible')}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{m.reason}</Text>
                </Table.Td>
                <Table.Td>
                  <Badge size="xs" variant="light" color={STATE_COLOR[m.state]}>
                    {t(`proposals.states.${m.state}`)}
                  </Badge>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
