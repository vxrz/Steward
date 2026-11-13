import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconCircleCheck, IconCircleDashed, IconCircleMinus, IconCircleX, IconPlus, IconScale, IconTrash, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_COST_MATCH_KINDS,
  type DataCostAllocation,
  type DataCostMatch,
  type DataCostMatchKind,
  type DataProduct,
  type DataProductCosts,
  type DataProductScorecard,
  type DataScorecardState,
} from '@sm/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { del, notifyError, post, put } from '../../api';
import { ErrorState, useFieldErrors } from '../../components/common';
import { confirmDanger } from '../../components/confirm';
import { FormModal } from '../../components/FormModal';
import { TableScroll } from '../../components/TableScroll';
import { useLevel } from '../../components/catalogue/cia';
import { fmtMonth } from '../../components/costs/common';
import { FormButtons, useBusy } from '../../components/dataproducts/form';
import { fmtNumber, numberFormat } from '../../format';
import { useAllocations, useInvalidateDataProducts, usePlatforms, useProductCosts } from './api';
import { EnvironmentSwitch, Fact, Section, useEnvironmentParam } from './parts';

const enc = encodeURIComponent;

/** An amount in micros as money in its currency (UI language). */
export function money(micros: number, currency: string): string {
  try {
    return numberFormat({ style: 'currency', currency, maximumFractionDigits: 0 }).format(micros / 1e6);
  } catch {
    return `${fmtNumber(Math.round(micros / 1e6))} ${currency}`;
  }
}

const totalText = (totals: { currency: string; amountMicros: number }[]) => totals.map((x) => money(x.amountMicros, x.currency)).join(' + ');

/** What a match claims, in words: "Resource lkc-123", "Tag team = sales". */
export function useMatchText(): (m: { kind: DataCostMatchKind; value: string | null; tagKey: string }) => string {
  const { t } = useTranslation('dataProducts');
  return (m) =>
    m.value === null
      ? t('costs.matchHidden')
      : m.kind === 'tag'
        ? t('costs.matchTag', { key: m.tagKey, value: m.value })
        : `${t(`costs.matchKinds.${m.kind}`)} ${m.value}`;
}

/**
 * The costs of a product (ADR 0036 part 11): an attribution of the cost lines Steward reads – showback, never
 * chargeback. Lines only this product matches are direct; shared lines are split by their allocation's rule. A part
 * the reader may not see makes a month incomplete, never a figure from which it could be computed.
 */
