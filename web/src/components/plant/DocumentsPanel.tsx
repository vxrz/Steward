import { useState } from 'react';
import { Anchor, Badge, Box, Button, FileButton, Group, Modal, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconFileUpload, IconLink, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DOCUMENT_TYPE_ID,
  PLANT_SOURCE_TYPE_ID,
  type LinkTarget,
  type PlantDocGroup,
  type PlantDocItem,
  type PlantDocKind,
  type PlantDocuments,
  type RecordDetail,
  type RecordType,
} from '@sm/shared';
import { api, get, notifyError, post } from '../../api';
import { QueryState, useFieldErrors } from '../common';
import { RecordStatusBadge, useRecordTypes, useTypeName } from '../records/common';
import { EditionBadge } from '../records/DocumentPanel';
import { typeTemplate } from '../records/builtin';

/**
 * The Documents panel of a plant page (0.12, docs/PLANT.md "Documents"): the records linked to the site, asset,
 * device profile, data collection or sink – with "New document" (the link already set), "Link existing" and
 * "Upload file" (a new document with the file attached) – and, read-only, the records it inherits: a derived profile
 * its base profiles', an asset its profile chain's and its collections'. Records the reader may not read are counted.
 */

const docsKey = (kind: PlantDocKind, id: string) => ['plant', 'documents', kind, id];

/** Types of living documents people write here: not the generated gateway configurations; DOC first. */
const documentTypes = (list: RecordType[] | undefined) =>
  (list ?? [])
    .filter((x) => x.workflow === 'document' && !x.archived && x.id !== PLANT_SOURCE_TYPE_ID)
    .sort((a, b) => Number(b.id === DOCUMENT_TYPE_ID) - Number(a.id === DOCUMENT_TYPE_ID));

