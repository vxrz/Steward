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
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import YAML from 'yaml';
import type { AuthConfig, AuthType, Platform, PlatformConfig } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { Hint, KeyValueEditor } from '../common';

const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic auth (username / password)' },
  { value: 'bearer', label: 'Static bearer token' },
  { value: 'apiKey', label: 'API key (header or query)' },
  { value: 'oauth2_client_credentials', label: 'OAuth2 client credentials' },
  { value: 'token_request', label: 'Custom login request (token from response)' },
];

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

export function SettingsTab({ platform }: { platform: Platform }) {
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
  const setReq = (patch: Partial<NonNullable<AuthConfig['request']>>) =>
    setAuth({ request: { method: 'POST', url: '', ...(auth.request ?? {}), ...patch } });
  const http = cfg.http ?? {};
  const setHttp = (patch: Partial<PlatformConfig['http']>) => setCfg({ ...cfg, http: { ...http, ...patch } });

  const needed = useMemo(() => requiredSecrets(auth), [auth]);
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
      notifyOk('Platform saved');
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          General
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Autocomplete
            label="Kind"
            description="Processes can require a kind for a connection"
            data={['insights-hub', 'industrial-edge-management', 'generic']}
            value={kind}
            onChange={setKind}
          />
          <TextInput label="Environment" placeholder="prod, test…" value={environment} onChange={(e) => setEnvironment(e.currentTarget.value)} />
          <TextInput
            label="Base URL"
            classNames={{ input: 'mono' }}
            description="May contain templates such as {{ vars.region }}"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
          />
          <TextInput
            label="Test path"
            description="GET request used by “Test connection”"
            classNames={{ input: 'mono' }}
            value={cfg.testPath ?? ''}
            onChange={(e) => setCfg({ ...cfg, testPath: e.currentTarget.value || undefined })}
          />
          <TextInput
            label="Portal URL"
            description="Start URL for browser automation (default: base URL)"
            classNames={{ input: 'mono' }}
            value={cfg.portalUrl ?? ''}
            onChange={(e) => setCfg({ ...cfg, portalUrl: e.currentTarget.value || undefined })}
          />
        </SimpleGrid>
        <Textarea label="Description" mt="sm" autosize minRows={2} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
      </Paper>

      <Paper withBorder p="md">
        <Title order={5}>Variables</Title>
        <Hint>
          Non-secret values such as tenant or region. Usable in URLs as {'{{ vars.tenant }}'}, in processes as conn.&lt;slot&gt;.vars.tenant or
          $pvar('&lt;slot&gt;', 'tenant', 'default').
        </Hint>
        <Stack mt="sm">
          <KeyValueEditor value={cfg.variables} onChange={(v) => setCfg({ ...cfg, variables: toStringMap(v) })} addLabel="Add variable" />
        </Stack>
      </Paper>

      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Authentication
        </Title>
        <Stack>
          <Select
            label="Type"
            data={AUTH_OPTIONS}
            value={auth.type}
            allowDeselect={false}
            onChange={(v) => setAuth({ type: (v as AuthType) ?? 'none' })}
          />
          {needed.length > 0 && (
            <Alert color={missing.length ? 'orange' : 'gray'} variant="light">
              <Text size="sm">
                Needs secrets: {needed.map((k) => <code key={k}>{k} </code>)}
                {missing.length > 0 ? ` – missing: ${missing.join(', ')} (add them on the Credentials tab)` : ' – all stored'}
              </Text>
            </Alert>
          )}
          {auth.type === 'apiKey' && (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label="Send key in"
                data={['header', 'query']}
                value={auth.apiKeyIn ?? 'header'}
                allowDeselect={false}
                onChange={(v) => setAuth({ apiKeyIn: (v as 'header' | 'query') ?? 'header' })}
              />
              <TextInput
                label={auth.apiKeyIn === 'query' ? 'Query parameter' : 'Header name'}
                placeholder={auth.apiKeyIn === 'query' ? 'api_key' : 'x-api-key'}
                value={auth.apiKeyName ?? ''}
                onChange={(e) => setAuth({ apiKeyName: e.currentTarget.value })}
              />
            </SimpleGrid>
          )}
          {auth.type === 'oauth2_client_credentials' && (
            <>
              <TextInput
                label="Token URL"
                classNames={{ input: 'mono' }}
                description="Templates allowed, e.g. https://{{ vars.tenant }}.piam.{{ vars.region }}.mindsphere.io/oauth/token"
                value={auth.tokenUrl ?? ''}
                onChange={(e) => setAuth({ tokenUrl: e.currentTarget.value })}
              />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="Scope" value={auth.scope ?? ''} onChange={(e) => setAuth({ scope: e.currentTarget.value || undefined })} />
                <Select
                  label="Send client credentials as"
                  data={[
                    { value: 'basic', label: 'Basic auth header' },
                    { value: 'body', label: 'Form body (client_id / client_secret)' },
                  ]}
                  value={auth.clientAuth ?? 'basic'}
                  allowDeselect={false}
                  onChange={(v) => setAuth({ clientAuth: (v as 'basic' | 'body') ?? 'basic' })}
                />
              </SimpleGrid>
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Extra token parameters
                </Text>
                <KeyValueEditor value={auth.extraParams} onChange={(v) => setAuth({ extraParams: v ? toStringMap(v) : undefined })} />
              </div>
            </>
          )}
          {auth.type === 'token_request' && (
            <>
              <Hint>
                A login call is made first; the token is extracted from its response and added to every API call. Use {'{{ secrets.x }}'} and{' '}
                {'{{ vars.x }}'} in URL, headers and body.
              </Hint>
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <Select
                  label="Method"
                  data={['POST', 'GET', 'PUT']}
                  value={auth.request?.method ?? 'POST'}
                  allowDeselect={false}
                  onChange={(v) => setReq({ method: (v as 'POST' | 'GET' | 'PUT') ?? 'POST' })}
                />
                <TextInput
                  label="Login URL"
                  classNames={{ input: 'mono' }}
                  description="Absolute or relative to base URL"
                  value={auth.request?.url ?? ''}
                  onChange={(e) => setReq({ url: e.currentTarget.value })}
                  style={{ gridColumn: 'span 2' }}
                />
              </SimpleGrid>
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Login headers
                </Text>
                <KeyValueEditor value={auth.request?.headers} onChange={(v) => setReq({ headers: v ? toStringMap(v) : undefined })} />
              </div>
              <Textarea
                label="Login body (JSON or YAML)"
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
                  label="Body encoding"
                  data={['json', 'form']}
                  value={auth.request?.bodyType ?? 'json'}
                  allowDeselect={false}
                  onChange={(v) => setReq({ bodyType: (v as 'json' | 'form') ?? 'json' })}
                />
                <TextInput
                  label="Token path (JSONata)"
                  classNames={{ input: 'mono' }}
                  placeholder="access_token"
                  value={auth.tokenPath ?? ''}
                  onChange={(e) => setAuth({ tokenPath: e.currentTarget.value })}
                />
                <TextInput
                  label="Expires-in path (seconds, optional)"
                  classNames={{ input: 'mono' }}
                  placeholder="expires_in"
                  value={auth.expiresInPath ?? ''}
                  onChange={(e) => setAuth({ expiresInPath: e.currentTarget.value || undefined })}
                />
                <TextInput
                  label="Header name"
                  placeholder="Authorization"
                  value={auth.headerName ?? ''}
                  onChange={(e) => setAuth({ headerName: e.currentTarget.value || undefined })}
                />
                <TextInput
                  label="Header value"
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
          HTTP options
        </Title>
        <Stack>
          <Switch
            label="Accept self-signed certificates"
            description="Common for on-premise Industrial Edge Management. Prefer adding the CA certificate below."
            checked={!!http.insecureTls}
            onChange={(e) => setHttp({ insecureTls: e.currentTarget.checked })}
          />
          <Textarea
            label="Additional CA certificate (PEM)"
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
              label="Proxy"
              description="Empty = HTTPS_PROXY / NO_PROXY environment, 'none' = direct, or a URL"
              classNames={{ input: 'mono' }}
              value={http.proxy ?? ''}
              onChange={(e) => setHttp({ proxy: e.currentTarget.value || undefined })}
            />
            <NumberInput
              label="Timeout (ms)"
              placeholder="60000"
              min={1000}
              value={http.timeoutMs ?? ''}
              onChange={(v) => setHttp({ timeoutMs: typeof v === 'number' ? v : undefined })}
            />
          </SimpleGrid>
          <div>
            <Text size="sm" fw={500} mb={4}>
              Default headers
            </Text>
            <KeyValueEditor value={http.defaultHeaders} onChange={(v) => setHttp({ defaultHeaders: v ? toStringMap(v) : undefined })} />
          </div>
        </Stack>
      </Paper>

      <Divider />
      <Group justify="flex-end">
        <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} disabled={!name.trim()}>
          Save settings
        </Button>
      </Group>
    </Stack>
  );
}