export function ProductCostsTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProducts');
  const [months, setMonths] = useState('6');
  const [envParam, setEnvironment] = useEnvironmentParam(p.environments);
  const q = useProductCosts(p.id, envParam, Number(months));
  const c = q.data;
  const [month, setMonth] = useState<string | null>(null);
  const shown = c?.months.find((m) => m.month === month) ?? c?.months.at(-2) ?? c?.months.at(-1);
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t('costs.help')}
        </Text>
        <Group gap="sm" align="flex-end">
          <EnvironmentSwitch
            names={c?.environments ?? p.environments}
            value={c?.environment ?? envParam}
            onChange={setEnvironment}
            testId="costs-environment"
          />
          <Select
            size="xs"
            label={t('costs.period')}
            data={['3', '6', '12', '24'].map((n) => ({ value: n, label: t('costs.months', { count: Number(n) }) }))}
            value={months}
            onChange={(m) => m && setMonths(m)}
            allowDeselect={false}
            w={150}
          />
        </Group>
      </Group>
      {q.isLoading && <Loader size="sm" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {c && !c.environment && (
        <Alert variant="light" color="gray">
          {t('costs.noEnvironment')}
        </Alert>
      )}
      {c && c.environment && (
        <>
          {(c.incomplete || c.amountsHidden) && (
            <Alert variant="light" color="orange" p="xs" data-testid="costs-incomplete">
              {t('costs.incomplete')}
            </Alert>
          )}
          <Section title={t('costs.byMonth')} testId="costs">
            {c.matches.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('costs.noMatches')}
              </Text>
            ) : (
              <TableScroll>
                <Table fz="sm" aria-label={t('costs.byMonth')} highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th scope="col">{t('costs.month')}</Table.Th>
                      <Table.Th scope="col" ta="right">
                        {t('costs.amount')}
                      </Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {[...c.months].reverse().map((m) => (
                      <Table.Tr key={m.month} data-selected={m.month === shown?.month || undefined}>
                        <Table.Td>
                          <Button
                            size="compact-xs"
                            variant={m.month === shown?.month ? 'light' : 'subtle'}
                            onClick={() => setMonth(m.month)}
                            aria-pressed={m.month === shown?.month}
                          >
                            {fmtMonth(m.month)}
                          </Button>
                        </Table.Td>
                        <Table.Td ta="right" className="nowrap">
                          {m.totals.length ? totalText(m.totals) : '–'}
                          {m.incomplete && (
                            <Text span size="xs" c="orange">
                              {' '}
                              ({t('costs.incompleteShort')})
                            </Text>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </TableScroll>
            )}
          </Section>
          {shown && shown.lines.length > 0 && <LinesOfMonth month={shown} />}
          <MatchesSection p={p} costs={c} onChanged={() => void q.refetch()} />
          <AllocationsSection p={p} costs={c} />
        </>
      )}
      <ValueAndCosts p={p} withCosts={false} />
    </Stack>
  );
}

function LinesOfMonth({ month }: { month: DataProductCosts['months'][number] }) {
  const { t } = useTranslation('dataProducts');
  const matchText = useMatchText();
  return (
    <Section title={t('costs.title', { month: fmtMonth(month.month, 'long') })} testId="cost-lines">
      <TableScroll>
        <Table fz="sm" aria-label={t('costs.lines')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">{t('costs.platform')}</Table.Th>
              <Table.Th scope="col">{t('costs.match')}</Table.Th>
              <Table.Th scope="col">{t('costs.kind')}</Table.Th>
              <Table.Th scope="col">{t('costs.share')}</Table.Th>
              <Table.Th scope="col" ta="right">
                {t('costs.amount')}
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {month.lines.map((l, i) => (
              <Table.Tr key={i}>
                <Table.Td>{l.platformName}</Table.Td>
                <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {matchText(l.match)}
                </Table.Td>
                <Table.Td>
                  {l.kind === 'direct' ? t('costs.direct') : t('costs.shareBy', { rule: t(`costs.rules.${l.rule ?? 'equal'}`) })}
                  {l.products > 1 && (
                    <Text size="xs" c="dimmed">
                      {t('costs.splitBetween', { count: l.products })}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{fmtNumber(l.share * 100, { maximumFractionDigits: 1 })} %</Table.Td>
                <Table.Td ta="right" className="nowrap">
                  {money(l.amountMicros, l.currency)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </TableScroll>
      <Text size="xs" c="dimmed" mt="xs">
        {t('costs.showback')}
      </Text>
    </Section>
  );
}

/** A product's matches in the environment – its own and those its elements carry – and adding or removing one. */
function MatchesSection({ p, costs, onChanged }: { p: DataProduct; costs: DataProductCosts; onChanged: () => void }) {
  const { t } = useTranslation('dataProducts');
  const matchText = useMatchText();
  const invalidate = useInvalidateDataProducts();
  const [adding, setAdding] = useState(false);
  const remove = async (m: DataCostMatch) => {
    if (!(await confirmDanger({ action: 'remove', message: t('costs.removeMatchConfirm', { match: matchText(m) }) }))) return;
    try {
      await del(m.elementId ? `/data-elements/${enc(m.elementId)}/cost-matches/${enc(m.id)}` : `/data-products/${enc(p.id)}/costs/matches/${enc(m.id)}`);
      invalidate();
      onChanged();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Section
      title={t('costs.matches')}
      testId="cost-matches"
      actions={
        costs.canEditMatches && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="cost-match-add">
            {t('costs.addMatch')}
          </Button>
        )
      }
    >
      <Text size="sm" c="dimmed" mb="sm">
        {t('costs.matchesHelp')}
      </Text>
      <MatchTable matches={costs.matches} onRemove={(m) => void remove(m)} />
      {adding && (
        <CostMatchForm
          target={{ kind: 'product', id: p.id }}
          environment={costs.environment ?? ''}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            invalidate();
            onChanged();
          }}
        />
      )}
    </Section>
  );
}

export function MatchTable({ matches, onRemove }: { matches: DataCostMatch[]; onRemove: (m: DataCostMatch) => void }) {
  const { t } = useTranslation('dataProducts');
  const matchText = useMatchText();
  if (!matches.length)
    return (
      <Text size="sm" c="dimmed">
        {t('costs.noMatches')}
      </Text>
    );
  return (
    <TableScroll>
      <Table fz="sm" aria-label={t('costs.matches')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">{t('costs.platform')}</Table.Th>
            <Table.Th scope="col">{t('costs.match')}</Table.Th>
            <Table.Th scope="col">{t('costs.from')}</Table.Th>
            <Table.Th scope="col">{t('costs.shared')}</Table.Th>
            <Table.Th scope="col">{t('table.actions')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {matches.map((m) => (
            <Table.Tr key={m.id} data-testid="cost-match">
              <Table.Td>{m.platformHidden ? t('hidden.platform') : m.platformName}</Table.Td>
              <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                {matchText(m)}
              </Table.Td>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>
                {m.element ? (
                  <Text span size="sm" className="mono">
                    {m.element.qualifiedName}
                  </Text>
                ) : (
                  t('costs.fromProduct')
                )}
              </Table.Td>
              <Table.Td>{m.sharedWith ? t('costs.sharedWith', { count: m.sharedWith }) : '–'}</Table.Td>
              <Table.Td>
                {m.canDelete && (
                  <Tooltip label={t('costs.removeMatch')}>
                    <ActionIcon variant="subtle" color="red" aria-label={t('costs.removeMatchNamed', { match: matchText(m) })} onClick={() => onRemove(m)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </TableScroll>
  );
}

/**
 * A cost match: the lines of a platform a product (in one environment) or an element claims – by resource id,
 * sub-account, service name, tag value or the application the lines are mapped to.
 */
export function CostMatchForm({
  target,
  environment,
  onClose,
  onSaved,
}: {
  /** A product's own match (in `environment`) or an element's */
  target: { kind: 'product' | 'element'; id: string };
  environment?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const platforms = usePlatforms();
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [kind, setKind] = useState<DataCostMatchKind>('resource');
  const [value, setValue] = useState('');
  const [tagKey, setTagKey] = useState('');
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    platform: environment !== undefined && !platformId && t('common:validation.required'),
    value: !value.trim() && t('common:validation.required'),
    tagKey: kind === 'tag' && !tagKey.trim() && t('common:validation.required'),
  });
  const save = () =>
    run(async () => {
      const url = target.kind === 'product' ? `/data-products/${enc(target.id)}/costs/matches` : `/data-elements/${enc(target.id)}/cost-matches`;
      await post(url, {
        ...(platformId ? { platformId } : {}),
        ...(environment !== undefined ? { environment } : {}),
        kind,
        value: value.trim(),
        tagKey: kind === 'tag' ? tagKey.trim() : '',
      });
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} title={environment ? t('costs.addMatchIn', { environment }) : t('costs.addMatch')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('costs.matchFormHelp')}
          </Text>
          <Select
            label={t('costs.platform')}
            description={environment === undefined ? t('costs.platformOfElement') : undefined}
            data={(platforms.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            value={platformId}
            onChange={setPlatformId}
            searchable
            clearable={environment === undefined}
            error={v.error('platform')}
            data-testid="cost-match-platform"
          />
          <Select
            label={t('costs.matchKind')}
            data={DATA_COST_MATCH_KINDS.map((k) => ({ value: k, label: t(`costs.matchKinds.${k}`) }))}
            value={kind}
            onChange={(k) => k && setKind(k as DataCostMatchKind)}
            allowDeselect={false}
          />
          {kind === 'tag' && (
            <TextInput label={t('costs.tagKey')} maxLength={100} value={tagKey} onChange={(e) => setTagKey(e.currentTarget.value)} error={v.error('tagKey')} />
          )}
          <TextInput
            label={t('costs.matchValue')}
            description={t(`costs.matchValueHints.${kind}`)}
            maxLength={200}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            error={v.error('value')}
            className="mono"
            data-testid="cost-match-value"
          />
          <FormButtons busy={busy} testId="cost-match-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The splits of the shared lines this product takes part in (set by who may manage the platform). */
function AllocationsSection({ p, costs }: { p: DataProduct; costs: DataProductCosts }) {
  const { t } = useTranslation('dataProducts');
  const matchText = useMatchText();
  const shared = costs.matches.some((m) => m.sharedWith > 0);
  const q = useAllocations(shared);
  const [editing, setEditing] = useState<DataCostAllocation | null>(null);
  const mine = (q.data ?? []).filter((a) => a.products.some((x) => x.product.id === p.id));
  if (!shared) return null;
  return (
    <Section title={t('allocations.title')} testId="cost-allocations">
      <Text size="sm" c="dimmed" mb="sm">
        {t('allocations.help')}
      </Text>
      <Stack gap="xs">
        {mine.map((a) => (
          <Paper key={`${a.platformId}:${a.kind}:${a.tagKey}:${a.value}`} withBorder p="xs">
            <Group justify="space-between" wrap="wrap" gap="xs">
              <div>
                <Text size="sm" fw={500}>
                  {a.platformName} · <span className="mono">{matchText(a)}</span>
                </Text>
                <Text size="xs" c="dimmed">
                  {a.rule === 'weight' ? t('allocations.byWeight') : t('allocations.equal')}
                  {' · '}
                  {a.products.map((x) => `${x.product.name}${a.weightsShown && x.weightPct !== null ? ` ${fmtNumber(x.weightPct)} %` : ''}`).join(', ')}
                  {a.hiddenProducts > 0 && `, ${t('hidden.count', { count: a.hiddenProducts })}`}
                  {a.weightsShown && a.notAttributedPct !== null && a.rule === 'weight'
                    ? ` · ${t('allocations.notAttributed', { pct: fmtNumber(a.notAttributedPct) })}`
                    : ''}
                </Text>
              </div>
              {a.canEdit && (
                <Button size="compact-xs" variant="default" leftSection={<IconScale size={12} />} onClick={() => setEditing(a)} data-testid="allocation-edit">
                  {t('allocations.change')}
                </Button>
              )}
            </Group>
          </Paper>
        ))}
      </Stack>
      {editing && (
        <AllocationForm
          a={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void q.refetch();
          }}
        />
      )}
    </Section>
  );
}

/** Equal, or a weight per product in percent – never more than 100 % together; what no product takes is not attributed. */
function AllocationForm({ a, onClose, onSaved }: { a: DataCostAllocation; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const invalidate = useInvalidateDataProducts();
  const matchText = useMatchText();
  const [rule, setRule] = useState<'equal' | 'weight'>(a.rule === 'weight' ? 'weight' : 'equal');
  const [weights, setWeights] = useState<Record<string, number | string>>(Object.fromEntries(a.products.map((x) => [x.product.id, x.weightPct ?? ''])));
  const [busy, run] = useBusy();
  const sum = Object.values(weights).reduce<number>((s, w) => s + (typeof w === 'number' ? w : 0), 0) + (a.hiddenWeightPct ?? 0);
  const v = useFieldErrors({ sum: rule === 'weight' && sum > 100 && t('allocations.over100') });
  const save = () =>
    run(async () => {
      await put('/data-products/cost-allocations', {
        platformId: a.platformId,
        kind: a.kind,
        value: a.value,
        tagKey: a.tagKey,
        rule,
        weights:
          rule === 'weight'
            ? a.products.map((x) => ({ productId: x.product.id, pct: typeof weights[x.product.id] === 'number' ? (weights[x.product.id] as number) : 0 }))
            : [],
      });
      invalidate();
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} title={t('allocations.editTitle', { platform: a.platformName, match: matchText(a) })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SegmentedControl
            value={rule}
            onChange={(r) => setRule(r as 'equal' | 'weight')}
            data={[
              { value: 'equal', label: t('allocations.equal') },
              { value: 'weight', label: t('allocations.byWeight') },
            ]}
            fullWidth
            aria-label={t('allocations.rule')}
          />
          {rule === 'weight' && (
            <SimpleGrid cols={{ base: 1, xs: 2 }}>
              {a.products.map((x) => (
                <NumberInput
                  key={x.product.id}
                  label={x.product.name}
                  min={0}
                  max={100}
                  decimalScale={2}
                  suffix=" %"
                  value={weights[x.product.id] ?? ''}
                  onChange={(w) => setWeights((s) => ({ ...s, [x.product.id]: w }))}
                />
              ))}
            </SimpleGrid>
          )}
          {rule === 'weight' && (
            <Text size="sm" c={sum > 100 ? 'red' : 'dimmed'} role="status">
              {t('allocations.sum', { pct: fmtNumber(sum) })}
              {a.hiddenProducts > 0 && ` ${t('allocations.hiddenKept', { count: a.hiddenProducts })}`}
              {v.error('sum') && ` – ${v.error('sum')}`}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('allocations.audit')}
          </Text>
          <FormButtons busy={busy} testId="allocation-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The product's business value beside its attributed costs of last month – never a ratio (decision 30). */
export function ValueAndCosts({ p, withCosts = true }: { p: DataProduct; withCosts?: boolean }) {
  const { t } = useTranslation('dataProducts');
  const q = useProductCosts(p.id, '', 2);
  const last = q.data?.months.at(-2);
  const hasValue = p.valueStatement || p.valueTier || p.valueAmount !== null;
  const costText = q.error
    ? '–'
    : !q.data
      ? '…'
      : !q.data.matches.length
        ? t('costs.noMatchesShort')
        : last && last.totals.length
          ? totalText(last.totals) + (last.incomplete ? ` (${t('costs.incompleteShort')})` : '')
          : t('costs.none');
  return (
    <Section title={withCosts ? t('value.titleWithCosts') : t('value.title')} testId="product-value">
      {hasValue ? (
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          <Fact label={t('form.valueTier')}>{p.valueTier ? t(`valueTier.${p.valueTier}`) : '–'}</Fact>
          <Fact label={t('form.valueAmount')}>
            {p.valueAmount !== null && p.valueCurrency ? t('value.perYear', { amount: money(p.valueAmount, p.valueCurrency) }) : '–'}
          </Fact>
          {p.valueStatement && (
            <div style={{ gridColumn: '1 / -1' }}>
              <Fact label={t('form.valueStatement')}>{p.valueStatement}</Fact>
            </div>
          )}
        </SimpleGrid>
      ) : (
        <Text size="sm" c="dimmed">
          {t('value.none')}
        </Text>
      )}
      {withCosts && (
        <Text size="sm" mt="sm" data-testid="product-costs-line">
          {t('value.costsLastMonth', { month: last ? fmtMonth(last.month, 'long') : '–', costs: costText })}
        </Text>
      )}
    </Section>
  );
}

const STATE_ICON: Record<DataScorecardState, { icon: Icon; color: string }> = {
  met: { icon: IconCircleCheck, color: 'green' },
  partial: { icon: IconCircleMinus, color: 'yellow' },
  notMet: { icon: IconCircleX, color: 'red' },
  noEvidence: { icon: IconCircleDashed, color: 'gray' },
  notApplicable: { icon: IconCircleDashed, color: 'gray' },
};

/** The scorecard of a product in an environment (ADR 0036 part 13): its parts and ISO/IEC 25012 dimensions with their evidence, and the maturity they give. */
export function ScorecardPanel({ query }: { query: UseQueryResult<DataProductScorecard> }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'applications']);
  const s = query.data;
  const level = useLevel();
  const evidence = (e: { key: string; values?: Record<string, string | number> }) => {
    const values: Record<string, string | number> = { ...(e.values ?? {}) };
    // numbers in the reader's format (99,5 in German); `count` stays a number for the plural
    for (const [k, v] of Object.entries(values)) if (typeof v === 'number' && k !== 'count') values[k] = fmtNumber(v);
    // a health status in words (healthy.status)
    if (typeof values.status === 'string') values.status = t(`dataProductViews:health.${values.status as 'up'}`);
    if (typeof values.source === 'string') values.source = t(`scorecard.sources.${values.source as 'monitor'}`);
    // a CIA level and dimensions by their labels, never their keys (confidentiality.rated, rated.belowFloor)
    if (typeof values.level === 'string') values.level = level('confidentiality', values.level)?.label ?? values.level;
    if (typeof values.dimensions === 'string')
      values.dimensions = values.dimensions
        .split(', ')
        .map((d) => t(`applications:cia.dimensions.${d as 'integrity'}`, { defaultValue: d }))
        .join(', ');
    return t(`scorecard.${e.key}` as 'scorecard.title', { ...values, defaultValue: '' });
  };
  return (
    <Section
      title={t('scorecard.title')}
      testId="product-scorecard"
      actions={
        s && (
          <Tooltip label={t('scorecard.maturityHelp')} multiline w={280}>
            <Badge variant="light" color={s.maturity >= 3 ? 'green' : s.maturity >= 1 ? 'blue' : 'gray'} tt="none" data-testid="product-maturity">
              {t('scorecard.maturity', { level: s.maturity, name: t(`scorecard.levels.${s.maturity}`) })}
            </Badge>
          </Tooltip>
        )
      }
    >
      {query.isLoading && <Loader size="sm" />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {s && (
        <Stack gap="sm">
          {s.environment && (
            <Text size="xs" c="dimmed">
              {t('scorecard.in', { environment: s.environment })}
            </Text>
          )}
          {(['part', 'iso25012'] as const).map((g) => {
            const parts = s.parts.filter((x) => x.group === g);
            if (!parts.length) return null;
            return (
              <div key={g}>
                <Text size="sm" fw={600} mb={4}>
                  {t(`scorecard.groups.${g}`)}
                </Text>
                <Stack gap={4}>
                  {parts.map((x) => {
                    const st = STATE_ICON[x.state];
                    const words = x.evidence.map(evidence).filter(Boolean);
                    return (
                      <Group key={x.id} gap="xs" wrap="nowrap" align="flex-start" data-testid={`scorecard-${x.id}`} data-state={x.state}>
                        <st.icon size={16} color={`var(--mantine-color-${st.color}-6)`} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
                        <div>
                          <Text size="sm">
                            {t(`scorecard.parts.${x.id}`)} – {t(`scorecard.states.${x.state}`)}
                          </Text>
                          {words.length > 0 && (
                            <Text size="xs" c="dimmed">
                              {words.join(' · ')}
                            </Text>
                          )}
                        </div>
                      </Group>
                    );
                  })}
                </Stack>
              </div>
            );
          })}
        </Stack>
      )}
    </Section>
  );
}
