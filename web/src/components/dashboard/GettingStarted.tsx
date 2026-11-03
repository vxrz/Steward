import { useEffect, useState, type ReactNode } from 'react';
import { ActionIcon, Anchor, Card, CloseButton, Group, Kbd, List, Progress, Stack, Text, ThemeIcon, Title, Tooltip, VisuallyHidden } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconChevronDown, IconChevronRight, IconRocket } from '@tabler/icons-react';
import type { DashboardSetup } from '@sm/shared';
import { useMe } from '../../auth';

const HIDDEN_KEY = 'sm.gettingStarted.hidden';
/** Folded or not, per user ("1" folded, "0" open; unset: folded on phones, open on wider screens). */
const collapsedKey = (user: string) => `sm.gettingStarted.collapsed.${user}`;

function readCollapsed(user: string): boolean | null {
  try {
    const v = localStorage.getItem(collapsedKey(user));
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

type StepKey = 'platform' | 'process' | 'run' | 'schedule' | 'monitor' | 'credential' | 'users' | 'report';

/** The steps of a useful installation, in a sensible order; `done` reads the instance-wide counts. */
const STEPS: { key: StepKey; to: string; done: (s: DashboardSetup) => boolean }[] = [
  { key: 'platform', to: '/platforms', done: (s) => s.platforms > 0 },
  { key: 'process', to: '/processes', done: (s) => s.processes > 0 },
  { key: 'run', to: '/processes', done: (s) => s.runs > 0 },
  { key: 'schedule', to: '/schedules?new=1', done: (s) => s.schedules > 0 },
  { key: 'monitor', to: '/monitors/new', done: (s) => s.monitors > 0 },
  { key: 'credential', to: '/credentials?new=1', done: (s) => s.credentials > 0 },
  { key: 'users', to: '/users', done: (s) => s.users > 1 },
  { key: 'report', to: '/reports?new=1', done: (s) => s.reportSchedules > 0 },
];

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * First-run checklist for administrators on the start page: what is set up, what is next (each step
 * links to the page or its create dialog) and a few features worth knowing. Hidden once everything is
 * done or when the administrator hides it (remembered per browser). It folds to its progress and the next
 * step – folded by default on phones, the choice remembered per user; the Help and user menus open it again.
 */
/** `forceShow`: opened from the Help menu – shown (and no longer hidden) even when every step is done. */
export function GettingStarted({ setup, demoAction, forceShow }: { setup: DashboardSetup; demoAction?: ReactNode; forceShow?: boolean }) {
  const { t } = useTranslation('dashboard');
  const { username } = useMe();
  const narrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const [hidden, setHidden] = useState(readHidden);
  // the user's choice; without one folded on phones (the list would fill the whole first screen)
  const [choice, setChoice] = useState<boolean | null>(() => readCollapsed(username));
  const collapsed = choice ?? !!narrow;
  useEffect(() => {
    if (!forceShow) return;
    setHidden(false);
    setChoice(false);
    try {
      localStorage.removeItem(HIDDEN_KEY);
      localStorage.setItem(collapsedKey(username), '0');
    } catch {
      /* storage blocked */
    }
  }, [forceShow, username]);
  const toggle = () => {
    const next = !collapsed;
    setChoice(next);
    try {
      localStorage.setItem(collapsedKey(username), next ? '1' : '0');
    } catch {
      /* storage blocked: only for this page view */
    }
  };
  const done = STEPS.filter((s) => s.done(setup)).length;
  if (hidden || (!forceShow && done === STEPS.length)) return null;
  const next = STEPS.find((s) => !s.done(setup));
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, '1');
    } catch {
      /* storage blocked: hidden for this page view */
    }
  };
  return (
    <Card withBorder mb="md" component="section" aria-labelledby="getting-started-title" data-testid="getting-started">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Group gap="xs" wrap="nowrap">
          <Tooltip label={collapsed ? t('checklist.expand') : t('checklist.collapse')}>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-controls="getting-started-steps"
              aria-label={collapsed ? t('checklist.expand') : t('checklist.collapse')}
              data-testid="getting-started-toggle"
            >
              {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
            </ActionIcon>
          </Tooltip>
          <IconRocket size={18} aria-hidden />
          <Title order={5} id="getting-started-title">
            {t('checklist.title')}
          </Title>
        </Group>
        <CloseButton size="sm" onClick={hide} aria-label={t('checklist.hide')} />
      </Group>
      <Group gap="sm" mb={collapsed ? 0 : 'sm'} wrap="nowrap">
        <Progress value={(done / STEPS.length) * 100} size="sm" style={{ flex: 1 }} aria-label={t('checklist.progressLabel')} />
        <Text size="xs" c="dimmed" className="nowrap">
          {t('checklist.progress', { done, total: STEPS.length })}
        </Text>
      </Group>
      {collapsed && next && (
        // folded: only the next step
        <Text size="sm" mt="xs">
          {t('checklist.next')}{' '}
          <Anchor component={Link} to={next.to} size="sm" fw={600}>
            {t(`checklist.steps.${next.key}.title`)}
          </Anchor>
        </Text>
      )}
      {!collapsed && demoAction}
      {!collapsed && (
        <div id="getting-started-steps">
          <List spacing={8} size="sm" center>
            {STEPS.map((s) => {
              const ok = s.done(setup);
              return (
                <List.Item
                  key={s.key}
                  data-done={ok}
                  icon={
                    <ThemeIcon size={20} radius="xl" color={ok ? 'green' : 'gray'} variant={ok ? 'filled' : 'light'} aria-hidden>
                      {ok ? <IconCheck size={13} /> : <Text size="xs">{STEPS.indexOf(s) + 1}</Text>}
                    </ThemeIcon>
                  }
                >
                  <Stack gap={0}>
                    <Group gap={6} wrap="wrap">
                      <Anchor
                        component={Link}
                        to={s.to}
                        size="sm"
                        fw={s === next ? 600 : undefined}
                        td={ok ? 'line-through' : undefined}
                        c={ok ? 'dimmed' : undefined}
                      >
                        {t(`checklist.steps.${s.key}.title`)}
                      </Anchor>
                      {ok && <VisuallyHidden>{t('checklist.doneSr')}</VisuallyHidden>}
                    </Group>
                    {!ok && (
                      <Text size="xs" c="dimmed">
                        {t(`checklist.steps.${s.key}.text`)}
                      </Text>
                    )}
                  </Stack>
                </List.Item>
              );
            })}
          </List>
          <Text size="xs" c="dimmed" mt="md">
            {t('checklist.discover')}{' '}
            <Anchor component={Link} to="/profile" size="xs">
              {t('checklist.discoverTokens')}
            </Anchor>
            {' · '}
            <Anchor component={Link} to="/monitors/wall" size="xs">
              {t('checklist.discoverWall')}
            </Anchor>
            {' · '}
            {t('checklist.discoverSearch')} <Kbd size="xs">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : t('checklist.shortcutCtrlK')}</Kbd>
          </Text>
        </div>
      )}
    </Card>
  );
}
