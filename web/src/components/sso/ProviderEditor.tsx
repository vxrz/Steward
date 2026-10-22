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
import { Trans, useTranslation } from 'react-i18next';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { errorText } from '../../i18n/errors';
import i18n from '../../i18n';

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

const roleOptions = () => ROLES.map((r) => ({ value: r, label: i18n.t(`common:roles.${r}`) }));

export function ProviderEditor({ provider, onClose, onSaved }: { provider: SsoProvider | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['users', 'common', 'auth']);
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
  const teamOptions = useMemo(() => (teams.data ?? []).map((team) => team.name), [teams.data]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const switchKind = (k: Kind) => {
    setKind(k);
    if (!provider) {
      setForm((f) => ({ ...DEFAULTS[k], issuer: k === 'entra' && tenant ? entraIssuer(tenant) : f.issuer, clientId: f.clientId }));
    }
  };

  const setMapping = (i: number, m: Partial<SsoRoleMapping>) =>
    set(
      'mappings',
      form.mappings.map((x, j) => (j === i ? { ...x, ...m } : x)),
    );

  const testDiscovery = async () => {
    setTesting(true);
    try {
      setDiscovery(await post<SsoDiscoveryResult>('/sso/discover', { issuer: form.issuer.trim() }));
    } catch (e) {
      setDiscovery({ ok: false, message: errorText(e) });
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
      notifyOk(t('provider.saved', { name: body.displayName }));
      onSaved();
    } catch (e) {
      notifyError(e, t('provider.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const needsSecret = form.clientAuth !== 'none';
  const valid = form.displayName.trim() && /^https?:\/\//.test(form.issuer.trim()) && form.clientId.trim();

  return (
    <Modal opened onClose={onClose} title={provider ? t('provider.edit', { name: provider.displayName }) : t('provider.add')} size="xl">
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
                    <IconKey size={16} /> {t('provider.genericOidc')}
                  </Group>
                ),
              },
            ]}
          />
        )}
        <TextInput
          label={t('provider.buttonLabel')}
          description={t('provider.buttonLabelHint', { button: t('auth:sso.signInWith', { provider: form.displayName || '…' }) })}
          required
          value={form.displayName}
          onChange={(e) => set('displayName', e.currentTarget.value)}
        />
        {kind === 'entra' && (
          <TextInput
            label={t('provider.tenant')}
            description={t('provider.tenantHint')}
            placeholder="00000000-0000-0000-0000-000000000000"
            value={tenant}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setTenant(value);
              set('issuer', value.trim() ? entraIssuer(value) : '');
            }}
          />
        )}
        <TextInput
          label={t('provider.issuer')}
          description={kind === 'entra' ? t('provider.issuerEntraHint') : t('provider.issuerHint')}
          required
          placeholder="https://idp.example.com/realms/company"
          value={form.issuer}
          onChange={(e) => {
            set('issuer', e.currentTarget.value);
            if (kind === 'entra') setTenant(tenantFromIssuer(e.currentTarget.value));
          }}
          rightSectionWidth={150}
          rightSection={
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconPlugConnected size={12} />}
              loading={testing}
              disabled={!form.issuer.trim()}
              onClick={testDiscovery}
            >
              {t('provider.testDiscovery')}
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
                    {t('provider.discovery.issuer')} <Code>{discovery.issuer}</Code>
                  </Text>
                )}
                {discovery.authorizationEndpoint && (
                  <Text size="xs" style={{ wordBreak: 'break-all' }}>
                    {t('provider.discovery.authorization')} <Code>{discovery.authorizationEndpoint}</Code>
                  </Text>
                )}
                {discovery.tokenEndpoint && (
                  <Text size="xs" style={{ wordBreak: 'break-all' }}>
                    {t('provider.discovery.token')} <Code>{discovery.tokenEndpoint}</Code>
                  </Text>
                )}
                {!!discovery.scopesSupported?.length && (
                  <Text size="xs">
                    {t('provider.discovery.scopes')} {discovery.scopesSupported.join(', ')}
                  </Text>
                )}
                {!!discovery.claimsSupported?.length && (
                  <Text size="xs">
                    {t('provider.discovery.claims')} {discovery.claimsSupported.join(', ')}
                  </Text>
                )}
              </Stack>
            )}
          </Alert>
        )}
        <Group grow align="flex-start">
          <TextInput
            label={kind === 'entra' ? t('provider.appClientId') : t('provider.clientId')}
            required
            value={form.clientId}
            onChange={(e) => set('clientId', e.currentTarget.value)}
          />
          {kind === 'oidc' && (
            <Select
              label={t('provider.clientAuth')}
              data={[
                { value: 'client_secret_basic', label: t('provider.authBasic') },
                { value: 'client_secret_post', label: t('provider.authPost') },
                { value: 'none', label: t('provider.authNone') },
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
              label={t('provider.secret')}
              description={t('provider.secretHint')}
              placeholder={provider?.hasClientSecret ? t('provider.secretStored') : undefined}
              value={secret}
              disabled={removeSecret}
              onChange={(e) => setSecret(e.currentTarget.value)}
              autoComplete="new-password"
            />
            {provider?.hasClientSecret && (
              <Checkbox size="xs" label={t('provider.removeSecret')} checked={removeSecret} onChange={(e) => setRemoveSecret(e.currentTarget.checked)} />
            )}
          </Stack>
        )}

        <UnstyledButton onClick={() => setAdvanced((a) => !a)}>
          <Group gap={4}>
            {advanced ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            <Text size="sm" fw={500}>
              {t('provider.scopesClaims')}
            </Text>
          </Group>
        </UnstyledButton>
        <Collapse in={advanced}>
          <Stack gap="xs">
            {kind === 'entra' && (
              <Select
                label={t('provider.clientAuth')}
                data={[
                  { value: 'client_secret_post', label: t('provider.authPostEntra') },
                  { value: 'client_secret_basic', label: t('provider.authBasic') },
                  { value: 'none', label: t('provider.authNone') },
                ]}
                value={form.clientAuth}
                onChange={(v) => v && set('clientAuth', v as SsoProviderInput['clientAuth'])}
                allowDeselect={false}
              />
            )}
            <TextInput label={t('provider.scopes')} value={form.scopes} onChange={(e) => set('scopes', e.currentTarget.value)} />
            <Group grow align="flex-start">
              <TextInput label={t('provider.usernameClaim')} value={form.usernameClaim} onChange={(e) => set('usernameClaim', e.currentTarget.value)} />
              <TextInput
                label={t('provider.displayNameClaim')}
                value={form.displayNameClaim}
                onChange={(e) => set('displayNameClaim', e.currentTarget.value)}
              />
            </Group>
            <Group grow align="flex-start">
              <TextInput label={t('provider.emailClaim')} value={form.emailClaim} onChange={(e) => set('emailClaim', e.currentTarget.value)} />
              <TextInput
                label={t('provider.groupsClaim')}
                description={t('provider.groupsClaimHint')}
                value={form.groupsClaim}
                onChange={(e) => set('groupsClaim', e.currentTarget.value)}
              />
            </Group>
          </Stack>
        </Collapse>

        <Divider label={t('provider.rolesTeams')} labelPosition="left" />
        {kind === 'entra' && (
          <Text size="xs" c="dimmed">
            <Trans t={t} i18nKey="provider.entraHint" components={{ b: <b />, c: <Code /> }} />
          </Text>
        )}
        <div className="table-scroll">
          <Table fz="sm" verticalSpacing={4} withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th miw={160}>{t('provider.claimValue', { claim: form.groupsClaim || 'claim' })}</Table.Th>
                <Table.Th miw={180}>{t('table.roles')}</Table.Th>
                <Table.Th miw={160}>{t('table.teams')}</Table.Th>
                <Table.Th w={36} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {form.mappings.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="xs" c="dimmed">
                      {t('provider.noMappings')}
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
                      placeholder={kind === 'entra' ? 'SM.Operators' : t('provider.groupName')}
                      value={m.claimValue}
                      onChange={(e) => setMapping(i, { claimValue: e.currentTarget.value })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      data={roleOptions()}
                      value={m.roles}
                      onChange={(v) => setMapping(i, { roles: v as Role[] })}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      data={teamOptions}
                      value={m.teams}
                      onChange={(v) => setMapping(i, { teams: v })}
                      placeholder={teamOptions.length ? undefined : t('provider.noTeams')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        set(
                          'mappings',
                          form.mappings.filter((_, j) => j !== i),
                        )
                      }
                      aria-label={t('provider.removeMapping')}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        <Group>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => set('mappings', [...form.mappings, { claimValue: '', roles: [], teams: [] }])}
          >
            {t('provider.addMapping')}
          </Button>
        </Group>
        <MultiSelect
          label={t('provider.defaultRoles')}
          description={t('provider.defaultRolesHint')}
          data={roleOptions()}
          value={form.defaultRoles}
          onChange={(v) => set('defaultRoles', v as Role[])}
          comboboxProps={{ withinPortal: true }}
        />

        <Divider />
        <Stack gap="xs">
          <Switch label={t('sso.enabled')} checked={form.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
          <Switch
            label={t('provider.autoProvision')}
            description={t('provider.autoProvisionHint')}
            checked={form.autoProvision}
            onChange={(e) => set('autoProvision', e.currentTarget.checked)}
          />
          <Switch
            label={t('provider.syncRoles')}
            description={t('provider.syncRolesHint')}
            checked={form.syncRoles}
            onChange={(e) => set('syncRoles', e.currentTarget.checked)}
          />
          <Switch label={t('provider.requireMapping')} checked={form.requireMapping} onChange={(e) => set('requireMapping', e.currentTarget.checked)} />
        </Stack>

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
