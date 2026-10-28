import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Modal, NumberInput, Paper, Select, Stack, Table, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconPlus, IconPlayerRecord, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { RECORDING_LIMITS, type Platform, type PlatformRecording, type RecordingInput } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { EmptyState, Hint, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { fmtBytes, fmtRelative } from '../../format';

/**
 * Recorded responses of a platform (#105): answers that a test run of a process or monitor uses instead of the
 * platform. Everyone who may use the platform sees them; managers add, change and remove them.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

const queryText = (q: Record<string, string>) => new URLSearchParams(q).toString();

export function RecordingsTab({ platform, readOnly }: { platform: Platform; readOnly: boolean }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['platform-recordings', platform.id],
    queryFn: () => get<PlatformRecording[]>(`/platforms/${platform.id}/recordings`),
  });
  const [editing, setEditing] = useState<PlatformRecording | 'new' | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: ['platform-recordings', platform.id] });
  const remove = async (r: PlatformRecording) => {
    if (!(await confirmDanger({ action: 'remove', message: t('recordings.removeConfirm', { request: `${r.method} ${r.path}` }) }))) return;
    try {
      await del(`/platforms/${platform.id}/recordings/${r.id}`);
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = q.data ?? [];
  return (
    <Stack gap="sm" data-testid="platform-recordings">
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start" wrap="wrap">
          <div style={{ flex: 1, minWidth: 240 }}>
            <Title order={5}>{t('recordings.title')}</Title>
            <Hint>{t('recordings.help')}</Hint>
          </div>
          {!readOnly && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
              {t('recordings.add')}
            </Button>
          )}
        </Group>
      </Paper>
      <QueryState query={q} rows={2} />
      {q.data && !list.length && (
        <EmptyState compact icon={IconPlayerRecord} title={t('recordings.empty')}>
          {t('recordings.emptyHint')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" highlightOnHover aria-label={t('recordings.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('recordings.request')}</Table.Th>
                <Table.Th>{t('recordings.status')}</Table.Th>
                <Table.Th>{t('recordings.size')}</Table.Th>
                <Table.Th>{t('recordings.updated')}</Table.Th>
                {!readOnly && <Table.Th aria-label={t('recordings.actions')} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((r) => {
                const qs = queryText(r.query);
                return (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
                        <Badge size="xs" variant="light" mr={6}>
                          {r.method}
                        </Badge>
                        {r.path}
                        {qs ? `?${qs}` : ''}
                      </Text>
                      {(r.bodyMatch !== null || r.note) && (
                        <Text size="xs" c="dimmed">
                          {[r.bodyMatch !== null ? t('recordings.withBodyMatch') : '', r.note].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={r.status < 300 ? 'green' : r.status < 500 ? 'orange' : 'red'}>
                        HTTP {r.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{fmtBytes(r.size)}</Table.Td>
                    <Table.Td>
                      <Text size="xs">
                        {fmtRelative(r.updatedAt)} · {r.updatedBy}
                      </Text>
                    </Table.Td>
                    {!readOnly && (
                      <Table.Td className="nowrap">
                        <Group gap={0} wrap="nowrap">
                          <ActionIcon variant="subtle" aria-label={t('recordings.edit', { request: `${r.method} ${r.path}` })} onClick={() => setEditing(r)}>
                            <IconEdit size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={t('recordings.remove', { request: `${r.method} ${r.path}` })}
                            onClick={() => void remove(r)}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Group>
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {editing && (
        <RecordingModal
          platform={platform}
          recording={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </Stack>
  );
}

const linesOf = (m: Record<string, string>, sep: string) =>
  Object.entries(m)
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n');

function parseLines(text: string, sep: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const m = sep.exec(l);
    if (!m) out[l] = '';
    else out[l.slice(0, m.index).trim()] = l.slice(m.index + m[0].length).trim();
  }
  return out;
}

const bodyText = (b: unknown) => (b === null || b === undefined ? '' : typeof b === 'string' ? b : JSON.stringify(b, null, 2));
/** JSON when it parses, the text as it is otherwise (an answer that is not JSON). */
function bodyValue(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Add or change a recorded response; `initial` prefills a new one (e.g. from the API explorer). */
export function RecordingModal({
  platform,
  recording,
  initial,
  onClose,
  onSaved,
}: {
  platform: Platform;
  recording: PlatformRecording | null;
  initial?: Partial<RecordingInput>;
  onClose: () => void;
  onSaved: (r: PlatformRecording) => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const src = recording ?? initial ?? {};
  const [method, setMethod] = useState<string>(src.method ?? 'GET');
  const [path, setPath] = useState(src.path ?? '');
  const [query, setQuery] = useState(linesOf(src.query ?? {}, '='));
  const [bodyMatch, setBodyMatch] = useState(src.bodyMatch === null || src.bodyMatch === undefined ? '' : JSON.stringify(src.bodyMatch, null, 2));
  const [status, setStatus] = useState<number>(src.status ?? 200);
  const [headers, setHeaders] = useState(linesOf(src.headers ?? { 'content-type': 'application/json' }, ': '));
  const [body, setBody] = useState(bodyText(src.body));
  const [note, setNote] = useState(src.note ?? '');
  const [busy, setBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);

  const save = async () => {
    let match: unknown = undefined;
    if (bodyMatch.trim()) {
      try {
        match = JSON.parse(bodyMatch);
      } catch {
        setMatchError(t('recordings.bodyMatchInvalid'));
        return;
      }
    }
    setMatchError(null);
    const input: RecordingInput = {
      method: method as RecordingInput['method'],
      path: path.trim(),
      query: parseLines(query, /=/),
      ...(match !== undefined ? { bodyMatch: match } : {}),
      status,
      headers: parseLines(headers, /:\s*/),
      ...(bodyValue(body) !== undefined ? { body: bodyValue(body) } : {}),
      note: note.trim(),
    };
    setBusy(true);
    try {
      const r = recording
        ? await put<PlatformRecording>(`/platforms/${platform.id}/recordings/${recording.id}`, input)
        : await post<PlatformRecording>(`/platforms/${platform.id}/recordings`, input);
      notifyOk(t('recordings.saved'));
      onSaved(r);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} size="lg" title={recording ? t('recordings.editTitle') : t('recordings.addTitle', { name: platform.name })}>
      <Stack gap="sm">
        <Hint>{t('recordings.redactionHint')}</Hint>
        <Group align="flex-end" wrap="nowrap" gap="xs">
          <Select label={t('explorer.method')} data={[...METHODS]} value={method} onChange={(v) => setMethod(v ?? 'GET')} allowDeselect={false} w={110} />
          <TextInput
            label={t('explorer.path')}
            description={t('recordings.pathHint')}
            classNames={{ input: 'mono' }}
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 0 }}
            required
          />
        </Group>
        <Textarea
          label={t('recordings.query')}
          description={t('recordings.queryHint')}
          classNames={{ input: 'mono' }}
          autosize
          minRows={1}
          maxRows={6}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <Textarea
          label={t('recordings.bodyMatch')}
          description={t('recordings.bodyMatchHint')}
          classNames={{ input: 'mono' }}
          autosize
          minRows={1}
          maxRows={8}
          value={bodyMatch}
          onChange={(e) => setBodyMatch(e.currentTarget.value)}
          error={matchError}
        />
        <NumberInput label={t('recordings.status')} min={100} max={599} value={status} onChange={(v) => setStatus(typeof v === 'number' ? v : 200)} w={160} />
        <Textarea
          label={t('recordings.headers')}
          description={t('recordings.headersHint')}
          classNames={{ input: 'mono' }}
          autosize
          minRows={1}
          maxRows={8}
          value={headers}
          onChange={(e) => setHeaders(e.currentTarget.value)}
        />
        <Textarea
          label={t('recordings.body')}
          description={t('recordings.bodyHint', { mb: RECORDING_LIMITS.bodyBytes / 1024 / 1024 })}
          classNames={{ input: 'mono' }}
          autosize
          minRows={4}
          maxRows={16}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <TextInput label={t('recordings.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!path.trim()}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
