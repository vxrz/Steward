import { lazy, Suspense, useEffect, useMemo, type ComponentType } from 'react';
import { Link, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Badge, Burger, Button, Center, Group, Loader, Text, ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure, useLocalStorage, useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IconMapPinOff, IconMoon, IconSun } from '@tabler/icons-react';
import { EmptyState } from './components/common';
import type { AuthStatus, TaskRecord } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../shared/src/brand';
import { AppLogo } from './components/brand/AppLogo';
import { AppFooter } from './components/brand/AppFooter';
import { get, setAuthChangeHandler } from './api';
import { MeContext } from './auth';
import { ForcedPasswordChangePage, LoginPage, SetupPage, VaultLockedPage } from './pages/Auth';
import { UserMenu, signOut } from './components/UserMenu';
import { CommandPalette, CommandPaletteButton } from './components/CommandPalette';
import { AppNav, useNavGroups } from './components/AppNav';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { currentLanguage, setLanguage } from './i18n';
import { useAppName } from './theme';

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
const TriggersPage = page(() => import('./pages/Triggers'), 'TriggersPage');
const MonitorsPage = page(() => import('./pages/Monitors'), 'MonitorsPage');
const MonitorDetailPage = page(() => import('./pages/MonitorDetail'), 'MonitorDetailPage');
const MonitorEditorPage = page(() => import('./pages/MonitorEditor'), 'MonitorEditorPage');
const MonitorWallPage = page(() => import('./pages/MonitorWall'), 'MonitorWallPage');
const PlatformsPage = page(() => import('./pages/Platforms'), 'PlatformsPage');
const PlatformDetailPage = page(() => import('./pages/PlatformDetail'), 'PlatformDetailPage');
const AuditPage = page(() => import('./pages/Audit'), 'AuditPage');
const UsersPage = page(() => import('./pages/Users'), 'UsersPage');
const SettingsPage = page(() => import('./pages/Settings'), 'SettingsPage');
const ProfilePage = page(() => import('./pages/Profile'), 'ProfilePage');
const AboutPage = page(() => import('./pages/About'), 'AboutPage');
const SystemStatusPage = page(() => import('./pages/SystemStatus'), 'SystemStatusPage');
const CredentialsPage = page(() => import('./pages/Credentials'), 'CredentialsPage');
const ReportsPage = page(() => import('./pages/Reports'), 'ReportsPage');
const RecordsPage = page(() => import('./pages/Records'), 'RecordsPage');
const RecordDetailPage = page(() => import('./pages/RecordDetail'), 'RecordDetailPage');
const RecordEditorPage = page(() => import('./pages/RecordEditor'), 'RecordEditorPage');
const RecordTypesPage = page(() => import('./pages/RecordTypes'), 'RecordTypesPage');
const ServicesPage = page(() => import('./pages/Services'), 'ServicesPage');
const ServiceDetailPage = page(() => import('./pages/ServiceDetail'), 'ServiceDetailPage');
const GitSyncPage = page(() => import('./pages/GitSync'), 'GitSyncPage');
const GitUpdatesPage = page(() => import('./pages/GitUpdates'), 'GitUpdatesPage');
const GitUpdateDetailPage = page(() => import('./pages/GitUpdates'), 'GitUpdateDetailPage');
const TicketsPage = page(() => import('./pages/Tickets'), 'TicketsPage');
const TicketDetailPage = page(() => import('./pages/TicketDetail'), 'TicketDetailPage');

function PageLoader() {
  return (
    <Center py={80}>
      <Loader size="sm" />
    </Center>
  );
}

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
  const appName = useAppName();
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const caps = status.me!.capabilities;
  const tasks = useQuery({ queryKey: ['tasks', 'mine-count'], queryFn: () => get<TaskRecord[]>('/tasks?status=open&mine=1'), refetchInterval: 5000 });
  const openTasks = tasks.data?.length ?? 0;

  const navGroups = useNavGroups(caps);
  const navItems = useMemo(() => navGroups.flatMap((g) => g.items), [navGroups]);
  // Narrow icon-only sidebar on wide screens (remembered per browser)
  const [rail, setRail] = useLocalStorage({ key: 'sm.nav.rail', defaultValue: false, getInitialValueInEffect: false });
  // The burger drawer on phones always shows the full sidebar.
  const isDesktop = useMediaQuery('(min-width: 48em)') ?? false;
  const railActive = rail && isDesktop;

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: railActive ? 64 : 232, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px={{ base: 'xs', xs: 'md' }} justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('toggleNavigation')} />
            <a
              href="/"
              onClick={(e) => (e.preventDefault(), navigate('/'))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'inherit', minWidth: 0 }}
            >
              <AppLogo size={26} />
              <Text fw={700} truncate>
                {appName}
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
      <AppShell.Navbar p="xs" aria-label={t('mainNavigation')}>
        <AppNav
          caps={caps}
          pathname={location.pathname}
          openTasks={openTasks}
          rail={railActive}
          onToggleRail={isDesktop ? () => setRail(!rail) : undefined}
          onNavigate={close}
        />
      </AppShell.Navbar>
      <AppShell.Main style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ErrorBoundary resetKey={location.pathname}>
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
                <Route path="/triggers" element={<TriggersPage />} />
                <Route path="/git-updates" element={<GitUpdatesPage />} />
                <Route path="/git-updates/:id" element={<GitUpdateDetailPage />} />
                <Route path="/monitors" element={<MonitorsPage />} />
                <Route path="/monitors/new" element={<MonitorEditorPage />} />
                <Route path="/monitors/wall" element={<MonitorWallPage />} />
                <Route path="/monitors/:id" element={<MonitorDetailPage />} />
                <Route path="/monitors/:id/edit" element={<MonitorEditorPage />} />
                <Route path="/platforms" element={<PlatformsPage />} />
                <Route path="/platforms/:id" element={<PlatformDetailPage />} />
                <Route path="/records" element={<RecordsPage />} />
                <Route path="/records/types" element={<RecordTypesPage />} />
                <Route path="/records/:id" element={<RecordDetailPage />} />
                <Route path="/records/:id/edit" element={<RecordEditorPage />} />
                <Route path="/services" element={<ServicesPage />} />
                <Route path="/services/:id" element={<ServiceDetailPage />} />
                <Route path="/credentials" element={<CredentialsPage />} />
                <Route path="/tickets" element={<TicketsPage />} />
                <Route path="/tickets/:id" element={<TicketDetailPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                {caps.viewAudit && <Route path="/audit" element={<AuditPage />} />}
                {caps.manageUsers && <Route path="/users" element={<UsersPage />} />}
                <Route path="/settings" element={<SettingsPage browserAvailable={status.browserAvailable} />} />
                <Route path="/settings/git-sync" element={<GitSyncPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/about" element={<AboutPage />} />
                {caps.viewAudit && <Route path="/settings/status" element={<SystemStatusPage />} />}
                <Route
                  path="*"
                  element={
                    <EmptyState
                      icon={IconMapPinOff}
                      title={t('pageNotFound')}
                      action={
                        <Button component={Link} to="/">
                          {t('backToDashboard')}
                        </Button>
                      }
                    />
                  }
                />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </div>
        <AppFooter signedIn />
      </AppShell.Main>
    </AppShell>
  );
}
