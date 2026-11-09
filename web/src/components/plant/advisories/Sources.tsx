import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Modal, NumberInput, Paper, Stack, Switch, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ADVISORY_LIMITS, type AdvisoryFetchResult, type AdvisorySource } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../../api';
import { fmtDate, fmtRelative } from '../../../format';
import { plantKeys } from '../../../queryKeys';
import { confirmDanger } from '../../confirm';

/**
 * The advisory sources (0.14, administrators): CSAF providers, aggregators and ROLIE feeds – none by default. Each is
 * read on its own schedule (or with "Read now") through the outbound policy.
 */
export function AdvisorySourcesModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: plantKeys.advisorySources, queryFn: () => get<AdvisorySource[]>('/plant/advisory-sources') });
  const [editing, setEditing] = useState<AdvisorySource | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: plantKeys.advisorySources });
    void qc.invalidateQueries({ queryKey: ['plant', 'advisories'] });
  };
  const fetchNow = async (s: AdvisorySource) => {
    setBusy(s.id);
    try {
      const r = await post<AdvisoryFetchResult>(`/plant/advisory-sources/${encodeURIComponent(s.id)}/fetch`, {});
      (r.failed.length ? notifyError : notifyOk)(
        r.failed.length
          ? `${t('sources.fetched', { name: s.name, created: r.created, updated: r.updated, failed: r.failed.length })}: ${r.failed[0]!.error}`
          : t('sources.fetched', { name: s.name, created: r.created, updated: r.updated, failed: 0 }),
      );
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (s: AdvisorySource) => {
    if (!(await confirmDanger({ action: 'remove', message: t('sources.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/plant/advisory-sources/${encodeURIComponent(s.id)}`);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('sources.title')} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('sources.intro')}
        </Text>
        {list.data?.length === 0 && <Text size="sm">{t('sources.none')}</Text>}
        {(list.data ?? []).map((s) => (
          <Paper key={s.id} withBorder p="sm" data-testid="advisory-source">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Group gap="xs" wrap="wrap">
                  <Text fw={500}>{s.name}</Text>
                  <Badge size="xs" variant="default">
                    {t(`sources.kind.${s.kind}`)}
                  </Badge>
                  {!s.enabled && (
                    <Badge size="xs" color="gray">
                      {t('sources.off')}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {s.url}
                </Text>
                <Text size="xs">
                  {s.lastRunAt ? <span title={fmtDate(s.lastRunAt)}>{t('sources.lastRun', { when: fmtRelative(s.lastRunAt) })}</span> : t('sources.never')} ·{' '}
                  {t('sources.advisories', { count: s.advisories })}
                </Text>
                {s.lastError && (
                  <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>
                    {s.lastError}
                  </Text>
                )}
              </Stack>
              <Group gap={4} wrap="nowrap">
                <Tooltip label={t('sources.fetch')}>
                  <ActionIcon variant="subtle" aria-label={t('sources.fetch')} loading={busy === s.id} onClick={() => void fetchNow(s)}>
                    <IconDownload size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('sources.edit')}>
                  <ActionIcon variant="subtle" aria-label={t('sources.edit')} onClick={() => setEditing(s)}>
                    <IconEdit size={16} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={t('sources.delete')}>
                  <ActionIcon variant="subtle" color="red" aria-label={t('sources.delete')} onClick={() => void remove(s)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          </Paper>
        ))}
        <Group>
          <Button leftSection={<IconPlus size={16} aria-hidden />} variant="default" onClick={() => setEditing('new')} data-testid="advisory-source-add">
            {t('sources.add')}
          </Button>
        </Group>
      </Stack>
      {editing && (
        <SourceForm
          source={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </Modal>
  );
}

function SourceForm({ source, onClose, onSaved }: { source: AdvisorySource | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const [name, setName] = useState(source?.name ?? '');
  const [url, setUrl] = useState(source?.url ?? '');
  const [enabled, setEnabled] = useState(source?.enabled ?? false);
  const [interval, setInterval] = useState<number>(source?.intervalHours ?? 24);
  const [publishers, setPublishers] = useState((source?.publishers ?? []).join('\n'));
  const [since, setSince] = useState(source?.since ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const body = {
      name: name.trim(),
      url: url.trim(),
      enabled,
      intervalHours: interval,
      publishers: publishers
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      since: since || null,
    };
    try {
      if (source) await put(`/plant/advisory-sources/${encodeURIComponent(source.id)}`, body);
      else await post('/plant/advisory-sources', body);
      onSaved();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={source ? t('sources.edit') : t('sources.add')}>
      <Stack>
        <TextInput label={t('sources.name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={120} data-autofocus />
        <TextInput
          label={t('sources.url')}
          description={t('sources.urlHint')}
          required
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          maxLength={2000}
        />
        <Switch label={t('sources.enabled')} checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
        <NumberInput label={t('sources.interval')} min={1} max={168} value={interval} onChange={(v) => setInterval(Number(v) || 24)} />
        <Textarea
          label={t('sources.publishers')}
          description={t('sources.publishersHint', { max: ADVISORY_LIMITS.providersPerAggregator })}
          value={publishers}
          onChange={(e) => setPublishers(e.currentTarget.value)}
          autosize
          minRows={1}
        />
        <TextInput type="date" label={t('sources.since')} value={since} onChange={(e) => setSince(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim() || !url.trim()}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
