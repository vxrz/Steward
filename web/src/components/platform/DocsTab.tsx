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
import type { Platform, PlatformDoc } from '@sm/shared';
import { api, del, get, notifyError, notifyOk, post } from '../../api';
import { Markdown } from '../common';
import { fmtDate } from '../../format';

function fmtSize(n?: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DocsTab({ platform }: { platform: Platform }) {
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
      notifyOk('Documentation added');
      setTitle('');
      setContent('');
      setUrl('');
      setFile(null);
      await refresh();
    } catch (e) {
      notifyError(e, 'Not added');
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
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Add documentation
        </Title>
        <Stack>
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as 'note' | 'link' | 'file')}
            data={[
              { value: 'note', label: 'Note' },
              { value: 'link', label: 'Link' },
              { value: 'file', label: 'File' },
            ]}
          />
          <TextInput label="Title" required={kind === 'note'} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          {kind === 'note' && (
            <Textarea
              label="Note (markdown)"
              autosize
              minRows={4}
              placeholder="e.g. Runbook: how to rotate service credentials…"
              value={content}
              onChange={(e) => setContent(e.currentTarget.value)}
            />
          )}
          {kind === 'link' && <TextInput label="URL" placeholder="https://…" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />}
          {kind === 'file' && (
            <Group>
              <FileButton onChange={setFile}>
                {(props) => (
                  <Button {...props} variant="light" leftSection={<IconUpload size={16} />}>
                    Choose file
                  </Button>
                )}
              </FileButton>
              <Text size="sm" c="dimmed">
                {file ? `${file.name} (${fmtSize(file.size)})` : 'PDF, Word, text… up to 50 MB'}
              </Text>
            </Group>
          )}
          <Group justify="flex-end">
            <Button onClick={add} loading={busy} disabled={!canAdd}>
              Add
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Documentation
        </Title>
        {docs.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No documentation yet. Keep runbooks, API manuals and useful links next to the platform.
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
                      <Anchor size="sm" fw={500} href={d.url} target="_blank" rel="noreferrer">
                        {d.title}
                      </Anchor>
                    )}
                    {d.kind === 'file' && (
                      <Anchor size="sm" fw={500} href={`/api/docs/${d.id}/file`} target="_blank">
                        {d.title}
                      </Anchor>
                    )}
                    <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
                      {d.kind === 'link' ? d.url : d.kind === 'file' ? `${d.filename} · ${fmtSize(d.size)}` : 'Note'} · {fmtDate(d.createdAt)}
                    </Text>
                  </div>
                </Group>
                <Tooltip label="Delete">
                  <ActionIcon variant="subtle" color="red" onClick={() => setRemoving(d)} aria-label="Delete">
                    <IconTrash size={16} />
                  </ActionIcon>
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

      <Modal opened={!!removing} onClose={() => setRemoving(null)} title="Delete documentation">
        <Text size="sm">
          Delete <strong>{removing?.title}</strong>?
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button color="red" onClick={() => removing && remove(removing)}>
            Delete
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}
