import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  ColorInput,
  FileButton,
  Group,
  Image,
  NavLink,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconInfoCircle, IconLayoutDashboard, IconPalette, IconRestore, IconServer, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { BRAND } from '../../../../shared/src/brand';
import {
  THEME_APP_NAME_MAX,
  THEME_LOGO_MAX_BYTES,
  THEME_LOGO_TYPES,
  normalizeHex,
  themeContrastNotes,
  themeCssVariables,
  type ColorSchemeName,
  type ThemeColorScheme,
  type ThemeContrastNote,
  type ThemeInput,
  type ThemeRadius,
  type ThemeSettings,
} from '../../../../shared/src/theme';
import { ApiError, api, getOptional, notifyError, notifyOk, put, post } from '../../api';
import { errorText } from '../../i18n/errors';
import { themeQueryKey } from '../../theme';
import { Logo } from '../brand/Logo';
import { fmtDate, fmtNumber } from '../../format';
import { confirmDanger } from '../confirm';

const SWATCHES = ['#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#e30613', '#7950f2', '#ffd400', '#343a40'];

/** Scheme-dependent Mantine variables, so a preview pane can show the other colour scheme too. */
const SCHEME_BASE: Record<ColorSchemeName, Record<string, string>> = {
  light: {
    '--mantine-color-body': '#ffffff',
    '--mantine-color-text': '#000000',
    '--mantine-color-bright': '#000000',
    '--mantine-color-dimmed': '#5c636a',
    '--mantine-color-default': '#ffffff',
    '--mantine-color-default-hover': '#f8f9fa',
    '--mantine-color-default-color': '#000000',
    '--mantine-color-default-border': '#ced4da',
  },
  dark: {
    '--mantine-color-body': '#242424',
    '--mantine-color-text': '#c9c9c9',
    '--mantine-color-bright': '#ffffff',
    '--mantine-color-dimmed': '#b8b8b8',
    '--mantine-color-default': '#2e2e2e',
    '--mantine-color-default-hover': '#3b3b3b',
    '--mantine-color-default-color': '#ffffff',
    '--mantine-color-default-border': '#424242',
  },
};

type Draft = ThemeInput;
const draftOf = (s: ThemeSettings): Draft => ({
  primaryColor: s.primaryColor,
  accentColor: s.accentColor,
  colorScheme: s.colorScheme,
  radius: s.radius,
  appName: s.appName,
});
const same = (a: Draft, b: Draft) => (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);

