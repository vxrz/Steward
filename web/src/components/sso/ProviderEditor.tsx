import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Collapse,
  Divider,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconBrandWindows, IconChevronDown, IconChevronRight, IconKey, IconPlus, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import { ROLES, type Role, type SsoDiscoveryResult, type SsoProvider, type SsoProviderInput, type SsoRoleMapping, type Team } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';

type Kind = 'entra' | 'oidc';

const ENTRA_PREFIX = 'https://login.microsoftonline.com/';
const entraIssuer = (tenant: string) => `${ENTRA_PREFIX}${tenant.trim()}/v2.0`;
const tenantFromIssuer = (issuer: string) => {
  const m = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(issuer.trim());
  return m ? m[1]! : '';
};

const DEFAULTS: Record<Kind, Omit<SsoProviderInput, 'type'>> = {
  entra: {
    displayName: 'Microsoft',
    issuer: '',
    clientId: '',
    clientAuth: 'client_secret_post',
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    displayNameClaim: 'name',
    emailClaim: 'email',
    groupsClaim: 'roles',
    mappings: [],
    defaultRoles: [],
    autoProvision: true,
    syncRoles: true,
    requireMapping: true,
    enabled: true,
  },
  oidc: {
    displayName: 'Company login',
    issuer: '',
    clientId: '',
    clientAuth: 'client_secret_basic',
    scopes: 'openid profile email',
    usernameClaim: 'preferred_username',
    displayNameClaim: 'name',
    emailClaim: 'email',
    groupsClaim: 'groups',
    mappings: [],
    defaultRoles: [],
    autoProvision: true,
    syncRoles: false,
    requireMapping: false,
    enabled: true,
  },
};

const roleOptions = ROLES.map((r) => ({ value: r, label: r }));

