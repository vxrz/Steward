import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  FileButton,
  Table,
  Tooltip,
  Card,
  Divider,
  Group,
  Loader,
  Modal,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconSearch, IconServer, IconKey, IconPlug, IconUpload, IconDownload, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CONNECTOR_FORMATS,
  DB_DIALECT_INFO,
  dbPort,
  impliedAuthType,
  type AuthType,
  type ConnectorPackage,
  type Platform,
  type PlatformPreset,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, apiUrl } from '../api';
import { useMe } from '../auth';
import { EmptyState, Hint, KeyValueEditor, QueryState, useFieldErrors } from '../components/common';
import { authLabel, presetDescription, presetSecretHelp, presetSecretLabel } from '../components/platform/presetText';
import i18n from '../i18n';
import { BRAND } from '../../../shared/src/brand';
import { EnvironmentInput } from '../components/catalogue/environments';
import { confirmDanger } from '../components/confirm';
import { fmtDate, fmtRelative } from '../format';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { platformKeys } from '../queryKeys';
import { AddPlatformWizard } from '../components/platform/AddPlatformWizard';
import { TableScroll } from '../components/TableScroll';

export const KIND_COLORS: Record<string, string> = {
  'insights-hub': 'teal',
  'industrial-edge-management': 'indigo',
  generic: 'gray',
};

/** The latest connection test as a status dot and words: "Last test OK 5 minutes ago" / "Last test failed …". */
function LastTest({ test, compact }: { test?: Platform['lastTest']; compact?: boolean }) {
  const { t } = useTranslation('platforms');
  if (test === undefined) return null;
  const color = !test ? 'var(--mantine-color-gray-5)' : test.ok ? 'var(--mantine-color-green-6)' : 'var(--mantine-color-red-6)';
  return (
    <Group gap={6} mt={compact ? 0 : 'xs'} wrap="nowrap" data-testid="platform-last-test">
      {test && !test.ok ? (
        <IconAlertTriangle size={14} color={color} aria-hidden style={{ flexShrink: 0 }} />
      ) : (
        <Box w={10} h={10} style={{ borderRadius: 10, background: color, flexShrink: 0, margin: 2 }} aria-hidden />
      )}
      <Text size="xs" c={test && !test.ok ? 'red' : 'dimmed'} title={test ? fmtDate(test.at) : undefined}>
        {!test
          ? t('card.neverTested')
          : test.ok
            ? t('card.lastTestOk', { when: fmtRelative(test.at) })
            : t('card.lastTestFailed', { when: fmtRelative(test.at) })}
      </Text>
    </Group>
  );
}

/** Base URL, or host, port and database of a database platform (0.7.0), which has no base URL. */
const addressOf = (p: Platform) => (p.config.database ? `${p.config.database.host}:${dbPort(p.config.database)}/${p.config.database.database}` : p.baseUrl);
/** The kind of sign-in in normal case ("Bearer token", "OAuth2 client credentials"), or the database dialect. */
const authTextOf = (p: Platform) => (p.config.database ? DB_DIALECT_INFO[p.config.database.dialect].label : authLabel(p.config.auth?.type));

/** A platform as a card: the phone list and the card view. */
function PlatformCard({ p }: { p: Platform }) {
  const { t } = useTranslation('platforms');
  const navigate = useNavigate();
  return (
    <Card withBorder padding="md" className="clickable" onClick={() => navigate(`/platforms/${p.id}`)}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Anchor
          component={Link}
          to={`/platforms/${p.id}`}
          fw={600}
          lineClamp={1}
          c="var(--mantine-color-text)"
          underline="hover"
          onClick={(e) => e.stopPropagation()}
        >
          {p.name}
        </Anchor>
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
        <Badge color="gray" variant="light" size="sm" tt="none">
          {authTextOf(p)}
        </Badge>
      </Group>
      <LastTest test={p.lastTest} />
      <Text size="xs" c="dimmed" className="mono" mt="sm" style={{ wordBreak: 'break-all' }}>
        {addressOf(p) || t('card.noBaseUrl')}
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
  );
}

