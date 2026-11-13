import { isPlantHidden } from '@sm/shared';
import { useState } from 'react';
import { Anchor, Badge, Box, Button, FileButton, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconCircleCheck, IconFileUpload, IconLink, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DOCUMENT_TYPE_ID,
  PLANT_SOURCE_TYPE_ID,
  type LinkTarget,
  type PlantDocGroup,
  type PlantDocConfirmation,
  type PlantDocItem,
  type PlantDocKind,
  type PlantDocReview,
  type PlantDocuments,
  type RecordDetail,
  type RecordType,
} from '@sm/shared';
import { api, get, notifyError, notifyOk, post } from '../../api';
import { fmtDay } from '../../format';
import { QueryState, useFieldErrors } from '../common';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { useRemoteSelect } from '../remoteSelect';
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
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 0.14 "Still current": a document listed here, or (`asset`) the asset's documentation as a whole */
  const confirm = async (what: 'record' | 'asset', target: string) => {
    setConfirming(`${what}:${target}`);
    try {
      const next = await post<PlantDocuments>(
        '/plant/documents/confirm',
        what === 'asset' ? { kind: 'asset', id: target } : { kind: 'record', id: target, entry: { kind, id } },
      );
      qc.setQueryData(docsKey(kind, id), next);
      void qc.invalidateQueries({ queryKey: ['plant', 'documentation'] });
      notifyOk(t('current.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setConfirming(null);
    }
  };
  const confirmOf = d?.canConfirm ? { onConfirm: (recordId: string) => void confirm('record', recordId), busy: confirming } : undefined;
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
  const actions = d?.canCreate && (
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
  );
  const inheritedCount = d?.inherited.reduce((n, g) => n + g.documents.length + g.hidden, 0) ?? 0;
  // a section of the page like the others (docs/reviews/UX-REVIEW.md "v0.12.0: collapsible content"): open; the inherited part folds once it is long
  return (
    <CollapsibleSection
      id={titleId}
      testId="plant-documents"
      title={t('title')}
      size="h4"
      count={d ? d.own.documents.length + d.own.hidden + inheritedCount : undefined}
      actions={actions || undefined}
      defaultOpen
    >
      <Stack gap="xs">
        {!d ? (
          <QueryState query={q} rows={2} />
        ) : (
          <>
            {d.documentation && (
              <Group justify="space-between" gap="xs" wrap="wrap" data-testid="plant-docs-whole">
                <Stack gap={0}>
                  <Text size="sm" fw={600}>
                    {t('current.whole')}
                  </Text>
                  <ConfirmationLine confirmation={d.documentation.confirmation} review={d.documentation.review} />
                </Stack>
                {d.canConfirm && (
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconCircleCheck size={14} />}
                    loading={confirming === `asset:${id}`}
                    onClick={() => void confirm('asset', id)}
                    data-testid="plant-docs-confirm-whole"
                  >
                    {t('current.wholeButton')}
                  </Button>
                )}
              </Group>
            )}
            <DocGroup group={d.own} labelledBy={`${titleId}-title`} empty={t('empty')} confirm={confirmOf} />
            {d.inherited.length > 0 && (
              <CollapsibleSection
                id={`${titleId}-inherited`}
                testId="plant-docs-inherited"
                order={3}
                size="h6"
                title={t('inheritedTitle')}
                description={t('inheritedHelp')}
                count={inheritedCount}
                defaultOpen={inheritedCount <= 10}
              >
                <Stack gap="xs">
                  {d.inherited.map((g) => (
                    <InheritedGroup key={`${g.from!.kind}:${g.from!.id}`} group={g} within={kind} confirm={confirmOf} />
                  ))}
                </Stack>
              </CollapsibleSection>
            )}
          </>
        )}
      </Stack>
      {creating && <NewDocumentModal kind={kind} id={id} label={d?.label ?? id} onClose={() => setCreating(false)} />}
      {linking && <LinkExistingModal kind={kind} id={id} label={d?.label ?? id} onClose={() => setLinking(false)} onLinked={refresh} />}
    </CollapsibleSection>
  );
}

/** "From base profile …", "From profile …", "From data collection …", "From sink …" */
type ConfirmProps = { onConfirm: (recordId: string) => void; busy: string | null } | undefined;

/**
 * "Last confirmed by X on date" (or not confirmed yet) and, when an interval applies, a gentle hint: never red, never an
 * alert – plant documents live for decades.
 */
function ConfirmationLine({ confirmation, review }: { confirmation: PlantDocConfirmation | null; review: PlantDocReview | null }) {
  const { t } = useTranslation('plantDocs');
  return (
    <Group gap={6} wrap="wrap">
      <Text size="xs" c="dimmed" data-testid="plant-docs-confirmed">
        {confirmation ? t('current.confirmedBy', { user: confirmation.by, date: fmtDay(confirmation.at) }) : t('current.never')}
      </Text>
      {review?.due && (
        <Badge size="xs" variant="light" color="blue" tt="none" data-testid="plant-docs-due" title={t('current.dueHelp', { months: review.months })}>
          {t('current.due')}
        </Badge>
      )}
      {review && !review.due && (
        <Text size="xs" c="dimmed">
          {t('current.next', { date: fmtDay(review.dueAt) })}
        </Text>
      )}
    </Group>
  );
}

function InheritedGroup({ group, within, confirm }: { group: PlantDocGroup; within: PlantDocKind; confirm?: ConfirmProps }) {
  const { t } = useTranslation(['plantDocs', 'plant']);
  const from = group.from!;
  // 0.21.0 (#293): files follow the profile – one the reader may not see is not named, its documents are counted
  const hidden = isPlantHidden(from.label);
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
        ) : hidden ? (
          t('plant:catalogueAccess.hiddenProfile')
        ) : (
          from.label
        )}
        {from.kind === 'device-profile' && !hidden && (
          <Text span size="xs" c="dimmed" className="mono">
            {' '}
            ({from.id})
          </Text>
        )}
      </Text>
      <DocGroup group={group} labelledBy={id} readOnly confirm={confirm} />
    </Stack>
  );
}

function DocGroup({
  group,
  labelledBy,
  empty,
  readOnly,
  confirm,
}: {
  group: PlantDocGroup;
  labelledBy: string;
  empty?: string;
  readOnly?: boolean;
  confirm?: ConfirmProps;
}) {
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
                <Table.Th>{t('current.column')}</Table.Th>
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
                  <Table.Td data-testid={`plant-docs-current-${x.id}`}>
                    <Stack gap={2} align="flex-start">
                      <ConfirmationLine confirmation={x.confirmation} review={x.review} />
                      {confirm && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          leftSection={<IconCircleCheck size={12} />}
                          loading={confirm.busy === `record:${x.id}`}
                          onClick={() => confirm.onConfirm(x.id)}
                          aria-label={t('current.buttonFor', { title: x.title })}
                        >
                          {t('current.button')}
                        </Button>
                      )}
                    </Stack>
                  </Table.Td>
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
  const [record, setRecord] = useState<string | null>(null);
  const pick = useRemoteSelect({ value: record });
  const [busy, setBusy] = useState(false);
  const targets = useQuery({
    queryKey: ['link-targets', 'record', pick.term],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=record&q=${encodeURIComponent(pick.term)}`),
    placeholderData: keepPreviousData,
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
            searchValue={pick.search}
            onSearchChange={pick.setSearch}
            filter={({ options }) => options}
            data={pick.options((targets.data ?? []).map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label })))}
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
