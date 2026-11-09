import { useEffect, useState } from 'react';
import { Alert, Badge, Checkbox, Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { McpPlantPreview, McpPlantProposal, McpProposalSelection } from '@sm/shared';
import { ChangeTable, useKindLabel } from '../plant/changes';

/** One preview: the entries it adds, the entries it changes (with what differs), its warnings and checks. */
function PreviewParts({ p, testId }: { p: McpPlantPreview; testId: string }) {
  const { t } = useTranslation('mcp');
  const kindLabel = useKindLabel();
  const added = p.changes.filter((c) => c.action === 'add');
  const changed = p.changes.filter((c) => c.action === 'change');
  return (
    <Stack gap="sm" data-testid={testId}>
      {added.length > 0 && (
        <Stack gap={4} data-testid={`${testId}-added`}>
          <Title order={3} fz="h5">
            {t('plantProposal.added', { count: added.length })}
          </Title>
          <ChangeTable changes={added} kindLabel={kindLabel} />
        </Stack>
      )}
      {changed.length > 0 && (
        <Stack gap={4} data-testid={`${testId}-changed`}>
          <Title order={3} fz="h5">
            {t('plantProposal.changed', { count: changed.length })}
          </Title>
          <ChangeTable changes={changed} kindLabel={kindLabel} diffsOpen />
        </Stack>
      )}
      {p.warnings.length > 0 && (
        <Alert color="yellow" variant="light" p="xs" title={t('plantProposal.warnings')}>
          <List size="sm" spacing={2}>
            {p.warnings.map((w, i) => (
              <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                {w.path}: {w.message}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
      {p.checks.length > 0 && (
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {t('plantProposal.checks')}
          </Text>
          <List size="sm" spacing={2}>
            {p.checks.map((c, i) => (
              <List.Item key={i} style={{ overflowWrap: 'anywhere' }}>
                {c.message}
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Reviewing plant registry changes an AI assistant proposed (0.12.0): what they add and change, grouped, a changed entry
 * with its differences field by field. While the request is open the preview of now is shown, as the reviewer; when it
 * differs from the one of the proposal the reviewer confirms it before applying. The assistant's texts are plain text.
 */
export function PlantProposalReview({
  p,
  editable,
  onChange,
}: {
  p: McpPlantProposal;
  editable: boolean;
  onChange: (selection: McpProposalSelection, count: number) => void;
}) {
  const { t } = useTranslation('mcp');
  const [confirmed, setConfirmed] = useState(false);
  const now = p.now;
  const shown = now ?? p.proposed;
  useEffect(() => {
    const count = now?.ok ? now.counts.add + now.counts.change : 0;
    if (!now) onChange({}, 0);
    else if (p.changedSince) onChange(confirmed ? { plant: { fingerprint: now.fingerprint } } : {}, confirmed ? count : 0);
    else onChange({ plant: { fingerprint: now.fingerprint } }, count);
  }, [now, p.changedSince, confirmed, onChange]);
  return (
    <Stack gap="sm" data-testid="plant-proposal">
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
          {t('plantProposal.onlyAddChange')}
        </Text>
        {p.hidden > 0 && (
          <Text size="xs" mt={4} data-testid="plant-proposal-hidden">
            {t('plantProposal.hidden', { count: p.hidden })}
          </Text>
        )}
        {p.importId && (
          <Text size="xs" mt={4}>
            {t('plantProposal.appliedAs', { id: p.importId })}
          </Text>
        )}
      </Paper>
      {now && !now.ok && (
        <Alert color="red" variant="light" title={t('plantProposal.problemsTitle')} data-testid="plant-proposal-problems">
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
        <Alert color="yellow" variant="light" title={t('plantProposal.changedSinceTitle')} data-testid="plant-proposal-changed-since">
          <Stack gap="xs">
            <Text size="sm">{t('plantProposal.changedSinceText')}</Text>
            {editable && now.ok && (
              <Checkbox
                checked={confirmed}
                onChange={(e) => setConfirmed(e.currentTarget.checked)}
                label={t('plantProposal.confirm')}
                data-testid="plant-proposal-confirm"
              />
            )}
          </Stack>
        </Alert>
      )}
      <Title order={2} fz="h4">
        {now ? t('plantProposal.previewNow') : t('plantProposal.previewProposed')}
      </Title>
      <PreviewParts p={shown} testId="plant-proposal-preview" />
      {now && p.changedSince && (
        <details>
          <summary>
            <Text span size="sm" fw={600}>
              {t('plantProposal.previewProposed')}
            </Text>
          </summary>
          <PreviewParts p={p.proposed} testId="plant-proposal-proposed" />
        </details>
      )}
    </Stack>
  );
}
