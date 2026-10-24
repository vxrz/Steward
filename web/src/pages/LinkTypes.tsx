import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Group, Modal, Select, Stack, Switch, Table, Text, TextInput } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { LINK_TYPE_ICONS, LINK_TYPE_KEY_RE, type LinkType, type LinkTypeIcon } from '@sm/shared';
import { notifyError, post, put } from '../api';
import { PageHeader, QueryState, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { LinkTypeIconView, useLinkTypeName, useLinkTypes } from '../components/records/linkTypes';

/** Types of external links: the built-in ones, and the administrators' own (name and icon; renamed and archived, never deleted). */
export function LinkTypesPage() {
  const { t } = useTranslation(['records', 'common']);
  const types = useLinkTypes();
  const typeName = useLinkTypeName();
  const { hasRole } = useMe();
  const isAdmin = hasRole('admin');
  const [editing, setEditing] = useState<LinkType | 'new' | null>(null);
  return (
    <>
      <PageHeader
        back="records"
        title={t('linkTypes.title')}
        description={t('linkTypes.description')}
        actions={
          isAdmin && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
              {t('linkTypes.new')}
            </Button>
          )
        }
      />
      {!isAdmin && (
        <Alert color="gray" variant="light" mb="md">
          {t('linkTypes.adminOnly')}
        </Alert>
      )}
      <QueryState query={types} />
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('linkTypes.title')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('linkTypes.name')}</Table.Th>
              <Table.Th>{t('linkTypes.key')}</Table.Th>
              <Table.Th>{t('linkTypes.origin')}</Table.Th>
              {isAdmin && <Table.Th aria-label={t('linkTypes.actions')} />}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(types.data ?? []).map((x) => (
              <Table.Tr key={x.key} data-inactive={x.archived || undefined}>
                <Table.Td>
                  <Group gap={8} wrap="nowrap">
                    <LinkTypeIconView icon={x.icon} />
                    <span>{typeName(x)}</span>
                    {x.archived && (
                      <Badge size="xs" variant="outline" color="gray">
                        {t('linkTypes.archived')}
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td className="mono">{x.key}</Table.Td>
                <Table.Td>{x.builtin ? t('linkTypes.builtin') : t('linkTypes.own')}</Table.Td>
                {isAdmin && (
                  <Table.Td>
                    {!x.builtin && (
                      <ActionIcon variant="subtle" aria-label={t('linkTypes.editNamed', { name: x.name })} onClick={() => setEditing(x)}>
                        <IconEdit size={16} />
                      </ActionIcon>
                    )}
                  </Table.Td>
                )}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {editing && <LinkTypeModal type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function LinkTypeModal({ type, onClose }: { type: LinkType | null; onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(type?.name ?? '');
  const [key, setKey] = useState('');
  const [icon, setIcon] = useState<LinkTypeIcon>(type?.icon ?? 'link');
  const [archived, setArchived] = useState(type?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    key: !type && key.trim() !== '' && !LINK_TYPE_KEY_RE.test(key.trim()) && t('linkTypes.keyInvalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      if (type) await put(`/link-types/${encodeURIComponent(type.key)}`, { name: name.trim(), icon, archived });
      else await post('/link-types', { name: name.trim(), icon, ...(key.trim() ? { key: key.trim() } : {}) });
      await qc.invalidateQueries({ queryKey: ['link-types'] });
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={type ? t('linkTypes.editNamed', { name: type.name }) : t('linkTypes.new')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('linkTypes.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
            maxLength={60}
            data-autofocus
            error={v.error('name')}
          />
          {type ? (
            <Text size="sm">
              {t('linkTypes.key')}: <span className="mono">{type.key}</span>
            </Text>
          ) : (
            <TextInput
              label={t('linkTypes.key')}
              description={t('linkTypes.keyHelp')}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value.toLowerCase())}
              maxLength={40}
              error={v.error('key')}
            />
          )}
          <Select
            label={t('linkTypes.icon')}
            data={LINK_TYPE_ICONS.map((i) => ({ value: i, label: t(`linkTypes.icons.${i}`) }))}
            value={icon}
            onChange={(x) => x && setIcon(x as LinkTypeIcon)}
            allowDeselect={false}
            leftSection={<LinkTypeIconView icon={icon} />}
            renderOption={({ option }) => (
              <Group gap={8} wrap="nowrap">
                <LinkTypeIconView icon={option.value} />
                <span>{option.label}</span>
              </Group>
            )}
          />
          {type && (
            <Switch
              label={t('linkTypes.archive')}
              description={t('linkTypes.archiveHelp')}
              checked={archived}
              onChange={(e) => setArchived(e.currentTarget.checked)}
            />
          )}
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
