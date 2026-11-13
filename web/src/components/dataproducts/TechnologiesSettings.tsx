import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Select, SimpleGrid, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_TECHNOLOGY_ICONS,
  DATA_TECHNOLOGY_KEY_RE,
  DATA_TECHNOLOGY_LIMITS as TL,
  DATA_TECHNOLOGY_ROLES,
  type DataTechnology,
  type DataTechnologyIcon,
  type DataTechnologyRole,
} from '@sm/shared';
import { del, notifyError, put } from '../../api';
import { useMe } from '../../auth';
import { DataTable } from '../DataTable';
import { FormModal } from '../FormModal';
import { QueryState, useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { genericKeys, useTechnologies } from '../../pages/dataproducts/generic';
import { FormButtons, useBusy } from './form';
import { TECHNOLOGY_ICON } from './technologyIcons';

const enc = encodeURIComponent;

/**
 * The technology list of parts and bridges (0.25.0, ADR 0037 part 0) under Settings → Catalogue → Data products: the
 * built-in entries and those administrators add – a name, a role (part, bridge or both), an icon and an optional
 * OpenLineage namespace pattern. Every reader of the module sees it; only administrators change it, and the built-in
 * entries stay as they are. A technology typed on an element or a runner that is in neither stays and shows as _not in
 * the list_.
 */
export function TechnologiesSettings() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const { isAdmin } = useMe();
  const list = useTechnologies();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ tech?: DataTechnology } | null>(null);
  const changed = () => void qc.invalidateQueries({ queryKey: genericKeys.technologies });
  const remove = async (x: DataTechnology) => {
    if (!(await confirmDanger({ action: 'delete', message: t('technologies.deleteConfirm', { name: x.name }) }))) return;
    try {
      await del(`/data-products/technologies/${enc(x.key)}`);
      changed();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <div data-testid="data-technologies">
      <Group justify="space-between" align="flex-end" mb={4} wrap="wrap" gap="xs">
        <div>
          <Text size="sm" fw={500}>
            {t('technologies.title')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('technologies.hint')}
          </Text>
        </div>
        {isAdmin && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="technology-add">
            {t('technologies.add')}
          </Button>
        )}
      </Group>
      <QueryState query={list} />
      {list.data && (
        <DataTable
          testId="technology-table"
          ariaLabel={t('technologies.title')}
          rows={list.data}
          rowKey={(x) => x.key}
          rowProps={(x) => ({ 'data-testid': `technology-${x.key}` })}
          card={(x) => (
            <Group gap="xs" justify="space-between" wrap="nowrap" data-testid={`technology-${x.key}`}>
              <TechName x={x} />
              <Text size="xs" c="dimmed">
                {t(`technologies.roles.${x.role}`)}
              </Text>
              {isAdmin && !x.builtIn && <RowActions x={x} onEdit={() => setEditing({ tech: x })} onRemove={() => void remove(x)} />}
            </Group>
          )}
          columns={[
            { key: 'name', header: t('technologies.name'), cell: (x) => <TechName x={x} /> },
            { key: 'role', header: t('technologies.role'), nowrap: true, cell: (x) => t(`technologies.roles.${x.role}`) },
            {
              key: 'pattern',
              header: t('technologies.pattern'),
              cell: (x) => (
                <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {x.olNamespacePattern ?? '–'}
                </Text>
              ),
            },
            {
              key: 'origin',
              header: t('technologies.origin'),
              nowrap: true,
              cell: (x) => (
                <Badge size="xs" variant="light" color={x.builtIn ? 'gray' : 'blue'} tt="none">
                  {x.builtIn ? t('technologies.builtIn') : t('technologies.own')}
                </Badge>
              ),
            },
            ...(isAdmin
              ? [
                  {
                    key: 'actions',
                    header: t('table.actions'),
                    cell: (x: DataTechnology) =>
                      !x.builtIn ? <RowActions x={x} onEdit={() => setEditing({ tech: x })} onRemove={() => void remove(x)} /> : null,
                  },
                ]
              : []),
          ]}
        />
      )}
      {editing && (
        <TechnologyForm
          tech={editing.tech}
          keys={(list.data ?? []).map((x) => x.key)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            changed();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TechName({ x }: { x: DataTechnology }) {
  const I = TECHNOLOGY_ICON[x.icon] ?? TECHNOLOGY_ICON.other;
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
      <I size={16} aria-hidden style={{ flexShrink: 0 }} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {x.name}
        </Text>
        <Text size="xs" c="dimmed" className="mono">
          {x.key}
        </Text>
      </Stack>
    </Group>
  );
}

function RowActions({ x, onEdit, onRemove }: { x: DataTechnology; onEdit: () => void; onRemove: () => void }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Group gap={2} wrap="nowrap">
      <Tooltip label={t('technologies.edit')}>
        <ActionIcon variant="subtle" color="gray" aria-label={t('technologies.editNamed', { name: x.name })} onClick={onEdit}>
          <IconPencil size={14} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('technologies.delete')}>
        <ActionIcon variant="subtle" color="red" aria-label={t('technologies.deleteNamed', { name: x.name })} onClick={onRemove}>
          <IconTrash size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function TechnologyForm({ tech, keys, onClose, onSaved }: { tech?: DataTechnology; keys: string[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const [key, setKey] = useState(tech?.key ?? '');
  const [name, setName] = useState(tech?.name ?? '');
  const [role, setRole] = useState<DataTechnologyRole>(tech?.role ?? 'part');
  const [icon, setIcon] = useState<DataTechnologyIcon>(tech?.icon ?? 'other');
  const [pattern, setPattern] = useState(tech?.olNamespacePattern ?? '');
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    key: !tech && (!DATA_TECHNOLOGY_KEY_RE.test(key.trim()) ? t('technologies.keyInvalid') : keys.includes(key.trim()) && t('technologies.keyTaken')),
    name: !name.trim() && t('common:validation.required'),
  });
  const save = () =>
    run(async () => {
      await put(`/data-products/technologies/${enc(tech?.key ?? key.trim())}`, { name: name.trim(), role, icon, olNamespacePattern: pattern.trim() || null });
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} title={tech ? t('technologies.editTitle', { name: tech.name }) : t('technologies.newTitle')}>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('technologies.name')}
              required
              maxLength={TL.name}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
              data-testid="technology-name"
            />
            <TextInput
              label={t('technologies.key')}
              description={t('technologies.keyHint')}
              required
              maxLength={TL.key}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
              error={v.error('key')}
              disabled={!!tech}
              className="mono"
              data-testid="technology-key"
            />
            <Select
              label={t('technologies.role')}
              data={DATA_TECHNOLOGY_ROLES.map((r) => ({ value: r, label: t(`technologies.roles.${r}`) }))}
              value={role}
              onChange={(r) => r && setRole(r as DataTechnologyRole)}
              allowDeselect={false}
              data-testid="technology-role"
            />
            <Select
              label={t('technologies.icon')}
              data={DATA_TECHNOLOGY_ICONS.map((i) => ({ value: i, label: t(`technologies.icons.${i}`) }))}
              value={icon}
              onChange={(i) => i && setIcon(i as DataTechnologyIcon)}
              allowDeselect={false}
              renderOption={({ option }) => {
                const I = TECHNOLOGY_ICON[option.value as DataTechnologyIcon];
                return (
                  <Group gap={6} wrap="nowrap">
                    <I size={14} aria-hidden />
                    {option.label}
                  </Group>
                );
              }}
            />
          </SimpleGrid>
          <TextInput
            label={t('technologies.pattern')}
            description={t('technologies.patternHint')}
            maxLength={TL.pattern}
            value={pattern}
            onChange={(e) => setPattern(e.currentTarget.value)}
            className="mono"
            data-testid="technology-pattern"
          />
          <FormButtons busy={busy} testId="technology-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
