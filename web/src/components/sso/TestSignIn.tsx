import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Card, Code, Group, Loader, Stack, Table, Tabs, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { IconExternalLink, IconFlask } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ErrorParams, SsoClaimEntry, SsoProviderInput, SsoSignInPreview, SsoTestResult, SsoTestStart } from '@sm/shared';
import { notifyError, post } from '../../api';
import { codeText, errorText } from '../../i18n/errors';
import { listFormat } from '../../format';

const OUTCOME_COLOR: Record<SsoSignInPreview['outcome'], string> = { signIn: 'blue', relink: 'blue', link: 'teal', create: 'green', refuse: 'red' };

const text = (params: ErrorParams | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, Array.isArray(v) ? listFormat().format(v.map(String)) : String(v ?? '')]));

/**
 * Test sign-in: the administrator signs in once through the (saved) provider in a new window and sees the claims it
 * sends and what a sign-in would do with the settings in the form – nothing signs in, no account changes. Claim
 * values are shown as text (React escapes them) and the server bounds them.
 */
export function TestSignIn({ providerId, draft }: { providerId: string | null; draft: SsoProviderInput }) {
  const { t } = useTranslation('users');
  const [test, setTest] = useState<SsoTestStart | null>(null);
  const [starting, setStarting] = useState(false);
  const { clientSecret: _secret, ...config } = draft;
  // as text: a value that only changes when a setting does (the form builds a new object at every render)
  const [debounced] = useDebouncedValue(JSON.stringify(config), 400);
  const result = useQuery({
    queryKey: ['sso-test', test?.testId, debounced],
    queryFn: () => post<SsoTestResult>(`/sso/test-sign-ins/${test!.testId}`, { config: JSON.parse(debounced) }),
    enabled: !!test,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 1500 : false),
    placeholderData: keepPreviousData,
  });

  const start = async () => {
    if (!providerId) return;
    setStarting(true);
    try {
      const s = await post<SsoTestStart>(`/sso/providers/${providerId}/test-sign-in`, {});
      setTest(s);
      // a new window without a reference back to Steward (the identity provider's page cannot reach this one)
      window.open(s.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notifyError(e, t('provider.test.notStarted'));
    } finally {
      setStarting(false);
    }
  };

  const r = result.data;
  return (
    <Card withBorder p="sm" data-testid="sso-test">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text fw={600} size="sm">
            {t('provider.test.title')}
          </Text>
          <Button size="xs" variant="light" leftSection={<IconFlask size={14} />} loading={starting} disabled={!providerId} onClick={start}>
            {test ? t('provider.test.again') : t('provider.test.start')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {providerId ? t('provider.test.hint') : t('provider.test.saveFirst')}
        </Text>
        {test && (!r || r.status === 'pending') && !result.isError && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm">{t('provider.test.waiting')}</Text>
            <Anchor href={test.authorizationUrl} target="_blank" rel="noopener noreferrer" size="sm">
              <Group gap={4} component="span">
                {t('provider.test.open')} <IconExternalLink size={12} />
              </Group>
            </Anchor>
          </Group>
        )}
        {result.isError && (
          <Alert color="red" variant="light" p="xs">
            {errorText(result.error)}
          </Alert>
        )}
        {r?.status === 'failed' && (
          <Alert color="red" variant="light" p="xs" data-testid="sso-test-failed">
            {t('provider.test.failed', { error: r.error ?? '' })}
          </Alert>
        )}
        {r?.status === 'done' && (
          <Tabs defaultValue="preview" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="preview">{t('provider.test.preview')}</Tabs.Tab>
              <Tabs.Tab value="idToken">{t('provider.test.idToken', { count: r.idToken?.length ?? 0 })}</Tabs.Tab>
              <Tabs.Tab value="userinfo">{t('provider.test.userinfo', { count: r.userinfo?.length ?? 0 })}</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="preview" pt="xs">
              {r.preview && <Preview preview={r.preview} />}
            </Tabs.Panel>
            <Tabs.Panel value="idToken" pt="xs">
              <Claims claims={r.idToken ?? []} />
            </Tabs.Panel>
            <Tabs.Panel value="userinfo" pt="xs">
              {r.userinfoError && (
                <Alert color="orange" variant="light" p="xs" mb="xs">
                  {t('provider.test.userinfoError', { error: r.userinfoError })}
                </Alert>
              )}
              <Claims claims={r.userinfo ?? []} />
            </Tabs.Panel>
          </Tabs>
        )}
      </Stack>
    </Card>
  );
}

