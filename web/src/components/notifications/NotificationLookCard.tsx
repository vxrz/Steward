import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, ColorInput, Group, Image, Paper, SegmentedControl, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceFloppy, IconEye, IconEyeOff, IconInfoCircle, IconRestore } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  NOTIFICATION_LOGO_SOURCES,
  NOTIFICATION_LOOK_DEFAULTS,
  NOTIFICATION_LOOK_FOOTER_MAX,
  NOTIFICATION_LOOK_NAME_MAX,
  type NotificationLogoSource,
  type NotificationLook,
  type NotificationLookInput,
  type NotificationLookPreview,
} from '@sm/shared';
import { getOptional, notifyError, notifyOk, post, put } from '../../api';

const toDraft = (l: NotificationLook): NotificationLookInput => ({ name: l.name, color: l.color, logoSource: l.logoSource, footer: l.footer });
const validColor = (c: string) => c === '' || /^#[0-9a-fA-F]{6}$/.test(c);

/** Adaptive Card container styles as Teams shows them (light theme). */
const TEAMS_STYLE: Record<string, string> = { good: '#e3f4e6', warning: '#fff3e3', attention: '#fde8e8', accent: '#e5f1fb', default: '#ffffff' };

interface CardPart {
  type?: string;
  style?: string;
  text?: string;
  url?: string;
  items?: CardPart[];
  columns?: CardPart[];
  isSubtle?: boolean;
  weight?: string;
}

/** A rough picture of the Teams card (Teams draws the real one; the preview shows content, logo and strip colour). */
function TeamsPreview({ card }: { card: unknown }) {
  const content = (card as { attachments?: { content?: { body?: CardPart[]; actions?: { title?: string }[] } }[] })?.attachments?.[0]?.content;
  if (!content?.body) return null;
  const [head, ...rest] = content.body;
  const columns = head?.items?.[0]?.columns ?? [];
  const logo = columns.flatMap((c) => c.items ?? []).find((i) => i.type === 'Image')?.url;
  const name = columns.flatMap((c) => c.items ?? []).find((i) => i.type === 'TextBlock')?.text;
  return (
    <Paper withBorder radius="md" style={{ overflow: 'hidden', maxWidth: 420 }}>
      <Group gap="xs" px="sm" py={8} style={{ background: TEAMS_STYLE[head?.style ?? 'default'] ?? TEAMS_STYLE.default }}>
        {logo && <Image src={logo} alt="" h={24} w="auto" fit="contain" />}
        <Text fw={700} size="sm" c="dark.7">
          {name}
        </Text>
      </Group>
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

/** Settings → Notifications → Look (administrators): name, colour, logo and footer of e-mails and Teams messages. */
export function NotificationLookCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['settings', 'notifications', 'look'],
    queryFn: () => getOptional<NotificationLook | null>('/settings/notifications/look', null),
  });
  const [d, setD] = useState<NotificationLookInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<NotificationLookPreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [debounced] = useDebouncedValue(d, 400);

  useEffect(() => {
    if (q.data) setD(toDraft(q.data));
  }, [q.data]);

  useEffect(() => {
    if (!showPreview || !debounced || !validColor(debounced.color)) return;
    let cancelled = false;
    post<NotificationLookPreview>('/settings/notifications/look/preview', debounced)
      .then((p) => !cancelled && setPreview(p))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [debounced, showPreview]);

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

  const logoNote = look.effective.logoProblem && d.logoSource === look.logoSource ? t(`look.logoProblem.${look.effective.logoProblem}`) : null;

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
            swatches={['#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#c2410c', '#862e9c', '#343a40']}
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
              onChange={(v) => setD({ ...d, logoSource: v as NotificationLogoSource })}
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
        {logoNote && (
          <Alert color="yellow" icon={<IconInfoCircle size={16} />}>
            {logoNote}
          </Alert>
        )}
        <Group>
          <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} disabled={!dirty || !validColor(d.color)}>
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
