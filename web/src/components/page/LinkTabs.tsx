import { useEffect, useRef, type ReactNode } from 'react';
import { Badge, Box, Group, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Icon } from '@tabler/icons-react';
import { useMe } from '../../auth';
import { useAutomateTabs, useServiceTabs } from '../AppNav';

export interface LinkTab {
  to: string;
  label: string;
  icon?: Icon;
  /** A count beside the label (e.g. open tickets) */
  count?: number;
  /** extra test id */
  testId?: string;
}

/**
 * Tabs that are addresses: every tab is a link (bookmarkable, opens in a new tab, the browser's back button
 * works), the current one is marked with aria-current. Used for an area's pages (Automate) and for the tabs of
 * a detail page (the service hub). Wraps on wider screens; scrolls sideways on phones instead of wrapping, with the
 * current tab scrolled into view (a link may lead straight to a tab at the end).
 */
export function LinkTabs({ tabs, active, label, mb = 'md', after }: { tabs: LinkTab[]; active: string; label: string; mb?: string; after?: ReactNode }) {
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    // the bar itself is scrolled, not the page (scrollIntoView would also move the page vertically)
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = tab.offsetLeft - (nav.clientWidth - tab.offsetWidth) / 2;
  }, [active]);
  return (
    <Box component="nav" ref={navRef} aria-label={label} mb={mb} className="link-tabs" data-testid="link-tabs">
      <Group gap={0} className="link-tabs-list">
        {tabs.map((tab) => {
          const current = tab.to === active;
          return (
            <UnstyledButton
              key={tab.to}
              component={Link}
              to={tab.to}
              className="link-tab"
              data-active={current || undefined}
              aria-current={current ? 'page' : undefined}
              data-testid={tab.testId}
            >
              <Group gap={6} wrap="nowrap" component="span">
                {tab.icon && <tab.icon size={16} stroke={1.6} aria-hidden />}
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <Badge size="xs" variant="light" className="count-badge" data-testid="link-tab-count">
                    {tab.count}
                  </Badge>
                )}
              </Group>
            </UnstyledButton>
          );
        })}
        {after}
      </Group>
    </Box>
  );
}

/** The Automate area's tabs above Processes, Schedules, Triggers, Git sync and Libraries (only the ones the user may use). */
export function AutomateTabs({ active }: { active: '/processes' | '/schedules' | '/triggers' | '/git-updates' | '/libraries' }) {
  const { t } = useTranslation('nav');
  const { caps } = useMe();
  const tabs = useAutomateTabs(caps);
  if (tabs.length < 2) return null;
  return <LinkTabs label={t('groups.automate')} active={active} tabs={tabs.map((n) => ({ to: n.to, label: n.label, icon: n.icon }))} />;
}

/** The tabs above Services, Scorecard and Costs (0.11.0): the reports about services are views of Services. */
export function ServiceTabs({ active }: { active: '/services' | '/scorecard' | '/costs' }) {
  const { t } = useTranslation('nav');
  const { caps } = useMe();
  const tabs = useServiceTabs(caps);
  if (tabs.length < 2) return null;
  return <LinkTabs label={t('items.services')} active={active} tabs={tabs.map((n) => ({ to: n.to, label: n.label, icon: n.icon }))} />;
}
