import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  ColorInput,
  FileButton,
  Group,
  Image,
  Paper,
  Radio,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceFloppy, IconEye, IconEyeOff, IconInfoCircle, IconRestore, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  NOTIFICATION_CORNERS,
  NOTIFICATION_DRY_RUN_DELIVERY,
  NOTIFICATION_FONTS,
  NOTIFICATION_HEADER_STYLES,
  NOTIFICATION_LOGO_ALIGNS,
  NOTIFICATION_LOGO_MAX_BYTES,
  NOTIFICATION_LOGO_SIZES,
  NOTIFICATION_LOGO_SOURCES,
  NOTIFICATION_LOOK_DEFAULTS,
  NOTIFICATION_LOOK_FOOTER_MAX,
  NOTIFICATION_LOOK_NAME_MAX,
  type NotificationLook,
  type NotificationLookInput,
  type NotificationLookPreview,
} from '@sm/shared';
import { api, apiUrl, getOptional, notifyError, notifyOk, post, put } from '../../api';

const KEYS = Object.keys(NOTIFICATION_LOOK_DEFAULTS) as (keyof NotificationLookInput)[];
const toDraft = (l: NotificationLook): NotificationLookInput => Object.fromEntries(KEYS.map((k) => [k, l[k]])) as unknown as NotificationLookInput;
const validColor = (c: string) => c === '' || /^#[0-9a-fA-F]{6}$/.test(c);
const SWATCHES = ['#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#c2410c', '#862e9c', '#343a40'];

/** Adaptive Card container styles as Teams shows them (light theme). */
const TEAMS_STYLE: Record<string, string> = {
  good: '#e3f4e6',
  warning: '#fff3e3',
  attention: '#fde8e8',
  accent: '#e5f1fb',
  emphasis: '#f1f3f5',
  default: '#ffffff',
};

interface CardPart {
  type?: string;
  style?: string;
  text?: string;
  url?: string;
  items?: CardPart[];
  columns?: CardPart[];
  isSubtle?: boolean;
  weight?: string;
  height?: string;
  horizontalAlignment?: string;
}

/** Every element of a card part, depth first (the header holds either a column set or an image and a text). */
const flat = (parts: CardPart[]): CardPart[] => parts.flatMap((p) => [p, ...flat([...(p.items ?? []), ...(p.columns ?? [])])]);

