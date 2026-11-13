import { useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEye, IconLink, IconLinkOff, IconTableShortcut } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataPort, DataPortRecordingPreview, PeekedMessage, PlatformRecording } from '@sm/shared';
import { del, get, notifyError, post } from '../../../api';
import { QueryState } from '../../../components/common';
import { confirmDanger } from '../../../components/confirm';
import { FormModal } from '../../../components/FormModal';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate } from '../../../format';
import { dpKeys, usePlatforms } from '../api';
import { CardTable } from '../parts';
import { usePortPreview } from './api';

const enc = encodeURIComponent;

/**
 * Previews (ADR 0037 part 6): what a port carries without reading a platform – the examples of the bound data contract
 * and recorded responses linked to the port, masked – and the Kafka peek on topic elements (the platform's rules:
 * its managers only, off unless it allows it, at most 5 messages of 4 KB, masked, audited without values). Steward
 * reads no rows from Snowflake or SQL databases (ADR 0036, metadata only).
 */
export function PortPreviewButton({ productId, port, environment }: { productId: string; port: DataPort; environment: string }) {
  const { t } = useTranslation('dataProductSemantic');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="compact-sm"
        variant="subtle"
        leftSection={<IconTableShortcut size={14} />}
        onClick={() => setOpen(true)}
        aria-label={t('preview.buttonNamed', { name: port.name })}
        data-testid="port-preview"
      >
        {t('preview.button')}
      </Button>
      {open && <PortPreviewModal productId={productId} port={port} environment={environment} onClose={() => setOpen(false)} />}
    </>
  );
}

