import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Badge, Burger, Center, Group, Loader, NavLink, ScrollArea, Text, ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  IconLayoutDashboard,
  IconChartBar,
  IconInbox,
  IconPlayerPlay,
  IconSitemap,
  IconCalendarTime,
  IconServer,
  IconShieldCheck,
  IconSettings,
  IconUsers,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';
import type { AuthStatus, Capabilities, TaskRecord } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../shared/src/brand';
import { Logo } from './components/brand/Logo';
import { AppFooter } from './components/brand/AppFooter';
import { get, setAuthChangeHandler } from './api';
import { MeContext } from './auth';
import { ForcedPasswordChangePage, LoginPage, SetupPage, VaultLockedPage } from './pages/Auth';
import { UserMenu, signOut } from './components/UserMenu';
import { CommandPalette, CommandPaletteButton } from './components/CommandPalette';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { currentLanguage, setLanguage } from './i18n';

// Pages are loaded on demand to keep the first download small.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function page<K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const DashboardPage = page(() => import('./pages/Dashboard'), 'DashboardPage');
const DashboardsPage = page(() => import('./pages/Dashboards'), 'DashboardsPage');
const DashboardViewPage = page(() => import('./pages/DashboardView'), 'DashboardViewPage');
const TasksPage = page(() => import('./pages/Tasks'), 'TasksPage');
const RunsPage = page(() => import('./pages/Runs'), 'RunsPage');
const RunDetailPage = page(() => import('./pages/RunDetail'), 'RunDetailPage');
const ProcessesPage = page(() => import('./pages/Processes'), 'ProcessesPage');
const ProcessEditorPage = page(() => import('./pages/ProcessEditor'), 'ProcessEditorPage');
const SchedulesPage = page(() => import('./pages/Schedules'), 'SchedulesPage');
const PlatformsPage = page(() => import('./pages/Platforms'), 'PlatformsPage');
const PlatformDetailPage = page(() => import('./pages/PlatformDetail'), 'PlatformDetailPage');
const AuditPage = page(() => import('./pages/Audit'), 'AuditPage');
const UsersPage = page(() => import('./pages/Users'), 'UsersPage');
const SettingsPage = page(() => import('./pages/Settings'), 'SettingsPage');
const ProfilePage = page(() => import('./pages/Profile'), 'ProfilePage');

function PageLoader() {
  return (
    <Center py={80}>
      <Loader size="sm" />
    </Center>
  );
}

type NavKey = 'dashboard' | 'dashboards' | 'tasks' | 'runs' | 'processes' | 'schedules' | 'platforms' | 'audit' | 'users' | 'settings';
const NAV: { to: string; key: NavKey; icon: typeof IconLayoutDashboard; cap?: keyof Capabilities }[] = [
  { to: '/', key: 'dashboard', icon: IconLayoutDashboard },
  { to: '/dashboards', key: 'dashboards', icon: IconChartBar },
  { to: '/tasks', key: 'tasks', icon: IconInbox },
  { to: '/runs', key: 'runs', icon: IconPlayerPlay },
  { to: '/processes', key: 'processes', icon: IconSitemap },
  { to: '/schedules', key: 'schedules', icon: IconCalendarTime },
  { to: '/platforms', key: 'platforms', icon: IconServer },
  { to: '/audit', key: 'audit', icon: IconShieldCheck, cap: 'viewAudit' },
  { to: '/users', key: 'users', icon: IconUsers, cap: 'manageUsers' },
  { to: '/settings', key: 'settings', icon: IconSettings },
];

export function App() {
  const { t } = useTranslation('nav');
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatus>('/auth/status') });
  useEffect(() => setAuthChangeHandler(() => qc.invalidateQueries({ queryKey: ['auth'] })), [qc]);
  // The language stored in the profile wins over the browser language once the user is known.
  const userLocale = status.data?.me?.user.locale;
  useEffect(() => {
    if (userLocale && userLocale !== currentLanguage()) void setLanguage(userLocale);
  }, [userLocale]);
  const onSignOut = () => signOut(qc);

  if (status.isLoading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (status.error || !status.data) {
    return (
      <Center h="100vh" p="md">
        <Text c="red">{t('serverUnreachable', { brand: BRAND.name, error: (status.error as Error)?.message ?? '' })}</Text>
      </Center>
    );
  }
  const st = status.data;
  if (st.setupRequired) return <SetupPage status={st} />;
  if (!st.me) return <LoginPage status={st} />;
  if (st.me.user.mustChangePassword) return <ForcedPasswordChangePage status={st} onSignOut={onSignOut} />;
  if (!st.unlocked) return <VaultLockedPage status={st} onSignOut={onSignOut} />;
  return (
    <MeContext.Provider value={st.me}>
      <Shell status={st} />
    </MeContext.Provider>
  );
}

function Shell({ status }: { status: AuthStatus }) {
  const { t } = useTranslation('nav');
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const caps = status.me!.capabilities;
  const tasks = useQuery({ queryKey: ['tasks', 'mine-count'], queryFn: () => get<TaskRecord[]>('/tasks?status=open&mine=1'), refetchInterval: 5000 });
  const openTasks = tasks.data?.length ?? 0;

  const navItems = NAV.filter((n) => !n.cap || caps[n.cap]).map((n) => ({ ...n, label: t(`items.${n.key}`) }));
  const isActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname.startsWith(to));

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px={{ base: 'xs', xs: 'md' }} justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('toggleNavigation')} />
            <a
              href="/"
              onClick={(e) => (e.preventDefault(), navigate('/'))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
            >
              <Logo size={26} />
              <Text fw={700} truncate>
                {BRAND.name}
              </Text>
            </a>
            {status.demo && (
              <Badge color="yellow" variant="light" visibleFrom="xs" style={{ flexShrink: 0 }}>
                {t('demo')}
              </Badge>
            )}
          </Group>
          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            <CommandPaletteButton />
            <NotificationCenter />
            <Tooltip label={colorScheme === 'dark' ? t('lightMode') : t('darkMode')}>
              <ActionIcon
                variant="subtle"
                onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')}
                aria-label={t('toggleColorScheme')}
                visibleFrom="xs"
              >
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <UserMenu />
          </Group>
        </Group>
        <CommandPalette pages={navItems} />
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {navItems.map((n) => (
            <NavLink
              key={n.to}
              label={n.label}
              leftSection={<n.icon size={18} stroke={1.6} />}
              active={isActive(n.to)}
              rightSection={
                n.to === '/tasks' && openTasks > 0 ? (
                  <Badge size="sm" color="violet" circle>
                    {openTasks}
                  </Badge>
                ) : undefined
              }
              onClick={() => {
                navigate(n.to);
                close();
              }}
              style={{ borderRadius: 6 }}
            />
          ))}
        </ScrollArea>
      </AppShell.Navbar>
      <AppShell.Main style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
        <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<DashboardPage demo={status.demo} />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/dashboards/:id" element={<DashboardViewPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/processes" element={<ProcessesPage />} />
          <Route path="/processes/:id" element={<ProcessEditorPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/platforms" element={<PlatformsPage />} />
          <Route path="/platforms/:id" element={<PlatformDetailPage />} />
          {caps.viewAudit && <Route path="/audit" element={<AuditPage />} />}
          {caps.manageUsers && <Route path="/users" element={<UsersPage />} />}
          <Route path="/settings" element={<SettingsPage browserAvailable={status.browserAvailable} />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Text>{t('pageNotFound')}</Text>} />
        </Routes>
        </Suspense>
        </div>
        <AppFooter />
      </AppShell.Main>
    </AppShell>
  );
}
