import { useState } from 'react';
import { ActionIcon, Anchor, Button, Card, Group, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SUPPORT_LIMITS as SL, isSupportUrl, levelName, type SupportLevel, type SupportLevelInput } from '@sm/shared';
import { del, notifyError, notifyOk, post, put } from '../../api';
import { useMe } from '../../auth';
import { DataTable } from '../DataTable';
import { FormModal } from '../FormModal';
import { QueryState, useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { FormButtons, useBusy } from '../dataproducts/form';
import { useSupportLevels } from './HelpAndSupport';

/**
 * Settings → Support levels (0.26.0, ADR 0039 part 5): the short list of what providing teams promise – names in
 * English and German, hours, one first-response time, a note and the SLA document. Administrators add, change, order
 * and remove levels; a level in use is removed only after saying which level its items get instead (or none).
 */
export function SupportLevelsCard() {
  const { t, i18n } = useTranslation(['support', 'common']);
  const { isAdmin } = useMe();
  const list = useSupportLevels();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ level?: SupportLevel } | null>(null);
  const [removing, setRemoving] = useState<SupportLevel | null>(null);
  const changed = () => void qc.invalidateQueries({ queryKey: ['support-levels'] });
  const rows = list.data ?? [];
  const moveLevel = async (i: number, d: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      qc.setQueryData(['support-levels'], await put<SupportLevel[]>('/support/levels/order', { ids }));
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (x: SupportLevel) => {
    if (x.usage > 0) return setRemoving(x);
    if (!(await confirmDanger({ action: 'delete', message: t('levels.removeConfirm', { name: x.nameEn }) }))) return;
    try {
      await del(`/support/levels/${encodeURIComponent(x.id)}`);
      changed();
      notifyOk(t('levels.removed'));
    } catch (e) {
      notifyError(e);
    }
  };
  const name = (x: SupportLevel) => levelName(x, i18n.language);
  const actions = (x: SupportLevel, i: number) => (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={t('levels.moveUp', { name: name(x) })}>
        <ActionIcon variant="subtle" size="lg" aria-label={t('levels.moveUp', { name: name(x) })} disabled={i === 0} onClick={() => void moveLevel(i, -1)}>
          <IconArrowUp size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('levels.moveDown', { name: name(x) })}>
        <ActionIcon
          variant="subtle"
          size="lg"
          aria-label={t('levels.moveDown', { name: name(x) })}
          disabled={i === rows.length - 1}
          onClick={() => void moveLevel(i, 1)}
        >
          <IconArrowDown size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('levels.editNamed', { name: name(x) })}>
        <ActionIcon variant="subtle" size="lg" aria-label={t('levels.editNamed', { name: name(x) })} onClick={() => setEditing({ level: x })}>
          <IconPencil size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('levels.remove', { name: name(x) })}>
        <ActionIcon variant="subtle" color="red" size="lg" aria-label={t('levels.remove', { name: name(x) })} onClick={() => void remove(x)}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
  return (
    <Card withBorder id="support-levels" data-testid="support-levels">
      <Group justify="space-between" align="flex-start" mb="xs" wrap="wrap" gap="xs">
        <Title order={2} size="h4">
          {t('levels.title')}
        </Title>
        {isAdmin && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="support-level-add">
            {t('levels.add')}
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('levels.description')}
      </Text>
      {!isAdmin && (
        <Text size="sm" mb="sm">
          {t('levels.readOnly')}
        </Text>
      )}
      <QueryState query={list} />
      {list.data &&
        (rows.length ? (
          <DataTable
            testId="support-level-table"
            ariaLabel={t('levels.title')}
            rows={rows}
            rowKey={(x) => x.id}
            rowProps={(x) => ({ 'data-testid': `support-level-${x.id}` })}
            card={(x) => (
              <Stack gap={4} data-testid={`support-level-${x.id}`}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" fw={600}>
                    {name(x)}
                  </Text>
                  {isAdmin && actions(x, rows.indexOf(x))}
                </Group>
                {x.hours && (
                  <Text size="xs">
                    {t('levels.hours')}: {x.hours}
                  </Text>
                )}
                {x.firstResponse && (
                  <Text size="xs">
                    {t('levels.firstResponse')}: {x.firstResponse}
                  </Text>
                )}
                {isAdmin && (
                  <Text size="xs" c="dimmed">
                    {t('levels.usage')}: {t('levels.usageCount', { count: x.usage })}
                  </Text>
                )}
              </Stack>
            )}
            columns={[
              {
                key: 'name',
                header: t('levels.nameEn'),
                cell: (x) => (
                  <Stack gap={0}>
                    <Text size="sm" fw={500}>
                      {x.nameEn}
                    </Text>
                    {x.nameDe && x.nameDe !== x.nameEn && (
                      <Text size="xs" c="dimmed" lang="de">
                        {x.nameDe}
                      </Text>
                    )}
                  </Stack>
                ),
              },
              { key: 'hours', header: t('levels.hours'), cell: (x) => x.hours || '–' },
              { key: 'firstResponse', header: t('levels.firstResponse'), cell: (x) => x.firstResponse || '–' },
              {
                key: 'sla',
                header: t('levels.slaUrl'),
                cell: (x) =>
                  x.slaUrl ? (
                    <Anchor href={x.slaUrl} target="_blank" rel="noopener noreferrer" size="sm">
                      {t('level.sla')}
                    </Anchor>
                  ) : (
                    '–'
                  ),
              },
              ...(isAdmin
                ? [
                    { key: 'usage', header: t('levels.usage'), nowrap: true, cell: (x: SupportLevel) => t('levels.usageCount', { count: x.usage }) },
                    { key: 'actions', header: t('levels.actions'), cell: (x: SupportLevel) => actions(x, rows.indexOf(x)) },
                  ]
                : []),
            ]}
          />
        ) : (
          <Text size="sm" c="dimmed">
            {t('levels.none')}
          </Text>
        ))}
      {editing && (
        <LevelForm
          level={editing.level}
          onClose={() => setEditing(null)}
          onSaved={() => {
            changed();
            setEditing(null);
            notifyOk(t('levels.saved'));
          }}
        />
      )}
      {removing && (
        <RemoveInUse
          level={removing}
          others={rows.filter((r) => r.id !== removing.id)}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            changed();
            setRemoving(null);
            notifyOk(t('levels.removed'));
          }}
        />
      )}
    </Card>
  );
}

