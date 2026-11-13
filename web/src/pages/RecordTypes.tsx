import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconLink, IconPlus, IconTrash } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RECORD_FIELD_KINDS, RECORD_WORKFLOW_KEYS, RECORD_WORKFLOWS, type RecordFieldDef, type RecordType, type RecordsMeta } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { PageHeader } from '../components/common';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { LibraryOriginBadge } from '../components/libraries/parts';
import { useRecordTypes, useTypeName } from '../components/records/common';
import { fieldLabel, typeDescription } from '../components/records/builtin';
import { TableColumnsEditor } from '../components/records/TableField';
import { DataTable, type DataColumn } from '../components/DataTable';

/** Record types (administrators): number prefix, name, workflow, template and fields. */
export function RecordTypesPage() {
  const { t } = useTranslation(['records', 'common']);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const types = useRecordTypes(true);
  const typeName = useTypeName();
  const [editing, setEditing] = useState<RecordType | 'new' | null>(null);
  // the page's heading and the way back stay: the reason is no dead end
  if (meta.data && !meta.data.canManageTypes)
    return (
      <>
        <PageHeader back="records" title={t('types.title')} />
        <Alert color="orange">{t('types.adminOnly')}</Alert>
      </>
    );
  const nameBadges = (x: RecordType) => (
    <>
      <GitOriginBadge kind="recordType" id={x.id} size="xs" /> <LibraryOriginBadge kind="recordType" id={x.id} size="xs" />
      {x.archived && (
        <Badge ml={6} size="xs" variant="outline" color="gray">
          {t('types.archived')}
        </Badge>
      )}
    </>
  );
  const editButton = (x: RecordType) => (
    <ActionIcon variant="subtle" aria-label={t('types.editNamed', { name: typeName(x) })} onClick={() => setEditing(x)}>
      <IconEdit size={16} />
    </ActionIcon>
  );
  const columns: DataColumn<RecordType>[] = [
    { key: 'key', header: t('types.key'), sortValue: (x) => x.key, tdProps: () => ({ className: 'mono' }), cell: (x) => x.key },
    {
      key: 'name',
      header: t('types.name'),
      sortValue: (x) => typeName(x),
      cell: (x) => (
        <>
          {typeName(x)} {nameBadges(x)}
          <Text size="xs" c="dimmed" lineClamp={2}>
            {typeDescription(x)}
          </Text>
        </>
      ),
    },
    {
      key: 'workflow',
      header: t('types.workflow'),
      sortValue: (x) => t(`types.workflows.${x.workflow}`),
      cell: (x) => (
        <>
          {t(`types.workflows.${x.workflow}`)}
          {x.workflow === 'document' && (
            <Text size="xs" c="dimmed">
              {x.reviewIntervalMonths ? t('types.reviewEvery', { count: x.reviewIntervalMonths }) : t('types.reviewNone')}
            </Text>
          )}
        </>
      ),
    },
    { key: 'fields', header: t('types.fields'), sortValue: (x) => x.fields.length, cell: (x) => x.fields.map((f) => fieldLabel(x.key, f)).join(', ') || '–' },
    { key: 'records', header: t('types.recordCount'), sortValue: (x) => x.recordCount, cell: (x) => x.recordCount },
    { key: 'actions', header: <VisuallyHidden>{t('types.actions')}</VisuallyHidden>, label: t('types.actions'), cell: editButton },
  ];

  return (
    <>
      <PageHeader
        back="records"
        title={t('types.title')}
        description={t('types.description')}
        actions={
          <>
            <Button size="xs" variant="default" leftSection={<IconLink size={14} />} component={Link} to="/records/link-types">
              {t('links.manageTypes')}
            </Button>
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
              {t('types.new')}
            </Button>
          </>
        }
      />
      <DataTable
        rows={types.data ?? []}
        columns={columns}
        rowKey={(x) => x.id}
        ariaLabel={t('types.title')}
        rowProps={(x) => ({ 'data-inactive': x.archived || undefined })}
        testId="record-type-list"
        rememberSort="record-types"
        defaultSort={{ key: 'key', dir: 'asc' }}
        card={(x) => (
          <Paper withBorder p="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600}>
                  <span className="mono">{x.key}</span> {typeName(x)}
                </Text>
                {nameBadges(x)}
              </div>
              {editButton(x)}
            </Group>
            <Text size="xs" c="dimmed" lineClamp={2}>
              {typeDescription(x)}
            </Text>
            <Text size="xs" mt={4}>
              {t(`types.workflows.${x.workflow}`)} · {t('types.recordCount')}: {x.recordCount}
            </Text>
          </Paper>
        )}
      />
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
  const [reviewMonths, setReviewMonths] = useState<number | ''>(type?.reviewIntervalMonths ?? 12);
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
        ...(workflow === 'document' ? { reviewIntervalMonths: reviewMonths === '' ? 12 : reviewMonths } : {}),
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
          {type?.builtin && (
            <Text size="xs" c="dimmed">
              {t('types.builtinHint')}
            </Text>
          )}
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              label={t('types.key')}
              description={locked ? t('types.keyLocked') : t('types.keyHelp')}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value.toUpperCase())}
              disabled={locked}
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
          {workflow === 'document' && (
            <NumberInput
              label={t('types.reviewInterval')}
              description={t('types.reviewIntervalHelp')}
              min={0}
              max={120}
              allowDecimal={false}
              value={reviewMonths}
              onChange={(v) => setReviewMonths(typeof v === 'number' ? v : '')}
              w={{ base: '100%', xs: 260 }}
            />
          )}
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
              {f.kind === 'table' && <TableColumnsEditor columns={f.columns ?? []} onChange={(columns) => updateField(i, { columns })} />}
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
