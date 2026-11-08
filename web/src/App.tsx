import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, Navigate, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
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
import { get, setAuthChangeHandler } from './api';
import { MeContext } from './auth';
import { EmergencyAccessPage, ForcedPasswordChangePage, LoginPage, SetupPage, VaultLockedPage } from './pages/Auth';
import { EmergencyBanner } from './components/security/EmergencyBanner';
import { UserMenu, signOut } from './components/UserMenu';
import { CommandPalette, CommandPaletteButton } from './components/CommandPalette';
import { AppNav, useAutomateTabs, useNavGroups } from './components/AppNav';
import { ModuleGate, ModuleOffPage } from './components/modules/ModuleOff';
import { useVisibilityQuery } from './modules';
import { NotificationCenter } from './components/notifications/NotificationCenter';
import { HelpMenu } from './components/HelpMenu';
import { UpdateNotice } from './components/UpdateNotice';
import { currentLanguage, setLanguage } from './i18n';
import { useAppName } from './theme';
import { withBase } from './basePath';
import { ShellLayoutContext } from './layout';
import { setRecentUser } from './components/page/recent';

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
const RunComparePage = page(() => import('./pages/RunCompare'), 'RunComparePage');
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
const SettingsIndex = page(() => import('./pages/Settings'), 'SettingsIndex');
const ProfilePage = page(() => import('./pages/Profile'), 'ProfilePage');
const OAuthAuthorizePage = page(() => import('./pages/OAuthAuthorize'), 'OAuthAuthorizePage');
const AboutPage = page(() => import('./pages/About'), 'AboutPage');
const SystemStatusPage = page(() => import('./pages/SystemStatus'), 'SystemStatusPage');
const CredentialsPage = page(() => import('./pages/Credentials'), 'CredentialsPage');
const ComplianceControlsPage = page(() => import('./pages/ComplianceControls'), 'ComplianceControlsPage');
const AccessChangesPage = page(() => import('./pages/AccessChanges'), 'AccessChangesPage');
const AccessReconciliationPage = page(() => import('./pages/AccessReconciliation'), 'AccessReconciliationPage');
const EvidencePacksPage = page(() => import('./pages/EvidencePacks'), 'EvidencePacksPage');
const StatusPagesPage = page(() => import('./pages/StatusPages'), 'StatusPagesPage');
const StatusPageViewPage = page(() => import('./pages/StatusPages'), 'StatusPageViewPage');
const PublicStatusPage = page(() => import('./pages/StatusPages'), 'PublicStatusPage');
const StatusViewerApp = page(() => import('./pages/StatusPages'), 'StatusViewerApp');
const McpRequestsPage = page(() => import('./pages/McpRequests'), 'McpRequestsPage');
const McpRequestDetailPage = page(() => import('./pages/McpRequests'), 'McpRequestDetailPage');
const PersonReviewsPage = page(() => import('./pages/PersonReviews'), 'PersonReviewsPage');
const PersonReviewDetailPage = page(() => import('./pages/PersonReviews'), 'PersonReviewDetailPage');
const ReportsPage = page(() => import('./pages/Reports'), 'ReportsPage');
const RecordsPage = page(() => import('./pages/Records'), 'RecordsPage');
const RecordDetailPage = page(() => import('./pages/RecordDetail'), 'RecordDetailPage');
const RecordEditorPage = page(() => import('./pages/RecordEditor'), 'RecordEditorPage');
const RecordTypesPage = page(() => import('./pages/RecordTypes'), 'RecordTypesPage');
const LinkTypesPage = page(() => import('./pages/LinkTypes'), 'LinkTypesPage');
const ServicesPage = page(() => import('./pages/Services'), 'ServicesPage');
const ServiceDetailPage = page(() => import('./pages/ServiceDetail'), 'ServiceDetailPage');
const ApplicationsPage = page(() => import('./pages/Applications'), 'ApplicationsPage');
const SystemsPage = page(() => import('./pages/Systems'), 'SystemsPage');
const MaintenancePage = page(() => import('./pages/Maintenance'), 'MaintenancePage');
const SystemDetailPage = page(() => import('./pages/SystemDetail'), 'SystemDetailPage');
const SystemSchemaPage = page(() => import('./pages/SystemSchema'), 'SystemSchemaPage');
const CostsPage = page(() => import('./pages/Costs'), 'CostsPage');
const CostDetailPage = page(() => import('./pages/CostDetail'), 'CostDetailPage');
const DataContractsPage = page(() => import('./pages/DataContracts'), 'DataContractsPage');
const DataContractNewPage = page(() => import('./pages/DataContractNew'), 'DataContractNewPage');
const DataContractDetailPage = page(() => import('./pages/DataContractDetail'), 'DataContractDetailPage');
const ApplicationDetailPage = page(() => import('./pages/ApplicationDetail'), 'ApplicationDetailPage');
const DutiesPage = page(() => import('./pages/Duties'), 'DutiesPage');
const DutyDetailPage = page(() => import('./pages/DutyDetail'), 'DutyDetailPage');
const ScorecardPage = page(() => import('./pages/Scorecard'), 'ScorecardPage');
const CiaScalePage = page(() => import('./pages/CiaScale'), 'CiaScalePage');
const GitSyncPage = page(() => import('./pages/GitSync'), 'GitSyncPage');
const MigrationPage = page(() => import('./pages/Migration'), 'MigrationPage');
const BackupsPage = page(() => import('./pages/Backups'), 'BackupsPage');
const GitUpdatesPage = page(() => import('./pages/GitUpdates'), 'GitUpdatesPage');
const GitUpdateDetailPage = page(() => import('./pages/GitUpdates'), 'GitUpdateDetailPage');
const LibrariesPage = page(() => import('./pages/Libraries'), 'LibrariesPage');
const LibraryDetailPage = page(() => import('./pages/Libraries'), 'LibraryDetailPage');
const LibraryReleasePage = page(() => import('./pages/LibraryRelease'), 'LibraryReleasePage');
const LibraryPublishersPage = page(() => import('./pages/LibraryPublishers'), 'LibraryPublishersPage');
const TicketsPage = page(() => import('./pages/Tickets'), 'TicketsPage');
const TicketDetailPage = page(() => import('./pages/TicketDetail'), 'TicketDetailPage');
const PlantSitesPage = page(() => import('./pages/PlantSites'), 'PlantSitesPage');
const PlantSitePage = page(() => import('./pages/PlantSite'), 'PlantSitePage');
const PlantAssetsPage = page(() => import('./pages/PlantAssets'), 'PlantAssetsPage');
const PlantAssetPage = page(() => import('./pages/PlantAsset'), 'PlantAssetPage');
const PlantImportPage = page(() => import('./pages/PlantImport'), 'PlantImportPage');
const PlantProfilesPage = page(() => import('./pages/PlantProfiles'), 'PlantProfilesPage');
const PlantProfilePage = page(() => import('./pages/PlantProfile'), 'PlantProfilePage');
const PlantDataPointPage = page(() => import('./pages/PlantDataPoint'), 'PlantDataPointPage');
const PlantKpisPage = page(() => import('./pages/PlantKpis'), 'PlantKpisPage');
const PlantKpiPage = page(() => import('./pages/PlantKpi'), 'PlantKpiPage');
const PlantExplorePage = page(() => import('./pages/PlantExplore'), 'PlantExplorePage');
const PlantChecksPage = page(() => import('./pages/PlantChecks'), 'PlantChecksPage');
const PlantNetworkPage = page(() => import('./pages/PlantNetwork'), 'PlantNetworkPage');
const PlantMapPage = page(() => import('./pages/PlantMap'), 'PlantMapPage');

