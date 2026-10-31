import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Checkbox,
  Code,
  Collapse,
  Divider,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown, IconChevronRight, IconExternalLink, IconPlus, IconPlugConnected, IconTrash } from '@tabler/icons-react';
import {
  BRAND,
  ROLES,
  TEAM_ROLES,
  SSO_PRESETS,
  SSO_DOMAIN,
  SSO_PRESET_INFO,
  ssoConfigWarnings,
  stableIdProblem,
  type Role,
  type SsoDiscoveryResult,
  type SsoPreset,
  type SsoProvider,
  type SsoProviderInput,
  type SsoRoleMapping,
  type Team,
} from '@sm/shared';
import { Trans, useTranslation } from 'react-i18next';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { errorText } from '../../i18n/errors';
import i18n from '../../i18n';
import { ClaimFields, LinkingAndRequired, ProfileAndSync, StableIdField, type ProviderForm } from './ClaimSettings';
import { ConfigWarnings } from './ConfigWarnings';
import { TestSignIn } from './TestSignIn';

const ENTRA_PREFIX = 'https://login.microsoftonline.com/';
const entraIssuer = (tenant: string) => `${ENTRA_PREFIX}${tenant.trim()}/v2.0`;
const tenantFromIssuer = (issuer: string) => {
  const m = /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i.exec(issuer.trim());
  return m ? m[1]! : '';
};

/** An Entra ID Conditional Access authentication context id (step-up). */
const AUTH_CONTEXT = /^c([1-9]|[1-9][0-9])$/;

/** Warnings only the server can tell (they need the accounts or how the provider was stored). */
const SERVER_WARNINGS = new Set(['USERNAME_COLLISIONS', 'EMAIL_VERIFIED_NOW_REQUIRED']);

/** Where the provider-side steps of a preset are described. */
export const presetDocsUrl = (preset: SsoPreset) => `${BRAND.repoUrl}/blob/HEAD/docs/SSO.md#${SSO_PRESET_INFO[preset].docsAnchor}`;

/** A new provider's settings from a preset (pre-fill only: everything stays editable). */
function presetForm(preset: SsoPreset, buttonLabel: string): ProviderForm {
  const d = SSO_PRESET_INFO[preset].defaults;
  return {
    ...(d as Required<typeof d>),
    displayName: buttonLabel,
    issuer: preset === 'google' ? SSO_PRESET_INFO.google.issuerPattern : '',
    clientId: '',
    mappings: [],
    defaultRoles: [],
    enabled: true,
    // a fresh copy: the preset objects are shared
    stableIdClaims: [...(d.stableIdClaims ?? ['sub'])],
    requiredClaims: (d.requiredClaims ?? []).map((r) => ({ ...r, values: [...r.values] })),
    profileFields: [],
    sync: { ...d.sync! },
  };
}

const roleOptions = () => ROLES.map((r) => ({ value: r, label: i18n.t(`common:roles.${r}`) }));
const teamRoleOptions = () => TEAM_ROLES.map((r) => ({ value: r, label: i18n.t(`common:roles.${r}`) }));

