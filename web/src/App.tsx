import { useEffect } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Badge, Burger, Center, Group, Loader, NavLink, ScrollArea, Text, ActionIcon, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconLayoutDashboard,
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
import { get, setAuthChangeHandler } from './api';
import { MeContext } from './auth';
import { ForcedPasswordChangePage, LoginPage, SetupPage, VaultLockedPage } from './pages/Auth';
import { UsersPage } from './pages/Users';
import { UserMenu, signOut } from './components/UserMenu';
import { DashboardPage } from './pages/Dashboard';
import { PlatformsPage } from './pages/Platforms';
import { PlatformDetailPage } from './pages/PlatformDetail';
import { ProcessesPage } from './pages/Processes';
import { ProcessEditorPage } from './pages/ProcessEditor';
import { RunsPage } from './pages/Runs';
import { RunDetailPage } from './pages/RunDetail';
import { TasksPage } from './pages/Tasks';
import { SchedulesPage } from './pages/Schedules';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';

const NAV: { to: string; label: string; icon: typeof IconLayoutDashboard; cap?: keyof Capabilities }[] = [
  { to: '/', label: 'Dashboard', icon: IconLayoutDashboard },
  { to: '/tasks', label: 'My tasks', icon: IconInbox },
  { to: '/runs', label: 'Runs', icon: IconPlayerPlay },
  { to: '/processes', label: 'Processes', icon: IconSitemap },
  { to: '/schedules', label: 'Schedules', icon: IconCalendarTime },
  { to: '/platforms', label: 'Platforms', icon: IconServer },
  { to: '/audit', label: 'Audit log', icon: IconShieldCheck, cap: 'viewAudit' },
  { to: '/users', label: 'Users & teams', icon: IconUsers, cap: 'manageUsers' },
  { to: '/settings', label: 'Settings', icon: IconSettings },
];

export function App() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth'], queryFn: () => get<AuthStatus>('/auth/status') });
  useEffect(() => setAuthChangeHandler(() => qc.invalidateQueries({ queryKey: ['auth'] })), [qc]);
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
        <Text c="red">Cannot reach the Service Manager server: {(status.error as Error)?.message}</Text>
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
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const caps = status.me!.capabilities;
  const tasks = useQuery({ queryKey: ['tasks', 'mine-count'], queryFn: () => get<TaskRecord[]>('/tasks?status=open&mine=1'), refetchInterval: 5000 });
  const openTasks = tasks.data?.length ?? 0;

  const isActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname.startsWith(to));

  return (
    <AppShell header={{ height: 52 }} navbar={{ width: 220, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700}>Service Manager</Text>
            {status.demo && (
              <Badge color="yellow" variant="light">
                demo
              </Badge>
            )}
          </Group>
          <Group gap={6} wrap="nowrap">
            <Tooltip label="Toggle dark mode">
              <ActionIcon variant="subtle" onClick={() => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark')} aria-label="Toggle color scheme">
                {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
              </ActionIcon>
            </Tooltip>
            <UserMenu />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <ScrollArea>
          {NAV.filter((n) => !n.cap || caps[n.cap]).map((n) => (
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
      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage demo={status.demo} />} />
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
          <Route path="*" element={<Text>Page not found</Text>} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}
