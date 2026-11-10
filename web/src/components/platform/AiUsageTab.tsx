import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Anchor, Badge, Button, Group, Modal, NumberInput, Paper, Progress, Select, SimpleGrid, Stack, Text, Textarea, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AiBudgetScope, AiBudgetUse, AiUsageEntry, AiUsageOverview, AiUsageTotals, Platform, ProcessSummary } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { useMe } from '../../auth';
import { fmtDate, fmtNumber, fmtRelative } from '../../format';
import { aiKeys, platformKeys, processKeys } from '../../queryKeys';
import { DataTable, type DataColumn } from '../DataTable';
import { EmptyState, QueryState } from '../common';
import { FormatBadge } from './AiModelsTab';

/**
 * Platform → AI usage (LLM gateways, 0.6.0, docs/AI.md): the budgets of the installation and of this gateway with their
 * use today and this month, the totals, the processes and models that used the most, and the latest calls. Readers of
 * the platform see it (names of processes they may not view are left out); administrators change budgets – raising
 * one asks them to confirm it is them (step-up). Administrators and auditors also see the budgets of processes.
 */
export function AiUsageTab({ platform }: { platform: Platform }) {
  const { t } = useTranslation(['platforms', 'common']);
  const { caps } = useMe();
  const q = useQuery({
    queryKey: platformKeys.aiUsage(platform.id),
    queryFn: () => get<AiUsageOverview>(`/platforms/${platform.id}/ai/usage`),
    refetchInterval: 30_000,
  });
  const [editing, setEditing] = useState<AiBudgetUse | { scope: AiBudgetScope; scopeId: string; name: string } | null>(null);
  if (!q.data) return <QueryState query={q} />;
  const o = q.data;
  return (
    <Stack maw={1100} data-testid="ai-usage-tab">
      <Text size="sm">{t('aiUsage.intro')}</Text>
      <Title order={4}>{t('aiUsage.budgets')}</Title>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {o.budgets.map((b) => (
          <BudgetCard key={`${b.scope}:${b.scopeId}`} budget={b} canEdit={o.canEditBudgets} onEdit={() => setEditing(b)} />
        ))}
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Totals title={t('aiUsage.today')} totals={o.today} />
        <Totals title={t('aiUsage.thisMonth')} totals={o.thisMonth} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <TopProcesses overview={o} />
        <ByModel overview={o} />
      </SimpleGrid>
      {(caps.viewAudit || o.canEditBudgets) && <ProcessBudgets canEdit={o.canEditBudgets} onEdit={setEditing} />}
      <RecentCalls entries={o.recent} />
      {editing && <BudgetModal budget={editing} platformId={platform.id} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

/** Costs are small numbers: two significant digits below one cent, else two decimals. */
const fmtCost = (v: number) =>
  v === 0 ? fmtNumber(0) : Math.abs(v) < 0.01 ? fmtNumber(v, { maximumSignificantDigits: 2 }) : fmtNumber(v, { maximumFractionDigits: 2 });

const stateColor = (s: AiBudgetUse['state']) => (s === 'exhausted' ? 'red' : s === 'warning' ? 'orange' : 'teal');

function scopeTitle(t: (k: string, o?: Record<string, unknown>) => string, b: { scope: AiBudgetScope; name: string }) {
  return b.scope === 'installation'
    ? t('aiUsage.scope.installation')
    : b.scope === 'platform'
      ? t('aiUsage.scope.platform', { name: b.name })
      : t('aiUsage.scope.process', { name: b.name });
}

function BudgetCard({ budget: b, canEdit, onEdit }: { budget: AiBudgetUse; canEdit: boolean; onEdit: () => void }) {
  const { t } = useTranslation('platforms');
  const tt = t as unknown as (k: string, o?: Record<string, unknown>) => string;
  return (
    <Paper withBorder p="md" data-testid="ai-budget">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Text fw={600} style={{ wordBreak: 'break-word' }}>
              {scopeTitle(tt, b)}
            </Text>
            <Group gap={6} wrap="wrap">
              <Badge color={stateColor(b.state)} variant="light" style={{ flexShrink: 0 }}>
                {t(`aiUsage.state.${b.state}`)}
              </Badge>
              <Text size="xs" c="dimmed">
                {b.updatedAt ? t('aiUsage.setBy', { who: b.updatedBy, when: fmtRelative(b.updatedAt) }) : t('aiUsage.noBudgetYet')}
              </Text>
            </Group>
          </Stack>
          {canEdit && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconEdit size={14} />}
              onClick={onEdit}
              aria-label={t('aiUsage.editNamed', { name: scopeTitle(tt, b) })}
              style={{ flexShrink: 0 }}
            >
              {t('aiUsage.edit')}
            </Button>
          )}
        </Group>
        <Meter label={t('aiUsage.perDay')} used={b.usedToday} limit={b.tokensPerDay} />
        <Meter label={t('aiUsage.perMonth')} used={b.usedThisMonth} limit={b.tokensPerMonth} />
      </Stack>
    </Paper>
  );
}

/** Use against a limit: a bar (orange from 80 %, red when used up), or the use alone without a limit. */
function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const { t } = useTranslation('platforms');
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const color = !limit ? 'gray' : pct >= 100 ? 'red' : pct >= 80 ? 'orange' : 'teal';
  const text = limit
    ? t('aiUsage.meter', { used: fmtNumber(used), limit: fmtNumber(limit), pct: fmtNumber(pct, { maximumFractionDigits: 0 }) })
    : t('aiUsage.meterNoLimit', { used: fmtNumber(used) });
  return (
    <Stack gap={4}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Text size="sm" c={limit ? undefined : 'dimmed'}>
          {text}
        </Text>
      </Group>
      <Progress value={limit ? pct : 0} color={color} size="md" aria-label={`${label}: ${text}`} />
    </Stack>
  );
}