function PortPreviewModal({ productId, port, environment, onClose }: { productId: string; port: DataPort; environment: string; onClose: () => void }) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const q = usePortPreview(productId, port.id, environment);
  const qc = useQueryClient();
  const [linking, setLinking] = useState(false);
  const v = q.data;
  const unlink = async (r: DataPortRecordingPreview) => {
    const name = `${r.method} ${r.path}`;
    if (!(await confirmDanger({ action: 'remove', message: t('preview.unlinkConfirm', { name }) }))) return;
    try {
      await del(`/data-products/${enc(productId)}/ports/${enc(port.id)}/recordings/${enc(r.recordingId)}`);
      void qc.invalidateQueries({ queryKey: dpKeys.all });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Modal opened onClose={onClose} size="xl" title={t('preview.title', { name: `${port.name}${port.version ? ` ${port.version}` : ''}` })}>
      <Stack gap="md" data-testid="port-preview-modal">
        <Text size="sm" c="dimmed">
          {t('preview.help')}
        </Text>
        {!v ? (
          <QueryState query={q} />
        ) : (
          <>
            <Stack gap="xs" data-testid="port-preview-examples">
              {v.examples ? (
                <>
                  <Text fw={600} size="sm">
                    {t('preview.examples', { contract: v.examples.contract.name, version: v.examples.version })}
                  </Text>
                  {v.examples.objects.every((o) => !o.properties.length) && (
                    <Text size="sm" c="dimmed">
                      {t('preview.noExamples')}
                    </Text>
                  )}
                  {v.examples.objects
                    .filter((o) => o.properties.length)
                    .map((o) => (
                      <CardTable
                        key={o.name}
                        rows={o.properties}
                        rowKey={(x) => x.name}
                        ariaLabel={t('preview.object', { name: o.name })}
                        columns={[
                          {
                            key: 'name',
                            header: t('preview.property'),
                            cell: (x) => (
                              <Group gap={4} wrap="wrap">
                                <Text size="sm" className="mono">
                                  {x.name}
                                </Text>
                                {x.personal && (
                                  <Badge size="xs" color="orange" variant="light" tt="none">
                                    {t('preview.personal')}
                                  </Badge>
                                )}
                              </Group>
                            ),
                          },
                          { key: 'type', header: t('preview.type'), nowrap: true, cell: (x) => x.logicalType ?? '–' },
                          {
                            key: 'values',
                            header: t('preview.values'),
                            cell: (x) => (
                              <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                                {x.examples.join(' · ')}
                              </Text>
                            ),
                          },
                        ]}
                      />
                    ))}
                  {v.examples.more > 0 && (
                    <Text size="sm" c="dimmed">
                      {t('preview.moreExamples', { count: v.examples.more })}
                    </Text>
                  )}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {v.hiddenContract ? t('preview.hiddenContract') : t('preview.noContract', { environment: v.environment || environment || '–' })}
                </Text>
              )}
            </Stack>
            <Stack gap="xs" data-testid="port-preview-recordings">
              <Group justify="space-between" gap="xs" wrap="wrap">
                <Text fw={600} size="sm">
                  {t('preview.recordings')}
                </Text>
                {v.mayLink && (
                  <Button
                    size="compact-sm"
                    variant="default"
                    leftSection={<IconLink size={14} />}
                    onClick={() => setLinking(true)}
                    data-testid="port-recording-link"
                  >
                    {t('preview.link')}
                  </Button>
                )}
              </Group>
              {v.recordings.length > 0 && (
                <Text size="xs" c="dimmed">
                  {t('preview.masked')}
                </Text>
              )}
              {v.recordings.map((r) => (
                <Paper key={r.recordingId} withBorder p="xs" data-testid="port-recording">
                  <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
                    <Stack gap={2} style={{ minWidth: 0 }}>
                      <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {r.method} {r.path} → {r.status} · {r.platform.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {[r.note, t('preview.added', { by: r.addedBy, date: fmtDate(r.addedAt) })].filter(Boolean).join(' · ')}
                      </Text>
                    </Stack>
                    {v.mayLink && (
                      <Tooltip label={t('preview.unlinkNamed', { name: `${r.method} ${r.path}` })}>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label={t('preview.unlinkNamed', { name: `${r.method} ${r.path}` })}
                          onClick={() => void unlink(r)}
                        >
                          <IconLinkOff size={16} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                  <Box
                    component="pre"
                    className="mono"
                    tabIndex={0}
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, margin: 0, maxHeight: 280, overflow: 'auto' }}
                  >
                    {r.body}
                    {r.truncated ? ` … (${t('preview.truncated')})` : ''}
                  </Box>
                </Paper>
              ))}
              {!v.recordings.length && (
                <Text size="sm" c="dimmed">
                  {t('preview.noRecordings')}
                </Text>
              )}
              {v.hiddenRecordings > 0 && (
                <Text size="sm" c="dimmed" fs="italic">
                  {t('preview.hiddenRecordings', { count: v.hiddenRecordings })}
                </Text>
              )}
            </Stack>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
        </Group>
      </Stack>
      {linking && (
        <LinkRecordingForm
          productId={productId}
          portId={port.id}
          onClose={() => setLinking(false)}
          onSaved={() => {
            setLinking(false);
            void qc.invalidateQueries({ queryKey: dpKeys.all });
          }}
        />
      )}
    </Modal>
  );
}

/** Link a recorded response of a platform the person may use. */
function LinkRecordingForm({ productId, portId, onClose, onSaved }: { productId: string; portId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const platforms = usePlatforms();
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, run] = useBusy();
  const recordings = useQuery({
    queryKey: [...dpKeys.all, 'semantic', 'recordings', platformId],
    queryFn: () => get<PlatformRecording[]>(`/platforms/${enc(platformId!)}/recordings`),
    enabled: !!platformId,
  });
  const usable = (platforms.data ?? []).filter((x) => x.permissions.includes('use'));
  const save = () =>
    run(async () => {
      await post(`/data-products/${enc(productId)}/ports/${enc(portId)}/recordings`, { recordingId, note: note.trim() });
      onSaved();
    });
  return (
    <FormModal onClose={onClose} title={t('preview.link')} dirty={!!recordingId || !!note}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (recordingId) void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('preview.platform')}
            data={usable.map((x) => ({ value: x.id, label: x.name }))}
            value={platformId}
            onChange={(x) => {
              setPlatformId(x);
              setRecordingId(null);
            }}
            searchable
            required
            data-testid="port-recording-platform"
          />
          {platformId && recordings.data && !recordings.data.length && (
            <Text size="sm" c="dimmed">
              {t('preview.noPlatformRecordings')}
            </Text>
          )}
          <Select
            label={t('preview.recording')}
            data={(recordings.data ?? []).map((r) => ({ value: r.id, label: `${r.method} ${r.path} → ${r.status}${r.note ? ` · ${r.note}` : ''}` }))}
            value={recordingId}
            onChange={setRecordingId}
            disabled={!platformId}
            searchable
            required
            data-testid="port-recording-select"
          />
          <TextInput label={t('preview.linkNote')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} />
          <FormButtons busy={busy} submit={t('preview.link')} testId="port-recording-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The eye of a `kafka.topic` element: the peek with the element's masking (session only, audited). */
export function PeekButton({ elementId, name }: { elementId: string; name: string }) {
  const { t } = useTranslation('dataProductSemantic');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip label={t('peek.named', { name })}>
        <ActionIcon variant="subtle" size="sm" aria-label={t('peek.named', { name })} onClick={() => setOpen(true)} data-testid="element-peek">
          <IconEye size={16} />
        </ActionIcon>
      </Tooltip>
      {open && <PeekModal elementId={elementId} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function PeekModal({ elementId, name, onClose }: { elementId: string; name: string; onClose: () => void }) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const [messages, setMessages] = useState<PeekedMessage[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    try {
      setMessages((await post<{ messages: PeekedMessage[] }>(`/data-elements/${enc(elementId)}/peek`, { count: 5 })).messages);
      setError(null);
    } catch (e) {
      setError(e);
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="xl" title={t('peek.title', { name })}>
      <Stack gap="sm" data-testid="element-peek-modal">
        <Alert color="yellow">{t('peek.note')}</Alert>
        {messages?.length === 0 && <Text c="dimmed">{t('peek.empty')}</Text>}
        {messages?.map((m) => (
          <Box key={`${m.partition}:${m.offset}`} data-testid="element-peek-message">
            <Text size="xs" c="dimmed">
              {t('peek.line', { partition: m.partition, offset: m.offset, date: m.timestamp ? fmtDate(m.timestamp) : '–', key: m.key ?? '–' })}
              {m.truncated ? ` · ${t('peek.truncated')}` : ''}
            </Text>
            <Box component="pre" className="mono" tabIndex={0} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, margin: 0 }}>
              {m.value}
            </Box>
          </Box>
        ))}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
          <Button onClick={() => void read()} loading={busy} data-testid="element-peek-read" color={error ? 'gray' : undefined}>
            {messages ? t('peek.again') : t('peek.read')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
