import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, SegmentedControl, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconFileCertificate, IconFileTypePdf } from '@tabler/icons-react';
import type { ReportLang, ReportRecord, RunStatus } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { fmtDate } from '../../format';

export const FINISHED_STATUSES: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
const INTERIM_STATUSES: RunStatus[] = ['waiting', 'interrupted'];

/** Whether a PDF report can be generated for a run in this status. */
export const canReport = (status: RunStatus) => FINISHED_STATUSES.includes(status) || INTERIM_STATUSES.includes(status);

export const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const defaultReportLang = (): ReportLang => (navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en');

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function LangControl({ value, onChange }: { value: ReportLang; onChange: (v: ReportLang) => void }) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Language
      </Text>
      <SegmentedControl
        value={value}
        onChange={(v) => onChange(v as ReportLang)}
        data={[
          { value: 'en', label: 'English' },
          { value: 'de', label: 'Deutsch' },
        ]}
      />
    </Stack>
  );
}

/** "Generate PDF report" dialog of a run. */
export function GenerateReportDialog({ runId, status, opened, onClose }: { runId: string; status: RunStatus; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [lang, setLang] = useState<ReportLang>(defaultReportLang);
  const [comment, setComment] = useState('');
  const [classification, setClassification] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReportRecord | null>(null);
  const interim = !FINISHED_STATUSES.includes(status);
  const close = () => {
    setDone(null);
    onClose();
  };
  const generate = async () => {
    setBusy(true);
    try {
      const rec = await post<ReportRecord>(`/runs/${runId}/reports`, {
        lang,
        comment: comment.trim() || undefined,
        classification: classification.trim() || undefined,
        timeZone: browserTimeZone(),
      });
      await qc.invalidateQueries({ queryKey: ['run-reports', runId] });
      notifyOk(`${rec.filename} was archived.`, 'PDF report generated');
      setComment('');
      setDone(rec);
    } catch (e) {
      notifyError(e, 'The report could not be generated');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title="Generate PDF report" size="lg">
      {done ? (
        <Stack>
          <Alert color="green" variant="light" title="The report was generated and archived">
            <Text size="sm">{done.filename}</Text>
            <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
              SHA-256 {done.sha256}
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              Close
            </Button>
            <Button component="a" href={`/api/reports/${done.id}/download`} leftSection={<IconDownload size={16} />}>
              Download PDF
            </Button>
          </Group>
        </Stack>
      ) : (
      <Stack>
        <Text size="sm" c="dimmed">
          Creates an archivable PDF/A report of this run: what was done and when, results, decisions, checks and evidence, with a sign-off block and empty digital
          signature fields. Every report is stored unchanged, and its SHA-256 is recorded in the audit log.
        </Text>
        {interim && (
          <Alert color="blue" variant="light" p="xs">
            This run has not finished yet. The report will be marked as an interim report.
          </Alert>
        )}
        <LangControl value={lang} onChange={setLang} />
        <Textarea
          label="Reviewer comment"
          description="Optional. Printed in the report with your name and the time, e.g. the result of your review."
          autosize
          minRows={3}
          maxRows={10}
          maxLength={4000}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
        <TextInput
          label="Classification"
          description="Optional. Leave empty to use the default from the report branding settings."
          placeholder="e.g. Confidential"
          maxLength={60}
          value={classification}
          onChange={(e) => setClassification(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button leftSection={<IconFileTypePdf size={16} />} loading={busy} onClick={generate}>
            Generate PDF
          </Button>
        </Group>
      </Stack>
      )}
    </Modal>
  );
}

/** Generated PDF reports of a run (tab on the run page). */
export function RunReportsPanel({ runId, status }: { runId: string; status: RunStatus }) {
  const [open, setOpen] = useState(false);
  const reports = useQuery({ queryKey: ['run-reports', runId], queryFn: () => get<ReportRecord[]>(`/runs/${runId}/reports`) });
  const list = reports.data ?? [];
  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed" maw={620}>
          Archived PDF reports of this run. Files are never changed; generating again creates a new version. The SHA-256 of each file is recorded in the audit log, so an
          archived copy can be verified later.
        </Text>
        <Tooltip label="Reports can be generated when the run has finished or is waiting for a decision" disabled={canReport(status)}>
          <Button leftSection={<IconFileCertificate size={16} />} disabled={!canReport(status)} onClick={() => setOpen(true)}>
            Generate PDF report
          </Button>
        </Tooltip>
      </Group>
      {reports.error && <Alert color="red">{(reports.error as Error).message}</Alert>}
      {list.length === 0 && !reports.isLoading ? (
        <Text size="sm" c="dimmed">
          No PDF reports yet.
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Version</Table.Th>
                <Table.Th>Generated</Table.Th>
                <Table.Th>By</Table.Th>
                <Table.Th>Language</Table.Th>
                <Table.Th>Comment</Table.Th>
                <Table.Th>SHA-256</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td className="nowrap">
                    <Group gap={4} wrap="nowrap">
                      <Text size="sm">v{r.version}</Text>
                      {r.interim && (
                        <Badge size="xs" color="blue" variant="light">
                          interim
                        </Badge>
                      )}
                      {r.auto && (
                        <Badge size="xs" color="gray" variant="light">
                          automatic
                        </Badge>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td className="nowrap">{fmtDate(r.createdAt)}</Table.Td>
                  <Table.Td>{r.createdBy}</Table.Td>
                  <Table.Td>{r.lang.toUpperCase()}</Table.Td>
                  <Table.Td style={{ maxWidth: 280, wordBreak: 'break-word' }}>{r.comment ?? <Text span c="dimmed" size="sm">–</Text>}</Table.Td>
                  <Table.Td>
                    <Tooltip label={r.sha256} multiline w={300}>
                      <Text size="xs" className="mono">
                        {r.sha256.slice(0, 12)}…
                      </Text>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Anchor href={`/api/reports/${r.id}/download`} size="sm" title={`${r.filename} (${fmtBytes(r.size)})`}>
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
      )}
      <GenerateReportDialog runId={runId} status={status} opened={open} onClose={() => setOpen(false)} />
    </Stack>
  );
}
