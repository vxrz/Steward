import { Fragment, useEffect, useMemo, useState } from 'react';
import { Accordion, Badge, Code, Divider, Group, NumberInput, Paper, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { Trans, useTranslation } from 'react-i18next';
import { COMMON_FIELDS, STEP_META, nodePorts, type ConnectionSlot, type FlowNode } from '@sm/shared';
import { FieldInput } from './fields';
import { ApiOperationSection } from './ApiOperation';
import { ExprNodeScope } from './ExprContext';
import { SubprocessSection } from './SubprocessSection';
import { ManualStepSection } from './ManualStepSection';
import { NODE_ICONS, nodeColor, portHelp } from '../flow/meta';
import { localizeField, portLabel, stepDescription, stepLabel } from '../../i18n/meta';

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SELECT_ONLY = new Set(['items', 'itemKey', 'columns', 'preselect']);
const NONE = new Set<string>();

export function ExpressionHelp() {
  const { t } = useTranslation('editor');
  // Code samples are passed as values so translators only see <c>…</c> placeholders, never JSONata.
  const c = { c: <Code /> };
  return (
    <Accordion variant="contained" chevronPosition="left">
      <Accordion.Item value="help">
        <Accordion.Control>
          <Text size="sm">{t('exprHelp.title')}</Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack gap={4}>
            <Text size="xs">
              <Trans t={t} i18nKey="exprHelp.p1" values={{ placeholder: '{{ expression }}' }} components={{ b: <b />, ...c }} />
            </Text>
            <Text size="xs">
              <Trans t={t} i18nKey="exprHelp.p2" components={{ ...c, slotvars: <Code>{'conn.<slot>.vars.*'}</Code> }} />
            </Text>
            <Text size="xs">
              <Trans t={t} i18nKey="exprHelp.p3" values={{ example: 'vars.users.body[$not(userName in $inputs.exempt)]' }} components={c} />
            </Text>
            <Text size="xs">
              <Trans t={t} i18nKey="exprHelp.p4" components={c} />
            </Text>
            <Text size="xs">
              <Trans t={t} i18nKey="exprHelp.p5" components={c} />
            </Text>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function NodeForm({
  node,
  onChange,
  onRename,
  otherIds,
  connections,
}: {
  node: FlowNode;
  onChange: (n: FlowNode) => void;
  onRename: (newId: string) => void;
  otherIds: Set<string>;
  connections: ConnectionSlot[];
}) {
  const { t, i18n } = useTranslation('editor');
  const meta = STEP_META[node.type];
  const rec = node as unknown as Record<string, unknown>;
  const set = (key: string, v: unknown) => {
    const next: Record<string, unknown> = { ...rec };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next as unknown as FlowNode);
  };
  const [idDraft, setIdDraft] = useState(node.id);
  useEffect(() => setIdDraft(node.id), [node.id]);
  const idError = !ID_RE.test(idDraft) ? t('form.idInvalid') : otherIds.has(idDraft) ? t('form.idUsed') : null;
  const Icon = NODE_ICONS[node.type];
  const ports = nodePorts(node as never);
  const executable = node.type !== 'note' && node.type !== 'start';
  const commonFields = COMMON_FIELDS.filter((f) => !(node.type === 'if' && f.key === 'when')).map((f) => localizeField('common', f));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const fields = useMemo(() => meta.fields.map((f) => localizeField(node.type, f)), [meta, node.type, i18n.language]);
  /** Settings of select tasks that a manual step does not use */
  const hidden = node.type === 'userTask' && node.mode === 'manual' ? SELECT_ONLY : NONE;

  return (
    <ExprNodeScope nodeId={node.id} enabled={node.type !== 'note'}>
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          <Badge size="lg" variant="light" color={nodeColor(node.type)} leftSection={<Icon size={14} />}>
            {stepLabel(node.type, meta)}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">
          {stepDescription(node.type, meta)}
        </Text>
        {node.type === 'start' && (
          <Text size="xs">
            <Trans t={t} i18nKey="form.startHint" components={{ b: <b /> }} />
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <TextInput
            label={t('form.nodeId')}
            description={t('form.nodeIdHint')}
            classNames={{ input: 'mono' }}
            value={idDraft}
            error={idDraft !== node.id ? idError : null}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setIdDraft(v);
              if (ID_RE.test(v) && !otherIds.has(v) && v !== node.id) onRename(v);
            }}
          />
          {node.type !== 'note' && (
            <TextInput
              label={t('form.name')}
              description={t('form.nameHint')}
              value={node.name ?? ''}
              onChange={(e) => set('name', e.currentTarget.value || undefined)}
            />
          )}
        </SimpleGrid>
        {executable && (
          <Textarea
            label={t('form.description')}
            autosize
            minRows={1}
            maxRows={4}
            value={node.description ?? ''}
            onChange={(e) => set('description', e.currentTarget.value || undefined)}
          />
        )}
        {fields
          .filter((f) => !hidden.has(f.key))
          .map((f) => (
            <Fragment key={f.key}>
              {!(node.type === 'subprocess' && (f.key === 'inputs' || f.key === 'connections')) && (
                <FieldInput field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
              )}
              {node.type === 'subprocess' && f.key === 'inputs' && (
                <SubprocessSection
                  node={node}
                  connections={connections}
                  onChange={(patch) => {
                    const next: Record<string, unknown> = { ...node, ...patch };
                    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
                    onChange(next as unknown as FlowNode);
                  }}
                />
              )}
              {node.type === 'userTask' && node.mode === 'manual' && f.key === 'fourEyes' && (
                <ManualStepSection
                  node={node}
                  onChange={(patch) => {
                    const next: Record<string, unknown> = { ...node, ...patch };
                    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
                    onChange(next as unknown as FlowNode);
                  }}
                />
              )}
              {node.type === 'http' && f.key === 'connection' && (
                <ApiOperationSection
                  node={node}
                  connections={connections}
                  onChange={(patch) => {
                    const next: Record<string, unknown> = { ...node, ...patch };
                    for (const k of Object.keys(patch)) if ((patch as Record<string, unknown>)[k] === undefined) delete next[k];
                    onChange(next as unknown as FlowNode);
                  }}
                />
              )}
            </Fragment>
          ))}
        {ports.length > 0 && (
          <Paper withBorder p="xs">
            <Text size="xs" fw={600} mb={4}>
              {t('form.outputs')}
            </Text>
            <Stack gap={4}>
              {ports.map((p) => (
                <Group key={p.id} gap={6} wrap="nowrap" align="flex-start">
                  <Badge size="xs" variant="outline" color={p.id === 'error' ? 'red' : 'gray'} style={{ flexShrink: 0 }}>
                    {portLabel(p.id, p.label) || p.id}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {portHelp(p.id)}
                  </Text>
                </Group>
              ))}
            </Stack>
          </Paper>
        )}
        {executable && (
          <>
            <Divider label={t('form.execution')} labelPosition="left" />
            {commonFields.map((f) => (
              <FieldInput key={f.key} field={f} value={rec[f.key]} onChange={(v) => set(f.key, v)} connections={connections} />
            ))}
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
              <NumberInput
                label={t('form.retryAttempts')}
                description={t('form.retryAttemptsHint')}
                min={1}
                max={10}
                value={node.retry?.attempts ?? ''}
                onChange={(v) => set('retry', v === '' || Number(v) <= 1 ? undefined : { ...(node.retry ?? {}), attempts: Number(v) })}
              />
              <NumberInput
                label={t('form.retryDelay')}
                min={0}
                disabled={!node.retry}
                value={node.retry?.delayMs ?? ''}
                onChange={(v) => node.retry && set('retry', { ...node.retry, delayMs: v === '' ? undefined : Number(v) })}
              />
            </SimpleGrid>
          </>
        )}
      </Stack>
    </ExprNodeScope>
  );
}