const MAIN_ID = 'main-content';

/** The sidebar's areas (v0.4.0) as addresses, e.g. /catalogue: they lead to the area's first page. */
const AREA_HOME: Record<string, string> = {
  '/home': '/',
  '/dashboard': '/',
  '/operate': '/runs',
  '/automate': '/processes',
  '/catalogue': '/services',
  '/compliance': '/compliance/controls',
  '/plant': '/plant/sites',
};

/** "Skip to content": the first focusable element, visible only while it has focus (WCAG 2.4.1). */
function SkipLink() {
  const { t } = useTranslation('nav');
  return (
    <a
      href={`#${MAIN_ID}`}
      className="skip-link"
      onClick={(e) => {
        // focus the main region without changing the URL (the router owns the hash)
        e.preventDefault();
        const main = document.getElementById(MAIN_ID);
        main?.focus();
        main?.scrollIntoView({ block: 'start' });
      }}
    >
      {t('skipToContent')}
    </a>
  );
}

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
  const location = useLocation();
  const navigate = useNavigate();

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
  // a status page's secret link works without signing in (#26)
  if (location.pathname === '/status') return <PublicStatusPage />;
  if (st.setupRequired) return <SetupPage status={st} />;
  // the one-time link of `steward admin emergency-access` (see auth/emergency.ts on the server)
  if (location.pathname === '/emergency-access' && !st.me?.emergency)
    return <EmergencyAccessPage status={st} onDone={() => navigate('/', { replace: true })} />;
  if (!st.me) return <LoginPage status={st} />;
  if (st.me.user.mustChangePassword) return <ForcedPasswordChangePage status={st} onSignOut={onSignOut} />;
  if (!st.unlocked) return <VaultLockedPage status={st} onSignOut={onSignOut} />;
  // status viewers (role "status" only) see nothing but the status pages
  if (st.me.user.roles.length && st.me.user.roles.every((r) => r === 'status')) {
    // the status pages switched off (ADR 0016): the status viewer learns it, and nothing else
    if (st.me.capabilities.modules?.statusPages === false)
      return (
        <MeContext.Provider value={st.me}>
          <Suspense fallback={<PageLoader />}>
            <Center p="md" mih="100vh">
              <div style={{ width: '100%', maxWidth: 640 }}>
                <ModuleOffPage module="statusPages" />
                <Center>
                  <Button variant="default" onClick={onSignOut}>
                    {t('userMenu.signOut')}
                  </Button>
                </Center>
              </div>
            </Center>
          </Suspense>
        </MeContext.Provider>
      );
    return <StatusViewerApp onSignOut={onSignOut} />;
  }
  return (
    <MeContext.Provider value={st.me}>
      <Shell status={st} />
    </MeContext.Provider>
  );
}

