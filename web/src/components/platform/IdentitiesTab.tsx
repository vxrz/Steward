import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Checkbox,
  Group,
  JsonInput,
  Modal,
  Paper,
  PasswordInput,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconId, IconPlus, IconShieldLock, IconStar, IconTrash } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  DATABASE_KIND,
  type ApiOperation,
  type Credential,
  type IdentityOperationFilter,
  type IdentityOperationRef,
  type Platform,
  type PlatformIdentity,
  type PlatformIdentitySettings,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { platformKeys } from '../../queryKeys';
import { AccessTab } from '../access/AccessTab';
import { DataTable, type DataColumn } from '../DataTable';
import { confirmDanger } from '../confirm';
import { useMe } from '../../auth';
import { PrivilegedBadge } from './PrivilegedBadge';
import { TableScroll } from '../TableScroll';

/**
 * The identities of a platform (ADR 0009; 0.13.0: editable). A row per identity; its managers add identities and change
 * their sign-in settings, variables, credentials, access, MCP mode, read-only flag and operation filter in a dialog.
 */
export function IdentitiesTab({ platform, onOpenTab }: { platform: Platform; onOpenTab: (tab: 'credentials' | 'mcp') => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const identities = platform.identities ?? [];
  const manage = platform.permissions.includes('manage');
  const [open, setOpen] = useState<string | null>(null);
  const columns: DataColumn<PlatformIdentity>[] = [
    { key: 'name', header: t('common:name'), cell: (i) => <IdentityName identity={i} />, sortValue: (i) => i.name },
    { key: 'signIn', header: t('identities.signIn'), cell: (i) => signInText(t, platform, i) },
    {
      key: 'credentials',
      header: t('identities.credentials'),
      cell: (i) => (i.secretKeys.length ? <span className="mono">{i.secretKeys.join(', ')}</span> : t('identities.noCredentials')),
    },
    { key: 'mcp', header: t('identities.mcpLabel'), cell: (i) => mcpText(t, i), sortValue: (i) => i.mcp.mode },
    { key: 'operations', header: t('identities.operations'), cell: (i) => filterText(t, i) },
    { key: 'who', header: t('identities.whoMayUse'), cell: (i) => whoText(t, i) },
    { key: 'register', header: t('identities.register'), cell: (i) => <RegisterText identity={i} /> },
    { key: 'you', header: t('identities.you'), cell: (i) => (i.mayUse ? t('identities.youMayUse') : t('identities.youMayNotUse')), nowrap: true },
  ];
  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconId size={18} />}>
        {t('identities.infoSeveral')}
      </Alert>
      {manage && (
        <Group justify="flex-end">
          <Button leftSection={<IconPlus size={16} />} onClick={() => setOpen('new')} data-testid="identity-add">
            {t('identities.add')}
          </Button>
        </Group>
      )}
      {identities.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('identities.none')}
        </Text>
      ) : (
        <DataTable
          rows={identities}
          columns={columns}
          rowKey={(i) => i.id}
          ariaLabel={t('identities.listLabel')}
          onRowClick={(i) => setOpen(i.id)}
          testId="identity-list"
          rowProps={(i) => ({ 'data-testid': 'identity-row', 'data-name': i.name })}
          card={(i) => (
            <Paper
              withBorder
              p="sm"
              data-testid="identity-card"
              component="button"
              type="button"
              onClick={() => setOpen(i.id)}
              style={{ cursor: 'pointer', width: '100%', textAlign: 'start' }}
            >
              <IdentityName identity={i} />
              <SimpleGrid cols={1} spacing={4} mt="xs">
                <Field label={t('identities.signIn')}>{signInText(t, platform, i)}</Field>
                <Field label={t('identities.mcpLabel')}>{mcpText(t, i)}</Field>
                <Field label={t('identities.operations')}>{filterText(t, i)}</Field>
                <Field label={t('identities.whoMayUse')}>{whoText(t, i)}</Field>
                <Field label={t('identities.register')}>
                  <RegisterText identity={i} />
                </Field>
                <Field label={t('identities.you')}>{i.mayUse ? t('identities.youMayUse') : t('identities.youMayNotUse')}</Field>
              </SimpleGrid>
            </Paper>
          )}
        />
      )}
      {identities.length === 1 && (
        <Text size="sm" c="dimmed">
          {t('identities.addHint')}{' '}
          <Anchor component="button" type="button" size="sm" onClick={() => onOpenTab('credentials')}>
            {t('identities.openCredentials')}
          </Anchor>
        </Text>
      )}
      {open && (
        <IdentityDialog
          platform={platform}
          identityId={open === 'new' ? null : open}
          onCreated={(id) => setOpen(id)}
          onClose={() => setOpen(null)}
          manage={manage}
        />
      )}
    </Stack>
  );
}