function Totals({ title, totals: x }: { title: string; totals: AiUsageTotals }) {
  const { t } = useTranslation('platforms');
  const tiles = [
    { label: t('aiUsage.calls'), value: fmtNumber(x.calls) },
    { label: t('aiUsage.refused'), value: fmtNumber(x.refused), color: x.refused ? 'orange' : undefined },
    { label: t('aiUsage.inputTokens'), value: fmtNumber(x.inputTokens) },
    { label: t('aiUsage.outputTokens'), value: fmtNumber(x.outputTokens) },
    ...(x.cost !== null ? [{ label: t('aiUsage.cost'), value: fmtCost(x.cost) }] : []),
  ];
  return (
    <Paper withBorder p="md">
      <Text fw={600} mb="xs">
        {title}
      </Text>
      <SimpleGrid cols={{ base: 2, xs: 3 }} spacing="xs">
        {tiles.map((tile) => (
          <Stack key={tile.label} gap={0}>
            <Text size="xs" c="dimmed">
              {tile.label}
            </Text>
            <Text size="lg" fw={600} c={tile.color}>
              {tile.value}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
    </Paper>
  );
}

function TopProcesses({ overview: o }: { overview: AiUsageOverview }) {
  const { t } = useTranslation('platforms');
  return (
    <Paper withBorder p="md">
      <Text fw={600} mb="xs">
        {t('aiUsage.topProcesses')}
      </Text>
      {o.topProcesses.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('aiUsage.noUseThisMonth')}
        </Text>
      ) : (
        <Stack gap={6} data-testid="ai-top-processes">
          {o.topProcesses.map((p, i) => {
            const share = o.thisMonth.inputTokens + o.thisMonth.outputTokens ? (p.tokens / (o.thisMonth.inputTokens + o.thisMonth.outputTokens)) * 100 : 0;
            const name = p.processId ? p.name : p.name === 'Connection tests' ? t('aiUsage.connectionTests') : t('aiUsage.otherProcesses');
            return (
              <Stack key={`${p.processId ?? 'none'}-${i}`} gap={2}>
                <Group justify="space-between" gap="xs" wrap="nowrap">
                  {p.processId ? (
                    <Anchor component={Link} to={`/processes/${encodeURIComponent(p.processId)}`} size="sm" style={{ minWidth: 0, wordBreak: 'break-word' }}>
                      {name}
                    </Anchor>
                  ) : (
                    <Text size="sm" c="dimmed" fs="italic">
                      {name}
                    </Text>
                  )}
                  <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
                    {t('aiUsage.processTokens', { tokens: fmtNumber(p.tokens), calls: fmtNumber(p.calls) })}
                  </Text>
                </Group>
                <Progress value={share} size="xs" color="pink" aria-label={t('aiUsage.share', { name, pct: fmtNumber(share, { maximumFractionDigits: 0 }) })} />
              </Stack>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}

function ByModel({ overview: o }: { overview: AiUsageOverview }) {
  const { t } = useTranslation('platforms');
  return (
    <Paper withBorder p="md">
      <Text fw={600} mb="xs">
        {t('aiUsage.byModel')}
      </Text>
      {o.byModel.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('aiUsage.noUseThisMonth')}
        </Text>
      ) : (
        <Stack gap={8}>
          {o.byModel.map((m) => (
            <Group key={m.model} justify="space-between" gap="xs" wrap="wrap">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
                  {m.model}
                </Text>
                <FormatBadge format={m.format} />
              </Stack>
              <Text size="sm" ta="right">
                {t('aiUsage.modelUse', { calls: fmtNumber(m.calls), input: fmtNumber(m.inputTokens), output: fmtNumber(m.outputTokens) })}
                {m.cost !== null && (
                  <Text span size="xs" c="dimmed" display="block">
                    {t('aiUsage.costValue', { cost: fmtCost(m.cost) })}
                  </Text>
                )}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

/** Budgets of single processes (every gateway): administrators change them, auditors read them. */
function ProcessBudgets({ canEdit, onEdit }: { canEdit: boolean; onEdit: (b: AiBudgetUse | { scope: AiBudgetScope; scopeId: string; name: string }) => void }) {
  const { t } = useTranslation('platforms');
  const q = useQuery({ queryKey: aiKeys.budgets, queryFn: () => get<{ budgets: AiBudgetUse[] }>('/ai/budgets') });
  const processes = useQuery({ queryKey: processKeys.all, queryFn: () => get<ProcessSummary[]>('/processes'), enabled: canEdit });
  const [adding, setAdding] = useState<string | null>(null);
  const list = (q.data?.budgets ?? []).filter((b) => b.scope === 'process');
  return (
    <Paper withBorder p="md" data-testid="ai-process-budgets">
      <Stack gap="sm">
        <Text fw={600}>{t('aiUsage.processBudgets')}</Text>
        <Text size="xs" c="dimmed">
          {t('aiUsage.processBudgetsHint')}
        </Text>
        {list.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('aiUsage.noProcessBudgets')}
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            {list.map((b) => (
              <BudgetCard key={b.scopeId} budget={b} canEdit={canEdit} onEdit={() => onEdit(b)} />
            ))}
          </SimpleGrid>
        )}
        {canEdit && (
          <Group align="flex-end" gap="xs" wrap="wrap">
            <Select
              label={t('aiUsage.addProcessBudget')}
              placeholder={t('aiUsage.chooseProcess')}
              searchable
              data={(processes.data ?? []).filter((p) => !list.some((b) => b.scopeId === p.id)).map((p) => ({ value: p.id, label: p.name }))}
              value={adding}
              onChange={setAdding}
              w={{ base: '100%', xs: 320 }}
            />
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              disabled={!adding}
              onClick={() => {
                const p = (processes.data ?? []).find((x) => x.id === adding);
                if (p) onEdit({ scope: 'process', scopeId: p.id, name: p.name });
                setAdding(null);
              }}
            >
              {t('aiUsage.setBudget')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function RecentCalls({ entries }: { entries: AiUsageEntry[] }) {
  const { t } = useTranslation('platforms');
  const result = (e: AiUsageEntry) => (
    <Tooltip label={e.reason} disabled={!e.reason}>
      <Badge size="sm" variant="light" color={e.result === 'ok' ? 'teal' : e.result === 'refused' ? 'orange' : e.result === 'pending' ? 'blue' : 'red'}>
        {t(`aiUsage.result.${e.result}`)}
      </Badge>
    </Tooltip>
  );
  const process = (e: AiUsageEntry) =>
    e.processId ? (
      e.runId ? (
        <Anchor component={Link} to={`/runs/${e.runId}`} size="sm">
          {e.processName}
        </Anchor>
      ) : (
        <Text size="sm">{e.processName}</Text>
      )
    ) : (
      <Text size="sm" c="dimmed" fs="italic">
        {e.stepKey === 'connection-test' ? t('aiUsage.connectionTest') : t('aiUsage.otherProcess')}
      </Text>
    );
  const columns: DataColumn<AiUsageEntry>[] = [
    { key: 'at', header: t('aiUsage.columns.at'), nowrap: true, sortValue: (e) => e.at, cell: (e) => <span title={fmtDate(e.at)}>{fmtRelative(e.at)}</span> },
    { key: 'process', header: t('aiUsage.columns.process'), sortValue: (e) => e.processName ?? '', cell: process },
    {
      key: 'model',
      header: t('aiUsage.columns.model'),
      sortValue: (e) => e.model,
      cell: (e) => (
        <Text size="sm" className="mono">
          {e.model}
        </Text>
      ),
    },
    {
      key: 'tokens',
      header: t('aiUsage.columns.tokens'),
      nowrap: true,
      sortValue: (e) => e.inputTokens + e.outputTokens,
      cell: (e) => `${fmtNumber(e.inputTokens)} / ${fmtNumber(e.outputTokens)}`,
    },
    {
      key: 'duration',
      header: t('aiUsage.columns.duration'),
      nowrap: true,
      sortValue: (e) => e.durationMs,
      cell: (e) => (e.result === 'refused' ? '–' : `${fmtNumber(e.durationMs)} ms`),
    },
    { key: 'result', header: t('aiUsage.columns.result'), nowrap: true, sortValue: (e) => e.result, cell: result },
  ];
  return (
    <Stack gap="xs">
      <Title order={4}>{t('aiUsage.recent')}</Title>
      {entries.length === 0 ? (
        <EmptyState title={t('aiUsage.noCalls')} compact>
          {t('aiUsage.noCallsHint')}
        </EmptyState>
      ) : (
        <DataTable
          rows={entries}
          columns={columns}
          rowKey={(e) => e.id}
          ariaLabel={t('aiUsage.recent')}
          testId="ai-recent"
          card={(e) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  {process(e)}
                  <Text size="xs" className="mono" style={{ wordBreak: 'break-all' }}>
                    {e.model}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('aiUsage.cardLine', { when: fmtRelative(e.at), input: fmtNumber(e.inputTokens), output: fmtNumber(e.outputTokens) })}
                  </Text>
                  {e.reason && (
                    <Text size="xs" c="dimmed" className="mono">
                      {e.reason}
                    </Text>
                  )}
                </Stack>
                {result(e)}
              </Group>
            </Paper>
          )}
        />
      )}
    </Stack>
  );
}

/** Set a budget (empty: no limit). Raising one (or removing its limit) asks the administrator to confirm it is them. */
function BudgetModal({
  budget,
  platformId,
  onClose,
}: {
  budget: AiBudgetUse | { scope: AiBudgetScope; scopeId: string; name: string };
  platformId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const tt = t as unknown as (k: string, o?: Record<string, unknown>) => string;
  const qc = useQueryClient();
  const current = 'tokensPerDay' in budget ? budget : null;
  const [day, setDay] = useState<number | ''>(current?.tokensPerDay ?? '');
  const [month, setMonth] = useState<number | ''>(current?.tokensPerMonth ?? '');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const raises = (from: number | null | undefined, to: number | '') => from !== null && from !== undefined && (to === '' || to > from);
  const raising = !!current && (raises(current.tokensPerDay, day) || raises(current.tokensPerMonth, month));
  const save = async () => {
    setBusy(true);
    try {
      await put('/ai/budgets', {
        scope: budget.scope,
        scopeId: budget.scopeId,
        tokensPerDay: day === '' ? null : day,
        tokensPerMonth: month === '' ? null : month,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      await qc.invalidateQueries({ queryKey: platformKeys.aiUsage(platformId) });
      await qc.invalidateQueries({ queryKey: aiKeys.budgets });
      notifyOk(t('aiUsage.saved'));
      onClose();
    } catch (e) {
      notifyError(e, t('aiUsage.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('aiUsage.editTitle', { name: scopeTitle(tt, budget) })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('aiUsage.editHint')}
        </Text>
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <NumberInput
            label={t('aiUsage.tokensPerDay')}
            placeholder={t('aiUsage.noLimit')}
            min={0}
            thousandSeparator
            data-autofocus
            value={day}
            onChange={(v) => setDay(v === '' ? '' : Number(v))}
          />
          <NumberInput
            label={t('aiUsage.tokensPerMonth')}
            placeholder={t('aiUsage.noLimit')}
            min={0}
            thousandSeparator
            value={month}
            onChange={(v) => setMonth(v === '' ? '' : Number(v))}
          />
        </SimpleGrid>
        <Textarea
          label={t('aiUsage.comment')}
          description={t('aiUsage.commentHint')}
          autosize
          minRows={2}
          maxLength={1000}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
        {raising && (
          <Text size="xs" c="orange" data-testid="ai-budget-raise">
            {t('aiUsage.raiseHint')}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
