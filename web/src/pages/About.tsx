import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Card, Code, ColorSwatch, Group, ScrollArea, SimpleGrid, Stack, Table, Text, TextInput, Title, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconBook, IconBrandGithub, IconExternalLink, IconFileText, IconLicense, IconRefresh, IconSearch, IconShieldLock, IconApi, IconList } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { BRAND } from '../../../shared/src/brand';
import type { AboutInfo, BuildInfo } from '../../../shared/src/system';
import { get } from '../api';
import { PageHeader } from '../components/common';
import { Logo } from '../components/brand/Logo';
import { usePublicApi } from '../components/PublicApiInfo';
import { WEB_BUILD, shortCommit } from '../buildInfo';
import { fmtDate } from '../format';
import { currentLanguage } from '../i18n';
import { LANGUAGES } from '../i18n/languages';
import { useAppTheme } from '../theme';

interface ThirdPartyPackage {
  name: string;
  version: string;
  license: string;
}

const repo = (p: string) => `${BRAND.repoUrl}/blob/HEAD/${p}`;

/** The two builds differ in version, or (when both know it) in commit: a tab left open across an update. */
export function buildMismatch(web: BuildInfo, server: BuildInfo): boolean {
  if (web.version !== server.version) return true;
  return !!web.commit && !!server.commit && web.commit !== server.commit;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Th scope="row" w={180} fw={500}>
        {label}
      </Table.Th>
      <Table.Td style={{ wordBreak: 'break-word' }}>{children}</Table.Td>
    </Table.Tr>
  );
}

function BuildRows({ build, label, kind }: { build: BuildInfo; label: string; kind: 'web' | 'server' }) {
  const { t } = useTranslation('system');
  const commit = shortCommit(build.commit);
  return (
    <>
      <Row label={t('about.versionOf', { what: label })}>
        <Text span fw={600} data-testid={`version-${kind}`}>
          {build.version}
        </Text>
      </Row>
      <Row label={t('about.commit')}>
        {commit ? (
          <Anchor href={`${BRAND.repoUrl}/commit/${build.commit}`} target="_blank" rel="noopener" ff="monospace" size="sm">
            {commit}
          </Anchor>
        ) : (
          <Text span size="sm" c="dimmed">
            {t('about.development')}
          </Text>
        )}
      </Row>
      <Row label={t('about.buildDate')}>{build.date ? fmtDate(build.date) : <Text span size="sm" c="dimmed">{t('about.development')}</Text>}</Row>
    </>
  );
}

function LinkItem({ href, icon, children }: { href: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Anchor href={href} target="_blank" rel="noopener" size="sm">
      <Group gap={6} wrap="nowrap" component="span">
        {icon}
        <span>{children}</span>
        <IconExternalLink size={12} aria-hidden />
      </Group>
    </Anchor>
  );
}

