import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Badge,
  Button,
  FileButton,
  Table,
  Tooltip,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  PasswordInput,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconPlus, IconServer, IconKey, IconPlug, IconUpload, IconDownload, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CONNECTOR_FORMATS, type ConnectorPackage, type Platform, type PlatformPreset } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, apiUrl } from '../api';
import { useMe } from '../auth';
import { Hint, KeyValueEditor, PageHeader } from '../components/common';
import { authLabel, presetDescription, presetSecretHelp, presetSecretLabel } from '../components/platform/presetText';
import i18n from '../i18n';
import { BRAND } from '../../../shared/src/brand';

export const KIND_COLORS: Record<string, string> = {
  'insights-hub': 'teal',
  'industrial-edge-management': 'indigo',
  generic: 'gray',
};

export function PlatformsPage() {
  const { t } = useTranslation('platforms');
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const { caps } = useMe();

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button variant="default" leftSection={<IconPlug size={16} />} onClick={() => setTypesOpen(true)}>
              {t('types.button')}
            </Button>
            {caps.createPlatforms && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                {t('add')}
              </Button>
            )}
          </>
        }
      />
      {platforms.isLoading && (
        <Center p="xl">
          <Loader />
        </Center>
      )}
      {platforms.data && platforms.data.length === 0 && (
        <Paper withBorder p="xl">
          <Stack align="center" gap="xs">
            <IconServer size={40} stroke={1.3} />
            <Text fw={600}>{t('empty.title')}</Text>
            <Text size="sm" c="dimmed" ta="center" maw={520}>
              {t('empty.text')}
            </Text>
            {caps.createPlatforms ? (
              <Button mt="sm" leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                {t('empty.addFirst')}
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                {t('empty.adminsOnly')}
              </Text>
            )}
          </Stack>
        </Paper>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
        {platforms.data?.map((p) => (
          <Card key={p.id} withBorder padding="md" className="clickable" onClick={() => navigate(`/platforms/${p.id}`)}>
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Text fw={600} lineClamp={1}>
                {p.name}
              </Text>
              {p.environment && (
                <Badge variant="outline" size="sm">
                  {p.environment}
                </Badge>
              )}
            </Group>
            <Group gap={6} mt={6}>
              <Badge color={KIND_COLORS[p.kind] ?? 'gray'} variant="light" size="sm">
                {p.kind}
              </Badge>
              <Badge color="gray" variant="light" size="sm">
                {authLabel(p.config.auth?.type)}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed" className="mono" mt="sm" style={{ wordBreak: 'break-all' }}>
              {p.baseUrl || t('card.noBaseUrl')}
            </Text>
            <Group gap={4} mt="xs">
              <IconKey size={14} />
              <Text size="xs" c="dimmed">
                {t('card.secrets', { count: p.secretKeys.length })}
              </Text>
              {p.acl.length > 0 && (
                <Badge size="xs" variant="light" color="orange" ml="auto">
                  {t('card.restricted')}
                </Badge>
              )}
              {!p.permissions.includes('use') && (
                <Badge size="xs" variant="light" color="gray" ml={p.acl.length ? undefined : 'auto'}>
                  {t('card.noAccess')}
                </Badge>
              )}
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      <AddPlatformModal opened={adding} onClose={() => setAdding(false)} onCreated={(id) => navigate(`/platforms/${id}`)} />
      <ConnectorTypesModal opened={typesOpen} onClose={() => setTypesOpen(false)} canManage={caps.createPlatforms} />
    </>
  );
}

/** Read a connector package JSON file and import it. */
/** Returns the kind of the imported connector type. */
async function importConnector(file: File): Promise<string | null> {
  try {
    const pkg = JSON.parse(await file.text()) as ConnectorPackage;
    if (!(CONNECTOR_FORMATS as readonly string[]).includes(pkg?.format)) throw new Error(i18n.t('platforms:types.notAConnector', { brand: BRAND.name }));
    await post('/platform-types/import', { package: pkg });
    notifyOk(i18n.t('platforms:types.imported', { name: pkg.label }));
    return pkg.kind;
  } catch (e) {
    notifyError(e, i18n.t('platforms:types.importFailed'));
    return null;
  }
}

function ConnectorTypesModal({ opened, onClose, canManage }: { opened: boolean; onClose: () => void; canManage: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['platform-presets'], queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const custom = (presets.data ?? []).filter((p) => p.custom);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-presets'] });
  return (
    <Modal opened={opened} onClose={onClose} title={t('types.title')} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('types.hint')}
        </Text>
        {canManage && (
          <Group>
            <FileButton accept=".json,application/json" onChange={(f) => f && importConnector(f).then(() => refresh())}>
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                  {t('types.import')}
                </Button>
              )}
            </FileButton>
          </Group>
        )}
        {custom.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('types.none', { presets: (presets.data ?? []).filter((p) => !p.custom).map((p) => p.label).join(', ') })}
          </Text>
        ) : (
          <div className="table-scroll">
            <Table fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('types.connector')}</Table.Th>
                  <Table.Th>{t('types.kind')}</Table.Th>
                  <Table.Th>{t('types.specs')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {custom.map((ct) => (
                  <Table.Tr key={ct.kind}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {ct.label}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {ct.description}
                      </Text>
                    </Table.Td>
                    <Table.Td className="mono">{ct.kind}</Table.Td>
                    <Table.Td>{ct.specCount ?? 0}</Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap" justify="flex-end">
                        <Tooltip label={t('types.exportFile')}>
                          <ActionIcon component="a" href={apiUrl(`/platform-types/${encodeURIComponent(ct.kind)}/export`)} variant="subtle" aria-label={t('types.export')}>
                            <IconDownload size={16} />
                          </ActionIcon>
                        </Tooltip>
                        {canManage && (
                          <Tooltip label={t('types.deleteHint')}>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label={t('common:delete')}
                              onClick={async () => {
                                if (!confirm(t('types.deleteConfirm', { name: ct.label }))) return;
                                await del(`/platform-types/${encodeURIComponent(ct.kind)}`).catch(notifyError);
                                refresh();
                              }}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Stack>
    </Modal>
  );
}

function AddPlatformModal({ opened, onClose, onCreated }: { opened: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['platform-presets'], queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const [preset, setPreset] = useState<PlatformPreset | null>(null);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) {
      setPreset(null);
      setName('');
      setEnvironment('');
      setSecrets({});
    }
  }, [opened]);

  const choose = (p: PlatformPreset) => {
    setPreset(p);
    setBaseUrl(p.baseUrl);
    setVariables({ ...p.config.variables });
    setSecrets({});
  };

  const create = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      const vars = Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
      const filtered = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
      const p = await post<Platform>('/platforms', {
        name,
        kind: preset.kind,
        environment,
        description: presetDescription(preset),
        baseUrl,
        config: { ...preset.config, variables: vars },
        secrets: filtered,
        typeKind: preset.custom ? preset.kind : undefined,
      });
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk(t('addModal.created', { name: p.name }));
      onClose();
      onCreated(p.id);
    } catch (e) {
      notifyError(e, t('addModal.notCreated'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={preset ? t('addModal.titlePreset', { preset: preset.label }) : t('addModal.title')} size="lg">
      {!preset && (
        <Stack gap="xs">
          {presets.isLoading && <Loader />}
          {presets.data?.map((p, i) => (
            <UnstyledButton key={i} onClick={() => choose(p)}>
              <Paper withBorder p="sm">
                <Group gap="xs">
                  <Text fw={600}>{p.label}</Text>
                  <Badge size="xs" variant="light" color={KIND_COLORS[p.kind] ?? 'gray'}>
                    {p.kind}
                  </Badge>
                  {p.custom && (
                    <Badge size="xs" variant="filled" color="grape">
                      {t('addModal.custom')}
                    </Badge>
                  )}
                  {!!p.specCount && (
                    <Badge size="xs" variant="outline">
                      {t('addModal.specs', { count: p.specCount })}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed" mt={4}>
                  {presetDescription(p)}
                </Text>
              </Paper>
            </UnstyledButton>
          ))}
          <Group justify="space-between" wrap="wrap">
            <Hint>{t('addModal.hint')}</Hint>
            <FileButton
              accept=".json,application/json"
              onChange={(f) =>
                f &&
                importConnector(f).then(async (kind) => {
                  if (!kind) return;
                  const list = (await presets.refetch()).data ?? [];
                  const found = list.find((x) => x.custom && x.kind === kind);
                  if (found) choose(found);
                })
              }
            >
              {(props) => (
                <Button {...props} size="xs" variant="subtle" leftSection={<IconUpload size={14} />}>
                  {t('types.import')}
                </Button>
              )}
            </FileButton>
          </Group>
        </Stack>
      )}
      {preset && (
        <Stack>
          <TextInput
            label={t('form.name')}
            required
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder={t('form.namePlaceholder')}
          />
          <TextInput
            label={t('form.environment')}
            value={environment}
            onChange={(e) => setEnvironment(e.currentTarget.value)}
            placeholder={t('form.environmentPlaceholder')}
          />
          <TextInput
            label={t('form.baseUrl')}
            classNames={{ input: 'mono' }}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            description={t('form.baseUrlHint', { example: '{{ vars.region }}' })}
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t('form.variables')}
            </Text>
            <KeyValueEditor value={variables} onChange={(v) => setVariables(v ?? {})} />
          </div>
          {preset.secretFields.length > 0 && (
            <>
              <Divider label={t('form.credentials')} labelPosition="left" />
              {preset.secretFields.map((f) => (
                <PasswordInput
                  key={f.key}
                  label={presetSecretLabel(preset, f)}
                  description={presetSecretHelp(preset, f) ?? t('form.storedAs', { key: f.key })}
                  value={secrets[f.key] ?? ''}
                  onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
                />
              ))}
              <Hint>{t('form.credentialsHint')}</Hint>
            </>
          )}
          <Group justify="space-between">
            <Button variant="subtle" onClick={() => setPreset(null)}>
              {t('common:back')}
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                {t('common:cancel')}
              </Button>
              <Button onClick={create} loading={busy} disabled={!name.trim()}>
                {t('addModal.create')}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
