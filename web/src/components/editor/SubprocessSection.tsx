import { ActionIcon, Alert, Anchor, Badge, Box, Code, Group, Loader, Paper, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowRight, IconExternalLink, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { ConnectionSlot, FlowNode, NodeOf } from '@sm/shared';
import { asText, fromText } from '../common';
import { ExpressionInput } from './ExpressionInput';
import { ExprKeyValueEditor } from './fields';
import { useProcessVersion } from './editorApi';
import { withBase } from '../../basePath';

type SubNode = NodeOf<'subprocess'>;

/** Inputs + connection mapping of a sub-process node, driven by the chosen child process. */
export function SubprocessSection({
  node,
  connections,
  onChange,
}: {
  node: SubNode;
  connections: ConnectionSlot[];
  onChange: (patch: Partial<FlowNode>) => void;
}) {
  const { t } = useTranslation(['editor', 'common']);
  const child = useProcessVersion(node.process || undefined, node.version);
  const inputs = (node.inputs ?? {}) as Record<string, unknown>;
  const conns = node.connections ?? {};
  const setInputs = (next: Record<string, unknown>) => onChange({ inputs: next } as Partial<FlowNode>);
  const setConns = (next: Record<string, string>) => onChange({ connections: Object.keys(next).length ? next : undefined } as Partial<FlowNode>);

  if (!node.process) {
    return (
      <Text size="xs" c="dimmed">
        {t('sub.choose')}
      </Text>
    );
  }
  if (child.isLoading) {
    return (
      <Group gap={6}>
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {t('sub.loading')}
        </Text>
      </Group>
    );
  }

  const openLink = (
    <Anchor href={withBase(`/processes/${encodeURIComponent(node.process)}`)} target="_blank" size="xs" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
      <Group gap={4} wrap="nowrap">
        <IconExternalLink size={12} />
        {t('sub.open')}
      </Group>
    </Anchor>
  );

  if (child.error || !child.data) {
    // child unknown or not readable: plain editors
    return (
      <Stack gap="xs">
        <Alert color="orange" p="xs">
          <Text size="xs">
            {t(node.version ? 'sub.loadFailedVersion' : 'sub.loadFailed', {
              version: node.version,
              error: (child.error as Error)?.message ?? t('sub.notFound'),
            })}
          </Text>
        </Alert>
        <Text size="sm" fw={500}>
          {t('steps.subprocess.fields.inputs.label')}
        </Text>
        <ExprKeyValueEditor value={inputs} onChange={(v) => setInputs(v ?? {})} />
        <Text size="sm" fw={500}>
          {t('steps.subprocess.fields.connections.label')}
        </Text>
        <ExprKeyValueEditor value={conns} onChange={(v) => setConns((v ?? {}) as Record<string, string>)} keyLabel={t('sub.childSlot')} />
      </Stack>
    );
  }

  const d = child.data.definition;
  const childInputs = d.inputs ?? [];
  const childSlots = d.connections ?? [];
  const known = new Set(childInputs.map((i) => i.name));
  const unknown = Object.keys(inputs).filter((k) => !known.has(k));
  const parentSlots = new Set(connections.map((c) => c.slot));
  const outputs = Object.keys(d.outputs ?? {});

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          {t(node.version ? 'sub.pinned' : 'sub.current', { name: child.data.name, version: node.version ?? child.data.currentVersion })}
        </Text>
        {openLink}
      </Group>

      <Box>
        <Text size="sm" fw={500}>
          {t('sub.inputs')}
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          {t('sub.inputsHint')}
        </Text>
        {childInputs.length === 0 && (
          <Text size="xs" c="dimmed">
            {t('sub.noInputs')}
          </Text>
        )}
        <Stack gap={8}>
          {childInputs.map((inp) => {
            const v = asText(inputs[inp.name]);
            const missing = inp.required && inp.default === undefined && !v;
            return (
              <ExpressionInput
                key={inp.name}
                size="xs"
                template
                label={
                  <>
                    <span className="mono">{inp.name}</span>
                    {inp.label && inp.label !== inp.name ? ` – ${inp.label}` : ''}
                    {inp.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
                  </>
                }
                description={[inp.type, inp.description, inp.default !== undefined ? t('sub.default', { value: asText(inp.default) }) : '']
                  .filter(Boolean)
                  .join(' · ')}
                placeholder={inp.default !== undefined ? asText(inp.default) : '{{ inputs.something }}'}
                error={missing ? t('sub.required') : undefined}
                value={v}
                onChange={(text) => {
                  const next = { ...inputs };
                  if (text === '') delete next[inp.name];
                  else next[inp.name] = fromText(text);
                  setInputs(next);
                }}
              />
            );
          })}
          {unknown.map((k) => (
            <Group key={k} gap={6} wrap="nowrap">
              <Badge color="orange" variant="light" size="sm" className="mono">
                {k}
              </Badge>
              <Text size="xs" c="orange" style={{ flex: 1 }}>
                {t('sub.unknownInput')}
              </Text>
              <Tooltip label={t('common:remove')}>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  aria-label={t('sub.removeInput', { name: k })}
                  onClick={() => {
                    const next = { ...inputs };
                    delete next[k];
                    setInputs(next);
                  }}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
        </Stack>
      </Box>

      <Box>
        <Text size="sm" fw={500}>
          {t('sub.connections')}
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          {t('sub.connectionsHint')}
        </Text>
        {childSlots.length === 0 && (
          <Text size="xs" c="dimmed">
            {t('sub.noConnections')}
          </Text>
        )}
        <Stack gap={6}>
          {childSlots.map((c) => {
            const mapped = conns[c.slot];
            const unresolved = !mapped && !parentSlots.has(c.slot);
            return (
              <Group key={c.slot} gap={6} wrap="nowrap" align="flex-start">
                <Box w={120} style={{ flexShrink: 0 }} pt={4}>
                  <Text size="xs" className="mono" truncate>
                    {c.slot}
                  </Text>
                  {c.kind && (
                    <Text size="10px" c="dimmed" truncate>
                      {c.kind}
                    </Text>
                  )}
                </Box>
                <IconArrowRight size={14} style={{ marginTop: 8, flexShrink: 0 }} />
                <Select
                  size="xs"
                  style={{ flex: 1, minWidth: 0 }}
                  aria-label={t('sub.connectionFor', { slot: c.slot })}
                  data={connections.map((p) => ({ value: p.slot, label: p.kind ? `${p.slot} (${p.kind})` : p.slot }))}
                  placeholder={parentSlots.has(c.slot) ? t('sub.sameName', { slot: c.slot }) : t('sub.chooseConnection')}
                  clearable
                  value={mapped ?? null}
                  error={unresolved ? t('sub.noSuchConnection', { slot: c.slot }) : mapped && !parentSlots.has(mapped) ? t('sub.unknownConnection') : undefined}
                  onChange={(v) => {
                    const next = { ...conns };
                    if (v) next[c.slot] = v;
                    else delete next[c.slot];
                    setConns(next);
                  }}
                />
              </Group>
            );
          })}
        </Stack>
      </Box>

      <Paper withBorder p="xs">
        <Text size="xs" fw={600} mb={2}>
          {t('sub.result')}
        </Text>
        {outputs.length ? (
          <Text size="xs" c="dimmed">
            <Trans
              t={t}
              i18nKey={node.saveAs ? 'sub.returnsSaved' : 'sub.returns'}
              components={{
                outputs: (
                  <>
                    {outputs.map((o, i) => (
                      <span key={o}>
                        {i > 0 && ', '}
                        <Code>{o}</Code>
                      </span>
                    ))}
                  </>
                ),
                path: <Code>{`vars.${node.saveAs ?? ''}.<name>`}</Code>,
              }}
            />
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            {t('sub.noOutputs')}
          </Text>
        )}
      </Paper>
    </Stack>
  );
}
