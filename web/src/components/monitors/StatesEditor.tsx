import { useMemo, useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
  type ComboboxData,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  STATE_LIMITS,
  type AfterMaxOff,
  derivedSettleSeconds,
  selectState,
  stateIssues,
  tryStates,
  type CheckDef,
  type MonitorDefinition,
  type MonitorDetail,
  type MonitorStatus,
  type MonitorSummary,
  type StateCase,
  type StateCell,
  type StatesDef,
} from '@sm/shared';
import { get } from '../../api';
import { monitorKeys } from '../../queryKeys';
import { MonitorStatusBadge, monitorStatusLabel } from './status';
import { fmtSpan } from './StatePanel';

/**
 * The editor's "States" tab (0.13, ADR 0021): the decision table – one row per state, one column per check. A cell is
 * Any, Up, Down (Off for a sub-monitor), as a condition that selects the state or as an expectation, or Required. Rows
 * move with buttons; the first row whose condition matches wins; "Otherwise" is fixed. "Try it" sets each check to a
 * status and shows what the monitor would report – computed in the browser by the same code as the engine.
 */

/** One select per cell: the value and its role together. */
type CellChoice = 'any' | 'up' | 'down' | 'off' | 'when:up' | 'when:down' | 'when:off' | 'requires';

function choiceOf(row: StateCase, checkId: string): CellChoice {
  if (row.requires?.includes(checkId)) return 'requires';
  const w = row.when?.[checkId];
  if (w && w !== 'any') return `when:${w}` as CellChoice;
  const e = row.expect?.[checkId];
  return e && e !== 'any' ? e : 'any';
}

function withChoice(row: StateCase, checkId: string, choice: CellChoice): StateCase {
  const when = { ...(row.when ?? {}) };
  const expect = { ...(row.expect ?? {}) };
  let requires = (row.requires ?? []).filter((x) => x !== checkId);
  delete when[checkId];
  delete expect[checkId];
  if (choice === 'requires') requires = [...requires, checkId];
  else if (choice.startsWith('when:')) when[checkId] = choice.slice(5) as StateCell;
  else if (choice !== 'any') expect[checkId] = choice as StateCell;
  const out: StateCase = { ...row, when, expect, requires };
  if (!Object.keys(when).length) delete out.when;
  if (!Object.keys(expect).length) delete out.expect;
  if (!requires.length) delete out.requires;
  return out;
}

const TRY_STATUSES: MonitorStatus[] = ['up', 'degraded', 'down', 'unknown'];
/** The row's "after the maximum" select: as the monitor says (not written), or its own value (#288). */
const INHERIT = 'inherit';