/** Settings → Appearance (administrators): colours, default colour scheme, corner radius, display name and logo. */
export function ThemeSettingsCard() {
  const { t } = useTranslation('system');
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['settings', 'theme'], queryFn: () => getOptional<ThemeSettings | null>('/settings/theme', null) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(draftOf(settings.data));
  }, [settings.data]);
  const primary = draft ? normalizeHex(draft.primaryColor) : null;
  const accent = draft ? normalizeHex(draft.accentColor) : null;
  const valid = !!primary && !!accent;
  const notes = useMemo(() => (primary && accent ? themeContrastNotes({ primaryColor: primary, accentColor: accent }) : []), [primary, accent]);
  if (!settings.data || !draft) return null;
  const s = settings.data;
  const dirty = !same(draft, draftOf(s));

  const applied = (next: ThemeSettings) => {
    qc.setQueryData(['settings', 'theme'], next);
    // everybody's tabs pick the change up on their next poll; this one at once
    void qc.invalidateQueries({ queryKey: themeQueryKey });
  };
  const run = async (key: string, fn: () => Promise<ThemeSettings>, ok: string) => {
    setBusy(key);
    try {
      applied(await fn());
      notifyOk(ok);
    } catch (e) {
      notifyError(new Error(themeError(e, t)));
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run(
      'save',
      () => put<ThemeSettings>('/settings/theme', { ...draft, primaryColor: primary, accentColor: accent, appName: draft.appName.trim() }),
      t('theme.saved'),
    );
  const reset = async () => {
    if (!(await confirmDanger({ action: 'reset', message: t('theme.resetConfirm', { brand: BRAND.name }) }))) return;
    void run('reset', () => post<ThemeSettings>('/settings/theme/reset'), t('theme.resetDone', { brand: BRAND.name }));
  };
  const upload = (file: File | null) => {
    if (!file) return;
    if (file.size > THEME_LOGO_MAX_BYTES) return notifyError(new Error(t('theme.errors.THEME_LOGO_TOO_LARGE')), t('theme.logoNotUploaded'));
    const form = new FormData();
    form.append('file', file, file.name);
    void run('logo', () => api<ThemeSettings>('POST', '/settings/theme/logo', form), t('theme.logoUploaded'));
  };
  const removeLogo = () => run('removeLogo', () => api<ThemeSettings>('DELETE', '/settings/theme/logo'), t('theme.logoRemoved'));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });
  const logoUrl = s.logo ? `/api/theme/logo?v=${s.logo.sha256.slice(0, 16)}` : null;

  return (
    <Card withBorder>
      <Group gap="xs" wrap="nowrap">
        <IconPalette size={18} aria-hidden />
        <Title order={5}>{t('theme.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('theme.intro')}
      </Text>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <ColorInput
            eyeDropperButtonProps={{ 'aria-label': t('theme.eyeDropper') }}
            label={t('theme.primary')}
            description={t('theme.primaryHint')}
            format="hex"
            swatches={SWATCHES}
            value={draft.primaryColor}
            error={primary ? undefined : t('theme.invalidColor')}
            onChange={(v) => set('primaryColor', v)}
          />
          <ColorInput
            eyeDropperButtonProps={{ 'aria-label': t('theme.eyeDropper') }}
            label={t('theme.accent')}
            description={t('theme.accentHint')}
            format="hex"
            swatches={SWATCHES}
            value={draft.accentColor}
            error={accent ? undefined : t('theme.invalidColor')}
            onChange={(v) => set('accentColor', v)}
          />
        </SimpleGrid>
        {notes.length > 0 && <ContrastNotes notes={notes} />}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Stack gap={4}>
            <Text size="sm" fw={500} id="theme-scheme-label">
              {t('theme.colorScheme')}
            </Text>
            <SegmentedControl
              aria-labelledby="theme-scheme-label"
              fullWidth
              value={draft.colorScheme}
              onChange={(v) => set('colorScheme', v as ThemeColorScheme)}
              data={[
                { value: 'auto', label: t('theme.schemes.auto') },
                { value: 'light', label: t('theme.schemes.light') },
                { value: 'dark', label: t('theme.schemes.dark') },
              ]}
            />
            <Text size="xs" c="dimmed">
              {t('theme.colorSchemeHint')}
            </Text>
          </Stack>
          <Stack gap={4}>
            <Text size="sm" fw={500} id="theme-radius-label">
              {t('theme.radius')}
            </Text>
            <SegmentedControl
              aria-labelledby="theme-radius-label"
              fullWidth
              value={draft.radius}
              onChange={(v) => set('radius', v as ThemeRadius)}
              data={[
                { value: 'sm', label: t('theme.radii.sm') },
                { value: 'md', label: t('theme.radii.md') },
                { value: 'lg', label: t('theme.radii.lg') },
              ]}
            />
          </Stack>
        </SimpleGrid>
        <TextInput
          label={t('theme.appName')}
          description={t('theme.appNameHint', { brand: BRAND.name })}
          placeholder={BRAND.name}
          maxLength={THEME_APP_NAME_MAX}
          value={draft.appName}
          onChange={(e) => set('appName', e.currentTarget.value)}
        />
        <Group align="flex-start" wrap="nowrap" gap="md">
          <Paper withBorder p="xs" w={132} h={64} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            {logoUrl ? (
              <Image src={logoUrl} alt={t('theme.logoAlt')} fit="contain" mah={44} maw={112} />
            ) : (
              <Logo size={40} title={t('theme.defaultLogo', { brand: BRAND.name })} />
            )}
          </Paper>
          <Stack gap={6} style={{ minWidth: 0 }}>
            <Text size="sm">
              {s.logo ? t('theme.customLogo', { width: s.logo.width, height: s.logo.height }) : t('theme.defaultLogo', { brand: BRAND.name })}
            </Text>
            <Text size="xs" c="dimmed">
              {t('theme.logoHint', { kb: THEME_LOGO_MAX_BYTES / 1024 })}
            </Text>
            <Group gap="xs">
              <FileButton onChange={upload} accept={THEME_LOGO_TYPES.join(',')}>
                {(props) => (
                  <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={busy === 'logo'}>
                    {t('theme.uploadLogo')}
                  </Button>
                )}
              </FileButton>
              {s.logo && (
                <Button size="xs" variant="subtle" color="gray" leftSection={<IconTrash size={14} />} loading={busy === 'removeLogo'} onClick={removeLogo}>
                  {t('theme.removeLogo')}
                </Button>
              )}
            </Group>
          </Stack>
        </Group>
        {valid && (
          <Box>
            <Text size="sm" fw={500} mb={4}>
              {t('theme.preview')}
            </Text>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
              {(['light', 'dark'] as const).map((scheme) => (
                <ThemePreview key={scheme} scheme={scheme} theme={{ ...draft, primaryColor: primary!, accentColor: accent! }} logoUrl={logoUrl} />
              ))}
            </SimpleGrid>
          </Box>
        )}
        <Group justify="space-between">
          <Group gap="xs">
            <Button onClick={save} loading={busy === 'save'} disabled={!valid || !dirty}>
              {t('theme.save')}
            </Button>
            {dirty && (
              <Button variant="default" onClick={() => setDraft(draftOf(s))}>
                {t('theme.discard')}
              </Button>
            )}
          </Group>
          <Button variant="subtle" color="gray" leftSection={<IconRestore size={16} />} loading={busy === 'reset'} onClick={reset}>
            {t('theme.reset', { brand: BRAND.name })}
          </Button>
        </Group>
        {s.updatedAt && (
          <Text size="xs" c="dimmed">
            {t('theme.lastChange', { when: fmtDate(s.updatedAt), who: s.updatedBy ?? '–' })}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function themeError(e: unknown, t: ReturnType<typeof useTranslation<'system'>>['t']): string {
  if (e instanceof ApiError && e.code?.startsWith('THEME_')) {
    const key = `theme.errors.${e.code}` as 'theme.errors.THEME_LOGO_TYPE';
    const text = t(key, { kb: THEME_LOGO_MAX_BYTES / 1024, defaultValue: '' });
    if (text) return text;
  }
  return errorText(e);
}

function ContrastNotes({ notes }: { notes: ThemeContrastNote[] }) {
  const { t } = useTranslation('system');
  const warning = notes.some((n) => n.kind === 'lowSurfaceContrast');
  return (
    <Alert
      variant="light"
      color={warning ? 'orange' : 'gray'}
      icon={warning ? <IconAlertTriangle size={18} /> : <IconInfoCircle size={18} />}
      title={t('theme.contrast.title')}
      p="xs"
    >
      <Stack gap={2}>
        {notes.map((n, i) => (
          <Text size="xs" key={i}>
            {t(`theme.contrast.${n.kind}`, {
              color: t(`theme.colors.${n.color}`),
              scheme: t(`theme.schemes.${n.scheme}`),
              used: n.used,
              ratio: fmtNumber(n.ratio, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            })}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}

/** A small page in the draft theme: header, navigation, buttons, badges, a link and an alert. */
function ThemePreview({ scheme, theme, logoUrl }: { scheme: ColorSchemeName; theme: ThemeInput; logoUrl: string | null }) {
  const { t } = useTranslation('system');
  const style = {
    ...SCHEME_BASE[scheme],
    ...themeCssVariables(theme, scheme),
    '--mantine-radius-default': `var(--mantine-radius-${theme.radius})`,
    background: 'var(--mantine-color-body)',
    color: 'var(--mantine-color-text)',
    colorScheme: scheme,
  } as CSSProperties;
  const name = theme.appName.trim() || BRAND.name;
  return (
    <Paper withBorder p="sm" style={style} role="group" aria-label={t('theme.previewOf', { scheme: t(`theme.schemes.${scheme}`) })} data-theme-preview={scheme}>
      <Group gap={8} wrap="nowrap" mb="xs">
        {logoUrl ? <img src={logoUrl} alt="" style={{ height: 22, width: 'auto', maxWidth: 88, objectFit: 'contain' }} /> : <Logo size={22} />}
        <Text fw={700} size="sm" truncate>
          {name}
        </Text>
        <Text size="xs" c="dimmed" ml="auto">
          {t(`theme.schemes.${scheme}`)}
        </Text>
      </Group>
      <Stack gap={6}>
        <Box>
          <NavLink
            component="div"
            label={t('theme.sample.navActive')}
            leftSection={<IconLayoutDashboard size={16} />}
            active
            style={{ borderRadius: 'var(--mantine-radius-default)' }}
          />
          <NavLink
            component="div"
            label={t('theme.sample.nav')}
            leftSection={<IconServer size={16} />}
            style={{ borderRadius: 'var(--mantine-radius-default)' }}
          />
        </Box>
        <Group gap={6}>
          <Button size="xs" tabIndex={-1}>
            {t('theme.sample.primary')}
          </Button>
          <Button size="xs" variant="light" tabIndex={-1}>
            {t('theme.sample.light')}
          </Button>
          <Button size="xs" variant="outline" tabIndex={-1}>
            {t('theme.sample.outline')}
          </Button>
          <Button size="xs" color="accent" tabIndex={-1}>
            {t('theme.sample.accent')}
          </Button>
        </Group>
        <Group gap={6}>
          <Badge>{t('theme.sample.badge')}</Badge>
          <Badge variant="light">{t('theme.sample.badgeLight')}</Badge>
          <Badge color="accent" circle>
            3
          </Badge>
          <Badge color="accent" variant="light">
            {t('theme.sample.accentLight')}
          </Badge>
        </Group>
        <Text size="sm">
          {t('theme.sample.text')}{' '}
          <Anchor href="#" onClick={(e) => e.preventDefault()} tabIndex={-1}>
            {t('theme.sample.link')}
          </Anchor>
        </Text>
        {/* (the message colour of Mantine's alert follows the page's colour scheme, not the preview's) */}
        <Alert variant="light" color="brand" p="xs" title={t('theme.sample.alertTitle')} styles={{ message: { color: 'var(--mantine-color-text)' } }}>
          <Text size="xs">{t('theme.sample.alert')}</Text>
        </Alert>
      </Stack>
    </Paper>
  );
}
