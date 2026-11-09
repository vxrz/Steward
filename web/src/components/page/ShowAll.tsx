import { useState } from 'react';
import { Button, Group, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { fmtNumber } from '../../format';
import { usePrinting } from './CollapsibleSection';

export interface ShowMoreState<T> {
  /** The entries to render now */
  items: readonly T[];
  total: number;
  first: number;
  /** Entries added per "Show N more" (paged lists: run steps, log lines); none: "Show all" / "Show fewer" */
  page?: number;
  limit: number;
  setLimit: (limit: number) => void;
}

/**
 * The first `first` entries of a long list, then "Show all N" (rule 2: 10 links or people, 20 data points). With
 * `page`, long lists grow page by page ("Show 500 more", "Show all"). Printing shows every entry.
 */
export function useShowMore<T>(items: readonly T[], first: number, opts: { page?: number } = {}): ShowMoreState<T> {
  // entries shown beyond the first ones (Infinity: all), so a list whose `first` changes keeps the user's choice
  const [extra, setExtra] = useState(0);
  const printing = usePrinting();
  const limit = first + extra;
  const shown = printing || limit >= items.length ? items : items.slice(0, limit);
  return { items: shown, total: items.length, first, page: opts.page, limit, setLimit: (l: number) => setExtra(Math.max(0, l - first)) };
}

/**
 * The button(s) under a list shortened by useShowMore. Test ids: `show-all-<id>`, with pages also `show-more-<id>`.
 * `label`: the "Showing 500 of 2,000 steps" text of a paged list.
 */
export function ShowAll<T>({ state, id, label }: { state: ShowMoreState<T>; id: string; label?: (shown: number, total: number) => string }) {
  const { t } = useTranslation('common');
  const { total, first, page, limit, setLimit } = state;
  const shown = state.items.length;
  if (total <= first) return null;
  if (page) {
    if (shown >= total) return null;
    return (
      <Group gap="xs" mt={4} className="sm-no-print">
        <Text size="xs" c="dimmed">
          {label ? label(shown, total) : t('showMore.shown', { shown: fmtNumber(shown), total: fmtNumber(total), count: total })}
        </Text>
        <Button size="compact-sm" variant="light" onClick={() => setLimit(limit + page)} data-testid={`show-more-${id}`}>
          {t('showMore.more', { count: Math.min(page, total - shown) })}
        </Button>
        <Button size="compact-sm" variant="subtle" onClick={() => setLimit(Infinity)} data-testid={`show-all-${id}`}>
          {t('showMore.all', { count: total })}
        </Button>
      </Group>
    );
  }
  const all = shown >= total;
  return (
    <Button
      size="compact-sm"
      variant="subtle"
      w="fit-content"
      mt={4}
      className="sm-no-print"
      onClick={() => setLimit(all ? first : Infinity)}
      data-testid={`show-all-${id}`}
    >
      {all ? t('showMore.fewer') : t('showMore.all', { count: total })}
    </Button>
  );
}