type T = ReturnType<typeof useTranslation<['platforms', 'common']>>['t'];

function signInText(t: T, platform: Platform, i: PlatformIdentity): string {
  return i.ownSignIn ? t('identities.ownSignIn') : t('identities.platformSignIn', { auth: t(`auth.${platform.config.auth?.type ?? 'none'}`) });
}
function mcpText(t: T, i: PlatformIdentity): string {
  return i.mcp.mode === 'writes'
    ? t('identities.mcp.writes', { mode: t(`identities.mcp.writeModes.${i.mcp.writes ?? 'confirm'}`) })
    : t(`identities.mcp.${i.mcp.mode}`);
}
function filterText(t: T, i: PlatformIdentity): string {
  const f = i.operationFilter;
  const text = !f
    ? t('identities.allOperations')
    : f.preset === 'read'
      ? t('identities.filterRead', { count: f.operations.length })
      : t('identities.filterChosen', { count: f.operations.length });
  return i.staleOperations ? `${text} · ${t('identities.stale', { count: i.staleOperations })}` : text;
}
function whoText(t: T, i: PlatformIdentity): string {
  return i.default ? t('identities.everyoneWithUse') : i.shared ? t('identities.listed', { count: i.shared }) : t('identities.closed');
}

/**
 * How many entries of the credentials register document the identity (0.14.0, ADR 0009 step 4) – a privileged one
 * without an entry is marked (a warning, not a block).
 */
function RegisterText({ identity: i }: { identity: PlatformIdentity }) {
  const { t } = useTranslation(['platforms', 'common']);
  const n = i.registerEntries ?? 0;
  if (!n && i.privileged)
    return (
      <Group gap={4} wrap="nowrap" data-testid="identity-register-missing">
        <IconAlertTriangle size={14} color="var(--mantine-color-orange-7)" aria-hidden />
        <Text size="sm">{t('identities.registerMissing')}</Text>
      </Group>
    );
  return <Text size="sm">{n ? t('identities.registerCount', { count: n }) : t('identities.registerNone')}</Text>;
}

function IdentityName({ identity: i }: { identity: PlatformIdentity }) {
  const { t } = useTranslation(['platforms', 'common']);
  const changed = i.integrity === 'mismatch' || i.integrity === 'unsealed';
  return (
    <Group gap={6} wrap="wrap">
      <Text fw={600} size="sm">
        {i.name}
      </Text>
      {i.default && (
        <Badge variant="light" size="sm">
          {t('identities.default')}
        </Badge>
      )}
      {i.readOnly && (
        <Badge variant="light" color="teal" size="sm">
          {t('identities.readOnly')}
        </Badge>
      )}
      {i.privileged && <PrivilegedBadge />}
      {changed && (
        <Badge variant="light" color="red" size="sm" leftSection={<IconAlertTriangle size={12} />}>
          {t('identities.changedOutside')}
        </Badge>
      )}
      {i.disabled && (
        <Badge variant="light" color="gray" size="sm" data-testid="identity-disabled">
          {t('identities.disabled')}
        </Badge>
      )}
    </Group>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" fw={600}>
        {label}
      </Text>
      {typeof children === 'string' ? <Text size="sm">{children}</Text> : children}
    </div>
  );
}

