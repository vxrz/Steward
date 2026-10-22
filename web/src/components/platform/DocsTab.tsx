import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Anchor,
  Button,
  Collapse,
  FileButton,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconFile, IconLink, IconNote, IconTrash, IconUpload } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { Platform, PlatformDoc } from '@sm/shared';
import { api, del, get, notifyError, notifyOk, post } from '../../api';
import { Markdown } from '../common';
import { fmtBytes, fmtDate } from '../../format';

const fmtSize = (n?: number): string => (n ? fmtBytes(n) : '');

export function DocsTab({ platform, readOnly = false }: { platform: Platform; readOnly?: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ['platform', platform.id, 'docs'], queryFn: () => get<PlatformDoc[]>(`/platforms/${platform.id}/docs`) });
  const [kind, setKind] = useState<'note' | 'link' | 'file'>('note');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<PlatformDoc | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['platform', platform.id, 'docs'] });

  const canAdd = kind === 'note' ? !!title.trim() && !!content.trim() : kind === 'link' ? /^https?:\/\//i.test(url) : !!file;

  const add = async () => {
    setBusy(true);
    try {
      if (kind === 'file' && file) {
        const fd = new FormData();
        fd.append('title', title || file.name);
        fd.append('file', file);
        await api('POST', `/platforms/${platform.id}/docs`, fd);
      } else if (kind === 'link') {
        await post(`/platforms/${platform.id}/docs`, { title: title || url, kind: 'link', url });
      } else {
        await post(`/platforms/${platform.id}/docs`, { title, kind: 'note', content });
      }
      notifyOk(t('docs.added'));
      setTitle('');
      setContent('');
      setUrl('');
      setFile(null);
      await refresh();
    } catch (e) {
      notifyError(e, t('docs.notAdded'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: PlatformDoc) => {
    try {
      await del(`/platforms/${platform.id}/docs/${d.id}`);
      await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setRemoving(null);
    }
  };

  const Icon = ({ k }: { k: PlatformDoc['kind'] }) => (k === 'note' ? <IconNote size={18} /> : k === 'link' ? <IconLink size={18} /> : <IconFile size={18} />);

  return (
    <Stack>
      {!readOnly && (
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          {t('docs.addTitle')}
        </Title>
        <Stack>
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as 'note' | 'link' | 'file')}
            data={[
              { value: 'note', label: t('docs.kinds.note') },
              { value: 'link', label: t('docs.kinds.link') },
              { value: 'file', label: t('docs.kinds.file') },
            ]}
          />
          <TextInput label={t('docs.title')} required={kind === 'note'} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          {kind === 'note' && (
            <Textarea
              label={t('docs.note')}
              autosize
              minRows={4}
              placeholder={t('docs.notePlaceholder')}
              value={content}
              onChange={(e) => setContent(e.currentTarget.value)}
            />
          )}
          {kind === 'link' && <TextInput label={t('docs.url')} placeholder="https://…" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />}
          {kind === 'file' && (
            <Group>
              <FileButton onChange={setFile}>
                {(props) => (
                  <Button {...props} variant="light" leftSection={<IconUpload size={16} />}>
                    {t('docs.chooseFile')}
                  </Button>
                )}
              </FileButton>
              <Text size="sm" c="dimmed">
                {file ? `${file.name} (${fmtSize(file.size)})` : t('docs.fileHint')}
              </Text>
            </Group>
          )}
          <Group justify="flex-end">
            <Button onClick={add} loading={busy} disabled={!canAdd}>
              {t('common:add')}
            </Button>
          </Group>
        </Stack>
      </Paper>
      )}

      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          {t('docs.listTitle')}
        </Title>
        {docs.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('docs.none')}
          </Text>
        )}
        <Stack gap="xs">
          {docs.data?.map((d) => (
            <Paper key={d.id} withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Icon k={d.kind} />
                  <div style={{ minWidth: 0 }}>
                    {d.kind === 'note' && (
                      <Anchor size="sm" fw={500} onClick={() => setExpanded({ ...expanded, [d.id]: !expanded[d.id] })}>
                        {d.title}
                      </Anchor>
                    )}
                    {d.kind === 'link' && (
                      <Anchor size="sm" fw={500} href={/^https?:\/\//i.test(d.url ?? "") ? d.url : undefined} target="_blank" rel="noreferrer">
                        {d.title}
                      </Anchor>
                    )}
                    {d.kind === 'file' && (
                      <Anchor size="sm" fw={500} href={`/api/docs/${d.id}/file`} target="_blank">
                        {d.title}
                      </Anchor>
                    )}
                    <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                      {d.kind === 'link' ? d.url : d.kind === 'file' ? `${d.filename} · ${fmtSize(d.size)}` : t('docs.kinds.note')} · {fmtDate(d.createdAt)}
                    </Text>
                  </div>
                </Group>
                <Tooltip label={t('common:delete')}>
                  {!readOnly && <ActionIcon variant="subtle" color="red" onClick={() => setRemoving(d)} aria-label={t('common:delete')}>
                    <IconTrash size={16} />
                  </ActionIcon>}
                </Tooltip>
              </Group>
              {d.kind === 'note' && (
                <Collapse in={!!expanded[d.id]}>
                  <Paper mt="sm" p="sm" bg="var(--mantine-color-default-hover)">
                    <Markdown text={d.content} />
                  </Paper>
                </Collapse>
              )}
            </Paper>
          ))}
        </Stack>
      </Paper>

      <Modal opened={!!removing} onClose={() => setRemoving(null)} title={t('docs.deleteTitle')}>
        <Text size="sm">
          <Trans t={t} i18nKey="docs.deleteText" values={{ name: removing?.title ?? '' }} components={{ b: <strong /> }} />
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRemoving(null)}>
            {t('common:cancel')}
          </Button>
          <Button color="red" onClick={() => removing && remove(removing)}>
            {t('common:delete')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
