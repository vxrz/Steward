import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Spoiler,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconApi, IconSearch } from '@tabler/icons-react';
import type { ApiOperation, ConnectionSlot, NodeOf, Platform } from '@sm/shared';
import { get } from '../../api';

type HttpNode = NodeOf<'http'>;
type Param = NonNullable<ApiOperation['parameters']>[number];

const storageKey = (slot: ConnectionSlot | undefined, connection: string) => `sm.specPlatform.${slot?.kind || connection}`;

function loadPlatform(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function savePlatform(key: string, id: string | null) {
  try {
    if (id) localStorage.setItem(key, id);
  } catch {
    /* ignore */
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paramNames = (path: string) => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

/** Values of path parameters as currently written in the node's path (null if the path no longer matches the operation). */
export function extractPathParams(opPath: string, nodePath: string): Record<string, string> | null {
  const names = paramNames(opPath);
  const pattern = '^' + opPath.split(/\{[^}]+\}/).map(escapeRe).join('(.*?)') + '$';
  const m = new RegExp(pattern).exec(nodePath);
  if (!m) return null;
  const out: Record<string, string> = {};
  names.forEach((n, i) => {
    const v = m[i + 1] ?? '';
    out[n] = v === `{${n}}` ? '' : v;
  });
  return out;
}

export function buildPath(opPath: string, values: Record<string, string>): string {
  return opPath.replace(/\{([^}]+)\}/g, (_m, n: string) => (values[n] ? values[n]! : `{${n}}`));
}

const defaultPathValue = (name: string) => `{{ vars.${name.replace(/[^A-Za-z0-9_]/g, '_')} }}`;

function successCodes(op: ApiOperation): number[] | undefined {
  return op.successStatus?.length ? op.successStatus : undefined;
}

/** Fields to apply when an operation is chosen. */
export function applyOperation(node: HttpNode, op: ApiOperation): Partial<HttpNode> {
  const values: Record<string, string> = {};
  for (const n of paramNames(op.path)) values[n] = defaultPathValue(n);
  const query = { ...(node.query ?? {}) };
  for (const p of op.parameters ?? []) if (p.in === 'query' && p.required && !(p.name in query)) query[p.name] = p.schema?.default !== undefined ? String(p.schema.default) : '';
  return {
    method: op.method.toUpperCase() as HttpNode['method'],
    path: buildPath(op.path, values),
    operationId: op.operationId,
    ...(Object.keys(query).length ? { query } : {}),
    ...(!node.name && op.summary ? { name: op.summary.slice(0, 80) } : {}),
    ...(!node.expectStatus?.length && successCodes(op) ? { expectStatus: successCodes(op) } : {}),
  };
}

/** API operation section of an http node: pick an operation from an OpenAPI spec and fill its parameters. */
export function ApiOperationSection({ node, connections, onChange }: { node: HttpNode; connections: ConnectionSlot[]; onChange: (patch: Partial<HttpNode>) => void }) {
  const slot = connections.find((c) => c.slot === node.connection);
  const key = storageKey(slot, node.connection ?? '');
  const [platformId, setPlatformIdState] = useState<string | null>(() => loadPlatform(key));
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setPlatformIdState(loadPlatform(key)), [key]);
  const setPlatformId = (id: string | null) => {
    setPlatformIdState(id);
    savePlatform(key, id);
  };

  const wantOps = !!node.connection && (!!node.operationId || pickerOpen);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms'), enabled: wantOps });
  const candidates = useMemo(() => (platforms.data ?? []).filter((p) => !slot?.kind || p.kind === slot.kind), [platforms.data, slot?.kind]);
  const effectivePlatform = platformId && candidates.some((c) => c.id === platformId) ? platformId : (candidates[0]?.id ?? null);
  const ops = useQuery({
    queryKey: ['platform', effectivePlatform, 'operations'],
    queryFn: () => get<ApiOperation[]>(`/platforms/${effectivePlatform}/operations`),
    enabled: wantOps && !!effectivePlatform,
  });
  const op = node.operationId ? (ops.data ?? []).find((o) => o.operationId === node.operationId) : undefined;

  const platformSelect = (
    <Select
      size="xs"
      label="Look up operations on"
      description={slot?.kind ? `Platforms of kind ${slot.kind} (with an imported API spec)` : 'Any platform with an imported API spec'}
      data={candidates.map((p) => ({ value: p.id, label: p.name }))}
      value={effectivePlatform}
      onChange={setPlatformId}
      placeholder={platforms.isLoading ? 'Loading…' : candidates.length ? 'Select platform' : 'No matching platforms'}
      allowDeselect={false}
    />
  );

  return (
    <Paper withBorder p="xs">
      <Group justify="space-between" wrap="nowrap" mb={op || node.operationId ? 6 : 0}>
        <Text size="xs" fw={600}>
          API operation
        </Text>
        <Button size="compact-xs" variant="light" leftSection={<IconApi size={12} />} onClick={() => setPickerOpen(true)} disabled={!node.connection}>
          {node.operationId ? 'Change' : 'Pick from API spec'}
        </Button>
      </Group>
      {!node.connection && (
        <Text size="xs" c="dimmed">
          Select a connection first.
        </Text>
      )}
      {node.operationId && !op && (
        <Text size="xs" c="dimmed">
          <span className="mono">{node.operationId}</span>
          {ops.isLoading ? ' – loading spec…' : effectivePlatform ? ' – not found in the selected platform’s specs.' : ' – no platform with a spec to look it up.'}
        </Text>
      )}
      {op && <OperationDetails node={node} op={op} onChange={onChange} />}

      <Modal opened={pickerOpen} onClose={() => setPickerOpen(false)} title="Pick an API operation" size="xl">
        <Stack>
          {platformSelect}
          {effectivePlatform && (
            <OperationList
              ops={ops.data}
              loading={ops.isLoading}
              onPick={(o) => {
                onChange(applyOperation(node, o));
                setPickerOpen(false);
              }}
            />
          )}
        </Stack>
      </Modal>
    </Paper>
  );
}