/** Add or change one identity. A new identity has only the general settings until it is saved. */
function IdentityDialog({
  platform,
  identityId,
  onCreated,
  onClose,
  manage,
}: {
  platform: Platform;
  identityId: string | null;
  onCreated: (id: string) => void;
  onClose: () => void;
  manage: boolean;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const identity = identityId ? platform.identities?.find((i) => i.id === identityId) : undefined;
  const [tab, setTab] = useState<string | null>('general');
  const title = identity ? t('identities.editTitle', { name: identity.name }) : t('identities.addTitle');
  return (
    <Modal opened onClose={onClose} title={title} size="xl" fullScreen={phone}>
      {!identity ? (
        <GeneralForm platform={platform} identity={null} manage={manage} onSaved={(i) => onCreated(i.id)} />
      ) : (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
            <Tabs.Tab value="general">{t('identities.tabs.general')}</Tabs.Tab>
            {manage && (
              <Tabs.Tab value="credentials" data-testid="identity-tab-credentials">
                {t('identities.tabs.credentials')}
              </Tabs.Tab>
            )}
            <Tabs.Tab value="access" data-testid="identity-tab-access">
              {t('identities.tabs.access')}
            </Tabs.Tab>
            <Tabs.Tab value="mcp" data-testid="identity-tab-mcp">
              {t('identities.tabs.mcp')}
            </Tabs.Tab>
            <Tabs.Tab value="operations" data-testid="identity-tab-operations">
              {t('identities.tabs.operations')}
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="general">
            <GeneralForm platform={platform} identity={identity} manage={manage} onSaved={() => undefined} onDeleted={onClose} />
          </Tabs.Panel>
          {manage && (
            <Tabs.Panel value="credentials">
              <CredentialsForm platform={platform} identity={identity} />
            </Tabs.Panel>
          )}
          <Tabs.Panel value="access">
            <AccessForm platform={platform} identity={identity} manage={manage} />
          </Tabs.Panel>
          <Tabs.Panel value="mcp">
            <McpForm platform={platform} identity={identity} manage={manage} />
          </Tabs.Panel>
          <Tabs.Panel value="operations">
            <OperationsForm platform={platform} identity={identity} manage={manage} />
          </Tabs.Panel>
        </Tabs>
      )}
    </Modal>
  );
}

function useRefresh(platform: Platform) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: platformKeys.detail(platform.id) }), qc.invalidateQueries({ queryKey: platformKeys.all })]);
}

const base = (platform: Platform, identity: PlatformIdentity) => `/platforms/${platform.id}/identities/${identity.id}`;

