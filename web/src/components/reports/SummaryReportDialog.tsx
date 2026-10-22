import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Divider, Group, Modal, MultiSelect, SimpleGrid, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconReportAnalytics } from '@tabler/icons-react';
import type { ProcessSummary, ReportLang, ReportRecord } from '@sm/shared';
import { useTranslation } from 'react-i18next';
import { get, notifyError, notifyOk, post, apiUrl } from '../../api';
import { fmtDate, fmtDay } from '../../format';
import { LangControl, browserTimeZone, defaultReportLang } from './RunReports';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function presetRange(preset: 'lastQuarter' | 'thisQuarter' | 'lastMonth' | 'last30'): [string, string] {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  switch (preset) {
    case 'thisQuarter':
      return [ymd(new Date(now.getFullYear(), q * 3, 1)), ymd(now)];
    case 'lastQuarter': {
      const start = new Date(now.getFullYear(), q * 3 - 3, 1);
      return [ymd(start), ymd(new Date(start.getFullYear(), start.getMonth() + 3, 0))];
    }
    case 'lastMonth':
      return [ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), ymd(new Date(now.getFullYear(), now.getMonth(), 0))];
    default:
      return [ymd(new Date(now.getTime() - 29 * 86400000)), ymd(now)];
  }
}

/** Periodic summary report (e.g. "Access reviews Q3") for one or more processes and a period. */
export function SummaryReportDialog({ opened, onClose, processIds }: { opened: boolean; onClose: () => void; processIds?: string[] }) {
  const { t } = useTranslation(['reports', 'common']);
  const qc = useQueryClient();
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes'), enabled: opened });
  const previous = useQuery({ queryKey: ['summary-reports'], queryFn: () => get<ReportRecord[]>('/reports?kind=summary&limit=20'), enabled: opened });
  const [selected, setSelected] = useState<string[]>(processIds ?? []);
  const [[from, to], setRange] = useState<[string, string]>(() => presetRange('lastQuarter'));
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<ReportLang>(defaultReportLang);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReportRecord | null>(null);

  useEffect(() => {
    if (opened && processIds?.length) setSelected(processIds);
  }, [opened, processIds]);

  const valid = selected.length > 0 && !!from && !!to && from <= to;
  const generate = async () => {
    setBusy(true);
    try {
      const start = new Date(`${from}T00:00:00`);
      const end = new Date(`${to}T00:00:00`);
      end.setDate(end.getDate() + 1); // the end date is included
      const rec = await post<ReportRecord>('/reports/summary', {
        processIds: selected,
        from: start.toISOString(),
        to: end.toISOString(),
        lang,
        title: title.trim() || undefined,
        comment: comment.trim() || undefined,
        timeZone: browserTimeZone(),
      });
      notifyOk(t('archived', { file: rec.filename }), t('summary.generated'));
      setDone(rec);
      qc.invalidateQueries({ queryKey: ['summary-reports'] });
    } catch (e) {
      notifyError(e, t('summary.failed'));
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDone(null);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title={t('summary.title')} size="xl">
      {done ? (
        <Stack>
          <Alert color="green" variant="light" title={t('summary.doneTitle')}>
            <Text size="sm">{done.filename}</Text>
            <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
              SHA-256 {done.sha256}
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDone(null)}>
              {t('summary.new')}
            </Button>
            <Button component="a" href={apiUrl(`/reports/${done.id}/download`)} leftSection={<IconDownload size={16} />}>
              {t('downloadPdf')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm" c="dimmed">
            {t('summary.intro')}
          </Text>
          <MultiSelect
            label={t('summary.processes')}
            required
            searchable
            clearable
            placeholder={t('summary.processesPlaceholder')}
            data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={selected}
            onChange={setSelected}
          />
          <Group gap="xs">
            <Text size="sm" fw={500}>
              {t('summary.period')}
            </Text>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('lastQuarter'))}>
              {t('summary.presets.lastQuarter')}
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('thisQuarter'))}>
              {t('summary.presets.thisQuarter')}
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('lastMonth'))}>
              {t('summary.presets.lastMonth')}
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('last30'))}>
              {t('summary.presets.last30')}
            </Button>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="date" label={t('summary.from')} required value={from} onChange={(e) => setRange([e.currentTarget.value, to])} />
            <TextInput type="date" label={t('summary.to')} required value={to} onChange={(e) => setRange([from, e.currentTarget.value])} error={from && to && from > to ? t('summary.endBeforeStart') : undefined} />
          </SimpleGrid>
          <TextInput label={t('summary.reportTitle')} description={t('summary.reportTitleHint')} maxLength={200} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <LangControl value={lang} onChange={setLang} />
          <Textarea label={t('comment')} description={t('summary.commentHint')} autosize minRows={2} maxRows={8} maxLength={4000} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common:cancel')}
            </Button>
            <Button leftSection={<IconReportAnalytics size={16} />} loading={busy} disabled={!valid} onClick={generate}>
              {t('generatePdf')}
            </Button>
          </Group>
          {(previous.data?.length ?? 0) > 0 && (
            <>
              <Divider label={t('summary.recent')} labelPosition="left" />
              <div className="table-scroll">
                <Table fz="sm" striped>
                  <Table.Tbody>
                    {previous.data!.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td className="nowrap">{fmtDate(r.createdAt)}</Table.Td>
                        <Table.Td>{r.title}</Table.Td>
                        <Table.Td className="nowrap">
                          {r.from ? fmtDay(r.from) : ''} – {r.to ? fmtDay(new Date(r.to).getTime() - 1) : ''}
                        </Table.Td>
                        <Table.Td>{r.createdBy}</Table.Td>
                        <Table.Td className="nowrap">
                          <Anchor href={apiUrl(`/reports/${r.id}/download`)} size="sm">
                            <Group gap={4} wrap="nowrap">
                              <IconDownload size={14} />
                              PDF
                            </Group>
                          </Anchor>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </>
          )}
        </Stack>
      )}
    </Modal>
  );
}
