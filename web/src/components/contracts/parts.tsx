import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Box, Button, CopyButton, Group, List, Paper, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconCircleCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  dataContractChangeLine,
  dataContractChangesMarkdown,
  type DataContractChange,
  type DataContractDiff,
  type DataContractFinding,
  type DataContractLintFinding,
  type DataContractPreview,
  type DataContractResult,
  type DataContractTx,
} from '@sm/shared';
import { post } from '../../api';
import { TONE } from '../common';

/** The colours of a test result: the label always says it as well. */
const RESULT_COLOR: Record<DataContractResult, string> = { passed: TONE.ok, warning: TONE.attention, failed: TONE.bad, error: TONE.bad };

export function ResultBadge({ result, size = 'sm' }: { result: DataContractResult | null | undefined; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('contracts');
  return (
    <Badge color={result ? RESULT_COLOR[result] : TONE.neutral} variant="light" size={size} style={{ minWidth: 'max-content' }} data-testid="contract-result">
      {result ? t(`results.${result}`) : t('results.never')}
    </Badge>
  );
}

/** The ODCS status of a contract (proposed, draft, active, deprecated, retired – or what the contract says). */
export function OdcsStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('contracts');
  if (!status) return null;
  const color = status === 'active' ? TONE.ok : status === 'deprecated' || status === 'retired' ? TONE.neutral : TONE.active;
  return (
    <Badge color={color} variant="outline" size="sm" style={{ minWidth: 'max-content' }}>
      {t(`odcsStatus.${status}`, { defaultValue: status })}
    </Badge>
  );
}

const SEVERITY_COLOR = { error: TONE.bad, warning: TONE.attention, info: TONE.neutral } as const;

/** Lint findings: Steward's JSON Schema check, a YAML problem, or the service's lint. */
export function LintList({ findings, title }: { findings: DataContractLintFinding[]; title?: string }) {
  const { t } = useTranslation('contracts');
  if (!findings.length)
    return (
      <Group gap={6} c="green.8" data-testid="contract-lint-ok">
        <IconCircleCheck size={16} aria-hidden />
        <Text size="sm">{t('lint.ok')}</Text>
      </Group>
    );
  const errors = findings.filter((f) => f.severity === 'error').length;
  return (
    <Alert
      color={errors ? 'red' : 'yellow'}
      variant="light"
      icon={errors ? <IconAlertTriangle size={16} /> : <IconInfoCircle size={16} />}
      title={title ?? t('lint.title', { count: findings.length })}
      data-testid="contract-lint"
    >
      <List size="sm" spacing={4}>
        {findings.slice(0, 50).map((f, i) => (
          <List.Item key={i}>
            <Text span size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {f.path}
            </Text>{' '}
            – {f.message}
            {f.source === 'service' && (
              <Badge size="xs" variant="light" ml={6}>
                {t('lint.fromService')}
              </Badge>
            )}
          </List.Item>
        ))}
      </List>
      {findings.length > 50 && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('lint.more', { count: findings.length - 50 })}
        </Text>
      )}
    </Alert>
  );
}

/** One change of a comparison, with its breaking mark. */
function ChangeItem({ c }: { c: DataContractChange }) {
  const { t } = useTranslation('contracts');
  const tx: DataContractTx = (key, values) => String(t(key as never, values as never));
  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      {c.breaking ? (
        <Tooltip label={t(`reasons.${c.reason!}`)} withArrow>
          <Badge color="red" variant="light" size="xs" style={{ flexShrink: 0 }} mt={2}>
            {t('breaking')}
          </Badge>
        </Tooltip>
      ) : (
        <Badge color="gray" variant="light" size="xs" style={{ flexShrink: 0 }} mt={2}>
          {t('compatible')}
        </Badge>
      )}
      <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
        {dataContractChangeLine(tx, c)}
      </Text>
    </Group>
  );
}