export function AboutPage() {
  const { t } = useTranslation('system');
  const about = useQuery({ queryKey: ['about'], queryFn: () => get<AboutInfo>('/about'), staleTime: 60000 });
  const publicApi = usePublicApi();
  const theme = useAppTheme();
  const { colorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light');
  const language = LANGUAGES.find((l) => l.code === currentLanguage());
  const server = about.data?.build;
  const mismatch = server ? buildMismatch(WEB_BUILD, server) : false;
  return (
    <>
      <PageHeader title={t('about.title', { brand: BRAND.name })} />
      <Stack maw={860}>
        <Card withBorder>
          <Group wrap="nowrap" align="flex-start" gap="md">
            <Logo size={56} title={BRAND.name} />
            <Stack gap={4} style={{ minWidth: 0 }}>
              <Title order={3}>{BRAND.name}</Title>
              <Text size="sm" c="dimmed">
                {BRAND.tagline}
              </Text>
              {theme.appName && theme.appName !== BRAND.name && (
                <Text size="sm">{t('about.providedAs', { name: theme.appName, brand: BRAND.name })}</Text>
              )}
              <Text size="sm">
                © {BRAND.copyrightYear}{' '}
                <Anchor href={BRAND.authorUrl} target="_blank" rel="noopener" inherit>
                  {BRAND.author}
                </Anchor>
                {' · '}
                <Anchor href={repo('LICENSE')} target="_blank" rel="noopener" inherit>
                  {t('about.license', { license: BRAND.license })}
                </Anchor>
              </Text>
            </Stack>
          </Group>
        </Card>

        {mismatch && (
          <Alert color="orange" variant="light" title={t('about.mismatchTitle')} icon={<IconRefresh size={18} />}>
            <Stack gap="xs" align="flex-start">
              <Text size="sm">{t('about.mismatch', { web: WEB_BUILD.version, server: server!.version })}</Text>
              <Button size="xs" variant="light" color="orange" leftSection={<IconRefresh size={14} />} onClick={() => window.location.reload()}>
                {t('about.reload')}
              </Button>
            </Stack>
          </Alert>
        )}

        <Card withBorder>
          <Title order={5} mb="xs">
            {t('about.versionTitle')}
          </Title>
          <Table.ScrollContainer minWidth={320}>
            <Table verticalSpacing={6}>
              <Table.Tbody>
                <BuildRows build={WEB_BUILD} label={t('about.webUi')} kind="web" />
                {server ? (
                  <BuildRows build={server} label={t('about.server')} kind="server" />
                ) : (
                  <Row label={t('about.server')}>
                    <Text size="sm" c="dimmed">
                      {about.isError ? t('about.serverUnknown') : t('about.loading')}
                    </Text>
                  </Row>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">
            {t('about.linksTitle')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            <LinkItem href={`${BRAND.repoUrl}#readme`} icon={<IconBook size={16} aria-hidden />}>
              {t('about.links.docs')}
            </LinkItem>
            <LinkItem href={`${BRAND.repoUrl}/tree/HEAD/docs`} icon={<IconFileText size={16} aria-hidden />}>
              {t('about.links.guides')}
            </LinkItem>
            <LinkItem href={repo('CHANGELOG.md')} icon={<IconList size={16} aria-hidden />}>
              {t('about.links.changelog')}
            </LinkItem>
            <LinkItem href={repo('SECURITY.md')} icon={<IconShieldLock size={16} aria-hidden />}>
              {t('about.links.security')}
            </LinkItem>
            <LinkItem href={BRAND.repoUrl} icon={<IconBrandGithub size={16} aria-hidden />}>
              {t('about.links.source')}
            </LinkItem>
            <LinkItem href={repo('LICENSE')} icon={<IconLicense size={16} aria-hidden />}>
              {t('about.links.license', { license: BRAND.license })}
            </LinkItem>
            {publicApi.data?.docsUrl && (
              <Anchor href={publicApi.data.docsUrl} target="_blank" rel="noopener" size="sm">
                <Group gap={6} wrap="nowrap" component="span">
                  <IconApi size={16} aria-hidden />
                  <span>{t('about.links.apiDocs')}</span>
                </Group>
              </Anchor>
            )}
          </SimpleGrid>
        </Card>

        <Card withBorder>
          <Title order={5} mb="xs">
            {t('about.settingsTitle')}
          </Title>
          <Table.ScrollContainer minWidth={320}>
            <Table verticalSpacing={6}>
              <Table.Tbody>
                <Row label={t('about.language')}>{language ? `${language.nativeName} (${language.code})` : currentLanguage()}</Row>
                <Row label={t('about.colorScheme')}>
                  {colorScheme === 'auto' ? t('about.schemeAuto', { current: t(`theme.schemes.${computed}`) }) : t(`theme.schemes.${colorScheme}`)}
                </Row>
                <Row label={t('about.theme')}>
                  <Group gap={8} wrap="wrap">
                    <ColorSwatch color={theme.primaryColor} size={16} aria-hidden />
                    <ColorSwatch color={theme.accentColor} size={16} aria-hidden />
                    <Text span size="sm">
                      {theme.custom ? t('about.themeCustom') : t('about.themeDefault', { brand: BRAND.name })}
                    </Text>
                    <Code>{theme.primaryColor}</Code>
                    <Code>{theme.accentColor}</Code>
                  </Group>
                </Row>
                <Row label={t('about.browsers')}>
                  <Text size="sm">{t('about.browserSupport')}</Text>
                </Row>
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>

        <ThirdPartyCard />
      </Stack>
    </>
  );
}

function ThirdPartyCard() {
  const { t } = useTranslation('system');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const list = useQuery({
    queryKey: ['third-party-licenses'],
    enabled: open,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch('/third-party-licenses.json', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as ThirdPartyPackage[];
    },
  });
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list.data ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.license.toLowerCase().includes(q));
  }, [list.data, filter]);
  const byLicense = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of list.data ?? []) m.set(p.license, (m.get(p.license) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list.data]);
  return (
    <Card withBorder>
      <Title order={5}>{t('about.thirdParty.title')}</Title>
      <Text size="sm" c="dimmed" mb="xs">
        {t('about.thirdParty.intro', { brand: BRAND.name })}
      </Text>
      {!open ? (
        <Group>
          <Button variant="light" size="xs" leftSection={<IconLicense size={14} />} onClick={() => setOpen(true)}>
            {t('about.thirdParty.show')}
          </Button>
        </Group>
      ) : list.isError ? (
        <Text size="sm" c="dimmed">
          {t('about.thirdParty.unavailable')}
        </Text>
      ) : (
        <Stack gap="xs">
          <Group gap={6}>
            {byLicense.map(([l, n]) => (
              <Badge key={l} variant="light" color="gray" size="sm" style={{ textTransform: 'none' }}>
                {l}: {n}
              </Badge>
            ))}
          </Group>
          <TextInput
            size="xs"
            maw={320}
            leftSection={<IconSearch size={14} />}
            aria-label={t('about.thirdParty.filter')}
            placeholder={t('about.thirdParty.filter')}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            {t('about.thirdParty.count', { count: rows.length })}
          </Text>
          <ScrollArea.Autosize mah={360} type="auto" viewportProps={{ tabIndex: 0, 'aria-label': t('about.thirdParty.title') }}>
            <Table striped verticalSpacing={4} fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('about.thirdParty.package')}</Table.Th>
                  <Table.Th>{t('about.thirdParty.version')}</Table.Th>
                  <Table.Th>{t('about.thirdParty.license')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((p) => (
                  <Table.Tr key={`${p.name}@${p.version}`}>
                    <Table.Td>
                      <Anchor href={`https://www.npmjs.com/package/${p.name}/v/${p.version}`} target="_blank" rel="noopener" inherit>
                        {p.name}
                      </Anchor>
                    </Table.Td>
                    <Table.Td className="mono">{p.version}</Table.Td>
                    <Table.Td>{p.license}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Stack>
      )}
    </Card>
  );
}