export function ProviderEditor({ provider, onClose, onSaved }: { provider: SsoProvider | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['users', 'common', 'auth']);
  const defaultLabel = (p: SsoPreset) => (p === 'entra' ? 'Microsoft' : p === 'google' ? 'Google' : t('provider.defaultOidcName'));
  const [preset, setPreset] = useState<SsoPreset>(provider?.preset ?? 'entra');
  const kind = SSO_PRESET_INFO[preset].type;
  const [form, setForm] = useState<ProviderForm>(() => {
    if (!provider) return presetForm('entra', 'Microsoft');
    const { id: _id, hasClientSecret: _h, createdAt: _c, updatedAt: _u, type: _t, warnings: _w, ...rest } = provider;
    return rest;
  });
  const [tenant, setTenant] = useState(() => tenantFromIssuer(provider?.issuer ?? ''));
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [keepLinks, setKeepLinks] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [accounts, setAccounts] = useState(false);
  const [discovery, setDiscovery] = useState<SsoDiscoveryResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams') });
  const teamOptions = useMemo(() => (teams.data ?? []).map((team) => team.name), [teams.data]);

  const set = <K extends keyof ProviderForm>(k: K, v: ProviderForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const switchPreset = (p: SsoPreset) => {
    setPreset(p);
    if (!provider) {
      setForm((f) => ({
        ...presetForm(p, defaultLabel(p)),
        issuer: p === 'entra' && tenant ? entraIssuer(tenant) : p === 'google' ? SSO_PRESET_INFO.google.issuerPattern : f.issuer,
        clientId: f.clientId,
      }));
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
    const body = draft();
    if (removeSecret) body.clientSecret = '';
    else if (secret) body.clientSecret = secret;
    if (issuerMoved) body.keepLinksOnIssuerChange = keepLinks;
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

  /** The settings as the server takes them (also the draft the test sign-in previews). */
  function draft(): SsoProviderInput {
    return {
      ...form,
      type: kind,
      preset,
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      mappings: form.mappings.filter((m) => m.claimValue.trim()).map((m) => ({ ...m, claimValue: m.claimValue.trim() })),
      profileFields: form.profileFields
        .filter((f) => f.key.trim() || f.claim.trim())
        .map((f) => ({ ...f, key: f.key.trim(), claim: f.claim.trim(), label: f.label.trim() || f.key.trim() })),
      requiredClaims: form.requiredClaims.filter((r) => r.claim.trim()).map((r) => ({ ...r, claim: r.claim.trim() })),
      stepUpAcrValues: form.stepUpAcrValues.trim(),
      // an authentication context is an Entra ID setting
      stepUpAuthContext: kind === 'entra' ? form.stepUpAuthContext.trim() : '',
    };
  }
  const issuerMoved = !!provider && provider.issuer !== form.issuer.trim().replace(/\/+$/, '');
  // checked while typing; collisions of existing accounts come from the server (saved settings)
  const warnings = [
    ...ssoConfigWarnings({ ...form, type: kind }),
    ...(provider?.warnings ?? []).filter(
      (w) => SERVER_WARNINGS.has(w.code) && (w.code !== 'EMAIL_VERIFIED_NOW_REQUIRED' || (form.emailVerificationNotice && !form.emailVerifiedByProvider)),
    ),
  ];
  const needsSecret = form.clientAuth !== 'none';
  const valid =
    form.displayName.trim() &&
    /^https?:\/\//.test(form.issuer.trim()) &&
    form.clientId.trim() &&
    !stableIdProblem(form.stableIdClaims, form.stableIdConfirmedClaims) &&
    (form.usernameTransform !== 'stripDomain' || (form.stripDomains.length > 0 && form.stripDomains.every((d) => SSO_DOMAIN.test(d)))) &&
    form.requiredClaims.every((r) => !r.claim.trim() || r.values.length > 0) &&
    (kind !== 'entra' || !form.stepUpAuthContext.trim() || AUTH_CONTEXT.test(form.stepUpAuthContext.trim()));

  return (
    <Modal opened onClose={onClose} title={provider ? t('provider.edit', { name: provider.displayName }) : t('provider.add')} size="xl">
      <Stack>
        {!provider ? (
          <Select
            label={t('provider.preset')}
            description={t('provider.presetHint')}
            data={SSO_PRESETS.map((p) => ({ value: p, label: p === 'generic' ? t('provider.genericOidc') : SSO_PRESET_INFO[p].label }))}
            value={preset}
            onChange={(v) => v && switchPreset(v as SsoPreset)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
            data-testid="sso-preset"
          />
        ) : null}
        <Alert variant="light" color="blue" p="xs">
          <Text size="xs">{t(`provider.presetHints.${preset}`)}</Text>
          <Anchor href={presetDocsUrl(preset)} target="_blank" rel="noopener noreferrer" size="xs">
            <Group gap={4} component="span">
              {t('provider.presetDocs', { provider: preset === 'generic' ? t('provider.genericOidc') : SSO_PRESET_INFO[preset].label })}
              <IconExternalLink size={12} />
            </Group>
          </Anchor>
        </Alert>
        <ConfigWarnings warnings={warnings} />
        {provider?.emailVerificationNotice && (
          <Checkbox
            label={t('provider.emailNoticeDismiss')}
            description={t('provider.emailNoticeDismissHint')}
            checked={!form.emailVerificationNotice}
            onChange={(e) => set('emailVerificationNotice', !e.currentTarget.checked)}
            data-testid="sso-email-notice"
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
          placeholder={SSO_PRESET_INFO[preset].issuerPattern}
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
        {issuerMoved && (
          <Checkbox
            label={t('provider.keepLinks')}
            description={t('provider.keepLinksHint')}
            checked={keepLinks}
            onChange={(e) => setKeepLinks(e.currentTarget.checked)}
          />
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

        <UnstyledButton onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
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
            <ClaimFields form={form} set={set} />
            <StableIdField form={form} set={set} />
          </Stack>
        </Collapse>

        <UnstyledButton onClick={() => setAccounts((a) => !a)} aria-expanded={accounts}>
          <Group gap={4}>
            {accounts ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            <Text size="sm" fw={500}>
              {t('provider.accountsSection')}
            </Text>
          </Group>
        </UnstyledButton>
        <Collapse in={accounts}>
          <Stack gap="sm">
            <LinkingAndRequired form={form} set={set} />
            <ProfileAndSync form={form} set={set} />
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
                <Table.Th miw={160}>{t('provider.teamRoles')}</Table.Th>
                <Table.Th w={36} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {form.mappings.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={5}>
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
                      aria-label={t('provider.claimValue', { claim: form.groupsClaim || 'claim' })}
                      placeholder={form.groupValues === 'ids' ? t('provider.groupId') : kind === 'entra' ? 'SM.Operators' : t('provider.groupName')}
                      value={m.claimValue}
                      onChange={(e) => setMapping(i, { claimValue: e.currentTarget.value })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      aria-label={t('table.roles')}
                      data={roleOptions()}
                      value={m.roles}
                      onChange={(v) => setMapping(i, { roles: v as Role[] })}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      aria-label={t('table.teams')}
                      data={teamOptions}
                      value={m.teams}
                      onChange={(v) => setMapping(i, { teams: v })}
                      placeholder={teamOptions.length ? undefined : t('provider.noTeams')}
                      comboboxProps={{ withinPortal: true }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <MultiSelect
                      size="xs"
                      aria-label={t('provider.teamRoles')}
                      data={teamRoleOptions()}
                      value={m.teamRoles ?? []}
                      onChange={(v) => setMapping(i, { teamRoles: v as Role[] })}
                      disabled={!m.teams.length}
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
            onClick={() => set('mappings', [...form.mappings, { claimValue: '', roles: [], teams: [], teamRoles: [] }])}
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

        <Divider label={t('provider.stepUp.title')} labelPosition="left" />
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {t(preset === 'google' ? 'provider.stepUp.hintGoogle' : 'provider.stepUp.hint')}
          </Text>
          <Switch
            label={t('provider.stepUp.mfa')}
            description={t(kind === 'entra' ? 'provider.stepUp.mfaHintEntra' : 'provider.stepUp.mfaHint')}
            checked={form.stepUpMfa}
            onChange={(e) => set('stepUpMfa', e.currentTarget.checked)}
          />
          {form.stepUpMfa && (
            <Group grow align="flex-start">
              {kind === 'entra' && (
                <TextInput
                  label={t('provider.stepUp.authContext')}
                  description={t('provider.stepUp.authContextHint')}
                  // i18n-ignore: an Entra ID authentication context id, the same in every language
                  placeholder="c1"
                  classNames={{ input: 'mono' }}
                  value={form.stepUpAuthContext}
                  error={form.stepUpAuthContext && !AUTH_CONTEXT.test(form.stepUpAuthContext.trim()) ? t('provider.stepUp.authContextInvalid') : null}
                  onChange={(e) => set('stepUpAuthContext', e.currentTarget.value)}
                />
              )}
              <TextInput
                label={t('provider.stepUp.acrValues')}
                description={t('provider.stepUp.acrValuesHint')}
                classNames={{ input: 'mono' }}
                maxLength={200}
                value={form.stepUpAcrValues}
                onChange={(e) => set('stepUpAcrValues', e.currentTarget.value)}
              />
            </Group>
          )}
        </Stack>

        <TestSignIn providerId={provider?.id ?? null} draft={draft()} />

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
