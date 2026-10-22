import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconExternalLink, IconSearch, IconTrash, IconUpload } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { ApiOperation, Platform, PlatformSpec } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../../api';
import { Hint } from '../common';
import { fmtDate } from '../../format';

export const METHOD_COLORS: Record<string, string> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'orange',
  PATCH: 'yellow',
  DELETE: 'red',
  HEAD: 'gray',
};

export function MethodBadge({ method }: { method: string }) {
  return (
    <Badge color={METHOD_COLORS[method] ?? 'gray'} variant="light" size="sm" w={62}>
      {method}
    </Badge>
  );
}

export function SpecsTab({
  platform,
  onPickOperation,
  readOnly = false,
}: {
  platform: Platform;
  onPickOperation: (op: ApiOperation) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const specs = useQuery({ queryKey: ['platform', platform.id, 'specs'], queryFn: () => get<PlatformSpec[]>(`/platforms/${platform.id}/specs`) });
  const ops = useQuery({ queryKey: ['platform', platform.id, 'operations'], queryFn: () => get<ApiOperation[]>(`/platforms/${platform.id}/operations`) });
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PlatformSpec | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['platform', platform.id] });

  const upload = async (fromUrl = false) => {
    setBusy(true);
    try {
      const s = await post<PlatformSpec>(
        `/platforms/${platform.id}/specs`,
        fromUrl ? { name: name || undefined, url: url.trim() } : { name: name || undefined, content },
      );
      notifyOk(t('specs.imported', { count: s.operationCount }), s.name);
      setName('');
      setContent('');
      setUrl('');
      await refresh();
    } catch (e) {
      notifyError(e, t('specs.notImported'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: PlatformSpec) => {
    try {
      await del(`/platforms/${platform.id}/specs/${s.id}`);
      await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setRemoving(null);
    }
  };

  const tags = useMemo(() => [...new Set((ops.data ?? []).map((o) => o.tag).filter(Boolean) as string[])].sort(), [ops.data]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (ops.data ?? []).filter(
      (o) =>
        (!tag || o.tag === tag) &&
        (!q || [o.method, o.path, o.summary, o.operationId, o.tag].some((x) => x?.toLowerCase().includes(q))),
    );
  }, [ops.data, filter, tag]);

  return (
    <Stack>
      {!readOnly && (
      <Paper withBorder p="md">
        <Title order={5}>{t('specs.importTitle')}</Title>
        <Hint>{t('specs.importHint')}</Hint>
        <Stack mt="sm">
          <Group align="flex-end" wrap="wrap">
            <TextInput label={t('specs.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1, minWidth: 180 }} />
            <FileButton
              accept=".json,.yaml,.yml,application/json,text/yaml"
              onChange={(f) => {
                if (!f) return;
                f.text().then((text) => {
                  setContent(text);
                  if (!name) setName(f.name.replace(/\.(json|ya?ml)$/i, ''));
                });
              }}
            >
              {(props) => (
                <Button {...props} variant="light" leftSection={<IconUpload size={16} />}>
                  {t('specs.chooseFile')}
                </Button>
              )}
            </FileButton>
          </Group>
          <Group align="flex-end" wrap="wrap">
            <TextInput
              label={t('specs.fromUrl')}
              placeholder="https://example.com/openapi.json"
              classNames={{ input: 'mono' }}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <Button variant="light" onClick={() => upload(true)} loading={busy} disabled={!/^https?:\/\/\S+$/.test(url.trim())}>
              {t('specs.importUrl')}
            </Button>
          </Group>
          <Textarea
            label={t('specs.paste')}
            classNames={{ input: 'mono' }}
            autosize
            minRows={3}
            maxRows={10}
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button onClick={() => upload(false)} loading={busy} disabled={content.trim().length < 2}>
              {t('specs.import')}
            </Button>
          </Group>
        </Stack>
      </Paper>
      )}

      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          {t('specs.title')}
        </Title>
        {specs.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('specs.none')}
          </Text>
        )}
        {!!specs.data?.length && (
          <div className="table-scroll">
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('common:name')}</Table.Th>
                  <Table.Th>{t('specs.version')}</Table.Th>
                  <Table.Th>{t('specs.format')}</Table.Th>
                  <Table.Th>{t('specs.operations')}</Table.Th>
                  <Table.Th>{t('specs.added')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {specs.data.map((s) => (
                  <Table.Tr key={s.id}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {s.name}
                      </Text>
                      {s.title && s.title !== s.name && (
                        <Text size="xs" c="dimmed">
                          {s.title}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{s.version ?? '–'}</Table.Td>
                    <Table.Td className="nowrap">{s.format}</Table.Td>
                    <Table.Td>{s.operationCount}</Table.Td>
                    <Table.Td className="nowrap">{fmtDate(s.createdAt)}</Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap" justify="flex-end">
                        <Tooltip label={t('specs.viewRaw')}>
                          <ActionIcon component="a" href={`/api/specs/${s.id}/content`} target="_blank" variant="subtle" aria-label={t('specs.viewRaw')}>
                            <IconExternalLink size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t('common:delete')}>
                          {!readOnly && <ActionIcon variant="subtle" color="red" onClick={() => setRemoving(s)} aria-label={t('common:delete')}>
                            <IconTrash size={16} />
                          </ActionIcon>}
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Paper>

      {!!ops.data?.length && (
        <Paper withBorder p="md">
          <Group justify="space-between" mb="sm" wrap="wrap">
            <Title order={5}>{t('specs.operationsCount', { count: filtered.length })}</Title>
            <Group gap="xs" wrap="wrap">
              <TextInput
                size="xs"
                placeholder={t('specs.search')}
                aria-label={t('specs.search')}
                leftSection={<IconSearch size={14} />}
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
              />
              {tags.length > 0 && <Select size="xs" placeholder={t('specs.allTags')} aria-label={t('specs.tag')} data={tags} value={tag} onChange={setTag} clearable searchable />}
            </Group>
          </Group>
          <Hint>{t('specs.clickHint')}</Hint>
          <div className="table-scroll">
            <Table highlightOnHover mt="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('specs.method')}</Table.Th>
                  <Table.Th>{t('specs.path')}</Table.Th>
                  <Table.Th>{t('specs.summary')}</Table.Th>
                  <Table.Th>{t('specs.tag')}</Table.Th>
                  <Table.Th>{t('specs.operationId')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.slice(0, 500).map((o, i) => (
                  <Table.Tr key={`${o.specId}-${i}`} className="clickable" onClick={() => onPickOperation(o)}>
                    <Table.Td>
                      <MethodBadge method={o.method} />
                    </Table.Td>
                    <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                      {o.path}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" lineClamp={2}>
                        {o.summary}
                      </Text>
                    </Table.Td>
                    <Table.Td>{o.tag}</Table.Td>
                    <Table.Td className="mono">{o.operationId}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {filtered.length > 500 && (
            <Text size="xs" c="dimmed" mt="xs">
              {t('specs.truncated', { count: 500 })}
            </Text>
          )}
        </Paper>
      )}

      <Modal opened={!!removing} onClose={() => setRemoving(null)} title={t('specs.deleteTitle')}>
        <Text size="sm">
          <Trans t={t} i18nKey="specs.deleteText" values={{ name: removing?.name ?? '', count: removing?.operationCount ?? 0 }} components={{ b: <strong /> }} />
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
      {ops.data?.length === 0 && specs.data && specs.data.length > 0 && (
        <Text size="sm" c="dimmed">
          {t('specs.noOperations')} <Anchor onClick={() => refresh()}>{t('specs.reload')}</Anchor>
        </Text>
      )}
    </Stack>
  );
}