/** Name, description, read-only flag, sign-in settings and variables – and the actions on the whole identity. */
function GeneralForm({
  platform,
  identity,
  manage,
  onSaved,
  onDeleted,
}: {
  platform: Platform;
  identity: PlatformIdentity | null;
  manage: boolean;
  onSaved: (i: PlatformIdentity) => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const refresh = useRefresh(platform);
  const settings = useQuery({
    queryKey: [...platformKeys.detail(platform.id), 'identity', identity?.id, 'settings'],
    queryFn: () => get<PlatformIdentitySettings>(`${base(platform, identity!)}/settings`),
    enabled: !!identity && manage,
  });
  const [name, setName] = useState(identity?.name ?? '');
  const [description, setDescription] = useState(identity?.description ?? '');
  const [readOnly, setReadOnly] = useState(identity?.readOnly ?? false);
  const [privileged, setPrivileged] = useState(identity?.privileged ?? false);
  const [own, setOwn] = useState(identity?.ownSignIn ?? false);
  const [auth, setAuth] = useState('');
  const [vars, setVars] = useState<{ key: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const database = platform.kind === DATABASE_KIND;
  useEffect(() => {
    if (!settings.data) return;
    setAuth(JSON.stringify(settings.data.auth ?? platform.config.auth ?? { type: 'none' }, null, 2));
    setVars(Object.entries(settings.data.variables).map(([key, value]) => ({ key, value })));
  }, [settings.data, platform.config.auth]);
  const fixed = new Set(settings.data?.fixedVariables ?? []);
  let authValid = true;
  if (own) {
    try {
      authValid = typeof (JSON.parse(auth || '{}') as { type?: unknown }).type === 'string';
    } catch {
      authValid = false;
    }
  }

  const save = async () => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        readOnly,
        // turning it off asks for a step-up (the dialog comes with the answer); never on the default identity
        ...(identity?.default ? {} : { privileged }),
        ...(identity
          ? {
              auth: own ? JSON.parse(auth || '{}') : null,
              variables: Object.fromEntries(vars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])),
            }
          : {}),
      };
      const saved = identity
        ? await put<PlatformIdentity>(base(platform, identity), body)
        : await post<PlatformIdentity>(`/platforms/${platform.id}/identities`, body);
      await refresh();
      notifyOk(t('identities.saved', { name: saved.name }));
      onSaved(saved);
    } catch (e) {
      notifyError(e, t('identities.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const action = async (fn: () => Promise<unknown>, ok: string, fail: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      notifyOk(ok);
      return true;
    } catch (e) {
      notifyError(e, fail);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    action(
      async () => {
        const r = await post<{ ok: boolean; message: string }>(`${base(platform, identity!)}/test`);
        if (!r.ok) throw new Error(r.message);
      },
      t('identities.testOk'),
      t('identities.testFailed'),
    );
  const tokenTypes = ['oauth2_client_credentials', 'token_request', 'jwt'];
  const usesToken = tokenTypes.includes((own ? settings.data?.auth?.type : platform.config.auth?.type) ?? '');
  const renew = () =>
    action(
      async () => {
        const r = await post<{ ok: boolean; message?: string }>(`${base(platform, identity!)}/token/renew`);
        if (!r.ok) throw new Error(r.message ?? '');
      },
      t('identities.tokenRenewed'),
      t('identities.tokenNotRenewed'),
    );
  const { isAdmin } = useMe();
  const enable = async () => {
    const who = identity!.acl?.length ? identity!.acl.map((e) => e.subject).join(', ') : t('identities.closed');
    if (!(await confirmDanger({ action: 'confirm', message: t('identities.enableText', { name: identity!.name, who }), confirmLabel: t('identities.enable') })))
      return;
    await action(() => post(`${base(platform, identity!)}/enable`), t('identities.enabled', { name: identity!.name }), t('identities.notSaved'));
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('identities.deleteText', { name: identity!.name }) }))) return;
    if (await action(() => del(base(platform, identity!)), t('identities.deleted', { name: identity!.name }), t('identities.notDeleted'))) onDeleted?.();
  };
  const makeDefault = async () => {
    if (
      !(await confirmDanger({
        action: 'confirm',
        message: t('identities.makeDefaultText', { name: identity!.name }),
        confirmLabel: t('identities.makeDefault'),
      }))
    )
      return;
    await action(() => post(`${base(platform, identity!)}/default`), t('identities.isDefault', { name: identity!.name }), t('identities.notSaved'));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (manage && name.trim() && authValid) void save();
      }}
    >
      <Stack>
        {identity?.disabled && (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="identity-disabled-alert">
            <Text size="sm">{t('identities.disabledText')}</Text>
            {manage && isAdmin && (
              <Button size="xs" mt="xs" color="orange" variant="light" onClick={enable} disabled={busy} data-testid="identity-enable">
                {t('identities.enable')}
              </Button>
            )}
          </Alert>
        )}
        <TextInput label={t('common:name')} value={name} onChange={(e) => setName(e.currentTarget.value)} required disabled={!manage} maxLength={100} />
        <Textarea
          label={t('identities.description')}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          disabled={!manage}
          autosize
          minRows={2}
        />
        {database ? (
          <Text size="sm" c="dimmed">
            {t('identities.databaseReadOnly')}
          </Text>
        ) : (
          <Switch
            label={t('identities.readOnlyLabel')}
            description={t('identities.readOnlyHelp')}
            checked={readOnly}
            onChange={(e) => setReadOnly(e.currentTarget.checked)}
            disabled={!manage}
            data-testid="identity-read-only"
          />
        )}
        {identity?.default ? (
          <Text size="sm" c="dimmed">
            {t('identities.privilegedDefault')}
          </Text>
        ) : (
          <Switch
            label={t('identities.privilegedLabel')}
            description={t('identities.privilegedHelp')}
            checked={privileged}
            onChange={(e) => setPrivileged(e.currentTarget.checked)}
            disabled={!manage}
            color="orange"
            data-testid="identity-privileged-switch"
          />
        )}
        {identity && <RegisterEntries platform={platform} identity={identity} />}
        {manage && identity && (
          <>
            <SegmentedControl
              value={own ? 'own' : 'platform'}
              onChange={(v) => setOwn(v === 'own')}
              data={[
                { value: 'platform', label: t('identities.signInPlatform') },
                { value: 'own', label: t('identities.signInOwn') },
              ]}
              aria-label={t('identities.signIn')}
            />
            {own && (
              <JsonInput
                label={t('identities.authLabel')}
                description={t('identities.authHelp')}
                value={auth}
                onChange={setAuth}
                autosize
                minRows={4}
                formatOnBlur
                error={authValid ? undefined : t('identities.authInvalid')}
              />
            )}
            <VariablesEditor value={vars} onChange={setVars} fixed={fixed} />
          </>
        )}
        {manage && (
          <Group justify="space-between" wrap="wrap">
            <Group gap="xs" wrap="wrap">
              {identity && !identity.default && !identity.disabled && !identity.privileged && (
                <Button variant="default" leftSection={<IconStar size={16} />} onClick={makeDefault} disabled={busy}>
                  {t('identities.makeDefault')}
                </Button>
              )}
              {identity && (
                <Button variant="default" onClick={test} disabled={busy} data-testid="identity-test">
                  {t('identities.test')}
                </Button>
              )}
              {identity && usesToken && (
                <Button variant="default" onClick={renew} disabled={busy}>
                  {t('identities.renewToken')}
                </Button>
              )}
              {identity && !identity.default && (
                <Button variant="subtle" color="red" leftSection={<IconTrash size={16} />} onClick={remove} disabled={busy}>
                  {t('common:delete')}
                </Button>
              )}
            </Group>
            <Button type="submit" loading={busy} disabled={!name.trim() || !authValid} data-testid="identity-save">
              {identity ? t('common:save') : t('identities.create')}
            </Button>
          </Group>
        )}
      </Stack>
    </form>
  );
}

