import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Group, Select, Stack, Table, Text, UnstyledButton } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import { IconArrowDown, IconArrowUp, IconArrowsSort, IconSortAscending, IconSortDescending } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { formatLocale } from '../i18n';

export type SortValue = string | number | boolean | null | undefined;
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

/** One column of a {@link DataTable}. */
export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  /** Header as plain text (the phone sort menu); defaults to `header` when that is a string. */
  label?: string;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable (client side, over the loaded rows). Empty values sort last. */
  sortValue?: (row: T) => SortValue;
  /** No line breaks in the cell (dates, numbers, badges). */
  nowrap?: boolean;
  /** Extra attributes of the cell (e.g. a `title` with the exact date). */
  tdProps?: (row: T) => Record<string, unknown>;
}

const collator = () => new Intl.Collator(formatLocale(), { numeric: true, sensitivity: 'base' });

/** Sorts rows by a column (stable; empty values last in both directions). */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  const coll = collator();
  const empty = (v: SortValue) => v === null || v === undefined || v === '';
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((a, b) => {
      if (empty(a.v) || empty(b.v)) return empty(a.v) === empty(b.v) ? a.i - b.i : empty(a.v) ? 1 : -1;
      const c = typeof a.v === 'string' || typeof b.v === 'string' ? coll.compare(String(a.v), String(b.v)) : Number(a.v) - Number(b.v);
      return (dir === 'asc' ? c : -c) || a.i - b.i;
    })
    .map((x) => x.row);
}

/** Next state when a column header is clicked: ascending → descending → the list's own order. */
function nextSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/**
 * The list table used by the main lists (Runs, Records, Credentials …): sortable column headers
 * (client side, over the rows loaded so far), rows that open their entry, a card list on phones
 * (`card`) with a sort menu, and an optional footer (see {@link ListFooter}).
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  ariaLabel,
  rowHref,
  onRowClick,
  card,
  footer,
  rowProps,
  defaultSort = null,
  cardBreakpoint = '48em',
  verticalSpacing,
  testId,
}: {
  rows: T[];
  columns: DataColumn<T>[];
  rowKey: (row: T) => string;
  ariaLabel: string;
  /** The row opens this page when clicked (the row should also hold a real link for the keyboard). */
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Card of one row on narrow screens; without it the table scrolls sideways. */
  card?: (row: T) => ReactNode;
  footer?: ReactNode;
  rowProps?: (row: T) => Record<string, unknown>;
  defaultSort?: SortState | null;
  /** Up to this width the cards are shown (default 48em, like Services). */
  cardBreakpoint?: string;
  verticalSpacing?: number | string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const narrow = useMediaQuery(`(max-width: ${cardBreakpoint})`) ?? false;
  const [sort, setSort] = useState<SortState | null>(defaultSort);
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    return sort && col?.sortValue ? sortRows(rows, col.sortValue, sort.dir) : rows;
  }, [rows, columns, sort]);
  const clickable = !!(rowHref || onRowClick);
  const activate = (row: T) => (onRowClick ? onRowClick(row) : rowHref && navigate(rowHref(row)));
  const sortable = columns.filter((c) => c.sortValue);
  const labelOf = (c: DataColumn<T>) => c.label ?? (typeof c.header === 'string' ? c.header : c.key);

  if (narrow && card) {
    return (
      <>
        {sortable.length > 0 && rows.length > 1 && (
          <Group gap={6} mb="xs" wrap="nowrap" data-testid="list-sort">
            <Select
              size="xs"
              aria-label={t('table.sortBy')}
              placeholder={t('table.sortBy')}
              data={sortable.map((c) => ({ value: c.key, label: labelOf(c) }))}
              value={sort?.key ?? null}
              onChange={(k) => setSort(k ? { key: k, dir: sort?.dir ?? 'asc' } : null)}
              clearable
              style={{ flex: 1 }}
            />
            {sort && (
              <ActionIcon
                variant="default"
                size="input-xs"
                onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
                aria-label={sort.dir === 'asc' ? t('table.sortedAsc') : t('table.sortedDesc')}
              >
                {sort.dir === 'asc' ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />}
              </ActionIcon>
            )}
          </Group>
        )}
        <Stack gap="xs" role="list" aria-label={ariaLabel} data-testid={testId}>
          {sorted.map((row) => (
            <div key={rowKey(row)} role="listitem">
              {card(row)}
            </div>
          ))}
        </Stack>
        {footer}
      </>
    );
  }

  return (
    <>
      <div className="table-scroll">
        <Table highlightOnHover={clickable} fz="sm" verticalSpacing={verticalSpacing} aria-label={ariaLabel} data-testid={testId}>
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => {
                const active = sort?.key === c.key ? sort.dir : null;
                return (
                  <Table.Th
                    key={c.key}
                    scope="col"
                    aria-sort={c.sortValue ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}
                  >
                    {c.sortValue ? (
                      <UnstyledButton onClick={() => setSort(nextSort(sort, c.key))} className="sort-header" fw={700} fz="sm">
                        <Group gap={4} wrap="nowrap" component="span">
                          <span>{c.header}</span>
                          {active === 'asc' ? (
                            <IconArrowUp size={14} aria-hidden />
                          ) : active === 'desc' ? (
                            <IconArrowDown size={14} aria-hidden />
                          ) : (
                            <IconArrowsSort size={14} aria-hidden opacity={0.45} />
                          )}
                        </Group>
                      </UnstyledButton>
                    ) : (
                      c.header
                    )}
                  </Table.Th>
                );
              })}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.map((row) => (
              <Table.Tr
                key={rowKey(row)}
                className={clickable ? 'clickable' : undefined}
                onClick={clickable ? () => activate(row) : undefined}
                {...rowProps?.(row)}
              >
                {columns.map((c) => (
                  <Table.Td key={c.key} className={c.nowrap ? 'nowrap' : undefined} {...c.tdProps?.(row)}>
                    {c.cell(row)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {footer}
    </>
  );
}

/**
 * Below a list: how many entries are shown ("Showing 200 of 340") and – when the server has more –
 * a _Load more_ button.
 */
export function ListFooter({
  shown,
  total,
  hasMore,
  onLoadMore,
  loading,
}: {
  shown: number;
  total?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  if (!shown) return null;
  return (
    <Group justify="space-between" gap="xs" mt="xs" data-testid="list-footer">
      <Text size="xs" c="dimmed" role="status">
        {total !== undefined && total > shown
          ? t('table.showingOf', { shown, total })
          : hasMore
            ? t('table.showingFirst', { count: shown })
            : t('table.showingAll', { count: shown })}
      </Text>
      {hasMore && onLoadMore && (
        <Button size="xs" variant="default" onClick={onLoadMore} loading={loading}>
          {t('table.loadMore')}
        </Button>
      )}
    </Group>
  );
}