function Claims({ claims }: { claims: SsoClaimEntry[] }) {
  const { t } = useTranslation('users');
  if (!claims.length) {
    return (
      <Text size="xs" c="dimmed">
        {t('provider.test.noClaims')}
      </Text>
    );
  }
  return (
    <div className="table-scroll">
      <Table fz="xs" verticalSpacing={2} withTableBorder data-testid="sso-test-claims">
        <Table.Thead>
          <Table.Tr>
            <Table.Th miw={120}>{t('provider.test.claim')}</Table.Th>
            <Table.Th>{t('provider.test.value')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {claims.map((c) => (
            <Table.Tr key={c.name}>
              <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                {c.name}
              </Table.Td>
              <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                {c.value}
                {c.truncated && (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    {t('provider.test.truncated')}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function Preview({ preview: p }: { preview: SsoSignInPreview }) {
  const { t } = useTranslation(['users', 'common']);
  const none = t('provider.test.none');
  // note codes come from the server (users:provider.test.notes.<code>)
  const noteText = t as unknown as (key: string, options: Record<string, string>) => string;
  const account = p.account?.username ?? p.username;
  const rows: [string, ReactNode][] = [
    [
      t('provider.test.username'),
      <>
        <Code>{p.username}</Code>{' '}
        <Text span size="xs" c="dimmed">
          {t('provider.test.usernameFrom', { claim: p.usernameFrom.claim, value: p.usernameFrom.value })}
        </Text>
      </>,
    ],
    [t('provider.test.displayName'), p.displayName],
    [t('provider.test.firstName'), p.firstName ?? none],
    [t('provider.test.lastName'), p.lastName ?? none],
    [
      t('provider.test.email'),
      <>
        {p.email ?? none}{' '}
        <Badge size="xs" variant="light" color={p.emailVerified ? 'green' : p.emailVerificationRequired ? 'red' : 'gray'}>
          {p.emailVerified === null
            ? t('provider.test.emailVerifiedMissing')
            : p.emailVerified
              ? t('provider.test.emailVerified')
              : t('provider.test.emailNotVerified')}
        </Badge>
        {p.emailVerificationRequired && (
          <Text span size="xs" c="dimmed">
            {' '}
            {t('provider.test.emailRequired')}
          </Text>
        )}
      </>,
    ],
    [
      t('provider.test.stableId'),
      <>
        {p.stableId.claims.map((c) => (
          <div key={c.name}>
            <Code>{c.name}</Code> ={' '}
            {c.value ?? (
              <Text span c="red">
                {t('provider.test.missing')}
              </Text>
            )}
          </div>
        ))}
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {t('provider.test.issuer', { issuer: p.stableId.issuer })}
        </Text>
      </>,
    ],
    [
      t('provider.test.groups', { claim: p.groups.claim || none }),
      <>
        {p.groups.values.length ? p.groups.values.join(', ') : none}
        {p.groups.matched.length > 0 && (
          <Text size="xs" c="dimmed">
            {t('provider.test.matched', { values: p.groups.matched.join(', ') })}
          </Text>
        )}
      </>,
    ],
    [t('provider.test.roles'), p.roles.length ? p.roles.map((r) => t(`common:roles.${r}`)).join(', ') : none],
    [t('provider.test.teams'), p.teams.length ? p.teams.join(', ') : none],
    ...p.profile.map((f): [string, ReactNode] => [f.label, f.value]),
  ];
  return (
    <Stack gap="xs" data-testid="sso-test-preview">
      <Group gap="xs" wrap="wrap">
        <Badge color={OUTCOME_COLOR[p.outcome]} variant="light">
          {t(`provider.test.outcomes.${p.outcome}`, { username: account })}
        </Badge>
        {p.relinkFrom && (
          <Text size="xs" c="dimmed">
            {t(`provider.test.relinkFrom.${p.relinkFrom}`)}
          </Text>
        )}
      </Group>
      {p.refusal && (
        <Alert color="red" variant="light" p="xs" data-testid="sso-test-refusal">
          {codeText(p.refusal.code, p.refusal.params, p.refusal.message) ?? p.refusal.message}
        </Alert>
      )}
      {p.notes.map((n, i) => (
        <Alert key={`${n.code}-${i}`} color={n.code === 'GROUPS_OVERAGE' ? 'orange' : 'gray'} variant="light" p="xs">
          {noteText(`provider.test.notes.${n.code}`, text(n.params))}
        </Alert>
      ))}
      <Text size="xs" c="dimmed">
        {t('provider.test.previewHint')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" verticalSpacing={2} withTableBorder>
          <Table.Tbody>
            {rows.map(([label, value]) => (
              <Table.Tr key={label}>
                <Table.Th w="35%" fw={500}>
                  {label}
                </Table.Th>
                <Table.Td style={{ wordBreak: 'break-word' }}>{value}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}
