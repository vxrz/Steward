import { ActionIcon, Button, Divider, Group, Radio, Select, Stack, Switch, Table, TagsInput, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  SSO_LIMITS,
  SSO_LINK_POLICIES,
  SSO_SYNCED_FIELDS,
  type SsoGroupValues,
  type SsoProfileField,
  type SsoProvider,
  type SsoRequiredClaim,
  type SsoSyncRule,
  type SsoUsernameTransform,
} from '@sm/shared';

/** The editor's form: every setting of a provider except the ones the server keeps. */
export type ProviderForm = Omit<SsoProvider, 'id' | 'hasClientSecret' | 'createdAt' | 'updatedAt' | 'type' | 'warnings'>;
type Set = <K extends keyof ProviderForm>(k: K, v: ProviderForm[K]) => void;

/** Scopes, claim names, user name rule, names and e-mail. */
export function ClaimFields({ form, set }: { form: ProviderForm; set: Set }) {
  const { t } = useTranslation('users');
  return (
    <Stack gap="xs">
      <TextInput label={t('provider.scopes')} value={form.scopes} onChange={(e) => set('scopes', e.currentTarget.value)} />
      <Group grow align="flex-start">
        <TextInput label={t('provider.usernameClaim')} value={form.usernameClaim} onChange={(e) => set('usernameClaim', e.currentTarget.value)} />
        <Select
          label={t('provider.usernameTransform')}
          data={(['lowercase', 'stripDomain', 'none'] as const).map((v) => ({ value: v, label: t(`provider.usernameTransforms.${v}`) }))}
          value={form.usernameTransform}
          onChange={(v) => v && set('usernameTransform', v as SsoUsernameTransform)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput label={t('provider.displayNameClaim')} value={form.displayNameClaim} onChange={(e) => set('displayNameClaim', e.currentTarget.value)} />
        <TextInput
          label={t('provider.displayNameTemplate')}
          description={t('provider.displayNameTemplateHint')}
          // i18n-ignore: claim names in the template syntax, the same in every language
          placeholder="{given_name} {family_name}"
          maxLength={SSO_LIMITS.template}
          value={form.displayNameTemplate}
          onChange={(e) => set('displayNameTemplate', e.currentTarget.value)}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput label={t('provider.firstNameClaim')} value={form.firstNameClaim} onChange={(e) => set('firstNameClaim', e.currentTarget.value)} />
        <TextInput label={t('provider.lastNameClaim')} value={form.lastNameClaim} onChange={(e) => set('lastNameClaim', e.currentTarget.value)} />
      </Group>
      <TextInput label={t('provider.emailClaim')} value={form.emailClaim} onChange={(e) => set('emailClaim', e.currentTarget.value)} />
      <Switch
        label={t('provider.emailVerifiedByProvider')}
        description={t('provider.emailVerifiedByProviderHint')}
        checked={form.emailVerifiedByProvider}
        onChange={(e) => set('emailVerifiedByProvider', e.currentTarget.checked)}
      />
      <Switch
        label={t('provider.useUserinfo')}
        description={t('provider.useUserinfoHint')}
        checked={form.useUserinfo}
        onChange={(e) => set('useUserinfo', e.currentTarget.checked)}
      />
      <Group grow align="flex-start">
        <TextInput
          label={t('provider.groupsClaim')}
          description={t('provider.groupsClaimHint')}
          value={form.groupsClaim}
          onChange={(e) => set('groupsClaim', e.currentTarget.value)}
        />
        <Select
          label={t('provider.groupValues')}
          data={(['names', 'ids'] as const).map((v) => ({ value: v, label: t(`provider.groupValueOptions.${v}`) }))}
          value={form.groupValues}
          onChange={(v) => v && set('groupValues', v as SsoGroupValues)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
      </Group>
    </Stack>
  );
}

/** The claims that identify a person for good. */
export function StableIdField({ form, set }: { form: ProviderForm; set: Set }) {
  const { t } = useTranslation('users');
  return (
    <TagsInput
      label={t('provider.stableId')}
      description={t('provider.stableIdHint')}
      value={form.stableIdClaims}
      onChange={(v) => set('stableIdClaims', v.map((x) => x.trim()).filter(Boolean))}
      maxTags={SSO_LIMITS.stableIdClaims}
      error={form.stableIdClaims.length ? undefined : t('provider.stableIdRequired')}
      data-testid="sso-stable-id"
    />
  );
}

/** Read-only account fields from claims, and how name and e-mail follow the provider. */
export function ProfileAndSync({ form, set }: { form: ProviderForm; set: Set }) {
  const { t } = useTranslation('users');
  const syncOptions = (['always', 'create'] as const).map((v) => ({ value: v, label: t(`provider.syncRules.${v}`) }));
  const setField = (i: number, f: Partial<SsoProfileField>) =>
    set(
      'profileFields',
      form.profileFields.map((x, j) => (j === i ? { ...x, ...f } : x)),
    );
  return (
    <Stack gap="xs">
      <Text size="sm" fw={500}>
        {t('provider.syncTitle')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" verticalSpacing={4} withTableBorder>
          <Table.Tbody>
            {SSO_SYNCED_FIELDS.map((f) => (
              <Table.Tr key={f}>
                <Table.Td miw={120}>{t(`provider.syncFields.${f}`)}</Table.Td>
                <Table.Td miw={220}>
                  <Select
                    size="xs"
                    aria-label={t('provider.syncFor', { field: t(`provider.syncFields.${f}`) })}
                    data={syncOptions}
                    value={form.sync[f]}
                    onChange={(v) => v && set('sync', { ...form.sync, [f]: v as SsoSyncRule })}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <Divider label={t('provider.profileFields')} labelPosition="left" />
      <Text size="xs" c="dimmed">
        {t('provider.profileFieldsHint')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" verticalSpacing={4} withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th miw={110}>{t('provider.profileKey')}</Table.Th>
              <Table.Th miw={130}>{t('provider.profileLabel')}</Table.Th>
              <Table.Th miw={150}>{t('provider.profileClaim')}</Table.Th>
              <Table.Th miw={190}>{t('provider.profileSync')}</Table.Th>
              <Table.Th w={36} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {form.profileFields.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={5}>
                  <Text size="xs" c="dimmed">
                    {t('provider.noProfileFields')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {form.profileFields.map((f, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  <TextInput
                    size="xs"
                    classNames={{ input: 'mono' }}
                    aria-label={t('provider.profileKey')}
                    // i18n-ignore: an example field key (an identifier)
                    placeholder="department"
                    value={f.key}
                    onChange={(e) => setField(i, { key: e.currentTarget.value })}
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    size="xs"
                    aria-label={t('provider.profileLabel')}
                    value={f.label}
                    onChange={(e) => setField(i, { label: e.currentTarget.value })}
                  />
                </Table.Td>
                <Table.Td>
                  <TextInput
                    size="xs"
                    classNames={{ input: 'mono' }}
                    aria-label={t('provider.profileClaim')}
                    // i18n-ignore: an example claim name
                    placeholder="address.locality"
                    value={f.claim}
                    onChange={(e) => setField(i, { claim: e.currentTarget.value })}
                  />
                </Table.Td>
                <Table.Td>
                  <Select
                    size="xs"
                    aria-label={t('provider.profileSync')}
                    data={syncOptions}
                    value={f.sync}
                    onChange={(v) => v && setField(i, { sync: v as SsoSyncRule })}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                  />
                </Table.Td>
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      set(
                        'profileFields',
                        form.profileFields.filter((_, j) => j !== i),
                      )
                    }
                    aria-label={t('provider.removeProfileField')}
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
          disabled={form.profileFields.length >= SSO_LIMITS.profileFields}
          onClick={() => set('profileFields', [...form.profileFields, { key: '', label: '', claim: '', sync: 'always' }])}
        >
          {t('provider.addProfileField')}
        </Button>
      </Group>
    </Stack>
  );
}

/** Which existing accounts an identity's first sign-in may link, and the claims it must have. */
export function LinkingAndRequired({ form, set }: { form: ProviderForm; set: Set }) {
  const { t } = useTranslation('users');
  const setRule = (i: number, r: Partial<SsoRequiredClaim>) =>
    set(
      'requiredClaims',
      form.requiredClaims.map((x, j) => (j === i ? { ...x, ...r } : x)),
    );
  return (
    <Stack gap="xs">
      <Radio.Group
        label={t('provider.linkExisting')}
        description={t('provider.linkExistingHint')}
        value={form.linkExisting}
        onChange={(v) => set('linkExisting', v as ProviderForm['linkExisting'])}
      >
        <Stack gap={6} mt={6}>
          {(['bound', 'byName', 'never'] as const satisfies readonly (typeof SSO_LINK_POLICIES)[number][]).map((v) => (
            <Radio key={v} value={v} label={t(`provider.linkPolicies.${v}`)} description={t(`provider.linkPolicyHints.${v}`)} />
          ))}
        </Stack>
      </Radio.Group>
      <Divider label={t('provider.requiredClaims')} labelPosition="left" />
      <Text size="xs" c="dimmed">
        {t('provider.requiredClaimsHint')}
      </Text>
      {form.requiredClaims.map((r, i) => (
        <Group key={i} align="flex-start" wrap="nowrap" gap="xs">
          <TextInput
            size="xs"
            w={130}
            classNames={{ input: 'mono' }}
            aria-label={t('provider.requiredClaim')}
            // i18n-ignore: an example claim name
            placeholder="hd"
            value={r.claim}
            onChange={(e) => setRule(i, { claim: e.currentTarget.value })}
          />
          <TagsInput
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            aria-label={t('provider.requiredValues')}
            placeholder={t('provider.requiredValuesPlaceholder')}
            value={r.values}
            maxTags={SSO_LIMITS.requiredClaimValues}
            onChange={(v) => setRule(i, { values: v })}
            error={r.values.length ? undefined : t('provider.requiredValuesMissing')}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            mt={4}
            onClick={() =>
              set(
                'requiredClaims',
                form.requiredClaims.filter((_, j) => j !== i),
              )
            }
            aria-label={t('provider.removeRequiredClaim')}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={form.requiredClaims.length >= SSO_LIMITS.requiredClaims}
          onClick={() => set('requiredClaims', [...form.requiredClaims, { claim: '', values: [] }])}
        >
          {t('provider.addRequiredClaim')}
        </Button>
      </Group>
    </Stack>
  );
}
