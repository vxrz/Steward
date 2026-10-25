import { useState } from 'react';
import { ActionIcon, Badge, Button, Card, Code, CopyButton, Group, SimpleGrid, Switch, Text, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandWindows, IconCheck, IconCopy, IconEdit, IconKey, IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { SSO_PRESET_INFO, type SsoProvider, type SsoProviderInput } from '@sm/shared';
import { BRAND } from '../../../../shared/src/brand';
import { del, get, notifyError, put } from '../../api';
import { ProviderEditor } from './ProviderEditor';
import { confirmDanger } from '../confirm';

export const SSO_PROVIDERS_KEY = ['sso-providers'];

export function useSsoProviders(enabled = true) {
  return useQuery({ queryKey: SSO_PROVIDERS_KEY, queryFn: () => get<SsoProvider[]>('/sso/providers'), enabled });
}

function toInput(p: SsoProvider): SsoProviderInput {
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, warnings: _w, ...rest } = p;
  return rest;
}

export function SsoSection() {
  const { t } = useTranslation(['users', 'common']);
  const qc = useQueryClient();
  const providers = useSsoProviders();
  const redirect = useQuery({ queryKey: ['sso-redirect-uri'], queryFn: () => get<{ redirectUri: string }>('/sso/redirect-uri') });
  const [editing, setEditing] = useState<SsoProvider | 'new' | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: SSO_PROVIDERS_KEY });
    qc.invalidateQueries({ queryKey: ['auth'] });
  };

  const toggle = async (p: SsoProvider, enabled: boolean) => {
    try {
      await put(`/sso/providers/${p.id}`, { ...toInput(p), enabled });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  const remove = async (p: SsoProvider) => {
    if (!(await confirmDanger({ action: 'remove', message: t('sso.removeConfirm', { name: p.displayName }) }))) return;
    try {
      await del(`/sso/providers/${p.id}`);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <Group justify="space-between" mt="md">
        <Title order={4}>{t('sso.title')}</Title>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
          {t('sso.add')}
        </Button>
      </Group>
      <Card withBorder p="sm">
        <Text size="xs" c="dimmed">
          <Trans t={t} i18nKey="sso.redirectHint" components={{ b: <b /> }} />
        </Text>
        <Group gap={4} wrap="nowrap" mt={4}>
          <Code style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{redirect.data?.redirectUri ?? '…'}</Code>
          {redirect.data && (
            <CopyButton value={redirect.data.redirectUri}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? t('common:copied') : t('common:copy')}>
                  <ActionIcon variant="subtle" onClick={copy} aria-label={t('sso.copyRedirect')}>
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('sso.redirectMatch', { brand: BRAND.name })}
        </Text>
      </Card>
      {providers.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('sso.none')}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {providers.data?.map((p) => (
          <Card key={p.id} withBorder padding="sm">
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
                {p.type === 'entra' ? <IconBrandWindows size={20} /> : <IconKey size={20} />}
                <div style={{ minWidth: 0 }}>
                  <Text fw={600} truncate>
                    {p.displayName}
                  </Text>
                  <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
                    {p.issuer}
                  </Text>
                </div>
              </Group>
              <Group gap={2} wrap="nowrap">
                <Switch size="xs" checked={p.enabled} onChange={(e) => toggle(p, e.currentTarget.checked)} aria-label={t('sso.enabled')} />
                <ActionIcon variant="subtle" onClick={() => setEditing(p)} aria-label={t('common:edit')}>
                  <IconEdit size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" onClick={() => remove(p)} aria-label={t('common:delete')}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
            <Group gap={4} mt="xs">
              <Badge size="xs" variant="light" color={p.type === 'entra' ? 'blue' : 'gray'}>
                {p.preset === 'generic' ? 'OIDC' : SSO_PRESET_INFO[p.preset].label}
              </Badge>
              {!p.enabled && (
                <Badge size="xs" color="gray">
                  {t('sso.badges.disabled')}
                </Badge>
              )}
              <Badge size="xs" variant="outline">
                {t('sso.badges.mappings', { count: p.mappings.length })}
              </Badge>
              {p.autoProvision && (
                <Badge size="xs" variant="light" color="teal">
                  {t('sso.badges.autoProvision')}
                </Badge>
              )}
              {p.syncRoles && (
                <Badge size="xs" variant="light" color="violet">
                  {t('sso.badges.syncRoles')}
                </Badge>
              )}
              {p.requireMapping && (
                <Badge size="xs" variant="light" color="orange">
                  {t('sso.badges.requireMapping')}
                </Badge>
              )}
              {p.linkExisting === 'byName' && (
                <Badge size="xs" variant="light" color="orange">
                  {t('sso.badges.linkByName')}
                </Badge>
              )}
              {p.warnings.length > 0 && (
                <Badge size="xs" variant="outline" color="orange">
                  {t('sso.badges.warnings', { count: p.warnings.length })}
                </Badge>
              )}
              {p.clientAuth !== 'none' && !p.hasClientSecret && (
                <Badge size="xs" color="red">
                  {t('sso.badges.secretMissing')}
                </Badge>
              )}
            </Group>
          </Card>
        ))}
      </SimpleGrid>
      {editing && (
        <ProviderEditor
          provider={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