export function StatesEditor({
  def,
  onChange,
  current,
  monitors,
  selfId,
}: {
  def: MonitorDefinition;
  onChange: (def: MonitorDefinition) => void;
  /** The saved monitor (its checks' current statuses for "Matches now") */
  current: MonitorDetail | null;
  monitors: MonitorSummary[];
  selfId: string | null;
}) {
  const { t } = useTranslation('monitors');
  const afterMaxOffLabel = (v: AfterMaxOff) => (v === 'down' ? t('states.afterMaxOffDown') : monitorStatusLabel('degraded'));
  const states = def.states;
  const checks = def.checks.filter((c) => c.enabled !== false);
  const follower = !!states?.from;
  const leader = useQuery({
    queryKey: monitorKeys.detail(states?.from),
    queryFn: () => get<MonitorDetail>(`/monitors/${states!.from}`),
    enabled: !!states?.from && states.from !== '(hidden)',
  });
  const nowStatuses = useMemo(
    () =>
      new Map(
        (current?.checks ?? []).filter((c) => c.enabled).map((c) => [c.checkId, c.status === 'off' && c.type !== 'monitor' ? 'down' : c.status] as const),
      ),
    [current],
  );
  const issues = useMemo(() => stateIssues(def), [def]);
  const [trial, setTrial] = useState<Record<string, MonitorStatus>>({});
  const [trialLeader, setTrialLeader] = useState<string | null>(null);
  const [trialBeyondMax, setTrialBeyondMax] = useState(false);
  // phones: one card per state with the same controls (the table is a desktop task)
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const [result, setResult] = useState<ReturnType<typeof tryStates> | null>(null);

  const set = (s: StatesDef | undefined) => {
    const next = { ...def };
    if (s) next.states = s;
    else delete next.states;
    onChange(next);
    setResult(null);
  };
  if (!states)
    return (
      <Stack>
        <Text size="sm">{t('states.intro')}</Text>
        <Group>
          <Button
            leftSection={<IconPlus size={14} />}
            onClick={() =>
              set({
                cases: [
                  { id: 'running', name: t('states.defaultRunning'), when: {}, expect: {} },
                  { id: 'off', name: t('states.defaultOff'), status: 'off', when: {}, expect: {} },
                ],
              })
            }
            data-testid="states-enable"
          >
            {t('states.enable')}
          </Button>
        </Group>
      </Stack>
    );

  const cases = states.cases;
  const setCases = (c: StateCase[]) => set({ ...states, cases: c });
  const setRow = (i: number, r: StateCase) => setCases(cases.map((x, j) => (j === i ? r : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= cases.length) return;
    const c = [...cases];
    [c[i], c[j]] = [c[j]!, c[i]!];
    setCases(c);
  };
  const matchNow = current ? selectState(def, nowStatuses, current.state?.id ?? null, leader.data?.state?.id ?? null).row?.id : undefined;
  /**
   * The choices of a cell, grouped by what they do: Any (no rule) first, then the condition that selects the state, the
   * expectations while it holds, and the precondition. Off only for a sub-monitor column (a sub-monitor that is off).
   */
  const options = (c: CheckDef): ComboboxData => {
    const item = (v: CellChoice) => ({ value: v, label: t(`states.choice.${v.replace(':', '_') as 'any'}`) as string });
    const off = c.type === 'monitor';
    const expected: CellChoice[] = ['up', 'down', ...(off ? (['off'] as const) : [])];
    const selects: CellChoice[] = ['when:up', 'when:down', ...(off ? (['when:off'] as const) : [])];
    return [
      item('any'),
      ...(follower ? [] : [{ group: t('states.group.selects'), items: selects.map(item) }]),
      { group: t('states.group.expected'), items: expected.map(item) },
      ...(follower ? [] : [{ group: t('states.group.precondition'), items: [item('requires')] }]),
    ];
  };
  const leaderIds = leader.data?.definition.states?.cases.map((c) => c.id) ?? [];
  /** The controls of one state, shared by the table (desktop) and the cards (phones). */
  const rowControls = (r: StateCase, i: number) => {
    const label = r.name || r.id;
    const derived = derivedSettleSeconds(def, r);
    return {
      label,
      order: (
        <Group gap={2} wrap="nowrap">
          <Text size="sm" w={18}>
            {i + 1}
          </Text>
          <ActionIcon size="sm" variant="subtle" aria-label={t('states.moveUp', { state: label })} disabled={i === 0} onClick={() => move(i, -1)}>
            <IconArrowUp size={14} />
          </ActionIcon>
          <ActionIcon
            size="sm"
            variant="subtle"
            aria-label={t('states.moveDown', { state: label })}
            disabled={i === cases.length - 1}
            onClick={() => move(i, 1)}
          >
            <IconArrowDown size={14} />
          </ActionIcon>
        </Group>
      ),
      nameId: (
        <Stack gap={2}>
          <TextInput
            size="xs"
            aria-label={t('states.name', { n: i + 1 })}
            value={r.name ?? ''}
            onChange={(e) => setRow(i, { ...r, name: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            className="mono"
            aria-label={t('states.id', { n: i + 1 })}
            value={r.id}
            onChange={(e) => setRow(i, { ...r, id: e.currentTarget.value.trim() })}
          />
          {matchNow === r.id && (
            <Badge size="xs" variant="light" data-testid="matches-now">
              {t('states.matchesNow')}
            </Badge>
          )}
        </Stack>
      ),
      shows: (
        <Select
          size="xs"
          w={110}
          aria-label={t('states.showsOf', { state: label })}
          value={r.status ?? 'up'}
          allowDeselect={false}
          data={[
            { value: 'up', label: monitorStatusLabel('up') },
            { value: 'off', label: monitorStatusLabel('off') },
          ]}
          onChange={(v) => {
            const next = { ...r, status: (v ?? 'up') as 'up' | 'off' };
            if (next.status === 'up') {
              delete next.maxOffHours;
              delete next.afterMaxOff;
            }
            setRow(i, next);
          }}
        />
      ),
      cell: (c: CheckDef) => (
        <Select
          size="xs"
          aria-label={t('states.cellLabel', { state: label, check: c.name })}
          value={choiceOf(r, c.id)}
          allowDeselect={false}
          data={options(c)}
          onChange={(v) => setRow(i, withChoice(r, c.id, (v ?? 'any') as CellChoice))}
          data-testid={`cell-${r.id}-${c.id}`}
        />
      ),
      settle: (
        <>
          <NumberInput
            size="xs"
            w={110}
            min={1}
            max={STATE_LIMITS.settleMax / 60}
            suffix=" min"
            aria-label={t('states.settleOf', { state: label })}
            placeholder={t('states.derived', { value: fmtSpan(derived) })}
            value={r.settleSeconds === undefined ? '' : Math.round(r.settleSeconds / 60)}
            onChange={(v) => {
              const next = { ...r };
              if (v === '' || v === null) delete next.settleSeconds;
              else next.settleSeconds = Math.min(STATE_LIMITS.settleMax, Math.max(STATE_LIMITS.settleMin, Math.round(Number(v) * 60)));
              setRow(i, next);
            }}
          />
          {r.settleSeconds === undefined && (
            <Text size="xs" c="dimmed">
              {t('states.derived', { value: fmtSpan(derived) })}
            </Text>
          )}
        </>
      ),
      contradiction: (
        <Select
          size="xs"
          w={130}
          aria-label={t('states.contradictionOf', { state: label })}
          value={r.contradiction ?? 'down'}
          allowDeselect={false}
          data={[
            { value: 'down', label: t('states.contradictionDown') },
            { value: 'degraded', label: monitorStatusLabel('degraded') },
          ]}
          onChange={(v) => {
            const next = { ...r };
            // down is the default: not written
            if (v === 'degraded') next.contradiction = 'degraded';
            else delete next.contradiction;
            setRow(i, next);
          }}
          data-testid={`contradiction-${r.id}`}
        />
      ),
      maxOff:
        (r.status ?? 'up') === 'off' ? (
          <Stack gap={4}>
            <NumberInput
              size="xs"
              w={110}
              min={0}
              max={STATE_LIMITS.maxOffHoursMax}
              suffix=" h"
              aria-label={t('states.maxOffOf', { state: label })}
              placeholder={`${states.maxOffHours ?? STATE_LIMITS.defaultMaxOffHours} h`}
              value={r.maxOffHours ?? ''}
              onChange={(v) => {
                const next = { ...r };
                if (v === '' || v === null) delete next.maxOffHours;
                else next.maxOffHours = Number(v);
                setRow(i, next);
              }}
            />
            <Select
              size="xs"
              w={150}
              aria-label={t('states.afterMaxOffOf', { state: label })}
              value={r.afterMaxOff ?? INHERIT}
              allowDeselect={false}
              data={[
                { value: INHERIT, label: t('states.afterMaxOffInherit', { value: afterMaxOffLabel(states.afterMaxOff ?? 'degraded') }) },
                { value: 'degraded', label: afterMaxOffLabel('degraded') },
                { value: 'down', label: afterMaxOffLabel('down') },
              ]}
              onChange={(v) => {
                const next = { ...r };
                if (v === 'degraded' || v === 'down') next.afterMaxOff = v;
                else delete next.afterMaxOff;
                setRow(i, next);
              }}
              data-testid={`after-max-off-${r.id}`}
            />
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            –
          </Text>
        ),
      remove: (
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={t('states.removeState', { state: label })}
          onClick={() => setCases(cases.filter((_, j) => j !== i))}
        >
          <IconTrash size={14} />
        </ActionIcon>
      ),
    };
  };

  return (
    <Stack>
      <Text size="sm">{t('states.intro')}</Text>
      <Group align="flex-end" wrap="wrap">
        <Select
          label={t('states.follows')}
          description={t('states.followsHint')}
          clearable
          searchable
          w={320}
          value={states.from ?? null}
          data={monitors.filter((m) => m.id !== selfId && !m.isTemplate).map((m) => ({ value: m.id, label: m.name }))}
          onChange={(v) => {
            const next: StatesDef = { ...states };
            if (v) {
              next.from = v;
              // a follower has no maximum off time of its own (the leader reports it)
              delete next.maxOffHours;
              delete next.afterMaxOff;
              next.cases = cases.map(({ when: _w, requires: _r, maxOffHours: _m, afterMaxOff: _a, ...c }) => c);
            } else delete next.from;
            set(next);
          }}
        />
        {!follower && (
          <NumberInput
            label={t('states.maxOff')}
            description={t('states.maxOffHint', { hours: STATE_LIMITS.defaultMaxOffHours })}
            w={220}
            min={0}
            max={STATE_LIMITS.maxOffHoursMax}
            placeholder={String(STATE_LIMITS.defaultMaxOffHours)}
            value={states.maxOffHours ?? ''}
            onChange={(v) => {
              const next: StatesDef = { ...states };
              if (v === '' || v === null) delete next.maxOffHours;
              else next.maxOffHours = Number(v);
              set(next);
            }}
          />
        )}
        {!follower && (
          <Select
            label={t('states.afterMaxOff')}
            description={t('states.afterMaxOffHint')}
            w={260}
            allowDeselect={false}
            value={states.afterMaxOff ?? 'degraded'}
            data={[
              { value: 'degraded', label: t('states.afterMaxOffDegradedDefault') },
              { value: 'down', label: afterMaxOffLabel('down') },
            ]}
            onChange={(v) => {
              const next: StatesDef = { ...states };
              // degraded is the default: not written
              if (v === 'down') next.afterMaxOff = 'down';
              else delete next.afterMaxOff;
              set(next);
            }}
            data-testid="after-max-off"
          />
        )}
        <Button variant="subtle" color="red" size="xs" onClick={() => set(undefined)}>
          {t('states.disable')}
        </Button>
      </Group>
      {follower && leaderIds.length > 0 && (
        <Text size="xs" c="dimmed">
          {t('states.leaderIds', { ids: leaderIds.join(', ') })}
        </Text>
      )}
      {phone ? (
        <Stack gap="sm" data-testid="states-cards">
          {cases.map((r, i) => {
            const x = rowControls(r, i);
            return (
              <Paper key={i} withBorder p="sm" data-testid={`state-card-${r.id}`} role="group" aria-label={x.label}>
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap" align="flex-start">
                    {x.order}
                    {x.remove}
                  </Group>
                  {x.nameId}
                  <Group gap="xs" wrap="nowrap" justify="space-between">
                    <Text size="sm">{t('states.shows')}</Text>
                    {x.shows}
                  </Group>
                  {checks.map((c) => (
                    <Group key={c.id} gap="xs" wrap="nowrap" justify="space-between">
                      <Text size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                        {c.name}
                      </Text>
                      <div style={{ width: 160, flexShrink: 0 }}>{x.cell(c)}</div>
                    </Group>
                  ))}
                  <Group gap="xs" wrap="nowrap" justify="space-between" align="flex-start">
                    <Text size="sm">{t('states.settle')}</Text>
                    <div>{x.settle}</div>
                  </Group>
                  <Group gap="xs" wrap="nowrap" justify="space-between">
                    <Text size="sm">{t('states.onContradiction')}</Text>
                    {x.contradiction}
                  </Group>
                  {!follower && (
                    <Group gap="xs" wrap="nowrap" justify="space-between">
                      <Text size="sm">{t('states.maxOffShort')}</Text>
                      {x.maxOff}
                    </Group>
                  )}
                </Stack>
              </Paper>
            );
          })}
          <Paper withBorder p="sm">
            <Text size="sm" fw={600}>
              {t('states.otherwise')}
            </Text>
            <Text size="sm" c="dimmed">
              {t('states.otherwiseHint')}
            </Text>
          </Paper>
        </Stack>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table withTableBorder withColumnBorders fz="sm" data-testid="states-table">
            <VisuallyHidden component="caption">{t('states.caption')}</VisuallyHidden>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('states.order')}</Table.Th>
                <Table.Th scope="col">{t('states.state')}</Table.Th>
                <Table.Th scope="col">{t('states.shows')}</Table.Th>
                {checks.map((c) => (
                  <Table.Th scope="col" key={c.id} style={{ minWidth: 120 }}>
                    {c.name}
                  </Table.Th>
                ))}
                <Table.Th scope="col">{t('states.settle')}</Table.Th>
                <Table.Th scope="col">{t('states.onContradiction')}</Table.Th>
                {!follower && <Table.Th scope="col">{t('states.maxOffShort')}</Table.Th>}
                <Table.Th scope="col">{t('states.remove')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {cases.map((r, i) => {
                const x = rowControls(r, i);
                return (
                  <Table.Tr key={i} data-testid={`state-row-${r.id}`}>
                    <Table.Td>{x.order}</Table.Td>
                    <Table.Th scope="row" style={{ minWidth: 150 }}>
                      {x.nameId}
                    </Table.Th>
                    <Table.Td>{x.shows}</Table.Td>
                    {checks.map((c) => (
                      <Table.Td key={c.id}>{x.cell(c)}</Table.Td>
                    ))}
                    <Table.Td>{x.settle}</Table.Td>
                    <Table.Td>{x.contradiction}</Table.Td>
                    {!follower && <Table.Td>{x.maxOff}</Table.Td>}
                    <Table.Td>{x.remove}</Table.Td>
                  </Table.Tr>
                );
              })}
              <Table.Tr>
                <Table.Td>–</Table.Td>
                <Table.Th scope="row">{t('states.otherwise')}</Table.Th>
                <Table.Td colSpan={checks.length + (follower ? 4 : 5)}>
                  <Text size="sm" c="dimmed">
                    {t('states.otherwiseHint')}
                  </Text>
                </Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <StatesLegend follower={follower} open={current === null} />
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          disabled={cases.length >= STATE_LIMITS.cases}
          onClick={() => {
            let n = cases.length + 1;
            while (cases.some((c) => c.id === `state-${n}`)) n++;
            setCases([...cases, { id: `state-${n}`, name: '' }]);
          }}
        >
          {t('states.add')}
        </Button>
      </Group>
      {issues.length > 0 && (
        <Stack gap={4} data-testid="states-issues">
          {issues.map((x, i) => (
            <Alert key={i} color={x.warning ? 'yellow' : 'red'} p="xs">
              <Text size="sm">
                {x.warning ? `${t('states.warning')}: ` : ''}
                {x.path.replace(/^states\.cases\.(\d+)/, (_, n: string) => t('states.rowRef', { n: Number(n) + 1 }))} – {x.message}
              </Text>
            </Alert>
          ))}
        </Stack>
      )}

      <Paper withBorder p="sm">
        <Stack gap="xs">
          <Title order={3} size="h5">
            {t('states.tryTitle')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('states.tryHint')}
          </Text>
          <Group wrap="wrap" align="flex-end">
            {checks.map((c) => (
              <Select
                key={c.id}
                size="xs"
                w={170}
                label={c.name}
                allowDeselect={false}
                value={trial[c.id] ?? nowStatuses.get(c.id) ?? 'up'}
                data={[...TRY_STATUSES, ...(c.type === 'monitor' ? (['off'] as const) : [])].map((s) => ({ value: s, label: monitorStatusLabel(s) }))}
                onChange={(v) => setTrial({ ...trial, [c.id]: (v ?? 'up') as MonitorStatus })}
                data-testid={`try-${c.id}`}
              />
            ))}
            {!follower && (
              <Checkbox
                size="xs"
                label={t('states.tryBeyondMax')}
                checked={trialBeyondMax}
                onChange={(e) => setTrialBeyondMax(e.currentTarget.checked)}
                data-testid="try-beyond-max"
              />
            )}
            {follower && (
              <Select
                size="xs"
                w={170}
                label={t('states.leaderState')}
                clearable
                value={trialLeader}
                data={(leaderIds.length ? leaderIds : cases.map((c) => c.id)).map((id) => ({ value: id, label: id }))}
                onChange={setTrialLeader}
              />
            )}
            <Button
              size="xs"
              onClick={() => {
                const statuses = Object.fromEntries(checks.map((c) => [c.id, trial[c.id] ?? nowStatuses.get(c.id) ?? 'up'])) as Record<string, MonitorStatus>;
                setResult(tryStates(def, statuses, { leaderState: trialLeader, beyondMaxOff: !follower && trialBeyondMax }));
              }}
              data-testid="states-try"
            >
              {t('states.try')}
            </Button>
          </Group>
          <div aria-live="polite" data-testid="states-try-result">
            {result && (
              <Stack gap={4}>
                <Group gap="xs">
                  <Text size="sm" fw={600}>
                    {result.row ? t('states.wins', { state: result.row.name || result.row.id }) : t('states.otherwiseWins')}
                  </Text>
                  {result.status && <MonitorStatusBadge status={result.status} />}
                </Group>
                <Text size="sm">
                  {t(`states.reason.${result.info.reason}`)} – {result.info.message}
                </Text>
              </Stack>
            )}
          </div>
        </Stack>
      </Paper>
    </Stack>
  );
}

/**
 * Under the table: what each group of a cell's choices does, where Off comes from, and what the columns mean – folded
 * away once the monitor is saved (open for a new one).
 */
function StatesLegend({ follower, open }: { follower: boolean; open: boolean }) {
  const { t } = useTranslation('monitors');
  return (
    <details open={open}>
      <summary>
        <Text component="span" size="xs">
          {t('states.legendTitle')}
        </Text>
      </summary>
      <Stack gap={2} mt={4} data-testid="states-legend">
        {!follower && (
          <Text size="xs" c="dimmed">
            <b>{t('states.group.selects')}</b> – {t('states.legendSelects')}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          <b>{t('states.group.expected')}</b> – {t('states.legendExpected')}
        </Text>
        {!follower && (
          <Text size="xs" c="dimmed">
            <b>{t('states.group.precondition')}</b> – {t('states.legendRequired')}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          <b>{t('states.choice.any')}</b> – {t('states.legendAny')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('states.legendOff')}
        </Text>
        <Text size="xs" c="dimmed">
          <b>{t('states.onContradiction')}</b> – {t('states.legendContradiction')}
        </Text>
        {!follower && (
          <Text size="xs" c="dimmed">
            <b>{t('states.maxOffShort')}</b> – {t('states.legendMaxOff')}
          </Text>
        )}
      </Stack>
    </details>
  );
}
