import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Collapse, Group, Paper, Select, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import type { Platform } from '@sm/shared';
import { post } from '../../api';
import { Hint, JsonView, KeyValueEditor } from '../common';

export interface ExplorerPreset {
  method: string;
  path: string;
  nonce: number;
}

interface ExplorerResult {
  status: number;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const toStringMap = (v: Record<string, unknown> | undefined): Record<string, string> | undefined =>
  v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)])) : undefined;

export function ExplorerTab({ platform, preset }: { platform: Platform; preset: ExplorerPreset | null }) {
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState(platform.config.testPath || '/');
  const [query, setQuery] = useState<Record<string, unknown> | undefined>();
  const [headers, setHeaders] = useState<Record<string, unknown> | undefined>();
  const [body, setBody] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplorerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);

  useEffect(() => {
    if (preset) {
      setMethod(preset.method);
      setPath(preset.path);
      setConfirmed(false);
    }
  }, [preset]);

  const writes = method !== 'GET' && method !== 'HEAD';

  const send = async () => {
    setError(null);
    let parsedBody: unknown = undefined;
    if (writes && body.trim()) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        parsedBody = body;
      }
    }
    setBusy(true);
    try {
      // Split a query string typed into the path into the query map.
      let p = path.trim();
      let q = toStringMap(query) ?? {};
      const qi = p.indexOf('?');
      if (qi >= 0) {
        const sp = new URLSearchParams(p.slice(qi + 1));
        q = { ...Object.fromEntries(sp.entries()), ...q };
        p = p.slice(0, qi);
      }
      const r = await post<ExplorerResult>(`/platforms/${platform.id}/request`, {
        method,
        path: p,
        query: Object.keys(q).length ? q : undefined,
        headers: toStringMap(headers),
        body: parsedBody,
      });
      setResult(r);
      if (writes) setConfirmed(false);
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Paper withBorder p="md">
        <Title order={5}>Ad-hoc request</Title>
        <Hint>
          Calls are authenticated with the platform's credentials and every call is recorded in the audit log. Path placeholders like
          {' {id} '}from a spec must be replaced by real values.
        </Hint>
        <Stack mt="sm">
          <Group align="flex-end" wrap="nowrap" gap="xs">
            <Select data={METHODS} value={method} onChange={(v) => setMethod(v ?? 'GET')} allowDeselect={false} w={110} label="Method" />
            <TextInput
              label="Path (relative to base URL)"
              classNames={{ input: 'mono' }}
              value={path}
              onChange={(e) => setPath(e.currentTarget.value)}
              style={{ flex: 1, minWidth: 0 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (!writes || confirmed)) send();
              }}
            />
          </Group>
          <div>
            <Text size="sm" fw={500} mb={4}>
              Query parameters
            </Text>
            <KeyValueEditor value={query} onChange={setQuery} />
          </div>
          <div>
            <Text size="sm" fw={500} mb={4}>
              Headers
            </Text>
            <KeyValueEditor value={headers} onChange={setHeaders} />
          </div>
          {writes && (
            <>
              <Textarea label="Body (JSON)" classNames={{ input: 'mono' }} autosize minRows={3} maxRows={14} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
              <Checkbox
                color="orange"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.currentTarget.checked)}
                label={`I understand this changes data on ${platform.name}`}
              />
            </>
          )}
          <Group justify="flex-end">
            <Button leftSection={<IconSend size={16} />} onClick={send} loading={busy} disabled={!path.trim() || (writes && !confirmed)} color={writes ? 'orange' : 'blue'}>
              Send
            </Button>
          </Group>
        </Stack>
      </Paper>
      {error && (
        <Alert color="red" title="Request failed">
          {error}
        </Alert>
      )}
      {result && (
        <Paper withBorder p="md">
          <Group gap="xs" mb="xs" wrap="wrap">
            <Badge color={result.ok ? 'green' : result.status >= 500 ? 'red' : 'orange'} variant="light">
              HTTP {result.status}
            </Badge>
            <Text size="sm" c="dimmed">
              {result.durationMs} ms
            </Text>
            <Text size="xs" className="mono" c="dimmed" style={{ wordBreak: 'break-all' }}>
              {result.url}
            </Text>
          </Group>
          <Anchor size="xs" onClick={() => setShowHeaders((s) => !s)}>
            {showHeaders ? 'Hide' : 'Show'} response headers
          </Anchor>
          <Collapse in={showHeaders}>
            <JsonView value={result.headers} maxHeight={200} />
          </Collapse>
          <Text size="sm" fw={500} mt="sm" mb={4}>
            Body
          </Text>
          <JsonView value={result.body} maxHeight={500} />
        </Paper>
      )}
    </Stack>
  );
}
