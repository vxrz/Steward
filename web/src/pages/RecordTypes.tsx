import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { RECORD_FIELD_KINDS, RECORD_WORKFLOW_KEYS, RECORD_WORKFLOWS, type RecordFieldDef, type RecordType, type RecordsMeta } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { PageHeader } from '../components/common';
import { useRecordTypes, useTypeName } from '../components/records/common';

/** Record types (administrators): number prefix, name, workflow, template and fields. */
export function RecordTypesPage() {
  const { t } = useTranslation(['records', 'common']);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const types = useRecordTypes(true);
  const typeName = useTypeName();
  const [editing, setEditing] = useState<RecordType | 'new' | null>(null);
  if (meta.data && !meta.data.canManageTypes) return <Alert color="orange">{t('types.adminOnly')}</Alert>;
  return (
    <>
      <PageHeader
        title={t('types.title')}
        description={t('types.description')}
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('types.new')}
          </Button>
        }
      />
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('types.title')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('types.key')}</Table.Th>
              <Table.Th>{t('types.name')}</Table.Th>
              <Table.Th>{t('types.workflow')}</Table.Th>
              <Table.Th>{t('types.fields')}</Table.Th>
              <Table.Th>{t('types.recordCount')}</Table.Th>
              <Table.Th aria-label={t('types.actions')} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(types.data ?? []).map((x) => (
              <Table.Tr key={x.id} data-inactive={x.archived || undefined}>
                <Table.Td className="mono">{x.key}</Table.Td>
                <Table.Td>
                  {typeName(x)}
                  {x.archived && (
                    <Badge ml={6} size="xs" variant="outline" color="gray">
                      {t('types.archived')}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {x.description}
                  </Text>
                </Table.Td>
                <Table.Td>{t(`types.workflows.${x.workflow}`)}</Table.Td>
                <Table.Td>{x.fields.map((f) => f.label).join(', ') || '–'}</Table.Td>
                <Table.Td>{x.recordCount}</Table.Td>
                <Table.Td>
                  <ActionIcon variant="subtle" aria-label={t('types.editNamed', { name: x.name })} onClick={() => setEditing(x)}>
                    <IconEdit size={16} />
                  </ActionIcon>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {editing && <TypeModal type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

const emptyField = (): RecordFieldDef => ({ key: '', label: '', kind: 'text' });

function TypeModal({ type, onClose }: { type: RecordType | null; onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const qc = useQueryClient();
  const [key, setKey] = useState(type?.key ?? '');
  const [name, setName] = useState(type?.name ?? '');
  const [description, setDescription] = useState(type?.description ?? '');
  const [workflow, setWorkflow] = useState<string>(type?.workflow ?? 'decision');
  const [template, setTemplate] = useState(type?.template ?? '');
  const [fields, setFields] = useState<RecordFieldDef[]>(type?.fields ?? []);
  const [archived, setArchived] = useState(type?.archived ?? false);
  const [busy, setBusy] = useState(false);
  const locked = !!type && type.recordCount > 0;
  const updateField = (i: number, patch: Partial<RecordFieldDef>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        key: key.trim().toUpperCase(),
        name: name.trim(),
        description: description.trim(),
        workflow,
        template,
        fields: fields.map((f) => ({
          key: f.key.trim(),
          label: f.label.trim(),
          kind: f.kind,
          ...(f.required ? { required: true } : {}),
          ...(f.kind === 'select' ? { options: f.options ?? [] } : {}),
          ...(f.help?.trim() ? { help: f.help.trim() } : {}),
        })),
        archived,
      };
      if (type) await put(`/record-types/${type.id}`, body);
      else await post('/record-types', body);
      void qc.invalidateQueries({ queryKey: ['record-types'] });
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={type ? t('types.edit', { key: type.key }) : t('types.new')} size="xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              label={t('types.key')}
              description={t('types.keyHelp')}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value.toUpperCase())}
              required
              maxLength={10}
              miw={160}
            />
            <TextInput label={t('types.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={80} miw={200} />
          </Group>
          <Textarea
            label={t('types.descriptionLabel')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={2}
            maxLength={1000}
          />
          <Select
            label={t('types.workflow')}
            description={locked ? t('types.workflowLocked') : t(`types.workflowHelp.${workflow as 'change'}`)}
            data={RECORD_WORKFLOW_KEYS.map((w) => ({
              value: w,
              label: `${t(`types.workflows.${w}`)} (${RECORD_WORKFLOWS[w].statuses.map((s) => t(`status.${s as 'draft'}`)).join(' · ')})`,
            }))}
            value={workflow}
            onChange={(v) => v && setWorkflow(v)}
            disabled={locked}
            allowDeselect={false}
          />
          <Textarea
            label={t('types.template')}
            description={t('types.templateHelp')}
            value={template}
            onChange={(e) => setTemplate(e.currentTarget.value)}
            autosize
            minRows={4}
            maxRows={14}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
          />
          <Text fw={600} size="sm">
            {t('types.fields')}
          </Text>
          {fields.map((f, i) => (
            <Paper key={i} withBorder p="xs">
              <Group align="flex-end" gap="xs" wrap="wrap">
                <TextInput
                  size="xs"
                  label={t('types.field.key')}
                  value={f.key}
                  onChange={(e) => updateField(i, { key: e.currentTarget.value })}
                  required
                  className="mono"
                  style={{ flex: '1 1 120px' }}
                />
                <TextInput
                  size="xs"
                  label={t('types.field.label')}
                  value={f.label}
                  onChange={(e) => updateField(i, { label: e.currentTarget.value })}
                  required
                  style={{ flex: '1 1 140px' }}
                />
                <Select
                  size="xs"
                  label={t('types.field.kind')}
                  data={RECORD_FIELD_KINDS.map((k) => ({ value: k, label: t(`types.kinds.${k}`) }))}
                  value={f.kind}
                  onChange={(v) => v && updateField(i, { kind: v as RecordFieldDef['kind'] })}
                  allowDeselect={false}
                  style={{ flex: '1 1 120px' }}
                />
                <Checkbox
                  size="xs"
                  label={t('types.field.required')}
                  checked={!!f.required}
                  onChange={(e) => updateField(i, { required: e.currentTarget.checked })}
                  mb={6}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('types.field.remove', { n: i + 1 })}
                  onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
                  mb={2}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              {f.kind === 'select' && (
                <TagsInput size="xs" mt={6} label={t('types.field.options')} value={f.options ?? []} onChange={(v) => updateField(i, { options: v })} />
              )}
            </Paper>
          ))}
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setFields((fs) => [...fs, emptyField()])} w="fit-content">
            {t('types.field.add')}
          </Button>
          {type && (
            <Switch label={t('types.archive')} description={t('types.archiveHelp')} checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} />
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
