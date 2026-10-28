import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Collapse, Group, Paper, Select, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { IconPlayerRecord, IconSend } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Platform, RecordingInput } from '@sm/shared';
import { RecordingModal } from './RecordingsTab';
import { post } from '../../api';
import { Hint, JsonView, KeyValueEditor } from '../common';
import { errorText } from '../../i18n/errors';
import { fmtNumber } from '../../format';

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

export function ExplorerTab({ platform, preset, canWrite = true }: { platform: Platform; preset: ExplorerPreset | null; canWrite?: boolean }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState(platform.config.testPath || '/');
  const [query, setQuery] = useState<Record<string, unknown> | undefined>();
  const [headers, setHeaders] = useState<Record<string, unknown> | undefined>();
  const [body, setBody] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplorerResult | null>(null);
  /** The request of the shown result, for "Save as recorded response" */
  const [sent, setSent] = useState<{ method: string; path: string; query: Record<string, string>; body: unknown } | null>(null);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);

  useEffect(() => {
    if (preset) {
      setMethod(canWrite || preset.method === 'GET' || preset.method === 'HEAD' ? preset.method : 'GET');
      setPath(preset.path);
      setConfirmed(false);
    }
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

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
      setSent({ method, path: p, query: q, body: parsedBody });
      if (writes) setConfirmed(false);
    } catch (e) {
      setResult(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <Paper withBorder p="md">
        <Title order={5}>{t('explorer.title')}</Title>
        <Hint>{t('explorer.hint', { example: '{id}' })}</Hint>
        <Stack mt="sm">
          <Group align="flex-end" wrap="nowrap" gap="xs">
            <Select
              data={canWrite ? METHODS : ['GET', 'HEAD']}
              value={method}
              onChange={(v) => setMethod(v ?? 'GET')}
              allowDeselect={false}
              w={110}
              label={t('explorer.method')}
            />
            <TextInput
              label={t('explorer.path')}
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
              {t('explorer.query')}
            </Text>
            <KeyValueEditor value={query} onChange={setQuery} />
          </div>
          <div>
            <Text size="sm" fw={500} mb={4}>
              {t('explorer.headers')}
            </Text>
            <KeyValueEditor value={headers} onChange={setHeaders} />
          </div>
          {writes && (
            <>
              <Textarea
                label={t('explorer.body')}
                classNames={{ input: 'mono' }}
                autosize
                minRows={3}
                maxRows={14}
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
              />
              <Checkbox
                color="orange"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.currentTarget.checked)}
                label={t('explorer.confirm', { name: platform.name })}
              />
            </>
          )}
          <Group justify="flex-end">
            <Button
              leftSection={<IconSend size={16} />}
              onClick={send}
              loading={busy}
              disabled={!path.trim() || (writes && !confirmed)}
              color={writes ? 'orange' : 'blue'}
            >
              {t('explorer.send')}
            </Button>
          </Group>
        </Stack>
      </Paper>
      {error && (
        <Alert color="red" title={t('explorer.failed')}>
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
              {fmtNumber(result.durationMs)} ms
            </Text>
            <Text size="xs" className="mono" c="dimmed" style={{ wordBreak: 'break-all' }}>
              {result.url}
            </Text>
          </Group>
          <Anchor size="xs" onClick={() => setShowHeaders((s) => !s)}>
            {showHeaders ? t('explorer.hideHeaders') : t('explorer.showHeaders')}
          </Anchor>
          <Collapse in={showHeaders}>
            <JsonView value={result.headers} maxHeight={200} />
          </Collapse>
          <Text size="sm" fw={500} mt="sm" mb={4}>
            {t('explorer.responseBody')}
          </Text>
          <JsonView value={result.body} maxHeight={500} />
          {canWrite && sent && (
            <Group justify="flex-end" mt="sm">
              <Button size="xs" variant="light" leftSection={<IconPlayerRecord size={14} />} onClick={() => setRecording(true)}>
                {t('recordings.saveFromExplorer')}
              </Button>
            </Group>
          )}
        </Paper>
      )}
      {recording && result && sent && (
        <RecordingModal
          platform={platform}
          recording={null}
          initial={{
            method: sent.method as RecordingInput['method'],
            path: sent.path,
            query: sent.query,
            status: result.status,
            headers: Object.fromEntries(Object.entries(result.headers).filter(([k]) => /^(content-type|link|x-total-count|etag)$/i.test(k))),
            body: result.body,
          }}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            void qc.invalidateQueries({ queryKey: ['platform-recordings', platform.id] });
          }}
        />
      )}
    </Stack>
  );
}