/** A rough picture of the Teams card (Teams draws the real one; the preview shows content, logo and strip colour). */
function TeamsPreview({ card }: { card: unknown }) {
  const content = (card as { attachments?: { content?: { body?: CardPart[]; actions?: { title?: string }[] } }[] })?.attachments?.[0]?.content;
  if (!content?.body) return null;
  const [head, ...rest] = content.body;
  const parts = flat(head?.items ?? []);
  const image = parts.find((i) => i.type === 'Image');
  const name = parts.find((i) => i.type === 'TextBlock')?.text;
  const centred = image?.horizontalAlignment === 'Center' || parts.some((i) => i.type === 'TextBlock' && i.horizontalAlignment === 'Center');
  const h = parseInt(image?.height ?? '24', 10) || 24;
  const Head = centred ? Stack : Group;
  return (
    <Paper withBorder radius="md" style={{ overflow: 'hidden', maxWidth: 420 }}>
      <Head gap="xs" px="sm" py={8} align="center" style={{ background: TEAMS_STYLE[head?.style ?? 'default'] ?? TEAMS_STYLE.default }}>
        {image?.url && <Image src={image.url} alt="" h={h} w="auto" fit="contain" />}
        <Text fw={700} size="sm" c="dark.7">
          {name}
        </Text>
      </Head>
      <Stack gap={4} p="sm" style={{ background: '#ffffff' }}>
        {rest.map((b, i) => (
          <Text key={i} size={b.isSubtle ? 'xs' : 'sm'} c={b.isSubtle ? 'gray.7' : 'dark.7'} fw={b.weight === 'Bolder' ? 600 : 400}>
            {b.text}
          </Text>
        ))}
        {content.actions?.[0]?.title && (
          <Box mt={6}>
            <Text size="sm" c="indigo.7" fw={600}>
              {content.actions[0].title}
            </Text>
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

/** Settings → Notifications → Look (administrators): name, colour, logo, footer and style of e-mails and Teams messages, and dry runs. */
export function NotificationLookCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['settings', 'notifications', 'look'],
    queryFn: () => getOptional<NotificationLook | null>('/settings/notifications/look', null),
  });
  const [d, setD] = useState<NotificationLookInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [logoBusy, setLogoBusy] = useState<'upload' | 'remove' | null>(null);
  const [preview, setPreview] = useState<NotificationLookPreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [sample, setSample] = useState<'test' | 'dryRun'>('test');
  const [debounced] = useDebouncedValue(d, 400);

  // take the saved settings into the form when they load or change – not when only the own logo changes,
  // so uploading a logo keeps unsaved choices
  const applied = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!q.data) return;
    const version = `${q.data.updatedAt ?? ''}|${JSON.stringify(toDraft(q.data))}`;
    if (applied.current === version) return;
    applied.current = version;
    setD(toDraft(q.data));
  }, [q.data]);

  useEffect(() => {
    if (!showPreview || !debounced || !validColor(debounced.color) || !validColor(debounced.buttonColor)) return;
    let cancelled = false;
    post<NotificationLookPreview>('/settings/notifications/look/preview', { ...debounced, sample })
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
    // the logo is part of the preview: refresh it when an own logo is uploaded or removed
  }, [debounced, showPreview, sample, q.data?.customLogo?.updatedAt, q.data?.customLogo]);

  if (!q.data || !d) return null;
  const look = q.data;
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(look));
  const isDefault = JSON.stringify(d) === JSON.stringify(NOTIFICATION_LOOK_DEFAULTS);

  const save = async () => {
    setBusy(true);
    try {
      const next = await put<NotificationLook>('/settings/notifications/look', d);
      qc.setQueryData(['settings', 'notifications', 'look'], next);
      notifyOk(t('look.saved'));
    } catch (e) {
      notifyError(e, t('notify.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const uploadLogo = async (file: File | null) => {
    if (!file) return;
    if (file.size > NOTIFICATION_LOGO_MAX_BYTES) {
      notifyError(new Error(t('look.logoTooLarge')), t('look.logoNotUploaded'));
      return;
    }
    setLogoBusy('upload');
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const next = await api<NotificationLook>('POST', '/settings/notifications/look/logo', form);
      qc.setQueryData(['settings', 'notifications', 'look'], next);
      notifyOk(t('look.logoUploaded'));
    } catch (e) {
      notifyError(e, t('look.logoNotUploaded'));
    } finally {
      setLogoBusy(null);
    }
  };

  const removeLogo = async () => {
    setLogoBusy('remove');
    try {
      const next = await api<NotificationLook>('DELETE', '/settings/notifications/look/logo');
      qc.setQueryData(['settings', 'notifications', 'look'], next);
      notifyOk(t('look.logoRemoved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setLogoBusy(null);
    }
  };

  // the problem of the saved choice; an own logo that is missing has its own hint
  const problem = look.effective.logoProblem && d.logoSource === look.logoSource ? look.effective.logoProblem : null;
  const logoNote = problem ? t(problem === 'missing' && d.logoSource === 'custom' ? 'look.logoProblem.missingCustom' : `look.logoProblem.${problem}`) : null;
  const custom = look.customLogo;
  /** A segmented choice of one style field. */
  const choice = (key: keyof NotificationLookInput, label: string, data: { value: string; label: string }[]) => (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <SegmentedControl aria-label={label} value={d[key]} onChange={(v) => setD({ ...d, [key]: v })} data={data} />
    </Stack>
  );

  return (
    <Card withBorder>
      <Title order={5}>{t('look.title')}</Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('look.intro')}
      </Text>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('look.name')}
            description={t('look.nameHint', { name: look.effective.name })}
            placeholder={look.effective.name}
            maxLength={NOTIFICATION_LOOK_NAME_MAX}
            value={d.name}
            onChange={(e) => setD({ ...d, name: e.currentTarget.value })}
          />
          <ColorInput
            eyeDropperButtonProps={{ 'aria-label': t('look.eyeDropper') }}
            label={t('look.color')}
            description={t('look.colorHint')}
            placeholder={look.effective.color}
            format="hex"
            swatches={SWATCHES}
            value={d.color}
            error={validColor(d.color) ? undefined : t('look.colorInvalid')}
            onChange={(v) => setD({ ...d, color: v })}
          />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              {t('look.logo')}
            </Text>
            <SegmentedControl
              aria-label={t('look.logo')}
              value={d.logoSource}
              onChange={(v) => setD({ ...d, logoSource: v as NotificationLookInput['logoSource'] })}
              data={NOTIFICATION_LOGO_SOURCES.map((s) => ({ value: s, label: t(`look.logoSource.${s}`) }))}
            />
            <Text size="xs" c="dimmed">
              {t('look.logoHint')}
            </Text>
          </Stack>
          <TextInput
            label={t('look.footer')}
            description={t('look.footerHint')}
            maxLength={NOTIFICATION_LOOK_FOOTER_MAX}
            value={d.footer}
            onChange={(e) => setD({ ...d, footer: e.currentTarget.value })}
          />
        </SimpleGrid>
        {d.logoSource === 'custom' && (
          <Group align="flex-start" wrap="nowrap" gap="md">
            <Paper withBorder p="xs" w={132} h={84} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {custom ? (
                <Image
                  src={apiUrl(`/settings/notifications/look/logo?v=${encodeURIComponent(custom.updatedAt ?? '')}`)}
                  alt={t('look.customLogo')}
                  fit="contain"
                  mah={64}
                  maw={112}
                />
              ) : (
                <Text size="xs" c="dimmed" ta="center">
                  {t('look.customLogoNone')}
                </Text>
              )}
            </Paper>
            <Stack gap={6}>
              <Text size="sm">
                {t('look.customLogo')}
                {custom && (
                  <Text span size="sm" c="dimmed">
                    {' · '}
                    {t('look.customLogoInfo', { type: custom.mime === 'image/png' ? 'PNG' : 'JPEG', size: Math.max(1, Math.round(custom.size / 1024)) })}
                  </Text>
                )}
              </Text>
              <Text size="xs" c="dimmed">
                {t('look.customLogoHint')}
              </Text>
              <Group gap="xs">
                <FileButton onChange={uploadLogo} accept="image/png,image/jpeg">
                  {(props) => (
                    <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={logoBusy === 'upload'}>
                      {custom ? t('look.replaceLogo') : t('look.uploadLogo')}
                    </Button>
                  )}
                </FileButton>
                {custom && (
                  <Button size="xs" variant="subtle" color="gray" leftSection={<IconTrash size={14} />} loading={logoBusy === 'remove'} onClick={removeLogo}>
                    {t('look.removeLogo')}
                  </Button>
                )}
              </Group>
            </Stack>
          </Group>
        )}
        {logoNote && (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            {logoNote}
          </Alert>
        )}
        <Stack gap={4}>
          <Title order={6}>{t('look.styleTitle')}</Title>
          <Text size="xs" c="dimmed">
            {t('look.styleHint')}
          </Text>
        </Stack>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {choice(
            'logoSize',
            t('look.logoSize'),
            NOTIFICATION_LOGO_SIZES.map((v) => ({ value: v, label: t(`look.logoSizes.${v}`) })),
          )}
          {choice(
            'logoAlign',
            t('look.logoAlign'),
            NOTIFICATION_LOGO_ALIGNS.map((v) => ({ value: v, label: t(`look.logoAligns.${v}`) })),
          )}
          {choice(
            'headerStyle',
            t('look.headerStyle'),
            NOTIFICATION_HEADER_STYLES.map((v) => ({ value: v, label: t(`look.headerStyles.${v}`) })),
          )}
          {choice(
            'corners',
            t('look.corners'),
            NOTIFICATION_CORNERS.map((v) => ({ value: v, label: t(`look.cornerStyles.${v}`) })),
          )}
          {choice(
            'font',
            t('look.font'),
            NOTIFICATION_FONTS.map((v) => ({ value: v, label: t(`look.fonts.${v}`) })),
          )}
          <ColorInput
            eyeDropperButtonProps={{ 'aria-label': t('look.eyeDropper') }}
            label={t('look.buttonColor')}
            description={t('look.buttonColorHint')}
            placeholder={d.color || look.effective.color}
            format="hex"
            swatches={SWATCHES}
            value={d.buttonColor}
            error={validColor(d.buttonColor) ? undefined : t('look.colorInvalid')}
            onChange={(v) => setD({ ...d, buttonColor: v })}
          />
        </SimpleGrid>
        <Radio.Group
          label={t('look.dryRunTitle')}
          description={t('look.dryRunHint')}
          value={d.dryRunDelivery}
          onChange={(v) => setD({ ...d, dryRunDelivery: v as NotificationLookInput['dryRunDelivery'] })}
        >
          <Stack gap={6} mt={6}>
            {NOTIFICATION_DRY_RUN_DELIVERY.map((v) => (
              <Radio key={v} value={v} label={t(`look.dryRunDelivery.${v}`)} />
            ))}
          </Stack>
        </Radio.Group>
        <Group>
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            onClick={save}
            loading={busy}
            disabled={!dirty || !validColor(d.color) || !validColor(d.buttonColor)}
          >
            {t('look.save')}
          </Button>
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconRestore size={16} />}
            disabled={isDefault}
            onClick={() => setD({ ...NOTIFICATION_LOOK_DEFAULTS })}
          >
            {t('look.reset')}
          </Button>
          <Button
            variant="light"
            leftSection={showPreview ? <IconEyeOff size={16} /> : <IconEye size={16} />}
            onClick={() => setShowPreview(!showPreview)}
            aria-expanded={showPreview}
          >
            {showPreview ? t('look.hidePreview') : t('look.showPreview')}
          </Button>
          <Text size="xs" c="dimmed">
            {t('look.testHint')}
          </Text>
        </Group>
        {showPreview && (
          <SegmentedControl
            aria-label={t('look.previewSample')}
            w="fit-content"
            value={sample}
            onChange={(v) => setSample(v as 'test' | 'dryRun')}
            data={(['test', 'dryRun'] as const).map((v) => ({ value: v, label: t(`look.previewSamples.${v}`) }))}
          />
        )}
        {showPreview && preview && (
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('look.previewEmail')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('look.subject', { subject: preview.subject })}
              </Text>
              {/* sandboxed: the preview document can neither run scripts nor navigate the app */}
              <iframe
                title={t('look.previewEmail')}
                sandbox=""
                srcDoc={preview.html}
                style={{ width: '100%', height: 360, border: '1px solid var(--mantine-color-default-border)', borderRadius: 6, background: '#f1f3f5' }}
              />
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('look.previewTeams')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('look.previewTeamsHint')}
              </Text>
              <TeamsPreview card={preview.teams} />
            </Stack>
          </SimpleGrid>
        )}
      </Stack>
    </Card>
  );
}