/** The changes between two versions, breaking ones first, with "Copy as Markdown" for a change record. */
export function ChangeList({ diff, name, from, to }: { diff: DataContractDiff; name: string; from: number; to: number }) {
  const { t } = useTranslation('contracts');
  const tx: DataContractTx = (key, values) => String(t(key as never, values as never));
  const sorted = useMemo(() => [...diff.changes].sort((a, b) => Number(b.breaking) - Number(a.breaking)), [diff]);
  if (!diff.total)
    return (
      <Text size="sm" c="dimmed" data-testid="contract-changes">
        {t('changes.none')}
      </Text>
    );
  return (
    <Stack gap="xs" data-testid="contract-changes">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="sm" fw={500}>
          {t('changes.summary', { count: diff.total, breaking: diff.breaking })}
        </Text>
        <CopyButton value={dataContractChangesMarkdown(tx, name, diff, from, to)}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="default" leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
              {copied ? t('changes.copied') : t('changes.copyMarkdown')}
            </Button>
          )}
        </CopyButton>
      </Group>
      {sorted.map((c, i) => (
        <ChangeItem key={i} c={c} />
      ))}
      {diff.total > diff.changes.length && (
        <Text size="xs" c="dimmed">
          {t('changes.more', { count: diff.total - diff.changes.length })}
        </Text>
      )}
    </Stack>
  );
}

/** Steward's own findings of a contract. */
export function FindingsList({ findings }: { findings: DataContractFinding[] }) {
  const { t } = useTranslation('contracts');
  if (!findings.length)
    return (
      <Group gap={6} c="green.8" data-testid="contract-findings-ok">
        <IconCircleCheck size={16} aria-hidden />
        <Text size="sm">{t('findings.none')}</Text>
      </Group>
    );
  return (
    <Stack gap={6} data-testid="contract-findings">
      {findings.map((f, i) => (
        <Group key={i} gap={8} wrap="nowrap" align="flex-start">
          <Badge color={SEVERITY_COLOR[f.severity]} variant="light" size="sm" style={{ flexShrink: 0 }}>
            {t(`findings.severity.${f.severity}`)}
          </Badge>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {f.kind === 'notTested' && f.count === undefined
              ? t('findings.neverTested')
              : t(`findings.kinds.${f.kind}`, { count: f.count ?? 0, schema: f.schema ?? '', fields: (f.fields ?? []).join(', ') })}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

/**
 * The YAML of a contract with its live check (half a second after the last change): Steward's JSON Schema check and,
 * for an existing contract, the changes against its current version.
 */
export function ContractYamlEditor({
  value,
  onChange,
  contractId,
  name,
  currentVersion,
  readOnly,
  onPreview,
}: {
  value: string;
  onChange: (v: string) => void;
  contractId?: string;
  name?: string;
  currentVersion?: number;
  readOnly?: boolean;
  onPreview?: (p: DataContractPreview | null) => void;
}) {
  const { t } = useTranslation('contracts');
  const [debounced] = useDebouncedValue(value, 500);
  const [preview, setPreview] = useState<DataContractPreview | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!debounced.trim()) {
      setPreview(null);
      onPreview?.(null);
      return;
    }
    let live = true;
    setChecking(true);
    post<DataContractPreview>(contractId ? `/data-contracts/${contractId}/check` : '/data-contracts/check', { yaml: debounced })
      .then((p) => {
        if (!live) return;
        setPreview(p);
        onPreview?.(p);
      })
      .catch(() => {
        if (live) setPreview(null);
      })
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
    // onPreview is a callback of the page: the check follows the text only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, contractId]);
  return (
    <Stack gap="sm">
      <Textarea
        label={t('editor.label')}
        description={t('editor.hint')}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        readOnly={readOnly}
        autosize
        minRows={14}
        maxRows={36}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        classNames={{ input: 'mono' }}
        styles={{ input: { fontSize: 13, lineHeight: 1.5 } }}
        data-testid="contract-yaml"
      />
      <Box aria-live="polite">
        {checking && !preview ? (
          <Text size="sm" c="dimmed">
            {t('editor.checking')}
          </Text>
        ) : preview ? (
          <Stack gap="sm">
            <LintList findings={preview.lint} />
            {preview.diff && !preview.unchanged && (
              <Paper withBorder p="sm">
                <Text size="sm" fw={600} mb="xs">
                  {t('editor.changesTitle')}
                </Text>
                <ChangeList diff={preview.diff} name={name ?? preview.facts?.name ?? ''} from={currentVersion ?? 0} to={(currentVersion ?? 0) + 1} />
              </Paper>
            )}
          </Stack>
        ) : null}
      </Box>
    </Stack>
  );
}

/** An empty contract to start from (ODCS v3.0.2). */
export const BLANK_CONTRACT = `apiVersion: v3.0.2
kind: DataContract
id: my-contract
name: My contract
version: 0.1.0
status: draft
description:
  purpose: What the data is for
schema:
  - name: my_table
    physicalType: table
    properties:
      - name: id
        logicalType: integer
        required: true
`;
