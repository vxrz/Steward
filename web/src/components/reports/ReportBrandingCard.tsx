import { useEffect, useState } from 'react';
import { Button, Card, ColorInput, FileButton, Group, Image, Paper, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEye, IconRestore, IconUpload } from '@tabler/icons-react';
import { REPORT_LANGS, REPORT_LOGO_MAX_BYTES, type ReportBranding, type ReportLang } from '@sm/shared';
import { useTranslation } from 'react-i18next';
import { BRAND } from '../../../../shared/src/brand';
import { api, getOptional, notifyError, notifyOk, put, apiUrl, authHeaders } from '../../api';
import { browserTimeZone, reportLangName } from './RunReports';
import { withBase } from '../../basePath';

type Draft = Pick<ReportBranding, 'companyName' | 'accentColor' | 'classification' | 'footerNote'>;

/** Settings → Report branding (administrators): company name, logo, colour, classification, footer note. */
export function ReportBrandingCard() {
  const { t } = useTranslation('reports');
  const brand = BRAND.name;
  const qc = useQueryClient();
  const branding = useQuery({ queryKey: ['report-branding'], queryFn: () => getOptional<ReportBranding | null>('/reports/branding', null) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (branding.data)
      setDraft({
        companyName: branding.data.companyName,
        accentColor: branding.data.accentColor,
        classification: branding.data.classification,
        footerNote: branding.data.footerNote,
      });
  }, [branding.data]);
  if (!branding.data || !draft) return null;
  const b = branding.data;
  const logoUrl = apiUrl(`/reports/branding/logo?v=${encodeURIComponent(b.logoUpdatedAt ?? 'default')}`);
  const validColor = /^#[0-9a-fA-F]{6}$/.test(draft.accentColor);

  const save = async () => {
    setBusy('save');
    try {
      const next = await put<ReportBranding>('/reports/branding', draft);
      qc.setQueryData(['report-branding'], next);
      notifyOk(t('branding.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    if (file.size > REPORT_LOGO_MAX_BYTES) {
      notifyError(new Error(t('branding.logoTooLarge')), t('branding.logoNotUploaded'));
      return;
    }
    setBusy('logo');
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const next = await api<ReportBranding>('POST', '/reports/branding/logo', form);
      qc.setQueryData(['report-branding'], next);
      notifyOk(t('branding.logoUploaded'));
    } catch (e) {
      notifyError(e, t('branding.logoNotUploaded'));
    } finally {
      setBusy(null);
    }
  };

  const resetLogo = async () => {
    setBusy('reset');
    try {
      const next = await api<ReportBranding>('DELETE', '/reports/branding/logo');
      qc.setQueryData(['report-branding'], next);
      notifyOk(t('branding.logoReset', { brand }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  /** Sample PDF with the current (unsaved) settings. */
  const preview = async (lang: ReportLang) => {
    setBusy(`preview-${lang}`);
    try {
      const res = await fetch(withBase('/api/reports/branding/preview'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ ...draft, lang, timeZone: browserTimeZone() }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `report-preview-${lang}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      notifyError(e, t('branding.previewFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card withBorder>
      <Title order={5}>{t('branding.title')}</Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('branding.intro')}
      </Text>
      <Stack>
        <Group align="flex-start" wrap="nowrap" gap="md">
          <Paper withBorder p="xs" w={132} h={84} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Image src={logoUrl} alt={t('branding.logoAlt')} fit="contain" mah={64} maw={112} />
          </Paper>
          <Stack gap={6}>
            <Text size="sm">{b.customLogo ? t('branding.customLogo') : t('branding.defaultLogo', { brand })}</Text>
            <Text size="xs" c="dimmed">
              {t('branding.logoHint')}
            </Text>
            <Group gap="xs">
              <FileButton onChange={upload} accept="image/png,image/jpeg">
                {(props) => (
                  <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={busy === 'logo'}>
                    {t('branding.uploadLogo')}
                  </Button>
                )}
              </FileButton>
              {b.customLogo && (
                <Button size="xs" variant="subtle" color="gray" leftSection={<IconRestore size={14} />} loading={busy === 'reset'} onClick={resetLogo}>
                  {t('branding.useDefaultLogo', { brand })}
                </Button>
              )}
            </Group>
          </Stack>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('branding.companyName')}
            description={t('branding.companyNameHint', { brand })}
            maxLength={120}
            value={draft.companyName}
            onChange={(e) => setDraft({ ...draft, companyName: e.currentTarget.value })}
          />
          <ColorInput
            eyeDropperButtonProps={{ 'aria-label': t('branding.eyeDropper') }}
            label={t('branding.accent')}
            description={t('branding.accentHint')}
            format="hex"
            swatches={['#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#c2410c', '#862e9c', '#343a40']}
            value={draft.accentColor}
            error={validColor ? undefined : t('branding.accentInvalid')}
            onChange={(v) => setDraft({ ...draft, accentColor: v })}
          />
          <TextInput
            label={t('branding.classification')}
            description={t('branding.classificationHint')}
            maxLength={60}
            value={draft.classification}
            onChange={(e) => setDraft({ ...draft, classification: e.currentTarget.value })}
          />
          <TextInput
            label={t('branding.footerNote')}
            description={t('branding.footerNoteHint')}
            maxLength={200}
            value={draft.footerNote}
            onChange={(e) => setDraft({ ...draft, footerNote: e.currentTarget.value })}
          />
        </SimpleGrid>
        <Group>
          <Button onClick={save} loading={busy === 'save'} disabled={!validColor}>
            {t('branding.save')}
          </Button>
          {REPORT_LANGS.map((lang) => (
            <Button
              key={lang}
              variant="default"
              leftSection={<IconEye size={16} />}
              loading={busy === `preview-${lang}`}
              disabled={!validColor}
              onClick={() => preview(lang)}
            >
              {t('branding.preview', { language: reportLangName(lang) })}
            </Button>
          ))}
        </Group>
      </Stack>
    </Card>
  );
}
