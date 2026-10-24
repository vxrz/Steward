import { useState } from 'react';
import { Anchor, Box, Button, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { RecordDetail, RecordsMeta, ServiceDocument } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { useFieldErrors } from '../common';
import { fmtDay } from '../../format';
import { RecordStatusBadge, useRecordTypes, useTypeName } from './common';
import { typeTemplate } from './builtin';
import { EditionBadge, ReviewStatusBadge } from './DocumentPanel';

/**
 * The documentation of a service: the living documents linked to it either way (only those the reader may
 * read – the server leaves out the others), and "New document" with the link to the service already set.
 */
export function ServiceDocumentsPanel({ service, documents }: { service: { id: string; name: string }; documents: ServiceDocument[] }) {
  const { t } = useTranslation(['services', 'records']);
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const [creating, setCreating] = useState(false);
  return (
    <Stack gap="xs" data-testid="service-documents">
      <Group justify="space-between">
        <Text fw={600} id="service-documents-title">
          {t('documents.title')}
        </Text>
        {meta.data?.canCreate && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            {t('documents.new')}
          </Button>
        )}
      </Group>
      {documents.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('documents.empty')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="service-documents-title">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('documents.document')}</Table.Th>
                <Table.Th>{t('documents.edition')}</Table.Th>
                <Table.Th>{t('documents.status')}</Table.Th>
                <Table.Th>{t('documents.review')}</Table.Th>
                <Table.Th>{t('documents.nextReview')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {documents.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    <Text span size="xs" c="dimmed" className="mono nowrap">
                      {d.number}
                    </Text>{' '}
                    <Anchor component={Link} to={`/records/${d.id}`} size="sm">
                      {d.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {d.edition ? (
                      <Box w="max-content">
                        <EditionBadge edition={d.edition} size="sm" />
                      </Box>
                    ) : (
                      <Text span size="sm" c="dimmed">
                        {t('documents.draft')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <RecordStatusBadge status={d.status} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <ReviewStatusBadge status={d.reviewStatus} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">{fmtDay(d.nextReviewAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && <NewServiceDocumentModal service={service} onClose={() => setCreating(false)} />}
    </Stack>
  );
}

/** A new living document for a service: the type (when there is more than one document type) and the title; the editor opens next. */
function NewServiceDocumentModal({ service, onClose }: { service: { id: string; name: string }; onClose: () => void }) {
  const { t } = useTranslation(['services', 'records', 'common']);
  const types = useRecordTypes();
  const typeName = useTypeName();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const docTypes = (types.data ?? []).filter((x) => x.workflow === 'document' && !x.archived);
  const [picked, setPicked] = useState<string | null>(null);
  const type = docTypes.length === 1 ? docTypes[0]!.key : picked;
  const selected = docTypes.find((x) => x.key === type);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ type: !type && t('common:validation.required'), title: !title.trim() && t('common:validation.required') });
  const submit = async () => {
    if (!v.validate() || !type) return;
    setBusy(true);
    try {
      // a built-in type starts with its template in the UI language (the server would use the stored, English one)
      const body = selected && typeTemplate(selected) !== selected.template ? typeTemplate(selected) : undefined;
      const r = await post<RecordDetail>('/records', {
        type,
        title: title.trim(),
        ...(body !== undefined ? { body } : {}),
        links: [{ kind: 'service', id: service.id, note: '' }],
      });
      void qc.invalidateQueries({ queryKey: ['records'] });
      void qc.invalidateQueries({ queryKey: ['service', service.id] });
      navigate(`/records/${r.id}/edit`);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('documents.newTitle', { name: service.name })}>
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
              value={picked}
              onChange={setPicked}
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
              {t('documents.noType')}
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
            {t('documents.linkNote', { name: service.name })}
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