function OperationList({ ops, loading, onPick }: { ops?: ApiOperation[]; loading: boolean; onPick: (o: ApiOperation) => void }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    return (ops ?? []).filter((o) => !needle || [o.method, o.path, o.summary, o.operationId, o.tag].some((x) => x?.toLowerCase().includes(needle))).slice(0, 200);
  }, [ops, q]);
  return (
    <>
      <TextInput leftSection={<IconSearch size={14} />} placeholder="Search path, summary, operationId…" value={q} onChange={(e) => setQ(e.currentTarget.value)} />
      {!loading && ops && ops.length === 0 && (
        <Text size="sm" c="dimmed">
          This platform has no API specification yet. Upload one on the platform page (tab "API specs").
        </Text>
      )}
      <ScrollArea.Autosize mah={440}>
        <Stack gap={4}>
          {filtered.map((o, i) => (
            <UnstyledButton key={`${o.specId}-${o.method}-${o.path}-${i}`} onClick={() => onPick(o)}>
              <Paper withBorder p={6}>
                <Group gap={6} wrap="nowrap">
                  <Badge size="sm" variant="light" w={64} style={{ flexShrink: 0 }}>
                    {o.method}
                  </Badge>
                  <Box style={{ minWidth: 0 }}>
                    <Text size="xs" className="mono" truncate>
                      {o.path}
                    </Text>
                    {(o.summary || o.operationId) && (
                      <Text size="xs" c="dimmed" truncate>
                        {o.summary ?? ''} {o.operationId ? `· ${o.operationId}` : ''}
                      </Text>
                    )}
                  </Box>
                </Group>
              </Paper>
            </UnstyledButton>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </>
  );
}

function OperationDetails({ node, op, onChange }: { node: HttpNode; op: ApiOperation; onChange: (patch: Partial<HttpNode>) => void }) {
  const params = (op.parameters ?? []).filter((p) => ['path', 'query', 'header'].includes(p.in));
  const pathValues = extractPathParams(op.path, node.path);
  const methodDiffers = node.method.toUpperCase() !== op.method.toUpperCase();

  const setParam = (p: Param, value: string) => {
    if (p.in === 'path') {
      const values = { ...(pathValues ?? {}), [p.name]: value };
      onChange({ path: buildPath(op.path, values) });
    } else if (p.in === 'query') {
      const q = { ...(node.query ?? {}) };
      if (value === '') delete q[p.name];
      else q[p.name] = value;
      onChange({ query: Object.keys(q).length ? q : undefined });
    } else {
      const h = { ...(node.headers ?? {}) };
      if (value === '') delete h[p.name];
      else h[p.name] = value;
      onChange({ headers: Object.keys(h).length ? h : undefined });
    }
  };
  const valueOf = (p: Param): string => {
    if (p.in === 'path') return pathValues?.[p.name] ?? '';
    const v = p.in === 'query' ? node.query?.[p.name] : node.headers?.[p.name];
    return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  };

  const insertBody = () => {
    const ct = op.requestContentType ?? '';
    onChange({
      body: structuredClone(op.requestBodyExample),
      ...(ct.includes('json') ? { bodyType: 'json' as const } : ct.includes('x-www-form-urlencoded') ? { bodyType: 'form' as const } : {}),
      ...(!node.expectStatus?.length && successCodes(op) ? { expectStatus: successCodes(op) } : {}),
    });
  };

  return (
    <Stack gap={6}>
      <Group gap={6} wrap="nowrap">
        <Badge size="xs" variant="light" style={{ flexShrink: 0 }}>
          {op.method}
        </Badge>
        <Text size="xs" className="mono" truncate>
          {op.path}
        </Text>
      </Group>
      {op.summary && (
        <Text size="xs" fw={500}>
          {op.summary}
        </Text>
      )}
      {op.description && op.description !== op.summary && (
        <Spoiler maxHeight={54} showLabel="more" hideLabel="less" styles={{ control: { fontSize: 11 } }}>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
            {op.description}
          </Text>
        </Spoiler>
      )}
      {methodDiffers && (
        <Alert color="orange" p={6} fz="xs">
          The node uses {node.method} but the operation is {op.method}.{' '}
          <Anchor size="xs" onClick={() => onChange({ method: op.method.toUpperCase() as HttpNode['method'] })}>
            Use {op.method}
          </Anchor>
        </Alert>
      )}
      {pathValues === null && params.some((p) => p.in === 'path') && (
        <Alert color="orange" p={6} fz="xs">
          The path was edited by hand and no longer matches <span className="mono">{op.path}</span>. Editing a path parameter below rebuilds it.
        </Alert>
      )}
      {params.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed">
            Parameters
          </Text>
          {params.map((p) => (
            <ParamInput key={`${p.in}:${p.name}`} param={p} value={valueOf(p)} onChange={(v) => setParam(p, v)} />
          ))}
        </Stack>
      )}
      {(op.hasBody || op.requestBodyExample !== undefined) && (
        <Group gap={6}>
          <Button size="compact-xs" variant="default" disabled={op.requestBodyExample === undefined} onClick={insertBody}>
            Insert example body
          </Button>
          {op.requestContentType && (
            <Text size="xs" c="dimmed" className="mono">
              {op.requestContentType}
            </Text>
          )}
        </Group>
      )}
      {!node.expectStatus?.length && successCodes(op) && (
        <Anchor size="xs" onClick={() => onChange({ expectStatus: successCodes(op) })}>
          Accept the documented success codes ({successCodes(op)!.join(', ')})
        </Anchor>
      )}
    </Stack>
  );
}

function ParamInput({ param, value, onChange }: { param: Param; value: string; onChange: (v: string) => void }) {
  const label = (
    <>
      <span className="mono">{param.name}</span>{' '}
      <Text span size="10px" c="dimmed">
        {param.in}
        {param.schema?.type ? ` · ${param.schema.type}${param.schema.format ? ` (${param.schema.format})` : ''}` : ''}
      </Text>
      {param.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
    </>
  );
  const description = param.description ? (param.description.length > 160 ? param.description.slice(0, 159) + '…' : param.description) : undefined;
  const placeholder = param.schema?.default !== undefined ? `default: ${String(param.schema.default)}` : 'value or {{ expression }}';
  if (param.schema?.enum?.length) {
    return (
      <Autocomplete
        size="xs"
        label={label}
        description={description}
        classNames={{ input: 'mono' }}
        data={param.schema.enum.map(String)}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
      />
    );
  }
  return <TextInput size="xs" label={label} description={description} classNames={{ input: 'mono' }} value={value} placeholder={placeholder} onChange={(e) => onChange(e.currentTarget.value)} />;
}