export function ProviderEditor({ provider, onClose, onSaved }: { provider: SsoProvider | null; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>(provider?.type ?? 'entra');
  const [form, setForm] = useState<Omit<SsoProviderInput, 'type'>>(() => {
    if (!provider) return { ...DEFAULTS.entra };
    const { id: _id, hasClientSecret: _h, createdAt: _c, updatedAt: _u, type: _t, ...rest } = provider;
    return rest;
  });
  const [tenant, setTenant] = useState(() => tenantFromIssuer(provider?.issuer ?? ''));
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [discovery, setDiscovery] = useState<SsoDiscoveryResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams') });
  const teamOptions = useMemo(() => (teams.data ?? []).map((t) => t.name), [teams.data]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const switchKind = (k: Kind) => {
    setKind(k);
    if (!provider) {
      setForm((f) => ({ ...DEFAULTS[k], issuer: k === 'entra' && tenant ? entraIssuer(tenant) : f.issuer, clientId: f.clientId }));
    }
  };

  const setMapping = (i: number, m: Partial<SsoRoleMapping>) => set('mappings', form.mappings.map((x, j) => (j === i ? { ...x, ...m } : x)));

  const testDiscovery = async () => {
    setTesting(true);
    try {
      setDiscovery(await post<SsoDiscoveryResult>('/sso/discover', { issuer: form.issuer.trim() }));
    } catch (e) {
      setDiscovery({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    const body: SsoProviderInput = {
      ...form,
      type: kind,
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      mappings: form.mappings.filter((m) => m.claimValue.trim()).map((m) => ({ ...m, claimValue: m.claimValue.trim() })),
    };
    if (removeSecret) body.clientSecret = '';
    else if (secret) body.clientSecret = secret;
    try {
      if (provider) await put(`/sso/providers/${provider.id}`, body);
      else await post('/sso/providers', body);
      notifyOk(`Single sign-on "${body.displayName}" saved`);
      onSaved();
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };

  const needsSecret = form.clientAuth !== 'none';
  const valid = form.displayName.trim() && /^https?:\/\//.test(form.issuer.trim()) && form.clientId.trim();

  return (
    <Modal opened onClose={onClose} title={provider ? `Edit ${provider.displayName}` : 'Add single sign-on'} size="xl">
      <Stack>
        {!provider && (
          <SegmentedControl
            value={kind}
            onChange={(v) => switchKind(v as Kind)}
            data={[
              {
                value: 'entra',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconBrandWindows size={16} /> Microsoft Entra ID
                  </Group>
                ),
              },
              {
                value: 'oidc',
                label: (
                  <Group gap={6} justify="center" wrap="nowrap">
                    <IconKey size={16} /> Generic OIDC
                  </Group>
                ),
              },
            ]}
          />
        )}
        <TextInput
          label="Button label"
          description={`Shown as "Sign in with ${form.displayName || '…'}"`}
          required
          value={form.displayName}
          onChange={(e) => set('displayName', e.currentTarget.value)}
        />
        {kind === 'entra' && (
          <TextInput
            label="Directory (tenant) ID"
            description="From the app registration overview in Entra ID"
            placeholder="00000000-0000-0000-0000-000000000000"
            value={tenant}
            onChange={(e) => {
              const t = e.currentTarget.value;
              setTenant(t);
              set('issuer', t.trim() ? entraIssuer(t) : '');
            }}
          />
        )}
        <TextInput
          label="Issuer URL"
          description={kind === 'entra' ? 'Computed from the tenant ID; edit only for special clouds' : 'The OpenID Connect issuer; /.well-known/openid-configuration must be reachable below it'}
          required
          placeholder="https://idp.example.com/realms/company"
          value={form.issuer}
          onChange={(e) => {
            set('issuer', e.currentTarget.value);
            if (kind === 'entra') setTenant(tenantFromIssuer(e.currentTarget.value));
          }}
          rightSectionWidth={130}
          rightSection={
            <Button size="compact-xs" variant="light" leftSection={<IconPlugConnected size={12} />} loading={testing} disabled={!form.issuer.trim()} onClick={testDiscovery}>
              Test discovery
            </Button>
          }
        />
        {discovery && (
          <Alert color={discovery.ok ? 'green' : 'red'} variant="light" withCloseButton onClose={() => setDiscovery(null)} p="xs">
            <Text size="sm">{discovery.message}</Text>
            {discovery.ok && (
              <Stack gap={2} mt={4}>
                {discovery.issuer && (
                  <Text size="xs">
                    Issuer: <Code>{discovery.issuer}</Code>
                  </Text>
                )}
                {discovery.authorizationEndpoint && (
                  <Text size="xs" style={{ wordBreak: 'break-all' }}>
                    Authorization: <Code>{discovery.authorizationEndpoint}</Code>
                  </Text>
                )}
                {discovery.tokenEndpoint && (
                  <Text size="xs" style={{ wordBreak: 'break-all' }}>
                    Token: <Code>{discovery.tokenEndpoint}</Code>
                  </Text>
                )}
                {!!discovery.scopesSupported?.length && <Text size="xs">Scopes: {discovery.scopesSupported.join(', ')}</Text>}
                {!!discovery.claimsSupported?.length && <Text size="xs">Claims: {discovery.claimsSupported.join(', ')}</Text>}
              </Stack>
            )}
          </Alert>
        )}
        <Group grow align="flex-start">
          <TextInput
            label={kind === 'entra' ? 'Application (client) ID' : 'Client ID'}
            required
            value={form.clientId}
            onChange={(e) => set('clientId', e.currentTarget.value)}
          />
          {kind === 'oidc' && (
            <Select
              label="Client authentication"
              data={[
                { value: 'client_secret_basic', label: 'Secret (Basic header)' },
                { value: 'client_secret_post', label: 'Secret (form body)' },
                { value: 'none', label: 'None – public client (PKCE)' },
              ]}
              value={form.clientAuth}
              onChange={(v) => v && set('clientAuth', v as SsoProviderInput['clientAuth'])}
              allowDeselect={false}
            />
          )}
        </Group>
        {needsSecret && (
          <Stack gap={4}>
            <PasswordInput
              label="Client secret"
              description="Stored encrypted with the master passphrase"
              placeholder={provider?.hasClientSecret ? '•••• stored – leave empty to keep' : undefined}
              value={secret}
              disabled={removeSecret}
              onChange={(e) => setSecret(e.currentTarget.value)}
              autoComplete="new-password"
            />
            {provider?.hasClientSecret && (
              <Checkbox size="xs" label="Remove the stored secret" checked={removeSecret} onChange={(e) => setRemoveSecret(e.currentTarget.checked)} />
            )}
          </Stack>
        )}

        <UnstyledButton onClick={() => setAdvanced((a) => !a)}>
          <Group gap={4}>
            {advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            <Text size="sm" fw={500}>
              Scopes and claims
            </Text>
          </Group>
        </UnstyledButton>
        <Collapse in={advanced}>
          <Stack gap="xs">
            {kind === 'entra' && (
              <Select
                label="Client authentication"
                data={[
                  { value: 'client_secret_post', label: 'Secret (form body) – Entra default' },
                  { value: 'client_secret_basic', label: 'Secret (Basic header)' },
                  { value: 'none', label: 'None – public client (PKCE)' },
                ]}
                value={form.clientAuth}
                onChange={(v) => v && set('clientAuth', v as SsoProviderInput['clientAuth'])}
                allowDeselect={false}
              />
            )}
            <TextInput label="Scopes" value={form.scopes} onChange={(e) => set('scopes', e.currentTarget.value)} />
            <Group grow align="flex-start">
              <TextInput label="User name claim" value={form.usernameClaim} onChange={(e) => set('usernameClaim', e.currentTarget.value)} />
              <TextInput label="Display name claim" value={form.displayNameClaim} onChange={(e) => set('displayNameClaim', e.currentTarget.value)} />
            </Group>
            <Group grow align="flex-start">
              <TextInput label="E-mail claim" value={form.emailClaim} onChange={(e) => set('emailClaim', e.currentTarget.value)} />
              <TextInput
                label="Roles / groups claim"
                description="Used for the mappings below"
                value={form.groupsClaim}
                onChange={(e) => set('groupsClaim', e.currentTarget.value)}
              />
            </Group>
          </Stack>
        </Collapse>

        <Divider label="Roles and teams" labelPosition="left" />
        {kind === 'entra' && (
          <Text size="xs" c="dimmed">
            In the Entra app registration define <b>App roles</b> (e.g. SM.Operators), assign users/groups to them in Enterprise applications, and map
            the role values here (claim <Code>roles</Code>). Alternatively emit the <Code>groups</Code> claim and map group object IDs (max. 200 groups
            per token).
          </Text>
        )}
        <div className="table-scroll">
          <Table fz="sm" verticalSpacing={4} withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th miw={160}>Claim value ({form.groupsClaim || 'claim'})</Table.Th>
                <Table.Th miw={180}>Roles</Table.Th>
                <Table.Th miw={160}>Teams</Table.Th>
                <Table.Th w={36} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {form.mappings.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="xs" c="dimmed">
                      No mappings – users only get the default roles below.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {form.mappings.map((m, i) => (
                <Table.Tr key={i}>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      classNames={{ input: 'mono' }}
                      placeholder={kind === 'entra' ? 'SM.Operators' : 'group name'}
                      value={m.claimValue}
                      onChange={(e) => setMapping(i, { claimValue: e.currentTarget.value })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect size="xs" data={roleOptions} value={m.roles} onChange={(v) => setMapping(i, { roles: v as Role[] })} comboboxProps={{ withinPortal: true }} />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      data={teamOptions}
                      value={m.teams}
                      onChange={(v) => setMapping(i, { teams: v })}
                      placeholder={teamOptions.length ? undefined : 'no teams yet'}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" onClick={() => set('mappings', form.mappings.filter((_, j) => j !== i))} aria-label="Remove mapping">
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        <Group>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => set('mappings', [...form.mappings, { claimValue: '', roles: [], teams: [] }])}>
            Add mapping
          </Button>
        </Group>
        <MultiSelect
          label="Default roles"
          description="Every user signing in with this provider gets these roles (in addition to mapped ones)"
          data={roleOptions}
          value={form.defaultRoles}
          onChange={(v) => set('defaultRoles', v as Role[])}
          comboboxProps={{ withinPortal: true }}
        />

        <Divider />
        <Stack gap="xs">
          <Switch label="Enabled" checked={form.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <Switch
            label="Create accounts on first sign-in"
            description="Otherwise an administrator has to create the user first (same user name); it is linked on the first sign-in."
            checked={form.autoProvision}
            onChange={(e) => set('autoProvision', e.currentTarget.checked)}
          />
          <Switch
            label="Sync roles and mapped teams at every sign-in"
            description="Roles come from the identity provider; changes made here are overwritten at the next sign-in."
            checked={form.syncRoles}
            onChange={(e) => set('syncRoles', e.currentTarget.checked)}
          />
          <Switch
            label="Deny sign-in when no mapping matches"
            checked={form.requireMapping}
            onChange={(e) => set('requireMapping', e.currentTarget.checked)}
          />
        </Stack>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
