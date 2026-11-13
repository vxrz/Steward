import { useEffect, useState } from 'react';
import { Alert, Badge, Checkbox, Group, List, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { DataProductImportChange, McpDataProductsProposal, McpProposalSelection } from '@sm/shared';
import { TableScroll } from '../TableScroll';
import { fmtNumber } from '../../format';

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '–';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
};

/** The entries a proposal adds and changes, a changed one field by field (the assistant's texts as plain text). */
function Changes({ changes, testId }: { changes: DataProductImportChange[]; testId: string }) {
  const { t } = useTranslation(['mcp', 'dataProducts']);
  if (!changes.length) return null;
  return (
    <TableScroll style={{ maxHeight: 420 }}>
      <Table fz="sm" striped aria-label={t('dpProposal.changes')} data-testid={testId}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">{t('dataProducts:transfer.what')}</Table.Th>
            <Table.Th scope="col">{t('dataProducts:transfer.key')}</Table.Th>
            <Table.Th scope="col">{t('dataProducts:transfer.action')}</Table.Th>
            <Table.Th scope="col">{t('dataProducts:transfer.detail')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {changes.map((c, i) => (
            <Table.Tr key={i}>
              <Table.Td>{t(`dataProducts:transfer.kinds.${c.kind}`)}</Table.Td>
              <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                {c.key}
              </Table.Td>
              <Table.Td>
                <Badge size="sm" color={c.action === 'add' ? 'green' : 'blue'} variant="light" tt="none">
                  {t(`dataProducts:transfer.actions.${c.action}`)}
                </Badge>
              </Table.Td>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>
                {c.fields.map((f) => (
                  <Text key={f.field} size="xs">
                    <span className="mono">{f.field}</span>: {show(f.before)} → {show(f.after)}
                  </Text>
                ))}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </TableScroll>
  );
}

/**
 * Reviewing data products an AI assistant proposed (ADR 0036 part 14): what the proposal adds and changes. While the
 * request is open the import's preview of now is shown, as the reviewer – applying imports it as them; when it differs
 * from the preview of the proposal the reviewer confirms it first. Nothing is removed by a proposal.
 */
export function DataProductsProposalReview({
  p,
  editable,
  onChange,
}: {
  p: McpDataProductsProposal;
  editable: boolean;
  onChange: (selection: McpProposalSelection, count: number) => void;
}) {
  const { t } = useTranslation('mcp');
  const [confirmed, setConfirmed] = useState(false);
  const now = p.now;
  useEffect(() => {
    const count = now?.ok ? now.counts.add + now.counts.change : 0;
    if (!now) onChange({}, 0);
    else if (p.changedSince) onChange(confirmed ? { dataProducts: { fingerprint: now.fingerprint } } : {}, confirmed ? count : 0);
    else onChange({ dataProducts: { fingerprint: now.fingerprint } }, count);
  }, [now, p.changedSince, confirmed, onChange]);
  if (p.incomplete)
    return (
      <Stack gap="sm" data-testid="dp-proposal">
        <Paper withBorder p="sm">
          <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
            {p.title}
          </Text>
        </Paper>
        <Alert color="blue" variant="light" data-testid="dp-proposal-incomplete">
          {t('dpProposal.incomplete', { count: p.parts, n: fmtNumber(p.parts) })}
        </Alert>
      </Stack>
    );
  const shown = now ?? p.proposed;
  return (
    <Stack gap="sm" data-testid="dp-proposal">
      <Paper withBorder p="sm">
        <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
          {p.title}
        </Text>
        <Group gap="xs" mt={4}>
          <Badge variant="light" color="green" tt="none">
            {t('plantProposal.countAdded', { count: shown.counts.add })}
          </Badge>
          <Badge variant="light" color="blue" tt="none">
            {t('plantProposal.countChanged', { count: shown.counts.change })}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          {t('dpProposal.onlyAddChange')}
        </Text>
        {p.hidden > 0 && (
          <Text size="xs" mt={4} data-testid="dp-proposal-hidden">
            {t('plantProposal.hidden', { count: p.hidden })}
          </Text>
        )}
        {p.parts > 1 && (
          <Text size="xs" mt={4}>
            {t('plantProposal.inParts', { count: p.parts, n: fmtNumber(p.parts) })}
          </Text>
        )}
        {p.result && (
          <Text size="xs" mt={4} data-testid="dp-proposal-result">
            {t('dpProposal.applied', { add: p.result.add, change: p.result.change })}
          </Text>
        )}
      </Paper>
      {now && !now.ok && (
        <Alert color="red" variant="light" title={t('plantProposal.problemsTitle')} data-testid="dp-proposal-problems">
          <List size="sm" spacing={2}>
            {now.problems.map((x, i) => (
              <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                {x.path}: {x.message}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {now && p.changedSince && (
        <Alert color="yellow" variant="light" title={t('plantProposal.changedSinceTitle')} data-testid="dp-proposal-changed-since">
          <Stack gap="xs">
            <Text size="sm">{t('plantProposal.changedSinceText')}</Text>
            {editable && now.ok && (
              <Checkbox
                checked={confirmed}
                onChange={(e) => setConfirmed(e.currentTarget.checked)}
                label={t('plantProposal.confirm')}
                data-testid="dp-proposal-confirm"
              />
            )}
          </Stack>
        </Alert>
      )}
      <Title order={2} fz="h4">
        {now ? t('plantProposal.previewNow') : t('plantProposal.previewProposed')}
      </Title>
      <Changes changes={shown.changes} testId="dp-proposal-preview" />
      {shown.warnings.length > 0 && (
        <Alert color="yellow" variant="light" p="xs" title={t('plantProposal.warnings')}>
          <List size="sm" spacing={2}>
            {shown.warnings.map((w, i) => (
              <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                {w}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}