export function PlatformsPage() {
  const { t } = useTranslation(['platforms', 'common']);
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  // the quick form for experts ("Skip the wizard")
  const [quick, setQuick] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const { caps } = useMe();
  // the filters live in the address (?q=, ?kind=, ?env=, ?test=), so a filtered list can be shared
  const [params, setParams] = useSearchParams();
  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const q = params.get('q') ?? '';
  const kind = params.get('kind');
  const env = params.get('env');
  const test = params.get('test');
  const setQ = (v: string) => set('q', v || null);
  const setKind = (v: string | null) => set('kind', v);
  const setEnv = (v: string | null) => set('env', v);
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('platforms', narrow);
  const all = platforms.data ?? [];
  const kinds = [...new Set(all.map((p) => p.kind))].sort();
  const envs = [...new Set(all.map((p) => p.environment).filter(Boolean))].sort();
  const needle = q.trim().toLowerCase();
  const testOf = (p: Platform) => (!p.lastTest ? 'never' : p.lastTest.ok ? 'ok' : 'failed');
  const shown = all.filter(
    (p) =>
      (!kind || p.kind === kind) &&
      (!env || p.environment === env) &&
      (!test || testOf(p) === test) &&
      (!needle || [p.name, p.kind, p.baseUrl, p.description, p.environment].some((x) => x?.toLowerCase().includes(needle))),
  );
  const filtered = !!(needle || kind || env || test);
  const platformColumns: DataColumn<Platform>[] = [
    {
      key: 'name',
      header: t('list.name'),
      sortValue: (p) => p.name,
      cell: (p) => (
        <Stack gap={2}>
          <Anchor component={Link} to={`/platforms/${p.id}`} fw={600} size="sm" onClick={(e) => e.stopPropagation()}>
            {p.name}
          </Anchor>
          <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
            {addressOf(p) || t('card.noBaseUrl')}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'kind',
      header: t('list.kind'),
      sortValue: (p) => p.kind,
      nowrap: true,
      cell: (p) => (
        <Badge color={KIND_COLORS[p.kind] ?? 'gray'} variant="light" size="sm">
          {p.kind}
        </Badge>
      ),
    },
    { key: 'environment', header: t('list.environment'), sortValue: (p) => p.environment, nowrap: true, cell: (p) => p.environment || '–' },
    {
      key: 'auth',
      header: t('list.auth'),
      sortValue: (p) => authTextOf(p),
      cell: (p) => <Text size="xs">{authTextOf(p)}</Text>,
    },
    {
      key: 'lastTest',
      header: t('list.lastTest'),
      sortValue: (p) => (p.lastTest ? `${p.lastTest.ok ? 1 : 0}${p.lastTest.at}` : ''),
      cell: (p) => <LastTest test={p.lastTest} compact />,
    },
    {
      key: 'access',
      header: t('list.access'),
      cell: (p) => (
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="dimmed" className="nowrap">
            {t('card.secrets', { count: p.secretKeys.length })}
          </Text>
          {p.acl.length > 0 && (
            <Badge size="xs" variant="light" color="orange">
              {t('card.restricted')}
            </Badge>
          )}
          {!p.permissions.includes('use') && (
            <Badge size="xs" variant="light" color="gray">
              {t('card.noAccess')}
            </Badge>
          )}
        </Group>
      ),
    },
  ];

  return (
    <ListPage
      activeFilters={[needle, kind, env, test].filter(Boolean).length}
      view="platforms"
      viewState={view}
      title={t('title')}
      description={t('description')}
      actions={
        <>
          <Button size="xs" variant="default" leftSection={<IconPlug size={14} />} onClick={() => setTypesOpen(true)}>
            {t('types.button')}
          </Button>
          {caps.createPlatforms && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
              {t('add')}
            </Button>
          )}
        </>
      }
      filters={
        all.length > 0 && (
          <Group gap="sm" align="flex-end" mb="md" wrap="wrap" role="search" aria-label={t('filter.search')}>
            <TextInput
              size="xs"
              label={t('filter.search')}
              placeholder={t('filter.searchPlaceholder')}
              leftSection={<IconSearch size={14} />}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              w={{ base: '100%', xs: 260 }}
            />
            {kinds.length > 1 && (
              <Select
                size="xs"
                label={t('filter.kind')}
                placeholder={t('filter.all')}
                data={kinds}
                value={kind}
                onChange={setKind}
                clearable
                searchable
                w={{ base: '48%', xs: 200 }}
              />
            )}
            {envs.length > 0 && (
              <Select
                size="xs"
                label={t('filter.environment')}
                placeholder={t('filter.all')}
                data={envs}
                value={env}
                onChange={setEnv}
                clearable
                w={{ base: '48%', xs: 160 }}
              />
            )}
            <Select
              size="xs"
              label={t('filter.lastTest')}
              placeholder={t('filter.all')}
              data={(['ok', 'failed', 'never'] as const).map((x) => ({ value: x, label: t(`filter.test.${x}`) }))}
              value={test}
              onChange={(v) => set('test', v)}
              clearable
              w={{ base: '48%', xs: 180 }}
            />
            {filtered && (
              <Text size="xs" c="dimmed" mb={6} aria-live="polite">
                {t('filter.count', { shown: shown.length, total: all.length })}
              </Text>
            )}
          </Group>
        )
      }
    >
      <QueryState query={platforms} rows={3} />
      {platforms.data && platforms.data.length === 0 && (
        <EmptyState
          icon={IconServer}
          title={t('empty.title')}
          whoCanAct={t('common:whoCanAct.platforms')}
          action={
            caps.createPlatforms && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>
                {t('empty.addFirst')}
              </Button>
            )
          }
        >
          {t('empty.text')}
          {!caps.createPlatforms && <div>{t('empty.adminsOnly')}</div>}
        </EmptyState>
      )}
      {filtered && shown.length === 0 && (
        <EmptyState
          compact
          icon={IconSearch}
          title={t('filter.noMatch')}
          action={
            <Button size="xs" variant="default" onClick={() => setParams({}, { replace: true })}>
              {t('filter.clear')}
            </Button>
          }
        />
      )}
      {shown.length > 0 &&
        (view.cards && !narrow ? (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} role="list" aria-label={t('title')} data-testid="platform-list">
            {shown.map((p) => (
              <div role="listitem" key={p.id}>
                <PlatformCard p={p} />
              </div>
            ))}
          </SimpleGrid>
        ) : (
          <DataTable
            rows={shown}
            columns={platformColumns}
            rowKey={(p) => p.id}
            ariaLabel={t('title')}
            rowHref={(p) => `/platforms/${p.id}`}
            testId="platform-list"
            rememberSort="platforms"
            defaultSort={{ key: 'name', dir: 'asc' }}
            footer={<ListFooter shown={shown.length} total={all.length} />}
            card={(p) => <PlatformCard p={p} />}
          />
        ))}
      {/* adding a platform: the setup wizard (v0.4.0), or the quick form */}
      <AddPlatformWizard
        opened={adding}
        onClose={() => setAdding(false)}
        onSkip={() => {
          setAdding(false);
          setQuick(true);
        }}
        onDone={(id) => navigate(`/platforms/${id}?tab=start`)}
        importConnector={importConnector}
      />
      <AddPlatformModal opened={quick} onClose={() => setQuick(false)} onCreated={(id) => navigate(`/platforms/${id}`)} />
      <ConnectorTypesModal opened={typesOpen} onClose={() => setTypesOpen(false)} canManage={caps.createPlatforms} />
    </ListPage>
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
  const presets = useQuery({ queryKey: platformKeys.presets, queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const custom = (presets.data ?? []).filter((p) => p.custom);
  const refresh = () => qc.invalidateQueries({ queryKey: platformKeys.presets });
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
            {t('types.none', {
              presets: (presets.data ?? [])
                .filter((p) => !p.custom)
                .map((p) => p.label)
                .join(', '),
            })}
          </Text>
        ) : (
          <TableScroll>
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
                          <ActionIcon
                            component="a"
                            href={apiUrl(`/platform-types/${encodeURIComponent(ct.kind)}/export`)}
                            variant="subtle"
                            aria-label={t('types.export')}
                          >
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
                                if (!(await confirmDanger({ action: 'delete', message: t('types.deleteConfirm', { name: ct.label }) }))) return;
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
          </TableScroll>
        )}
      </Stack>
    </Modal>
  );
}

