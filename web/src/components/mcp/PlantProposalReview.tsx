import { useEffect, useState } from 'react';
import { Alert, Anchor, Badge, Checkbox, Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconBook, IconPaperclip } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { McpPlantPreview, McpPlantProposal, McpPlantSourceGroup, McpProposalSelection } from '@sm/shared';
import { ChangeTable, useKindLabel } from '../plant/changes';
import { ShowAll, useShowMore } from '../page/ShowAll';
import { fmtNumber } from '../../format';

const entryPath = (g: McpPlantSourceGroup) =>
  g.kind === 'profile' ? `/plant/profiles/${encodeURIComponent(g.entry)}` : `/plant/assets/${encodeURIComponent(g.entry)}`;

/**
 * 0.16.1: the data points of one entry described by one document – each with its page and section – and whether the
 * document is kept in Steward: the record linked to the entry, or the offer to attach it on the entry's Documents panel.
 */
function SourceGroup({ g }: { g: McpPlantSourceGroup }) {
  const { t } = useTranslation(['mcp', 'plant']);
  const more = useShowMore(g.points, 10);
  const docs = `${entryPath(g)}#plant-docs-${g.kind === 'profile' ? 'device-profile' : 'asset'}`;
  return (
    <Paper withBorder p="sm" data-testid="plant-proposal-source-doc">
      <Stack gap={6}>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <IconBook size={16} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
              {g.document}
            </Text>
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {g.kind === 'profile' ? t('plantProposal.sourceOfProfile', { name: g.entryName }) : t('plantProposal.sourceOfAsset', { name: g.entryName })}
            </Text>
          </Stack>
        </Group>
        {g.record ? (
          <Text size="xs" data-testid="plant-proposal-source-record">
            {t('plantProposal.sourceKept')}{' '}
            <Anchor component={Link} to={`/records/${encodeURIComponent(g.record.id)}`} size="xs">
              {g.record.number} {g.record.title}
            </Anchor>
          </Text>
        ) : g.exists ? (
          <Group gap={4} wrap="wrap" data-testid="plant-proposal-attach">
            <IconPaperclip size={14} aria-hidden />
            <Anchor component={Link} to={docs} size="xs">
              {t('plantProposal.attachManual')}
            </Anchor>
            <Text size="xs" c="dimmed">
              {t('plantProposal.attachManualHint')}
            </Text>
          </Group>
        ) : (
          <Text size="xs" c="dimmed" data-testid="plant-proposal-attach-later">
            {t('plantProposal.attachManualLater')}
          </Text>
        )}
        <List size="sm" spacing={2} data-testid="plant-proposal-source-points">
          {more.items.map((x) => (
            <List.Item key={`${x.interface}/${x.id}`} style={{ overflowWrap: 'anywhere' }}>
              <Text span size="sm" fw={500}>
                {x.name}
              </Text>{' '}
              <Text span size="xs" c="dimmed" className="mono">
                {x.id}
              </Text>{' '}
              <Badge size="xs" variant="light" color={x.action === 'add' ? 'green' : 'blue'} tt="none">
                {x.action === 'add' ? t('plantProposal.pointAdded') : t('plantProposal.pointChanged')}
              </Badge>{' '}
              <Text span size="xs">
                {[x.page ? t('plant:data.sourcePageIs', { page: x.page }) : '', x.section].filter(Boolean).join(' · ')}
              </Text>
            </List.Item>
          ))}
        </List>
        <ShowAll state={more} id={`sources-${g.kind}-${g.entry}`} />
      </Stack>
    </Paper>
  );
}

/** 0.16.1: where the proposed data points come from, by entry and document. */
function Sources({ p }: { p: McpPlantProposal }) {
  const { t } = useTranslation('mcp');
  const groups = p.sources ?? [];
  if (!groups.length) return null;
  const count = groups.reduce((n, g) => n + g.points.length, 0) + (p.sourcesMore ?? 0);
  return (
    <Stack gap="xs" data-testid="plant-proposal-sources">
      <Title order={2} fz="h4">
        {t('plantProposal.sources', { count, n: fmtNumber(count) })}
      </Title>
      <Text size="xs" c="dimmed">
        {t('plantProposal.sourcesHint')}
      </Text>
      {groups.map((g) => (
        <SourceGroup key={`${g.kind}/${g.entry}/${g.document}`} g={g} />
      ))}
      {(p.sourcesMore ?? 0) > 0 && (
        <Text size="xs" c="dimmed">
          {t('plantProposal.sourcesMore', { count: p.sourcesMore, n: fmtNumber(p.sourcesMore ?? 0) })}
        </Text>
      )}
    </Stack>
  );
}

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
  // 0.16.1: the assistant is still sending parts – nothing to review yet (or it never sent the last one)
  if (p.incomplete || p.unfinished)
    return (
      <Stack gap="sm" data-testid="plant-proposal">
        <Paper withBorder p="sm">
          <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
            {p.title}
          </Text>
        </Paper>
        <Alert color={p.incomplete ? 'blue' : 'gray'} variant="light" data-testid="plant-proposal-incomplete">
          {p.incomplete
            ? t('plantProposal.incomplete', { count: p.parts ?? 0, n: fmtNumber(p.parts ?? 0), kb: fmtNumber(Math.ceil(p.document.bytes / 1024)) })
            : t('plantProposal.unfinished', { count: p.parts ?? 0, n: fmtNumber(p.parts ?? 0) })}
        </Alert>
      </Stack>
    );
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
        {(p.parts ?? 1) > 1 && (
          <Text size="xs" mt={4} data-testid="plant-proposal-parts">
            {t('plantProposal.inParts', { count: p.parts, n: fmtNumber(p.parts ?? 0) })}
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
      <Sources p={p} />
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
