import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Autocomplete,
  Button,
  Divider,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import YAML from 'yaml';
import { useTranslation } from 'react-i18next';
import type { AuthConfig, AuthType, HttpOptions, Platform, PlatformConfig } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { Hint, KeyValueEditor } from '../common';

const AUTH_OPTIONS: AuthType[] = ['none', 'basic', 'bearer', 'apiKey', 'oauth2_client_credentials', 'token_request'];

const toStringMap = (v: Record<string, unknown> | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));

/** Secrets referenced by an auth config. */
export function requiredSecrets(auth: AuthConfig | undefined): string[] {
  switch (auth?.type) {
    case 'basic':
      return ['username', 'password'];
    case 'bearer':
      return ['token'];
    case 'apiKey':
      return ['apiKey'];
    case 'oauth2_client_credentials':
      return ['clientId', 'clientSecret'];
    case 'token_request': {
      const text = JSON.stringify(auth.request ?? {});
      return [...new Set([...text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))];
    }
    default:
      return [];
  }
}

export function SettingsTab({ platform, readOnly = false }: { platform: Platform; readOnly?: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(platform.name);
  const [kind, setKind] = useState(platform.kind);
  const [environment, setEnvironment] = useState(platform.environment);
  const [description, setDescription] = useState(platform.description);
  const [baseUrl, setBaseUrl] = useState(platform.baseUrl);
  const [cfg, setCfg] = useState<PlatformConfig>(platform.config);
  const [bodyText, setBodyText] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(platform.name);
    setKind(platform.kind);
    setEnvironment(platform.environment);
    setDescription(platform.description);
    setBaseUrl(platform.baseUrl);
    setCfg(platform.config);
    const b = platform.config.auth?.request?.body;
    setBodyText(b === undefined ? '' : YAML.stringify(b, { lineWidth: 0 }));
    setBodyError(null);
  }, [platform]);

  const auth = cfg.auth ?? { type: 'none' };
  const setAuth = (patch: Partial<AuthConfig>) => setCfg({ ...cfg, auth: { ...auth, ...patch } });
  const setReq = (patch: Partial<NonNullable<AuthConfig['request']>>) => setAuth({ request: { method: 'POST', url: '', ...(auth.request ?? {}), ...patch } });
  const http = cfg.http ?? {};
  const setHttp = (patch: Partial<PlatformConfig['http']>) => setCfg({ ...cfg, http: { ...http, ...patch } });
  const retry = http.retry ?? {};
  const setRetry = (patch: Partial<NonNullable<HttpOptions['retry']>>) => {
    const next = Object.fromEntries(Object.entries({ ...retry, ...patch }).filter(([, v]) => v !== undefined && v !== false));
    setHttp({ retry: Object.keys(next).length ? next : undefined });
  };
  const num = (v: string | number) => (typeof v === 'number' ? v : undefined);

  const needed = useMemo(() => requiredSecrets(cfg.auth ?? { type: 'none' }), [cfg.auth]);
  const missing = needed.filter((k) => !platform.secretKeys.includes(k));

  const save = async () => {
    let config = cfg;
    if (auth.type === 'token_request') {
      let body: unknown = undefined;
      if (bodyText.trim()) {
        try {
          body = YAML.parse(bodyText);
        } catch (e) {
          setBodyError((e as Error).message);
          return;
        }
      }
      config = { ...cfg, auth: { ...auth, request: { method: 'POST', url: '', ...(auth.request ?? {}), body } } };
    }
    setBusy(true);
    try {
      await put(`/platforms/${platform.id}`, { name, kind, description, baseUrl, environment, config });
      await Promise.all([qc.invalidateQueries({ queryKey: ['platform', platform.id] }), qc.invalidateQueries({ queryKey: ['platforms'] })]);
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e, t('settings.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Stack>
        <Paper withBorder p="md">
          <Title order={5} mb="sm">
            {t('settings.general')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('common:name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Autocomplete
              label={t('settings.kind')}
              description={t('settings.kindHint')}
              data={['insights-hub', 'industrial-edge-management', 'generic']}
              value={kind}
              onChange={setKind}
            />
            <TextInput
              label={t('settings.environment')}
              placeholder={t('settings.environmentPlaceholder')}
              value={environment}
              onChange={(e) => setEnvironment(e.currentTarget.value)}
            />
            <TextInput
              label={t('settings.baseUrl')}
              classNames={{ input: 'mono' }}
              description={t('settings.baseUrlHint', { example: '{{ vars.region }}' })}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
            />
            <TextInput
              label={t('settings.testPath')}
              description={t('settings.testPathHint')}
              classNames={{ input: 'mono' }}
              value={cfg.testPath ?? ''}
              onChange={(e) => setCfg({ ...cfg, testPath: e.currentTarget.value || undefined })}
            />
            <TextInput
              label={t('settings.portalUrl')}
              description={t('settings.portalUrlHint')}
              classNames={{ input: 'mono' }}
              value={cfg.portalUrl ?? ''}
              onChange={(e) => setCfg({ ...cfg, portalUrl: e.currentTarget.value || undefined })}
            />
          </SimpleGrid>
          <Textarea
            label={t('settings.description')}
            mt="sm"
            autosize
            minRows={2}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
        </Paper>

        <Paper withBorder p="md">
          <Title order={5}>{t('settings.variables')}</Title>
          <Hint>
            {t('settings.variablesHint', { url: '{{ vars.tenant }}', conn: 'conn.<slot>.vars.tenant', pvar: "$pvar('<slot>', 'tenant', 'default')" })}
          </Hint>
          <Stack mt="sm">
            <KeyValueEditor value={cfg.variables} onChange={(v) => setCfg({ ...cfg, variables: toStringMap(v) })} addLabel={t('settings.addVariable')} />
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Title order={5} mb="sm">
            {t('settings.authentication')}
          </Title>
          <Stack>
            <Select
              label={t('settings.type')}
              data={AUTH_OPTIONS.map((a) => ({ value: a, label: t(`settings.authOptions.${a}`) }))}
              value={auth.type}
              allowDeselect={false}
              onChange={(v) => setAuth({ type: (v as AuthType) ?? 'none' })}
            />
            {needed.length > 0 && (
              <Alert color={missing.length ? 'orange' : 'gray'} variant="light">
                <Text size="sm">
                  {t('settings.needsSecrets')}{' '}
                  {needed.map((k) => (
                    <code key={k}>{k} </code>
                  ))}
                  {missing.length > 0 ? ` – ${t('settings.missingSecrets', { keys: missing.join(', ') })}` : ` – ${t('settings.allStored')}`}
                </Text>
              </Alert>
            )}
            {auth.type === 'apiKey' && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label={t('settings.apiKeyIn')}
                  data={[
                    { value: 'header', label: t('settings.inHeader') },
                    { value: 'query', label: t('settings.inQuery') },
                  ]}
                  value={auth.apiKeyIn ?? 'header'}
                  allowDeselect={false}
                  onChange={(v) => setAuth({ apiKeyIn: (v as 'header' | 'query') ?? 'header' })}
                />
                <TextInput
                  label={auth.apiKeyIn === 'query' ? t('settings.queryParam') : t('settings.headerName')}
                  placeholder={auth.apiKeyIn === 'query' ? 'api_key' : 'x-api-key'}
                  value={auth.apiKeyName ?? ''}
                  onChange={(e) => setAuth({ apiKeyName: e.currentTarget.value })}
                />
              </SimpleGrid>
            )}
            {auth.type === 'oauth2_client_credentials' && (
              <>
                <TextInput
                  label={t('settings.tokenUrl')}
                  classNames={{ input: 'mono' }}
                  description={t('settings.tokenUrlHint', { example: 'https://{{ vars.tenant }}.piam.{{ vars.region }}.mindsphere.io/oauth/token' })}
                  value={auth.tokenUrl ?? ''}
                  onChange={(e) => setAuth({ tokenUrl: e.currentTarget.value })}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput label={t('settings.scope')} value={auth.scope ?? ''} onChange={(e) => setAuth({ scope: e.currentTarget.value || undefined })} />
                  <Select
                    label={t('settings.clientAuth')}
                    data={[
                      { value: 'basic', label: t('settings.clientAuthBasic') },
                      { value: 'body', label: t('settings.clientAuthBody') },
                    ]}
                    value={auth.clientAuth ?? 'basic'}
                    allowDeselect={false}
                    onChange={(v) => setAuth({ clientAuth: (v as 'basic' | 'body') ?? 'basic' })}
                  />
                </SimpleGrid>
                <div>
                  <Text size="sm" fw={500} mb={4}>
                    {t('settings.extraParams')}
                  </Text>
                  <KeyValueEditor value={auth.extraParams} onChange={(v) => setAuth({ extraParams: v ? toStringMap(v) : undefined })} />
                </div>
              </>
            )}
            {auth.type === 'token_request' && (
              <>
                <Hint>{t('settings.tokenRequestHint', { secrets: '{{ secrets.x }}', vars: '{{ vars.x }}' })}</Hint>
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <Select
                    label={t('settings.method')}
                    data={['POST', 'GET', 'PUT']}
                    value={auth.request?.method ?? 'POST'}
                    allowDeselect={false}
                    onChange={(v) => setReq({ method: (v as 'POST' | 'GET' | 'PUT') ?? 'POST' })}
                  />
                  <TextInput
                    label={t('settings.loginUrl')}
                    classNames={{ input: 'mono' }}
                    description={t('settings.loginUrlHint')}
                    value={auth.request?.url ?? ''}
                    onChange={(e) => setReq({ url: e.currentTarget.value })}
                    style={{ gridColumn: 'span 2' }}
                  />
                </SimpleGrid>
                <div>
                  <Text size="sm" fw={500} mb={4}>
                    {t('settings.loginHeaders')}
                  </Text>
                  <KeyValueEditor value={auth.request?.headers} onChange={(v) => setReq({ headers: v ? toStringMap(v) : undefined })} />
                </div>
                <Textarea
                  label={t('settings.loginBody')}
                  classNames={{ input: 'mono' }}
                  autosize
                  minRows={3}
                  value={bodyText}
                  error={bodyError}
                  onChange={(e) => {
                    setBodyText(e.currentTarget.value);
                    setBodyError(null);
                  }}
                />
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label={t('settings.bodyEncoding')}
                    data={['json', 'form']}
                    value={auth.request?.bodyType ?? 'json'}
                    allowDeselect={false}
                    onChange={(v) => setReq({ bodyType: (v as 'json' | 'form') ?? 'json' })}
                  />
                  <TextInput
                    label={t('settings.tokenPath')}
                    classNames={{ input: 'mono' }}
                    placeholder="access_token"
                    value={auth.tokenPath ?? ''}
                    onChange={(e) => setAuth({ tokenPath: e.currentTarget.value })}
                  />
                  <TextInput
                    label={t('settings.expiresInPath')}
                    classNames={{ input: 'mono' }}
                    placeholder="expires_in"
                    value={auth.expiresInPath ?? ''}
                    onChange={(e) => setAuth({ expiresInPath: e.currentTarget.value || undefined })}
                  />
                  <TextInput
                    label={t('settings.headerName')}
                    placeholder="Authorization"
                    value={auth.headerName ?? ''}
                    onChange={(e) => setAuth({ headerName: e.currentTarget.value || undefined })}
                  />
                  <TextInput
                    label={t('settings.headerValue')}
                    classNames={{ input: 'mono' }}
                    placeholder="Bearer {{ token }}"
                    value={auth.headerValue ?? ''}
                    onChange={(e) => setAuth({ headerValue: e.currentTarget.value || undefined })}
                  />
                </SimpleGrid>
              </>
            )}
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Title order={5} mb="sm">
            {t('settings.http')}
          </Title>
          <Stack>
            <Switch
              label={t('settings.insecureTls')}
              description={t('settings.insecureTlsHint')}
              checked={!!http.insecureTls}
              onChange={(e) => setHttp({ insecureTls: e.currentTarget.checked })}
            />
            <Textarea
              label={t('settings.caPem')}
              classNames={{ input: 'mono' }}
              autosize
              minRows={2}
              maxRows={8}
              placeholder="-----BEGIN CERTIFICATE-----"
              value={http.caPem ?? ''}
              onChange={(e) => setHttp({ caPem: e.currentTarget.value || undefined })}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput
                label={t('settings.proxy')}
                description={t('settings.proxyHint')}
                classNames={{ input: 'mono' }}
                value={http.proxy ?? ''}
                onChange={(e) => setHttp({ proxy: e.currentTarget.value || undefined })}
              />
              <NumberInput
                label={t('settings.timeout')}
                placeholder="60000"
                min={1000}
                value={http.timeoutMs ?? ''}
                onChange={(v) => setHttp({ timeoutMs: typeof v === 'number' ? v : undefined })}
              />
            </SimpleGrid>
            <div>
              <Text size="sm" fw={500} mb={4}>
                {t('settings.defaultHeaders')}
              </Text>
              <KeyValueEditor value={http.defaultHeaders} onChange={(v) => setHttp({ defaultHeaders: v ? toStringMap(v) : undefined })} />
            </div>
            <Divider label={t('settings.retries')} labelPosition="left" />
            <Hint>{t('settings.retriesHint')}</Hint>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                label={t('settings.maxRetries')}
                description={t('settings.maxRetriesHint')}
                placeholder="3"
                min={0}
                max={10}
                value={retry.maxRetries ?? ''}
                onChange={(v) => setRetry({ maxRetries: num(v) })}
              />
              <NumberInput
                label={t('settings.maxConcurrency')}
                description={t('settings.maxConcurrencyHint')}
                placeholder="4"
                min={1}
                max={64}
                value={http.maxConcurrency ?? ''}
                onChange={(v) => setHttp({ maxConcurrency: num(v) })}
              />
              <NumberInput
                label={t('settings.baseDelay')}
                placeholder="500"
                min={0}
                step={100}
                value={retry.baseDelayMs ?? ''}
                onChange={(v) => setRetry({ baseDelayMs: num(v) })}
              />
              <NumberInput
                label={t('settings.maxDelay')}
                placeholder="30000"
                min={0}
                step={1000}
                value={retry.maxDelayMs ?? ''}
                onChange={(v) => setRetry({ maxDelayMs: num(v) })}
              />
            </SimpleGrid>
            <Switch
              label={t('settings.retryNonIdempotent')}
              description={t('settings.retryNonIdempotentHint')}
              checked={!!retry.retryNonIdempotent}
              onChange={(e) => setRetry({ retryNonIdempotent: e.currentTarget.checked })}
            />
            <TagsInput
              label={t('settings.trustedOrigins')}
              description={t('settings.trustedOriginsHint')}
              placeholder="https://gateway.example.com"
              value={http.trustedOrigins ?? []}
              onChange={(v) => setHttp({ trustedOrigins: v.length ? v : undefined })}
              disabled={readOnly}
            />
          </Stack>
        </Paper>

        {!readOnly && (
          <>
            <Divider />
            <Group justify="flex-end">
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} disabled={!name.trim()}>
                {t('settings.save')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </fieldset>
  );
}