function Shell({ status }: { status: AuthStatus }) {
  const { t } = useTranslation('nav');
  const qc = useQueryClient();
  const appName = useAppName();
  const [opened, { toggle, close }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const caps = status.me!.capabilities;
  // a plant viewer (#218, role "plant" only): the Plant area and the profile, nothing else (the server refuses the rest)
  const plantOnly = caps.plantOnly === true;
  // recent items (command palette) are kept per user
  setRecentUser(status.me!.user.id);
  const tasks = useQuery({
    queryKey: ['tasks', 'mine-count'],
    queryFn: () => get<TaskRecord[]>('/tasks?status=open&mine=1'),
    refetchInterval: 5000,
    enabled: !plantOnly,
  });
  const openTasks = tasks.data?.length ?? 0;

  // what the person may see (U2): the sidebar and the palette leave out areas with nothing for them
  const { data: seen, settled: seenSettled } = useVisibilityQuery(!plantOnly);
  const navGroups = useNavGroups(caps, seen);
  const automateTabs = useAutomateTabs(caps);
  // the palette finds the tab pages of an entry, too (Schedules, Triggers, Git sync)
  const navItems = useMemo(() => {
    const items = navGroups.flatMap((g) => g.items);
    return [...items, ...automateTabs.filter((tab) => !items.some((i) => i.to === tab.to))];
  }, [navGroups, automateTabs]);
  // Narrow icon-only sidebar on wide screens (remembered per browser)
  const [rail, setRail] = useLocalStorage({ key: 'sm.nav.rail', defaultValue: false, getInitialValueInEffect: false });
  // The burger drawer on phones always shows the full sidebar.
  const isDesktop = useMediaQuery('(min-width: 48em)') ?? false;
  const railActive = rail && isDesktop;
  // full-screen pages (the process editor) collapse the sidebar on wide screens
  const [wide, setWide] = useState(false);
  const layout = useMemo(() => ({ wide, setWide }), [wide]);
  const notFound = (
    <EmptyState
      icon={IconMapPinOff}
      title={t('pageNotFound')}
      action={
        <Button component={Link} to="/">
          {t('backToDashboard')}
        </Button>
      }
    />
  );

  return (
    <ShellLayoutContext.Provider value={layout}>
      <AppShell header={{ height: 52 }} navbar={{ width: railActive ? 64 : 232, breakpoint: 'sm', collapsed: { mobile: !opened, desktop: wide } }} padding="md">
        <SkipLink />
        <AppShell.Header>
          <Group h="100%" px={{ base: 'xs', xs: 'md' }} justify="space-between" wrap="nowrap" gap="xs">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label={t('toggleNavigation')} />
              <a
                href={withBase('/')}
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
              {!plantOnly && <CommandPaletteButton />}
              <HelpMenu />
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
          {!plantOnly && <CommandPalette pages={navItems} />}
        </AppShell.Header>
        <AppShell.Navbar p="xs" aria-label={t('mainNavigation')}>
          <AppNav
            caps={caps}
            seen={seen}
            seenSettled={seenSettled}
            userId={status.me!.user.id}
            pathname={location.pathname}
            openTasks={openTasks}
            rail={railActive}
            onToggleRail={isDesktop ? () => setRail(!rail) : undefined}
            onNavigate={close}
          />
        </AppShell.Navbar>
        <AppShell.Main id={MAIN_ID} tabIndex={-1} style={{ display: 'flex', flexDirection: 'column', outline: 'none' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {status.me!.emergency && <EmergencyBanner expiresAt={status.me!.emergency.expiresAt} onSignOut={() => signOut(qc)} />}
            {caps.manageSettings && <UpdateNotice />}
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<PageLoader />}>
                {plantOnly ? (
                  <Routes>
                    <Route path="/" element={<Navigate to="/plant/sites" replace />} />
                    {caps.plant && <Route path="/plant/sites" element={<PlantSitesPage />} />}
                    {caps.plant && <Route path="/plant/sites/:siteId" element={<PlantSitePage />} />}
                    {caps.plant && <Route path="/plant/sites/:siteId/network" element={<PlantNetworkPage />} />}
                    {caps.plant && <Route path="/plant/sites/:siteId/network/:tab" element={<PlantNetworkPage />} />}
                    {caps.plant && <Route path="/plant/sites/:siteId/:tab" element={<PlantSitePage />} />}
                    {caps.plant && <Route path="/plant/assets" element={<PlantAssetsPage />} />}
                    {caps.plant && <Route path="/plant/assets/:assetId" element={<PlantAssetPage />} />}
                    {caps.plant && <Route path="/plant/assets/:assetId/:tab" element={<PlantAssetPage />} />}
                    {caps.plant && <Route path="/plant/import" element={<PlantImportPage />} />}
                    {caps.plant && <Route path="/plant/profiles" element={<PlantProfilesPage />} />}
                    {caps.plant && <Route path="/plant/profiles/:profileId" element={<PlantProfilePage />} />}
                    {caps.plant && <Route path="/plant/profiles/:profileId/points/:pointId" element={<PlantDataPointPage />} />}
                    {caps.plant && <Route path="/plant/kpis" element={<PlantKpisPage />} />}
                    {caps.plant && <Route path="/plant/kpis/:kpiId" element={<PlantKpiPage />} />}
                    {caps.plant && <Route path="/plant/explore" element={<PlantExplorePage />} />}
                    {caps.plant && <Route path="/plant/checks" element={<PlantChecksPage />} />}
                    {caps.plant && <Route path="/plant/map" element={<PlantMapPage />} />}
                    <Route path="/plant" element={<Navigate to="/plant/sites" replace />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="*" element={notFound} />
                  </Routes>
                ) : (
                  <Routes>
                    <Route path="/" element={<DashboardPage demo={status.demo} />} />
                    <Route path="/dashboards" element={<DashboardsPage />} />
                    <Route path="/dashboards/:id" element={<DashboardViewPage />} />
                    <Route path="/tasks" element={<TasksPage />} />
                    <Route path="/mcp-requests" element={<McpRequestsPage />} />
                    <Route path="/mcp-requests/:id" element={<McpRequestDetailPage />} />
                    <Route path="/runs" element={<RunsPage />} />
                    <Route path="/runs/compare" element={<RunComparePage />} />
                    <Route path="/runs/:id" element={<RunDetailPage />} />
                    <Route path="/processes" element={<ProcessesPage />} />
                    <Route path="/processes/:id" element={<ProcessEditorPage />} />
                    <Route path="/schedules" element={<SchedulesPage />} />
                    <Route path="/triggers" element={<TriggersPage />} />
                    <Route path="/git-updates" element={<GitUpdatesPage />} />
                    <Route path="/git-updates/:id" element={<GitUpdateDetailPage />} />
                    <Route
                      path="/libraries"
                      element={
                        <ModuleGate module="libraries">
                          <LibrariesPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/libraries/releases/:id"
                      element={
                        <ModuleGate module="libraries">
                          <LibraryReleasePage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/libraries/:library"
                      element={
                        <ModuleGate module="libraries">
                          <LibraryDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/monitors" element={<MonitorsPage />} />
                    <Route path="/monitors/new" element={<MonitorEditorPage />} />
                    <Route path="/monitors/wall" element={<MonitorWallPage />} />
                    <Route path="/monitors/:id" element={<MonitorDetailPage />} />
                    <Route path="/monitors/:id/edit" element={<MonitorEditorPage />} />
                    <Route path="/platforms" element={<PlatformsPage />} />
                    <Route path="/platforms/:id" element={<PlatformDetailPage />} />
                    <Route path="/records" element={<RecordsPage />} />
                    <Route path="/records/types" element={<RecordTypesPage />} />
                    <Route path="/records/link-types" element={<LinkTypesPage />} />
                    <Route path="/records/:id" element={<RecordDetailPage />} />
                    <Route path="/records/:id/edit" element={<RecordEditorPage />} />
                    <Route path="/services" element={<ServicesPage />} />
                    <Route path="/services/:id" element={<ServiceDetailPage />} />
                    <Route path="/services/:id/:tab" element={<ServiceDetailPage />} />
                    <Route path="/applications" element={<ApplicationsPage />} />
                    <Route path="/applications/cia-scale" element={<CiaScalePage />} />
                    <Route path="/applications/:id" element={<ApplicationDetailPage />} />
                    <Route path="/systems" element={<SystemsPage />} />
                    <Route path="/systems/:id" element={<SystemDetailPage />} />
                    <Route path="/systems/:id/schema" element={<SystemSchemaPage />} />
                    <Route
                      path="/data-contracts"
                      element={
                        <ModuleGate module="dataContracts">
                          <DataContractsPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/data-contracts/new"
                      element={
                        <ModuleGate module="dataContracts">
                          <DataContractNewPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/data-contracts/:id"
                      element={
                        <ModuleGate module="dataContracts">
                          <DataContractDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/data-contracts/:id/:tab"
                      element={
                        <ModuleGate module="dataContracts">
                          <DataContractDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/maintenance" element={<MaintenancePage />} />
                    <Route
                      path="/status-pages"
                      element={
                        <ModuleGate module="statusPages">
                          <StatusPagesPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/status-pages/:id"
                      element={
                        <ModuleGate module="statusPages">
                          <StatusPageViewPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/duties" element={<DutiesPage />} />
                    <Route path="/duties/:id" element={<DutyDetailPage />} />
                    <Route
                      path="/scorecard"
                      element={
                        <ModuleGate module="scorecard">
                          <ScorecardPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/costs"
                      element={
                        <ModuleGate module="costs">
                          <CostsPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/costs/:scope/:id"
                      element={
                        <ModuleGate module="costs">
                          <CostDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/costs/:scope/:id/:tab"
                      element={
                        <ModuleGate module="costs">
                          <CostDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/credentials" element={<CredentialsPage />} />
                    <Route path="/tickets" element={<TicketsPage />} />
                    <Route path="/tickets/:id" element={<TicketDetailPage />} />
                    <Route
                      path="/compliance/controls"
                      element={
                        <ModuleGate module="compliance">
                          <ComplianceControlsPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/compliance/access-changes"
                      element={
                        <ModuleGate module="compliance">
                          <AccessChangesPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/compliance/reconciliation"
                      element={
                        <ModuleGate module="compliance">
                          <AccessReconciliationPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/compliance/person-reviews"
                      element={
                        <ModuleGate module="compliance">
                          <PersonReviewsPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/compliance/person-reviews/:id"
                      element={
                        <ModuleGate module="compliance">
                          <PersonReviewDetailPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/compliance/evidence-packs"
                      element={
                        <ModuleGate module="compliance">
                          <EvidencePacksPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/reports" element={<ReportsPage />} />
                    {/* the plant registry (#218): switched off, its pages say so (U10) */}
                    <Route
                      path="/plant/sites"
                      element={
                        <ModuleGate module="plant">
                          <PlantSitesPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/sites/:siteId"
                      element={
                        <ModuleGate module="plant">
                          <PlantSitePage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/sites/:siteId/network"
                      element={
                        <ModuleGate module="plant">
                          <PlantNetworkPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/sites/:siteId/network/:tab"
                      element={
                        <ModuleGate module="plant">
                          <PlantNetworkPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/sites/:siteId/:tab"
                      element={
                        <ModuleGate module="plant">
                          <PlantSitePage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/assets"
                      element={
                        <ModuleGate module="plant">
                          <PlantAssetsPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/assets/:assetId"
                      element={
                        <ModuleGate module="plant">
                          <PlantAssetPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/assets/:assetId/:tab"
                      element={
                        <ModuleGate module="plant">
                          <PlantAssetPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/import"
                      element={
                        <ModuleGate module="plant">
                          <PlantImportPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/profiles"
                      element={
                        <ModuleGate module="plant">
                          <PlantProfilesPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/profiles/:profileId"
                      element={
                        <ModuleGate module="plant">
                          <PlantProfilePage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/profiles/:profileId/points/:pointId"
                      element={
                        <ModuleGate module="plant">
                          <PlantDataPointPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/kpis"
                      element={
                        <ModuleGate module="plant">
                          <PlantKpisPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/kpis/:kpiId"
                      element={
                        <ModuleGate module="plant">
                          <PlantKpiPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/explore"
                      element={
                        <ModuleGate module="plant">
                          <PlantExplorePage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/checks"
                      element={
                        <ModuleGate module="plant">
                          <PlantChecksPage />
                        </ModuleGate>
                      }
                    />
                    <Route
                      path="/plant/map"
                      element={
                        <ModuleGate module="plant">
                          <PlantMapPage />
                        </ModuleGate>
                      }
                    />
                    {caps.viewAudit && <Route path="/audit" element={<AuditPage />} />}
                    {caps.manageUsers && <Route path="/users" element={<UsersPage />} />}
                    <Route path="/settings" element={<SettingsIndex />} />
                    <Route path="/settings/git-sync" element={<GitSyncPage />} />
                    <Route
                      path="/settings/libraries"
                      element={
                        <ModuleGate module="libraries">
                          <LibraryPublishersPage />
                        </ModuleGate>
                      }
                    />
                    <Route path="/settings/migration" element={<MigrationPage />} />
                    <Route path="/settings/backups" element={<BackupsPage />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route path="/oauth/authorize" element={<OAuthAuthorizePage />} />
                    <Route path="/about" element={<AboutPage />} />
                    {caps.viewAudit && <Route path="/settings/status" element={<SystemStatusPage />} />}
                    <Route path="/settings/:area" element={<SettingsPage browserAvailable={status.browserAvailable} />} />
                    {/* the areas of the sidebar as addresses: their first page */}
                    {Object.entries(AREA_HOME).map(([from, to]) => (
                      <Route key={from} path={from} element={<Navigate to={to} replace />} />
                    ))}
                    <Route path="/admin" element={<Navigate to={caps.manageUsers ? '/users' : caps.viewAudit ? '/audit' : '/profile'} replace />} />
                    <Route path="*" element={notFound} />
                  </Routes>
                )}
              </Suspense>
            </ErrorBoundary>
          </div>
        </AppShell.Main>
      </AppShell>
    </ShellLayoutContext.Provider>
  );
}
