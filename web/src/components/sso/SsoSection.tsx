import { useState } from 'react';
import { ActionIcon, Badge, Button, Card, Code, CopyButton, Group, SimpleGrid, Stack, Switch, Text, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandWindows, IconCheck, IconCopy, IconEdit, IconKey, IconPlus, IconTrash } from '@tabler/icons-react';
import type { SsoProvider, SsoProviderInput } from '@sm/shared';
import { del, get, notifyError, put } from '../../api';
import { ProviderEditor } from './ProviderEditor';

export const SSO_PROVIDERS_KEY = ['sso-providers'];

export function useSsoProviders(enabled = true) {
  return useQuery({ queryKey: SSO_PROVIDERS_KEY, queryFn: () => get<SsoProvider[]>('/sso/providers'), enabled });
}

function toInput(p: SsoProvider): SsoProviderInput {
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest;
}

export function SsoSection() {
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
    if (!confirm(`Remove single sign-on "${p.displayName}"? Users of this provider can no longer sign in (their accounts and history stay).`)) return;
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
        <Title order={4}>Single sign-on</Title>
        <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
          Add provider
        </Button>
      </Group>
      <Card withBorder p="sm">
        <Text size="xs" c="dimmed">
          Register this as redirect URI (type <b>Web</b>) in your identity provider / Entra app registration:
        </Text>
        <Group gap={4} wrap="nowrap" mt={4}>
          <Code style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{redirect.data?.redirectUri ?? '…'}</Code>
          {redirect.data && (
            <CopyButton value={redirect.data.redirectUri}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy'}>
                  <ActionIcon variant="subtle" onClick={copy} aria-label="Copy redirect URI">
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          It must match exactly how users open Steward (host name and http/https). Entra ID only accepts http for localhost.
        </Text>
      </Card>
      {providers.data?.length === 0 && (
        <Text size="sm" c="dimmed">
          No single sign-on configured. Add Microsoft Entra ID or any OpenID Connect provider (Okta, Keycloak, Google Workspace, ADFS …).
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
                <Switch size="xs" checked={p.enabled} onChange={(e) => toggle(p, e.currentTarget.checked)} aria-label="Enabled" />
                <ActionIcon variant="subtle" onClick={() => setEditing(p)} aria-label="Edit">
                  <IconEdit size={16} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" onClick={() => remove(p)} aria-label="Delete">
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Group>
            <Group gap={4} mt="xs">
              <Badge size="xs" variant="light" color={p.type === 'entra' ? 'blue' : 'gray'}>
                {p.type === 'entra' ? 'Entra ID' : 'OIDC'}
              </Badge>
              {!p.enabled && (
                <Badge size="xs" color="gray">
                  disabled
                </Badge>
              )}
              <Badge size="xs" variant="outline">
                {p.mappings.length} mapping(s)
              </Badge>
              {p.autoProvision && (
                <Badge size="xs" variant="light" color="teal">
                  auto-provision
                </Badge>
              )}
              {p.syncRoles && (
                <Badge size="xs" variant="light" color="violet">
                  role sync
                </Badge>
              )}
              {p.requireMapping && (
                <Badge size="xs" variant="light" color="orange">
                  mapping required
                </Badge>
              )}
              {p.clientAuth !== 'none' && !p.hasClientSecret && (
                <Badge size="xs" color="red">
                  secret missing
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