/**
 * The entries of the credentials register that document the identity (0.14.0, ADR 0009 step 4): status and next due
 * date, as far as the person may read the register.
 */
function RegisterEntries({ platform, identity }: { platform: Platform; identity: PlatformIdentity }) {
  const { t } = useTranslation(['platforms', 'common', 'credentials']);
  const n = identity.registerEntries ?? 0;
  const entries = useQuery({
    queryKey: ['credentials', 'identity', identity.id],
    queryFn: () => get<{ items: Credential[] }>(`/credentials?platform=${encodeURIComponent(platform.id)}&identity=${encodeURIComponent(identity.id)}`),
    enabled: n > 0,
    retry: false,
  });
  return (
    <Stack gap={4} data-testid="identity-register">
      <Text size="sm" fw={500}>
        {t('identities.register')}
      </Text>
      {!n ? (
        <Text size="sm" c={identity.privileged ? undefined : 'dimmed'}>
          {identity.privileged && <IconAlertTriangle size={14} color="var(--mantine-color-orange-7)" aria-hidden style={{ verticalAlign: 'text-bottom' }} />}{' '}
          {identity.privileged ? t('identities.registerMissingText') : t('identities.registerEmpty')}{' '}
          <Anchor component={Link} to="/credentials" size="sm">
            {t('identities.registerOpen')}
          </Anchor>
        </Text>
      ) : (
        <>
          {(entries.data?.items ?? []).map((c) => (
            <Group key={c.id} gap="xs" wrap="wrap">
              <Anchor component={Link} to={`/credentials?open=${encodeURIComponent(c.id)}`} size="sm">
                {c.name}
              </Anchor>
              <Badge size="xs" variant="light" color={c.status === 'ok' ? 'green' : c.status === 'dueSoon' ? 'yellow' : 'red'}>
                {t(`credentials:status.${c.status}`)}
              </Badge>
              {c.nextDueAt && (
                <Text size="xs" c="dimmed">
                  {t('identities.registerNextDue', { date: c.nextDueAt.slice(0, 10) })}
                </Text>
              )}
            </Group>
          ))}
          {entries.isError && (
            <Text size="sm" c="dimmed">
              {t('identities.registerCount', { count: n })}
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

/** The variables an identity sets over the platform's; those that decide where requests go cannot be set. */
function VariablesEditor({
  value,
  onChange,
  fixed,
}: {
  value: { key: string; value: string }[];
  onChange: (v: { key: string; value: string }[]) => void;
  fixed: Set<string>;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const set = (i: number, patch: Partial<{ key: string; value: string }>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {t('identities.variables')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('identities.variablesHelp', { fixed: [...fixed].join(', ') || '–' })}
      </Text>
      {value.map((v, i) => (
        <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            aria-label={t('common:name')}
            placeholder={t('common:name')}
            value={v.key}
            onChange={(e) => set(i, { key: e.currentTarget.value })}
            error={fixed.has(v.key.trim()) ? t('identities.variableFixed') : undefined}
            style={{ flex: 1, minWidth: 0 }}
          />
          <TextInput
            aria-label={t('common:value')}
            placeholder={t('common:value')}
            value={v.value}
            onChange={(e) => set(i, { value: e.currentTarget.value })}
            style={{ flex: 1, minWidth: 0 }}
          />
          <ActionIcon variant="subtle" color="red" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t('common:remove')} mt={4}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => onChange([...value, { key: '', value: '' }])}>
          {t('identities.addVariable')}
        </Button>
      </Group>
    </Stack>
  );
}

/** The identity's credentials in the vault: names only, values are never shown. */
function CredentialsForm({ platform, identity }: { platform: Platform; identity: PlatformIdentity }) {
  const { t } = useTranslation(['platforms', 'common']);
  const refresh = useRefresh(platform);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // "This is a rotation" (0.14.0, ADR 0009 step 4): on by default where register entries document the identity
  const registered = (identity.registerEntries ?? 0) > 0;
  const [rotation, setRotation] = useState(true);
  const store = async (patch: Record<string, string | null>, ok: string) => {
    setBusy(true);
    try {
      const asRotation = registered && rotation && Object.values(patch).some((v) => !!v);
      await put(`${base(platform, identity)}/secrets${asRotation ? '?rotation=1' : ''}`, patch);
      await refresh();
      notifyOk(ok);
      setKey('');
      setValue('');
    } catch (e) {
      notifyError(e, t('credentials.notStored'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      {identity.secretKeys.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('credentials.none')}
        </Text>
      ) : (
        <TableScroll>
          <Table aria-label={t('identities.credentials')}>
            <Table.Tbody>
              {identity.secretKeys.map((k) => (
                <Table.Tr key={k}>
                  <Table.Td className="mono">{k}</Table.Td>
                  <Table.Td c="dimmed">••••••••</Table.Td>
                  <Table.Td w={50}>
                    <Tooltip label={t('common:remove')}>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => store({ [k]: null }, t('credentials.removed', { key: k }))}
                        aria-label={t('common:remove')}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim() && value) void store({ [key.trim()]: value }, t('credentials.stored', { key: key.trim() }));
        }}
      >
        <Stack>
          <Autocomplete
            label={t('common:name')}
            placeholder={t('credentials.namePlaceholder')}
            data={['apiKey', 'token', 'username', 'password', 'clientId', 'clientSecret', 'privateKey']}
            value={key}
            onChange={setKey}
            data-testid="identity-secret-name"
          />
          <PasswordInput
            label={t('common:value')}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            autoComplete="new-password"
            data-testid="identity-secret-value"
          />
          {registered && (
            <Checkbox
              label={t('identities.rotation')}
              description={t('identities.rotationHelp', { count: identity.registerEntries ?? 0 })}
              checked={rotation}
              onChange={(e) => setRotation(e.currentTarget.checked)}
              data-testid="identity-secret-rotation"
            />
          )}
          <Group justify="flex-end">
            <Button
              type="submit"
              loading={busy}
              disabled={!key.trim() || !value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())}
              data-testid="identity-secret-store"
            >
              {t('credentials.store')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  );
}

/** Who may use the identity: everyone with "use" (the default), else its access list and owning teams. */
function AccessForm({ platform, identity, manage }: { platform: Platform; identity: PlatformIdentity; manage: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const refresh = useRefresh(platform);
  if (identity.default) return <Text size="sm">{t('identities.defaultAccess')}</Text>;
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('identities.accessHelp')}
      </Text>
      {/* 0.23.0 (ADR 0033 phase 2): its access list became shares – View with "use" */}
      <AccessTab kind="platform_identity" id={identity.id} />
    </Stack>
  );
}

/** The identity's MCP mode: off, read, or changing calls after an approval. */
function McpForm({ platform, identity, manage }: { platform: Platform; identity: PlatformIdentity; manage: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const refresh = useRefresh(platform);
  const current = identity.mcp.mode === 'writes' ? `writes:${identity.mcp.writes ?? 'confirm'}` : identity.mcp.mode;
  const [mode, setMode] = useState<string>(current);
  const [busy, setBusy] = useState(false);
  const database = platform.kind === DATABASE_KIND;
  // a privileged identity (0.14.0, ADR 0009 step 4): off, or changing calls a second person approves – never reads
  const privileged = identity.privileged;
  const save = async () => {
    setBusy(true);
    try {
      const [m, w] = mode.split(':');
      await put(`${base(platform, identity)}/mcp`, { mode: m, ...(w ? { writes: w } : {}) });
      await refresh();
      notifyOk(t('identities.mcpSaved'));
    } catch (e) {
      notifyError(e, t('identities.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('identities.mcpHelp')}
      </Text>
      {privileged && (
        <Alert color="orange" variant="light" icon={<IconShieldLock size={16} />} data-testid="identity-mcp-privileged">
          {t('identities.mcpPrivileged')}
        </Alert>
      )}
      <Select
        label={t('identities.mcpLabel')}
        value={mode}
        onChange={(v) => v && setMode(v)}
        disabled={!manage}
        allowDeselect={false}
        data-testid="identity-mcp-mode"
        data={[
          { value: 'off', label: t('identities.mcp.off') },
          ...(privileged ? [] : [{ value: 'read', label: t('identities.mcp.read') }]),
          ...(database
            ? []
            : (privileged ? (['fourEyes'] as const) : (['confirm', 'fourEyes'] as const)).map((w) => ({
                value: `writes:${w}`,
                label: t('identities.mcp.writes', { mode: t(`identities.mcp.writeModes.${w}`) }),
              }))),
        ]}
      />
      {manage && (
        <Group justify="flex-end">
          <Button onClick={save} loading={busy} disabled={mode === current} data-testid="identity-mcp-save">
            {t('common:save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

const refKey = (r: Pick<IdentityOperationRef, 'specId' | 'method' | 'specPath'>) => `${r.specId} ${r.method.toUpperCase()} ${r.specPath}`;
const opRef = (o: ApiOperation): IdentityOperationRef => ({
  specId: o.specId,
  method: o.method.toUpperCase(),
  specPath: o.specPath ?? o.path,
  ...(o.operationId ? { operationId: o.operationId } : {}),
});

/** The operation filter: All, Read (every GET and HEAD, plus chosen ones) or Chosen – picked from the platform's specs. */
function OperationsForm({ platform, identity, manage }: { platform: Platform; identity: PlatformIdentity; manage: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const refresh = useRefresh(platform);
  const ops = useQuery({ queryKey: platformKeys.operations(platform.id), queryFn: () => get<ApiOperation[]>(`/platforms/${platform.id}/operations`) });
  const [preset, setPreset] = useState<'all' | 'read' | 'chosen'>(identity.operationFilter?.preset ?? 'all');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((identity.operationFilter?.operations ?? []).map(refKey)));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const byKey = useMemo(() => new Map((ops.data ?? []).map((o) => [refKey(opRef(o)), o])), [ops.data]);
  if (ops.isLoading) return null;
  const list = ops.data ?? [];
  if (!list.length)
    return (
      <Text size="sm" c="dimmed">
        {t('identities.noSpecs')}
      </Text>
    );
  const stale = (identity.operationFilter?.operations ?? []).filter((r) => !byKey.has(refKey(r)));
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = list.filter((o) => words.every((w) => [o.operationId, o.method, o.path, o.summary, o.tag].filter(Boolean).join(' ').toLowerCase().includes(w)));
  const untagged = t('identities.untagged');
  const groups = new Map<string, ApiOperation[]>();
  for (const o of shown) groups.set(o.tag || untagged, [...(groups.get(o.tag || untagged) ?? []), o]);
  const safe = (o: ApiOperation) => ['GET', 'HEAD'].includes(o.method.toUpperCase());
  const save = async () => {
    setBusy(true);
    try {
      const filter: IdentityOperationFilter | null =
        preset === 'all' ? null : { preset, operations: [...chosen].flatMap((k) => (byKey.has(k) ? [opRef(byKey.get(k)!)] : [])) };
      await put(`${base(platform, identity)}`, { operationFilter: filter });
      await refresh();
      notifyOk(t('identities.filterSaved'));
    } catch (e) {
      notifyError(e, t('identities.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('identities.filterHelp')}
      </Text>
      <SegmentedControl
        value={preset}
        onChange={(v) => setPreset(v as 'all' | 'read' | 'chosen')}
        disabled={!manage}
        aria-label={t('identities.operations')}
        data={[
          { value: 'all', label: t('identities.presetAll') },
          { value: 'read', label: t('identities.presetRead') },
          { value: 'chosen', label: t('identities.presetChosen') },
        ]}
        data-testid="identity-filter-preset"
      />
      {stale.length > 0 && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('identities.staleText', { list: stale.map((r) => `${r.method} ${r.specPath}`).join(', ') })}
        </Alert>
      )}
      {preset !== 'all' && (
        <>
          <TextInput
            placeholder={t('identities.searchOperations')}
            aria-label={t('identities.searchOperations')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
          <ScrollArea.Autosize mah={360} type="auto">
            <Stack gap="sm">
              {[...groups].map(([tag, items]) => (
                <div key={tag}>
                  <Title order={6} mb={4}>
                    {tag}
                  </Title>
                  <Stack gap={4}>
                    {items.map((o) => {
                      const k = refKey(opRef(o));
                      const implied = preset === 'read' && safe(o);
                      return (
                        <Checkbox
                          key={k}
                          checked={implied || chosen.has(k)}
                          disabled={!manage || implied}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.currentTarget.checked) next.add(k);
                            else next.delete(k);
                            setChosen(next);
                          }}
                          label={
                            <span>
                              <span className="mono">
                                {o.method.toUpperCase()} {o.path}
                              </span>
                              {o.summary ? ` – ${o.summary}` : ''}
                            </span>
                          }
                        />
                      );
                    })}
                  </Stack>
                </div>
              ))}
            </Stack>
          </ScrollArea.Autosize>
        </>
      )}
      <Text size="xs" c="dimmed">
        {t('identities.filterLimit')}
      </Text>
      {manage && (
        <Group justify="flex-end">
          <Button onClick={save} loading={busy} data-testid="identity-filter-save">
            {t('common:save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
