import type { ReactNode } from 'react';
import { Badge, Box, Group, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Icon } from '@tabler/icons-react';
import { useMe } from '../../auth';
import { useAutomateTabs } from '../AppNav';

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
 * a detail page (the service hub). Scrolls sideways on phones instead of wrapping.
 */
export function LinkTabs({ tabs, active, label, mb = 'md', after }: { tabs: LinkTab[]; active: string; label: string; mb?: string; after?: ReactNode }) {
  return (
    <Box component="nav" aria-label={label} mb={mb} className="link-tabs" data-testid="link-tabs">
      <Group gap={0} wrap="nowrap" className="link-tabs-list">
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
                  <Badge size="xs" variant="light" circle>
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
