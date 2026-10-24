import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Box, Button, Center, Collapse, Group, Loader, Paper, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronDown, IconChevronRight, IconRefresh } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { NodeInspection } from '@sm/shared';
import i18n from '../../i18n';
import { JsonView, StatusBadge, statusLabel } from '../common';
import { fmtDate, fmtDuration, fmtRelative } from '../../format';
import { inspectNode, isNotFound, useLatestRun, useRunDetail } from './editorApi';
import { errorText } from '../../i18n/errors';
import { withBase } from '../../basePath';

type Activation = NodeInspection['activations'][number];

function Section({ title, children, defaultOpen = false, color }: { title: string; children: ReactNode; defaultOpen?: boolean; color?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap={4}>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          <Text size="xs" fw={600} c={color}>
            {title}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        <Box mt={4}>{children}</Box>
      </Collapse>
    </Box>
  );
}

const loopLabel = (key: string): string | null => {
  const idx = [...key.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]) + 1);
  return idx.length ? i18n.t('editor:inspector.item', { n: idx.join(' / ') }) : null;
};

const present = (v: unknown) => v !== undefined && v !== null;

function ActivationView({ a, first }: { a: Activation; first: boolean }) {
  const { t } = useTranslation('editor');
  const loop = loopLabel(a.key);
  return (
    <Paper withBorder p={6}>
      <Group gap={6} wrap="wrap">
        <StatusBadge status={a.status} size="xs" />
        {loop && (
          <Tooltip label={a.key}>
            <Badge size="xs" variant="outline" color="gray">
              {loop}
            </Badge>
          </Tooltip>
        )}
        <Text size="xs" c="dimmed">
          {fmtDuration(a.durationMs)}
        </Text>
        <Text size="xs" c="dimmed" ml="auto">
          {fmtDate(a.startedAt)}
        </Text>
      </Group>
      <Stack gap={4} mt={4}>
        {a.error && (
          <Alert color="red" p={6}>
            <Text size="xs" style={{ wordBreak: 'break-word' }}>
              {a.error}
            </Text>
          </Alert>
        )}
        {present(a.input) && (
          <Section title={t('inspector.input')}>
            <JsonView value={a.input} maxHeight={240} />
          </Section>
        )}
        {present(a.output) && (
          <Section title={t('inspector.output')} defaultOpen={first}>
            <JsonView value={a.output} maxHeight={300} />
          </Section>
        )}
        {!present(a.input) && !present(a.output) && !a.error && (
          <Text size="xs" c="dimmed">
            {t('inspector.noData')}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

/** "Last run" view of one node: activations with input / output / error and the variables before it ran. */
export function NodeInspector({ processId, nodeId }: { processId?: string; nodeId: string }) {
  const { t } = useTranslation(['editor', 'common']);
  const qc = useQueryClient();
  const latest = useLatestRun(processId);
  const run = latest.data?.[0];
  const runId = run?.id;
  const inspect = useQuery({
    queryKey: ['inspect', runId, nodeId],
    queryFn: () => inspectNode(runId!, nodeId),
    enabled: !!runId,
    retry: false,
  });
  // older servers: fall back to the step records of the run detail
  const fallback = !!runId && !!inspect.error && isNotFound(inspect.error);
  const detail = useRunDetail(fallback ? runId : undefined);
  const [showAll, setShowAll] = useState(false);

  const activations: Activation[] = useMemo(() => {
    if (inspect.data) return inspect.data.activations;
    if (fallback && detail.data)
      return detail.data.steps
        .filter((s) => s.stepId === nodeId)
        .map((s) => ({ key: s.key, status: s.status, startedAt: s.startedAt, durationMs: s.durationMs, input: s.input, output: s.output, error: s.error }));
    return [];
  }, [inspect.data, fallback, detail.data, nodeId]);

  if (!processId) {
    return (
      <Text size="sm" c="dimmed">
        {t('inspector.saveFirst')}
      </Text>
    );
  }
  if (latest.isLoading || (runId && inspect.isLoading) || (fallback && detail.isLoading)) {
    return (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    );
  }
  if (!run) {
    return (
      <Text size="sm" c="dimmed">
        {t('inspector.noRun')}
      </Text>
    );
  }
  const hardError = inspect.error && !fallback ? errorText(inspect.error) : detail.error ? errorText(detail.error) : null;
  const limit = showAll ? activations.length : 20;
  const varsBefore = inspect.data?.varsBefore;

  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed" truncate>
          <Trans
            t={t}
            i18nKey={run.dryRun ? 'inspector.runLineDry' : 'inspector.runLine'}
            values={{ id: run.id, status: statusLabel(run.status), when: fmtRelative(run.startedAt) }}
            components={{ a: <Anchor href={withBase(`/runs/${run.id}`)} target="_blank" size="xs" className="mono" /> }}
          />
        </Text>
        <Tooltip label={t('inspector.reload')}>
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label={t('inspector.reloadLabel')}
            onClick={() => {
              qc.invalidateQueries({ queryKey: ['runs', 'latest', processId] });
              qc.invalidateQueries({ queryKey: ['inspect'] });
              qc.invalidateQueries({ queryKey: ['run', runId] });
            }}
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      {hardError && (
        <Alert color="red" p="xs">
          <Text size="xs">{hardError}</Text>
        </Alert>
      )}
      {!hardError && activations.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('inspector.didNotRun')}
        </Text>
      )}
      {activations.length > 1 && (
        <Text size="xs" c="dimmed">
          {t('inspector.activations', { count: activations.length })}
        </Text>
      )}
      {activations.slice(0, limit).map((a, i) => (
        <ActivationView key={`${a.key}-${i}`} a={a} first={i === 0} />
      ))}
      {activations.length > limit && (
        <Button size="compact-xs" variant="light" onClick={() => setShowAll(true)}>
          {t('inspector.showAll', { count: activations.length })}
        </Button>
      )}
      {varsBefore && Object.keys(varsBefore).length > 0 && (
        <Paper withBorder p={6}>
          <Section title={t('inspector.varsBefore', { count: Object.keys(varsBefore).length })}>
            <JsonView value={varsBefore} maxHeight={300} />
          </Section>
        </Paper>
      )}
      {fallback && (
        <Text size="10px" c="dimmed">
          {t('inspector.varsUnavailable')}
        </Text>
      )}
    </Stack>
  );
}
