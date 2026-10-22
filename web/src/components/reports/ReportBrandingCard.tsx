import { useEffect, useState } from 'react';
import { Button, Card, ColorInput, FileButton, Group, Image, Paper, SimpleGrid, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEye, IconRestore, IconUpload } from '@tabler/icons-react';
import { REPORT_LOGO_MAX_BYTES, type ReportBranding, type ReportLang } from '@sm/shared';
import { api, getOptional, notifyError, notifyOk, put } from '../../api';
import { browserTimeZone } from './RunReports';

type Draft = Pick<ReportBranding, 'companyName' | 'accentColor' | 'classification' | 'footerNote'>;

/** Settings → Report branding (administrators): company name, logo, colour, classification, footer note. */
export function ReportBrandingCard() {
  const qc = useQueryClient();
  const branding = useQuery({ queryKey: ['report-branding'], queryFn: () => getOptional<ReportBranding | null>('/reports/branding', null) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (branding.data) setDraft({ companyName: branding.data.companyName, accentColor: branding.data.accentColor, classification: branding.data.classification, footerNote: branding.data.footerNote });
  }, [branding.data]);
  if (!branding.data || !draft) return null;
  const b = branding.data;
  const logoUrl = `/api/reports/branding/logo?v=${encodeURIComponent(b.logoUpdatedAt ?? 'default')}`;
  const validColor = /^#[0-9a-fA-F]{6}$/.test(draft.accentColor);

  const save = async () => {
    setBusy('save');
    try {
      const next = await put<ReportBranding>('/reports/branding', draft);
      qc.setQueryData(['report-branding'], next);
      notifyOk('Report branding saved');
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | null) => {
    if (!file) return;
    if (file.size > REPORT_LOGO_MAX_BYTES) {
      notifyError(new Error('The logo must not be larger than 1 MB.'), 'Logo not uploaded');
      return;
    }
    setBusy('logo');
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const next = await api<ReportBranding>('POST', '/reports/branding/logo', form);
      qc.setQueryData(['report-branding'], next);
      notifyOk('Logo uploaded');
    } catch (e) {
      notifyError(e, 'Logo not uploaded');
    } finally {
      setBusy(null);
    }
  };

  const resetLogo = async () => {
    setBusy('reset');
    try {
      const next = await api<ReportBranding>('DELETE', '/reports/branding/logo');
      qc.setQueryData(['report-branding'], next);
      notifyOk('The Steward logo is used again');
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
      const res = await fetch('/api/reports/branding/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
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
      notifyError(e, 'Preview failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card withBorder>
      <Title order={5}>Report branding</Title>
      <Text size="sm" c="dimmed" mb="sm">
        Used for all new PDF reports (run reports and summaries). Reports that were already generated are not changed.
      </Text>
      <Stack>
        <Group align="flex-start" wrap="nowrap" gap="md">
          <Paper withBorder p="xs" w={132} h={84} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Image src={logoUrl} alt="Report logo" fit="contain" mah={64} maw={112} />
          </Paper>
          <Stack gap={6}>
            <Text size="sm">{b.customLogo ? 'Custom logo' : 'Default: Steward logo'}</Text>
            <Text size="xs" c="dimmed">
              PNG or JPEG, up to 1 MB. A wide logo with a transparent background works best.
            </Text>
            <Group gap="xs">
              <FileButton onChange={upload} accept="image/png,image/jpeg">
                {(props) => (
                  <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} loading={busy === 'logo'}>
                    Upload logo
                  </Button>
                )}
              </FileButton>
              {b.customLogo && (
                <Button size="xs" variant="subtle" color="gray" leftSection={<IconRestore size={14} />} loading={busy === 'reset'} onClick={resetLogo}>
                  Use Steward logo
                </Button>
              )}
            </Group>
          </Stack>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Company name"
            description="Shown next to the logo. Empty: Steward"
            maxLength={120}
            value={draft.companyName}
            onChange={(e) => setDraft({ ...draft, companyName: e.currentTarget.value })}
          />
          <ColorInput
            label="Accent colour"
            description="Lines, headings and highlights"
            format="hex"
            swatches={['#1c7ed6', '#0b7285', '#2f9e44', '#e8590c', '#c2410c', '#862e9c', '#343a40']}
            value={draft.accentColor}
            error={validColor ? undefined : 'Use a hex colour like #1c7ed6'}
            onChange={(v) => setDraft({ ...draft, accentColor: v })}
          />
          <TextInput
            label="Default classification"
            description="Printed on every page, e.g. Internal or Confidential. It can be changed per report."
            maxLength={60}
            value={draft.classification}
            onChange={(e) => setDraft({ ...draft, classification: e.currentTarget.value })}
          />
          <TextInput
            label="Footer note"
            description="Optional, e.g. Confidential – for internal use only"
            maxLength={200}
            value={draft.footerNote}
            onChange={(e) => setDraft({ ...draft, footerNote: e.currentTarget.value })}
          />
        </SimpleGrid>
        <Group>
          <Button onClick={save} loading={busy === 'save'} disabled={!validColor}>
            Save branding
          </Button>
          <Button variant="default" leftSection={<IconEye size={16} />} loading={busy === 'preview-en'} disabled={!validColor} onClick={() => preview('en')}>
            Preview (English)
          </Button>
          <Button variant="default" leftSection={<IconEye size={16} />} loading={busy === 'preview-de'} disabled={!validColor} onClick={() => preview('de')}>
            Preview (German)
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
