import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, SegmentedControl, Stack, Table, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconFileCertificate, IconFileTypePdf } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { REPORT_LANGS, type ReportLang, type ReportRecord, type RunStatus } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { errorText } from '../../i18n/errors';
import { currentLanguage } from '../../i18n';
import { LANGUAGES } from '../../i18n/languages';
import { fmtBytes, fmtDate } from '../../format';

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

const isReportLang = (v: string): v is ReportLang => (REPORT_LANGS as readonly string[]).includes(v);

/** Report language preselected in the dialogs: the UI language when reports exist in it, else English. */
export const defaultReportLang = (): ReportLang => {
  const lang = currentLanguage();
  return isReportLang(lang) ? lang : 'en';
};

/** Native name of a report language ("Deutsch"), from the one list of languages. */
export const reportLangName = (code: string): string => LANGUAGES.find((l) => l.code === code)?.nativeName ?? code.toUpperCase();

export function LangControl({ value, onChange, disabled, label }: { value: ReportLang; onChange: (v: ReportLang) => void; disabled?: boolean; label?: string }) {
  const { t } = useTranslation('reports');
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label ?? t('language')}
      </Text>
      <SegmentedControl
        value={value}
        disabled={disabled}
        onChange={(v) => isReportLang(v) && onChange(v)}
        data={REPORT_LANGS.map((code) => ({ value: code, label: reportLangName(code) }))}
      />
    </Stack>
  );
}

/** "Generate PDF report" dialog of a run. */
export function GenerateReportDialog({ runId, status, opened, onClose }: { runId: string; status: RunStatus; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['reports', 'common']);
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
      notifyOk(t('archived', { file: rec.filename }), t('run.generated'));
      setComment('');
      setDone(rec);
    } catch (e) {
      notifyError(e, t('run.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('run.dialogTitle')} size="lg">
      {done ? (
        <Stack>
          <Alert color="green" variant="light" title={t('run.doneTitle')}>
            <Text size="sm">{done.filename}</Text>
            <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
              SHA-256 {done.sha256}
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common:close')}
            </Button>
            <Button component="a" href={`/api/reports/${done.id}/download`} leftSection={<IconDownload size={16} />}>
              {t('downloadPdf')}
            </Button>
          </Group>
        </Stack>
      ) : (
      <Stack>
        <Text size="sm" c="dimmed">
          {t('run.intro')}
        </Text>
        {interim && (
          <Alert color="blue" variant="light" p="xs">
            {t('run.interimHint')}
          </Alert>
        )}
        <LangControl value={lang} onChange={setLang} />
        <Textarea
          label={t('comment')}
          description={t('run.commentHint')}
          autosize
          minRows={3}
          maxRows={10}
          maxLength={4000}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
        <TextInput
          label={t('run.classification')}
          description={t('run.classificationHint')}
          placeholder={t('run.classificationPlaceholder')}
          maxLength={60}
          value={classification}
          onChange={(e) => setClassification(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            {t('common:cancel')}
          </Button>
          <Button leftSection={<IconFileTypePdf size={16} />} loading={busy} onClick={generate}>
            {t('generatePdf')}
          </Button>
        </Group>
      </Stack>
      )}
    </Modal>
  );
}

/** Generated PDF reports of a run (tab on the run page). */
export function RunReportsPanel({ runId, status }: { runId: string; status: RunStatus }) {
  const { t } = useTranslation('reports');
  const [open, setOpen] = useState(false);
  const reports = useQuery({ queryKey: ['run-reports', runId], queryFn: () => get<ReportRecord[]>(`/runs/${runId}/reports`) });
  const list = reports.data ?? [];
  return (
    <Stack>
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed" maw={620}>
          {t('panel.intro')}
        </Text>
        <Tooltip label={t('panel.notYet')} disabled={canReport(status)}>
          <Button leftSection={<IconFileCertificate size={16} />} disabled={!canReport(status)} onClick={() => setOpen(true)}>
            {t('panel.generate')}
          </Button>
        </Tooltip>
      </Group>
      {reports.error && <Alert color="red">{errorText(reports.error)}</Alert>}
      {list.length === 0 && !reports.isLoading ? (
        <Text size="sm" c="dimmed">
          {t('panel.none')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" striped withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('panel.version')}</Table.Th>
                <Table.Th>{t('panel.generatedAt')}</Table.Th>
                <Table.Th>{t('panel.by')}</Table.Th>
                <Table.Th>{t('language')}</Table.Th>
                <Table.Th>{t('panel.comment')}</Table.Th>
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
                          {t('panel.interim')}
                        </Badge>
                      )}
                      {r.auto && (
                        <Badge size="xs" color="gray" variant="light">
                          {t('panel.automatic')}
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
