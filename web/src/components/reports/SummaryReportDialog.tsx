import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Divider, Group, Modal, MultiSelect, SimpleGrid, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconReportAnalytics } from '@tabler/icons-react';
import type { ProcessSummary, ReportLang, ReportRecord } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { fmtDate } from '../../format';
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
      notifyOk(`${rec.filename} was archived.`, 'Summary report generated');
      setDone(rec);
      qc.invalidateQueries({ queryKey: ['summary-reports'] });
    } catch (e) {
      notifyError(e, 'The summary report could not be generated');
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setDone(null);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title="Summary report" size="xl">
      {done ? (
        <Stack>
          <Alert color="green" variant="light" title="The summary report was generated and archived">
            <Text size="sm">{done.filename}</Text>
            <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
              SHA-256 {done.sha256}
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDone(null)}>
              New summary
            </Button>
            <Button component="a" href={`/api/reports/${done.id}/download`} leftSection={<IconDownload size={16} />}>
              Download PDF
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm" c="dimmed">
            One PDF for audits: all runs of the selected processes in a period, with status, who started them, decisions, changes and failed checks, plus totals. It
            is archived and its SHA-256 is recorded in the audit log.
          </Text>
          <MultiSelect
            label="Processes"
            required
            searchable
            clearable
            placeholder="Select one or more processes"
            data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={selected}
            onChange={setSelected}
          />
          <Group gap="xs">
            <Text size="sm" fw={500}>
              Period
            </Text>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('lastQuarter'))}>
              Last quarter
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('thisQuarter'))}>
              This quarter
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('lastMonth'))}>
              Last month
            </Button>
            <Button size="compact-xs" variant="light" onClick={() => setRange(presetRange('last30'))}>
              Last 30 days
            </Button>
          </Group>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="date" label="From" required value={from} onChange={(e) => setRange([e.currentTarget.value, to])} />
            <TextInput type="date" label="To (inclusive)" required value={to} onChange={(e) => setRange([from, e.currentTarget.value])} error={from && to && from > to ? 'The end must not be before the start' : undefined} />
          </SimpleGrid>
          <TextInput label="Title" description="Optional, e.g. Access reviews Q3" maxLength={200} value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
          <LangControl value={lang} onChange={setLang} />
          <Textarea label="Reviewer comment" description="Optional. Printed in the report with your name and the time." autosize minRows={2} maxRows={8} maxLength={4000} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button leftSection={<IconReportAnalytics size={16} />} loading={busy} disabled={!valid} onClick={generate}>
              Generate PDF
            </Button>
          </Group>
          {(previous.data?.length ?? 0) > 0 && (
            <>
              <Divider label="Recent summary reports" labelPosition="left" />
              <div className="table-scroll">
                <Table fz="sm" striped>
                  <Table.Tbody>
                    {previous.data!.map((r) => (
                      <Table.Tr key={r.id}>
                        <Table.Td className="nowrap">{fmtDate(r.createdAt)}</Table.Td>
                        <Table.Td>{r.title}</Table.Td>
                        <Table.Td className="nowrap">
                          {r.from ? new Date(r.from).toLocaleDateString() : ''} – {r.to ? new Date(new Date(r.to).getTime() - 1).toLocaleDateString() : ''}
                        </Table.Td>
                        <Table.Td>{r.createdBy}</Table.Td>
                        <Table.Td className="nowrap">
                          <Anchor href={`/api/reports/${r.id}/download`} size="sm">
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