function LevelForm({ level, onClose, onSaved }: { level?: SupportLevel; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['support', 'common']);
  const [x, setX] = useState<Required<SupportLevelInput>>({
    nameEn: level?.nameEn ?? '',
    nameDe: level?.nameDe ?? '',
    hours: level?.hours ?? '',
    firstResponse: level?.firstResponse ?? '',
    note: level?.note ?? '',
    slaUrl: level?.slaUrl ?? '',
  });
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    nameEn: !x.nameEn.trim() && t('common:validation.required'),
    slaUrl: !!x.slaUrl.trim() && !isSupportUrl(x.slaUrl) && t('fields.urlInvalid'),
  });
  const set = (patch: Partial<SupportLevelInput>) => setX((cur) => ({ ...cur, ...patch }));
  const save = () =>
    run(async () => {
      const body = Object.fromEntries(Object.entries(x).map(([k, val]) => [k, String(val).trim()]));
      if (level) await put(`/support/levels/${encodeURIComponent(level.id)}`, body);
      else await post('/support/levels', body);
      onSaved();
    });
  return (
    <FormModal onClose={onClose} size="lg" title={level ? t('levels.editTitle', { name: level.nameEn }) : t('levels.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('levels.nameEn')}
              required
              maxLength={SL.name}
              value={x.nameEn}
              onChange={(e) => set({ nameEn: e.currentTarget.value })}
              error={v.error('nameEn')}
              data-autofocus
              data-testid="support-level-name"
            />
            <TextInput label={t('levels.nameDe')} maxLength={SL.name} value={x.nameDe} onChange={(e) => set({ nameDe: e.currentTarget.value })} lang="de" />
            <TextInput label={t('levels.hours')} maxLength={SL.hours} value={x.hours} onChange={(e) => set({ hours: e.currentTarget.value })} />
            <TextInput
              label={t('levels.firstResponse')}
              placeholder={t('levels.firstResponsePlaceholder')}
              maxLength={SL.firstResponse}
              value={x.firstResponse}
              onChange={(e) => set({ firstResponse: e.currentTarget.value })}
            />
          </SimpleGrid>
          <Textarea
            label={t('levels.note')}
            autosize
            minRows={2}
            maxLength={SL.levelNote}
            value={x.note}
            onChange={(e) => set({ note: e.currentTarget.value })}
          />
          <TextInput
            label={t('levels.slaUrl')}
            description={t('levels.slaUrlHint')}
            placeholder="https://…"
            maxLength={SL.url}
            value={x.slaUrl}
            onChange={(e) => set({ slaUrl: e.currentTarget.value })}
            error={v.error('slaUrl')}
          />
          <FormButtons busy={busy} testId="support-level-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

function RemoveInUse({ level, others, onClose, onRemoved }: { level: SupportLevel; others: SupportLevel[]; onClose: () => void; onRemoved: () => void }) {
  const { t, i18n } = useTranslation(['support', 'common']);
  const [target, setTarget] = useState<string>('');
  const [busy, run] = useBusy();
  const remove = () =>
    run(async () => {
      const q = target ? `?replaceWith=${encodeURIComponent(target)}` : '?clear=1';
      await del(`/support/levels/${encodeURIComponent(level.id)}${q}`);
      onRemoved();
    });
  return (
    <FormModal onClose={onClose} title={t('levels.removeInUseTitle', { name: level.nameEn })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <Stack gap="sm">
          <Text size="sm">{t('levels.removeInUse', { count: level.usage })}</Text>
          <Select
            label={t('levels.replaceWith')}
            data={[{ value: '', label: t('levels.replaceNone') }, ...others.map((o) => ({ value: o.id, label: levelName(o, i18n.language) }))]}
            value={target}
            onChange={(v) => setTarget(v ?? '')}
            allowDeselect={false}
            data-testid="support-level-replace"
          />
          <FormButtons busy={busy} submit={t('levels.removeButton')} testId="support-level-remove" />
        </Stack>
      </form>
    </FormModal>
  );
}