function AddPlatformModal({ opened, onClose, onCreated }: { opened: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: platformKeys.presets, queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const [preset, setPreset] = useState<PlatformPreset | null>(null);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // the authentication: the preset's, or – on a preset with "none" – the one the filled-in credential fields are for,
  // until it is chosen by hand (entered credentials were silently never sent before, v0.3.1)
  const [authChoice, setAuthChoice] = useState<AuthType | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) {
      setPreset(null);
      setName('');
      setEnvironment('');
      setSecrets({});
      setAuthChoice(null);
    }
  }, [opened]);

  const choose = (p: PlatformPreset) => {
    setPreset(p);
    setBaseUrl(p.baseUrl);
    setVariables({ ...p.config.variables });
    setSecrets({});
    setAuthChoice(null);
  };
  const authFields = preset?.secretFields.filter((f) => f.auth) ?? [];
  const authType: AuthType = authChoice ?? impliedAuthType(preset?.config.auth?.type, preset?.secretFields ?? [], secrets);
  const authOptions = [...new Set<AuthType>([preset?.config.auth?.type ?? 'none', ...authFields.map((f) => f.auth!)])];

  const check = useFieldErrors({ name: !name.trim() && t('common:validation.required') });
  const create = async () => {
    if (!preset || !check.validate()) return;
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
        config: { ...preset.config, auth: { ...preset.config.auth, type: authType }, variables: vars },
        secrets: filtered,
        typeKind: preset.custom ? preset.kind : undefined,
      });
      await qc.invalidateQueries({ queryKey: platformKeys.all });
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
            error={check.error('name')}
          />
          <EnvironmentInput label={t('form.environment')} value={environment} onChange={setEnvironment} />
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
              {authFields.length > 0 && (
                <Select
                  label={t('form.authType')}
                  description={t('form.authTypeHint')}
                  data={authOptions.map((a) => ({ value: a, label: authLabel(a) }))}
                  value={authType}
                  allowDeselect={false}
                  onChange={(v) => v && setAuthChoice(v as AuthType)}
                  data-testid="add-platform-auth"
                />
              )}
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
              <Button onClick={create} loading={busy}>
                {t('addModal.create')}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
