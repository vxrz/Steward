import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, SegmentedControl, SimpleGrid, Switch, Table, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconChevronLeft, IconChevronRight, IconPlus, IconTool } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MaintenanceList, MaintenanceOccurrence } from '@sm/shared';
import { get } from '../api';
import { EmptyState, PageHeader, QueryState, useCreateParam } from '../components/common';
import { MaintenanceDetailModal, MaintenanceFormModal, TargetBadges, WhenLine, useRepeatLabel } from '../components/catalogue/maintenance';
import { dateTimeFormat, fmtTime } from '../format';

/** Maintenance windows (#108): what is planned, as a list or a month calendar; plan, change and cancel windows. */
export function MaintenancePage() {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const open = params.get('open');
  const setOpen = (id: string | null) =>
    setParams(
      (p) => {
        if (id) p.set('open', id);
        else p.delete('open');
        return p;
      },
      { replace: true },
    );
  const repeat = useRepeatLabel();

  const list = useQuery({
    queryKey: ['maintenance-windows', 'list', showCancelled],
    queryFn: () =>
      get<MaintenanceList>(
        `/maintenance-windows?to=${encodeURIComponent(new Date(Date.now() + 400 * 86_400_000).toISOString())}${showCancelled ? '&cancelled=true' : ''}`,
      ),
  });
  // the calendar shows whole weeks (Monday first) around the month
  const gridStart = useMemo(() => {
    const d = new Date(month);
    d.setDate(1 - ((d.getDay() + 6) % 7));
    return d;
  }, [month]);
  const gridEnd = useMemo(() => {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + 42);
    return d;
  }, [gridStart]);
  const cal = useQuery({
    queryKey: ['maintenance-windows', 'calendar', gridStart.toISOString()],
    queryFn: () =>
      get<MaintenanceList>(`/maintenance-windows?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(gridEnd.toISOString())}`),
    enabled: view === 'calendar',
  });
  const canPlan = !!list.data?.canPlan;
  useCreateParam(canPlan, () => setCreating(true));

  const windows = list.data?.windows ?? [];
  return (
    <>
      <PageHeader
        title={t('maintenance.title')}
        description={t('maintenance.description')}
        actions={
          canPlan && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('maintenance.new')}
            </Button>
          )
        }
      />
      <Group gap="md" mb="md" align="center" wrap="wrap">
        <SegmentedControl
          size="xs"
          aria-label={t('maintenance.view')}
          value={view}
          onChange={(v) => setView(v as typeof view)}
          data={[
            { value: 'list', label: t('maintenance.list') },
            { value: 'calendar', label: t('maintenance.calendar') },
          ]}
        />
        {view === 'list' && (
          <Switch size="xs" label={t('maintenance.showCancelled')} checked={showCancelled} onChange={(e) => setShowCancelled(e.currentTarget.checked)} />
        )}
      </Group>
      {view === 'list' && (
        <>
          <QueryState query={list} />
          {list.isSuccess && windows.length === 0 && (
            <EmptyState
              icon={IconTool}
              title={t('maintenance.emptyTitle')}
              action={
                canPlan && (
                  <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                    {t('maintenance.new')}
                  </Button>
                )
              }
            >
              {t('maintenance.emptyText')}
            </EmptyState>
          )}
          {windows.length > 0 && (
            <div className="table-scroll">
              <Table highlightOnHover fz="sm" aria-label={t('maintenance.title')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('maintenance.colTitle')}</Table.Th>
                    <Table.Th>{t('maintenance.colWhen')}</Table.Th>
                    <Table.Th>{t('maintenance.colRepeat')}</Table.Th>
                    <Table.Th>{t('maintenance.colTargets')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {windows.map((w) => (
                    <Table.Tr key={w.id} className="clickable" onClick={() => setOpen(w.id)}>
                      <Table.Td>
                        <UnstyledButton
                          fw={500}
                          fz="sm"
                          c="var(--mantine-primary-color-filled)"
                          aria-label={t('maintenance.detailsOf', { title: w.title })}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen(w.id);
                          }}
                        >
                          {w.title}
                        </UnstyledButton>
                      </Table.Td>
                      <Table.Td>
                        <WhenLine w={w} />
                      </Table.Td>
                      <Table.Td>{repeat(w)}</Table.Td>
                      <Table.Td>
                        <TargetBadges targets={w.targets} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </>
      )}
      {view === 'calendar' && (
        <MonthGrid
          month={month}
          gridStart={gridStart}
          occurrences={cal.data?.occurrences ?? []}
          onMonth={(delta) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1))}
          onToday={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          onOpen={setOpen}
        />
      )}
      {open && <MaintenanceDetailModal id={open} onClose={() => setOpen(null)} />}
      {creating && (
        <MaintenanceFormModal
          onClose={() => setCreating(false)}
          onSaved={(w) => {
            void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            setOpen(w.id);
          }}
        />
      )}
    </>
  );
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function MonthGrid({
  month,
  gridStart,
  occurrences,
  onMonth,
  onToday,
  onOpen,
}: {
  month: Date;
  gridStart: Date;
  occurrences: MaintenanceOccurrence[];
  onMonth: (delta: number) => void;
  onToday: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('applications');
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const weekday = dateTimeFormat({ weekday: 'short' });
  const today = new Date();
  // an occurrence shows on every day it touches
  const onDay = (d: Date) => {
    const s = d.getTime();
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    return occurrences.filter((o) => Date.parse(o.startsAt) < e && Date.parse(o.endsAt) > s);
  };
  const inMonth = occurrences.some((o) => new Date(o.startsAt).getMonth() === month.getMonth() || new Date(o.endsAt).getMonth() === month.getMonth());
  return (
    <Paper withBorder p="sm" data-testid="maintenance-calendar">
      <Group justify="space-between" mb="sm">
        <Group gap={4}>
          <Tooltip label={t('maintenance.previousMonth')}>
            <ActionIcon variant="default" aria-label={t('maintenance.previousMonth')} onClick={() => onMonth(-1)}>
              <IconChevronLeft size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('maintenance.nextMonth')}>
            <ActionIcon variant="default" aria-label={t('maintenance.nextMonth')} onClick={() => onMonth(1)}>
              <IconChevronRight size={16} />
            </ActionIcon>
          </Tooltip>
          <Button size="compact-xs" variant="subtle" onClick={onToday}>
            {t('maintenance.today')}
          </Button>
        </Group>
        <Text fw={600} aria-live="polite">
          {dateTimeFormat({ month: 'long', year: 'numeric' }).format(month)}
        </Text>
      </Group>
      <div className="table-scroll">
        <SimpleGrid cols={7} spacing={2} verticalSpacing={2} miw={560}>
          {days.slice(0, 7).map((d) => (
            <Text key={`h${d.getDay()}`} size="xs" c="dimmed" ta="center">
              {weekday.format(d)}
            </Text>
          ))}
          {days.map((d) => {
            const items = onDay(d);
            return (
              <Paper key={d.toISOString()} withBorder p={4} mih={84} bg={sameDay(d, today) ? 'var(--mantine-primary-color-light)' : undefined}>
                <Text size="xs" fw={sameDay(d, today) ? 700 : 400} c={d.getMonth() === month.getMonth() || sameDay(d, today) ? undefined : 'dimmed'}>
                  {d.getDate()}
                </Text>
                {items.slice(0, 3).map((o) => (
                  <Badge
                    key={`${o.windowId}${o.startsAt}`}
                    component="button"
                    type="button"
                    size="xs"
                    fullWidth
                    radius="sm"
                    color={o.active ? 'orange' : 'blue'}
                    variant="light"
                    tt="none"
                    mt={2}
                    style={{ cursor: 'pointer', justifyContent: 'flex-start' }}
                    onClick={() => onOpen(o.windowId)}
                    title={`${o.title} · ${fmtTime(o.startsAt)}–${fmtTime(o.endsAt)}`}
                  >
                    {sameDay(new Date(o.startsAt), d) ? `${fmtTime(o.startsAt)} ` : ''}
                    {o.title}
                  </Badge>
                ))}
                {items.length > 3 && (
                  <Text size="xs" c="dimmed">
                    +{items.length - 3}
                  </Text>
                )}
              </Paper>
            );
          })}
        </SimpleGrid>
      </div>
      {!inMonth && (
        <Text size="sm" c="dimmed" mt="sm">
          {t('maintenance.noneInRange')}
        </Text>
      )}
    </Paper>
  );
}
