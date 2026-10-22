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
import { CONNECTOR_FORMATS, type ConnectorPackage, type Platform, type PlatformPreset } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { Hint, KeyValueEditor, PageHeader } from '../components/common';

export const AUTH_LABELS: Record<string, string> = {
  none: 'No auth',
  basic: 'Basic auth',
  bearer: 'Bearer token',
  apiKey: 'API key',
  oauth2_client_credentials: 'OAuth2 client credentials',
  token_request: 'Custom login',
};

export const KIND_COLORS: Record<string, string> = {
  'insights-hub': 'teal',
  'industrial-edge-management': 'indigo',
  generic: 'gray',
};

export function PlatformsPage() {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const { caps } = useMe();

  return (
    <>
      <PageHeader
        title="Platforms"
        description="Systems you manage – e.g. an Insights Hub tenant or an Industrial Edge Management instance – with their base URL, credentials, API specifications and documentation."
        actions={
          <>
            <Button variant="default" leftSection={<IconPlug size={16} />} onClick={() => setTypesOpen(true)}>
              Connector types
            </Button>
            {caps.createPlatforms && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                Add platform
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
            <Text fw={600}>No platforms yet</Text>
            <Text size="sm" c="dimmed" ta="center" maw={520}>
              A platform is one instance of a system you administer, for example your production Insights Hub tenant or an
              on-premise Industrial Edge Management. It stores the base URL, how to authenticate, encrypted credentials, API
              specifications (OpenAPI) and documentation. Processes then pick a platform for each connection when they run.
            </Text>
            {caps.createPlatforms ? (
              <Button mt="sm" leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                Add your first platform
              </Button>
            ) : (
              <Text size="sm" c="dimmed">
                Only administrators can add platforms.
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
                {AUTH_LABELS[p.config.auth?.type ?? 'none'] ?? p.config.auth?.type}
              </Badge>
            </Group>
            <Text size="xs" c="dimmed" className="mono" mt="sm" style={{ wordBreak: 'break-all' }}>
              {p.baseUrl || 'no base URL'}
            </Text>
            <Group gap={4} mt="xs">
              <IconKey size={14} />
              <Text size="xs" c="dimmed">
                {p.secretKeys.length} stored secret{p.secretKeys.length === 1 ? '' : 's'}
              </Text>
              {p.acl.length > 0 && (
                <Badge size="xs" variant="light" color="orange" ml="auto">
                  restricted
                </Badge>
              )}
              {!p.permissions.includes('use') && (
                <Badge size="xs" variant="light" color="gray" ml={p.acl.length ? undefined : 'auto'}>
                  no access
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
    if (!(CONNECTOR_FORMATS as readonly string[]).includes(pkg?.format)) throw new Error('Not a Steward connector file');
    await post('/platform-types/import', { package: pkg });
    notifyOk(`Connector type "${pkg.label}" imported`);
    return pkg.kind;
  } catch (e) {
    notifyError(e, 'Import failed');
    return null;
  }
}

function ConnectorTypesModal({ opened, onClose, canManage }: { opened: boolean; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['platform-presets'], queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const custom = (presets.data ?? []).filter((p) => p.custom);
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-presets'] });
  return (
    <Modal opened={opened} onClose={onClose} title="Connector types" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          A connector type is a reusable template for a kind of system: authentication, variables, HTTP options, which credentials are
          needed, documentation links and API specifications – never credential values. Create one from a configured platform
          (platform page → menu → “Save as connector type”), export it as a file and import it on another installation. New platforms of
          that type get its API specifications automatically.
        </Text>
        {canManage && (
          <Group>
            <FileButton accept=".json,application/json" onChange={(f) => f && importConnector(f).then(() => refresh())}>
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                  Import connector file
                </Button>
              )}
            </FileButton>
          </Group>
        )}
        {custom.length === 0 ? (
          <Text size="sm" c="dimmed">
            No custom connector types yet. Built-in presets: {(presets.data ?? []).filter((p) => !p.custom).map((p) => p.label).join(', ')}.
          </Text>
        ) : (
          <div className="table-scroll">
            <Table fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Connector</Table.Th>
                  <Table.Th>Kind</Table.Th>
                  <Table.Th>Specs</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {custom.map((t) => (
                  <Table.Tr key={t.kind}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {t.label}
                      </Text>
                      <Text size="xs" c="dimmed" lineClamp={2}>
                        {t.description}
                      </Text>
                    </Table.Td>
                    <Table.Td className="mono">{t.kind}</Table.Td>
                    <Table.Td>{t.specCount ?? 0}</Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap" justify="flex-end">
                        <Tooltip label="Export as file">
                          <ActionIcon component="a" href={`/api/platform-types/${encodeURIComponent(t.kind)}/export`} variant="subtle" aria-label="Export">
                            <IconDownload size={16} />
                          </ActionIcon>
                        </Tooltip>
                        {canManage && (
                          <Tooltip label="Delete connector type (existing platforms are not affected)">
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              aria-label="Delete"
                              onClick={async () => {
                                if (!confirm(`Delete connector type "${t.label}"? Existing platforms keep working.`)) return;
                                await del(`/platform-types/${encodeURIComponent(t.kind)}`).catch(notifyError);
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
        description: preset.description,
        baseUrl,
        config: { ...preset.config, variables: vars },
        secrets: filtered,
        typeKind: preset.custom ? preset.kind : undefined,
      });
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      notifyOk(`Platform "${p.name}" created`);
      onClose();
      onCreated(p.id);
    } catch (e) {
      notifyError(e, 'Platform not created');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={preset ? `New platform – ${preset.label}` : 'Add platform – choose a starting point'} size="lg">
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
                      custom
                    </Badge>
                  )}
                  {!!p.specCount && (
                    <Badge size="xs" variant="outline">
                      {p.specCount} API spec{p.specCount === 1 ? '' : 's'}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed" mt={4}>
                  {p.description}
                </Text>
              </Paper>
            </UnstyledButton>
          ))}
          <Group justify="space-between" wrap="wrap">
            <Hint>Everything can be changed later – presets only pre-fill authentication and URLs.</Hint>
            <FileButton
              accept=".json,application/json"
              onChange={(f) =>
                f &&
                importConnector(f).then(async (kind) => {
                  if (!kind) return;
                  const list = (await presets.refetch()).data ?? [];
                  const t = list.find((x) => x.custom && x.kind === kind);
                  if (t) choose(t);
                })
              }
            >
              {(props) => (
                <Button {...props} size="xs" variant="subtle" leftSection={<IconUpload size={14} />}>
                  Import connector file
                </Button>
              )}
            </FileButton>
          </Group>
        </Stack>
      )}
      {preset && (
        <Stack>
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="e.g. Insights Hub – Production" />
          <TextInput
            label="Environment"
            value={environment}
            onChange={(e) => setEnvironment(e.currentTarget.value)}
            placeholder="prod, test, dev…"
          />
          <TextInput
            label="Base URL"
            classNames={{ input: 'mono' }}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            description="May contain templates like {{ vars.region }}"
          />
          <div>
            <Text size="sm" fw={500} mb={4}>
              Variables
            </Text>
            <KeyValueEditor value={variables} onChange={(v) => setVariables(v ?? {})} />
          </div>
          {preset.secretFields.length > 0 && (
            <>
              <Divider label="Credentials (encrypted at rest)" labelPosition="left" />
              {preset.secretFields.map((f) => (
                <PasswordInput
                  key={f.key}
                  label={f.label}
                  description={f.help ?? `Stored as secret "${f.key}"`}
                  value={secrets[f.key] ?? ''}
                  onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
                />
              ))}
              <Hint>Leave fields empty that you don't need. You can add or replace credentials later.</Hint>
            </>
          )}
          <Group justify="space-between">
            <Button variant="subtle" onClick={() => setPreset(null)}>
              Back
            </Button>
            <Group>
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={create} loading={busy} disabled={!name.trim()}>
                Create platform
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
