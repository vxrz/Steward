import { createContext, useContext, useState, type ReactNode } from 'react';
import { Box, Group, SegmentedControl, TextInput, Tooltip, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconLayoutList, IconSearch, IconTable } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Icon } from '@tabler/icons-react';
import type { VisibilityArea } from '@sm/shared';
import { EmptyState, FilterPanel, PageHeader } from '../common';
import { RestrictedEmpty, useHiddenByPermissions } from '../modules/RestrictedEmpty';

/** How a list shows its rows: `auto` = table on wide screens, cards on phones (DataTable's own choice). */
export type ListView = 'auto' | 'table' | 'cards';

const ListViewContext = createContext<ListView>('auto');

/** The view chosen on the list page around a {@link DataTable} (`auto` outside a ListPage). */
export const useListView = (): ListView => useContext(ListViewContext);

const viewKey = (id: string) => `sm.list.view.${id}`;
function readView(id: string): ListView {
  try {
    const v = localStorage.getItem(viewKey(id));
    return v === 'table' || v === 'cards' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * The table/card choice of a list, remembered per list in this browser – for pages that draw their own cards
 * (pass it to ListPage as `viewState`). `cards` tells whether to show cards now (`narrow`: the phone width).
 */
export function useStoredListView(id: string, narrow: boolean): { value: ListView; onChange: (v: ListView) => void; cards: boolean } {
  const [value, setValue] = useState<ListView>(() => readView(id));
  return { value, onChange: setValue, cards: value === 'cards' || (value === 'auto' && narrow) };
}

/** Table or cards, remembered per list in this browser. */
function ViewToggle({ id, value, onChange }: { id: string; value: ListView; onChange: (v: ListView) => void }) {
  const { t } = useTranslation();
  // the width up to which DataTable shows cards by default
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const data = [
    {
      value: 'table',
      label: (
        <Tooltip label={t('listPage.table')} withArrow>
          <Group gap={0} wrap="nowrap" component="span">
            <IconTable size={16} aria-hidden />
            <VisuallyHidden>{t('listPage.table')}</VisuallyHidden>
          </Group>
        </Tooltip>
      ),
    },
    {
      value: 'cards',
      label: (
        <Tooltip label={t('listPage.cards')} withArrow>
          <Group gap={0} wrap="nowrap" component="span">
            <IconLayoutList size={16} aria-hidden />
            <VisuallyHidden>{t('listPage.cards')}</VisuallyHidden>
          </Group>
        </Tooltip>
      ),
    },
  ];
  return (
    <SegmentedControl
      size="xs"
      aria-label={t('listPage.view')}
      data-testid={`list-view-${id}`}
      data={data}
      // auto: what the list shows at this width (cards on phones) until the user chooses
      value={value === 'auto' ? (narrow ? 'cards' : 'table') : value}
      onChange={(v) => {
        const next = v as ListView;
        onChange(next);
        // stored here, so that controlled pages (useStoredListView) remember it as well
        try {
          localStorage.setItem(viewKey(id), next);
        } catch {
          /* storage blocked: the choice lasts for this page view */
        }
      }}
    />
  );
}

/**
 * The template of a list page (v0.4.0): optional area tabs, the title (h1) with the primary action, a search
 * field, filters that fold behind a button on phones, a table/card toggle and the list itself – or, when the
 * list has no entries yet, the empty state with who can add the first one.
 */
export function ListPage({
  tabs,
  title,
  description,
  primaryAction,
  actions,
  search,
  filters,
  activeFilters = 0,
  view,
  viewState,
  empty,
  children,
  testId,
  area,
}: {
  /** Above the title: the tabs of the area (Automate) */
  tabs?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** The main action (New …), shown first and filled */
  primaryAction?: ReactNode;
  /** Further header actions (reports, import, …) */
  actions?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string; label?: string };
  filters?: ReactNode;
  /** Number of active filters (the phone's "Filters (2)" button) */
  activeFilters?: number;
  /** Shows the table/card toggle; the id names the remembered choice */
  view?: string;
  /** The choice, when the page draws its own cards ({@link useStoredListView}) */
  viewState?: { value: ListView; onChange: (v: ListView) => void };
  /** Shown above the page's content while `show` holds (the page leaves out its empty list then) */
  empty?: { show: boolean; icon?: Icon; title: ReactNode; text?: ReactNode; whoCanAct?: ReactNode; action?: ReactNode };
  /** The area of the list (GET /api/me/visibility): empty, but with entries the person may not see, it says so */
  area?: VisibilityArea;
  children?: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [own, setOwn] = useState<ListView>(() => (view ? readView(view) : 'auto'));
  const chosen = viewState?.value ?? own;
  const setChosen = viewState?.onChange ?? setOwn;
  const headerActions =
    primaryAction || actions ? (
      <>
        {actions}
        {primaryAction}
      </>
    ) : undefined;
  const toolbar = search || filters || view;
  const hidden = useHiddenByPermissions(area);
  // the empty state comes before the page's own content, which still renders (its dialogs live there)
  return (
    <Box data-testid={testId} data-list-page>
      {tabs}
      <PageHeader title={title} description={description} actions={headerActions} />
      {toolbar && (
        <Group gap="xs" align="flex-end" wrap="nowrap" mb={filters ? 0 : 'md'}>
          <Box style={{ flex: 1, minWidth: 0 }}>
            {search && (
              <TextInput
                size="xs"
                mb={filters ? 'xs' : 0}
                leftSection={<IconSearch size={14} aria-hidden />}
                aria-label={search.label ?? t('listPage.search')}
                placeholder={search.placeholder ?? t('listPage.search')}
                value={search.value}
                onChange={(e) => search.onChange(e.currentTarget.value)}
                maw={360}
                type="search"
              />
            )}
            {filters && <FilterPanel active={activeFilters}>{filters}</FilterPanel>}
          </Box>
          {view && (
            <Box mb={filters ? 'md' : 0} style={{ flexShrink: 0 }}>
              <ViewToggle id={view} value={chosen} onChange={setChosen} />
            </Box>
          )}
        </Group>
      )}
      {empty?.show &&
        (hidden ? (
          <RestrictedEmpty />
        ) : (
          <EmptyState icon={empty.icon} title={empty.title} action={empty.action} whoCanAct={empty.whoCanAct}>
            {empty.text}
          </EmptyState>
        ))}
      <ListViewContext.Provider value={chosen}>{children}</ListViewContext.Provider>
    </Box>
  );
}
