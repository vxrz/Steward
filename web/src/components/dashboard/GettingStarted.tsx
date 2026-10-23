import { useEffect, useState, type ReactNode } from 'react';
import { Anchor, Card, CloseButton, Group, Kbd, List, Progress, Stack, Text, ThemeIcon, Title, VisuallyHidden } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconRocket } from '@tabler/icons-react';
import type { DashboardSetup } from '@sm/shared';

const HIDDEN_KEY = 'sm.gettingStarted.hidden';

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
 * done or when the administrator hides it (remembered per browser).
 */
/** `forceShow`: opened from the Help menu – shown (and no longer hidden) even when every step is done. */
export function GettingStarted({ setup, demoAction, forceShow }: { setup: DashboardSetup; demoAction?: ReactNode; forceShow?: boolean }) {
  const { t } = useTranslation('dashboard');
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    if (!forceShow) return;
    setHidden(false);
    try {
      localStorage.removeItem(HIDDEN_KEY);
    } catch {
      /* storage blocked */
    }
  }, [forceShow]);
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
          <IconRocket size={18} aria-hidden />
          <Title order={5} id="getting-started-title">
            {t('checklist.title')}
          </Title>
        </Group>
        <CloseButton size="sm" onClick={hide} aria-label={t('checklist.hide')} />
      </Group>
      <Group gap="sm" mb="sm" wrap="nowrap">
        <Progress value={(done / STEPS.length) * 100} size="sm" style={{ flex: 1 }} aria-label={t('checklist.progressLabel')} />
        <Text size="xs" c="dimmed" className="nowrap">
          {t('checklist.progress', { done, total: STEPS.length })}
        </Text>
      </Group>
      {demoAction}
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
    </Card>
  );
}