export function PlantDocumentsPanel({ kind, id }: { kind: PlantDocKind; id: string }) {
  const { t } = useTranslation(['plantDocs', 'records', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: docsKey(kind, id), queryFn: () => get<PlantDocuments>(`/plant/documents?kind=${kind}&id=${encodeURIComponent(id)}`) });
  const types = useRecordTypes();
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const d = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['plant', 'documents'] });
  const titleId = `plant-docs-${kind}`;
  /** "Upload file": a new living document named after the file, linked here, with the file attached; then its editor. */
  const upload = async (file: File | null) => {
    if (!file) return;
    const docType = documentTypes(types.data)[0];
    if (!docType) return notifyError(new Error(t('noType')));
    setUploading(true);
    try {
      const r = await post<RecordDetail>('/records', {
        type: docType.key,
        title: file.name.replace(/\.[^.]{1,8}$/, '').slice(0, 300) || file.name,
        body: typeTemplate(docType),
        links: [{ kind, id, note: '' }],
      });
      const fd = new FormData();
      fd.append('file', file);
      await api('POST', `/records/${r.id}/attachments`, fd);
      refresh();
      navigate(`/records/${r.id}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setUploading(false);
    }
  };
  return (
    <Stack gap="xs" data-testid="plant-documents">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={2} fz="h4" id={titleId}>
          {t('title')}
        </Title>
        {d?.canCreate && (
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="plant-docs-new">
              {t('new')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconLink size={14} />} onClick={() => setLinking(true)} data-testid="plant-docs-link">
              {t('linkExisting')}
            </Button>
            <FileButton onChange={(f) => void upload(f)}>
              {(props) => (
                <Button size="xs" variant="default" leftSection={<IconFileUpload size={14} />} loading={uploading} {...props}>
                  {t('upload')}
                </Button>
              )}
            </FileButton>
          </Group>
        )}
      </Group>
      {!d ? (
        <QueryState query={q} rows={2} />
      ) : (
        <>
          <DocGroup group={d.own} labelledBy={titleId} empty={t('empty')} />
          {d.inherited.length > 0 && (
            <Stack gap="xs" data-testid="plant-docs-inherited">
              <Text size="xs" c="dimmed">
                {t('inheritedHelp')}
              </Text>
              {d.inherited.map((g) => (
                <InheritedGroup key={`${g.from!.kind}:${g.from!.id}`} group={g} within={kind} />
              ))}
            </Stack>
          )}
        </>
      )}
      {creating && <NewDocumentModal kind={kind} id={id} label={d?.label ?? id} onClose={() => setCreating(false)} />}
      {linking && <LinkExistingModal kind={kind} id={id} label={d?.label ?? id} onClose={() => setLinking(false)} onLinked={refresh} />}
    </Stack>
  );
}

/** "From base profile …", "From profile …", "From data collection …", "From sink …" */
function InheritedGroup({ group, within }: { group: PlantDocGroup; within: PlantDocKind }) {
  const { t } = useTranslation('plantDocs');
  const from = group.from!;
  const key =
    from.kind === 'device-profile' ? (within === 'device-profile' ? 'fromBase' : 'fromProfile') : from.kind === 'data-sink' ? 'fromSink' : 'fromCollection';
  const id = `plant-docs-from-${from.kind}-${from.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  return (
    <Stack gap={4} data-testid={`plant-docs-from-${from.kind}`}>
      <Text size="sm" fw={600} id={id}>
        {t(key)}{' '}
        {from.path ? (
          <Anchor component={Link} to={from.path} size="sm" fw={600}>
            {from.label}
          </Anchor>
        ) : (
          from.label
        )}
        {from.kind === 'device-profile' && (
          <Text span size="xs" c="dimmed" className="mono">
            {' '}
            ({from.id})
          </Text>
        )}
      </Text>
      <DocGroup group={group} labelledBy={id} readOnly />
    </Stack>
  );
}

function DocGroup({ group, labelledBy, empty, readOnly }: { group: PlantDocGroup; labelledBy: string; empty?: string; readOnly?: boolean }) {
  const { t } = useTranslation(['plantDocs', 'records']);
  const typeName = useTypeName();
  if (!group.documents.length && !group.hidden)
    return empty ? (
      <Text size="sm" c="dimmed">
        {empty}
      </Text>
    ) : null;
  return (
    <Stack gap={4}>
      {group.documents.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={labelledBy}>
          <Table fz="sm" aria-labelledby={labelledBy} data-testid={readOnly ? 'plant-docs-inherited-table' : 'plant-docs-own'}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('document')}</Table.Th>
                <Table.Th>{t('type')}</Table.Th>
                <Table.Th>{t('status')}</Table.Th>
                <Table.Th>{t('edition')}</Table.Th>
                <Table.Th>{t('files')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {group.documents.map((x: PlantDocItem) => (
                <Table.Tr key={x.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    <Text span size="xs" c="dimmed" className="mono nowrap">
                      {x.number}
                    </Text>{' '}
                    <Anchor component={Link} to={`/records/${x.id}`} size="sm">
                      {x.title}
                    </Anchor>
                    {x.generated && (
                      <Badge size="xs" variant="light" color="grape" ml={6} tt="none" title={t('generatedHelp')}>
                        {t('generated')}
                      </Badge>
                    )}
                    {readOnly && (
                      <Badge size="xs" variant="outline" color="gray" ml={6} tt="none">
                        {t('inherited')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">{typeName({ key: x.typeKey, name: x.typeName, builtin: true })}</Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <RecordStatusBadge status={x.status} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {x.edition ? (
                      <Box w="max-content">
                        <EditionBadge edition={x.edition} size="sm" />
                      </Box>
                    ) : (
                      '–'
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">{x.attachments}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {group.hidden > 0 && (
        <Text size="xs" c="dimmed" data-testid="plant-docs-hidden">
          {t('hidden', { count: group.hidden })}
        </Text>
      )}
    </Stack>
  );
}

/** A new living document linked to the entry: the type (when there is more than one) and the title; its editor opens next. */
function NewDocumentModal({ kind, id, label, onClose }: { kind: PlantDocKind; id: string; label: string; onClose: () => void }) {
  const { t } = useTranslation(['plantDocs', 'records', 'common']);
  const types = useRecordTypes();
  const typeName = useTypeName();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const docTypes = documentTypes(types.data);
  const [picked, setPicked] = useState<string | null>(null);
  // the first one (DOC, unless an administrator archived it) is preselected
  const type = picked ?? docTypes[0]?.key ?? null;
  const selected = docTypes.find((x) => x.key === type);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ type: !type && t('common:validation.required'), title: !title.trim() && t('common:validation.required') });
  const submit = async () => {
    if (!v.validate() || !type) return;
    setBusy(true);
    try {
      const r = await post<RecordDetail>('/records', {
        type,
        title: title.trim(),
        ...(selected ? { body: typeTemplate(selected) } : {}),
        links: [{ kind, id, note: '' }],
      });
      void qc.invalidateQueries({ queryKey: ['plant', 'documents'] });
      void qc.invalidateQueries({ queryKey: ['records'] });
      navigate(`/records/${r.id}/edit`);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('newTitle', { name: label })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          {docTypes.length > 1 ? (
            <Select
              label={t('records:create.type')}
              data={docTypes.map((x) => ({ value: x.key, label: `${x.key} – ${typeName(x)}` }))}
              value={type}
              onChange={setPicked}
              allowDeselect={false}
              required
              error={v.error('type')}
            />
          ) : (
            selected && (
              <Text size="sm">
                {t('records:create.type')}: {selected.key} – {typeName(selected)}
              </Text>
            )
          )}
          {types.isSuccess && docTypes.length === 0 && (
            <Text size="sm" c="red">
              {t('noType')}
            </Text>
          )}
          <TextInput
            label={t('records:create.recordTitle')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            required
            maxLength={300}
            data-autofocus
            error={v.error('title')}
          />
          <Text size="xs" c="dimmed">
            {t('linkNote', { name: label })}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={types.isSuccess && docTypes.length === 0}>
              {t('records:create.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** Links a record the reader may change to the entry (the link is the record's: its editors may remove it there). */
function LinkExistingModal({
  kind,
  id,
  label,
  onClose,
  onLinked,
}: {
  kind: PlantDocKind;
  id: string;
  label: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const [record, setRecord] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = useQuery({
    queryKey: ['link-targets', 'record', debounced],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=record&q=${encodeURIComponent(debounced)}`),
  });
  const v = useFieldErrors({ record: !record && t('common:validation.required') });
  const submit = async () => {
    if (!v.validate() || !record) return;
    setBusy(true);
    try {
      await post(`/records/${record}/links`, { kind, id, note: '' });
      onLinked();
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('linkTitle', { name: label })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('record')}
            placeholder={t('search')}
            searchable
            searchValue={q}
            onSearchChange={setQ}
            filter={({ options }) => options}
            data={(targets.data ?? []).map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label }))}
            value={record}
            onChange={setRecord}
            nothingFoundMessage={targets.isFetching ? t('searching') : t('nothingFound')}
            required
            error={v.error('record')}
            data-autofocus
            data-testid="plant-docs-link-record"
          />
          <Text size="xs" c="dimmed">
            {t('linkHelp')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('linkSubmit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
