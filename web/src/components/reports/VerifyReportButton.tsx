import { useState } from 'react';
import { Alert, Anchor, Button, FileButton, Modal, Stack, Table, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconFileSearch } from '@tabler/icons-react';
import type { ReportVerification } from '@sm/shared';
import { useTranslation } from 'react-i18next';
import { api, notifyError } from '../../api';
import { fmtDate } from '../../format';

/** Checks an archived (possibly signed) PDF against the report.generated entries of the audit log. */
export function VerifyReportButton() {
  const { t } = useTranslation(['reports', 'audit']);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; v: ReportVerification } | null>(null);
  const check = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      setResult({ name: file.name, v: await api<ReportVerification>('POST', '/reports/verify', form) });
    } catch (e) {
      notifyError(e, t('verify.failed'));
    } finally {
      setBusy(false);
    }
  };
  const v = result?.v;
  return (
    <>
      <FileButton onChange={check} accept="application/pdf">
        {(props) => (
          <Button {...props} size="xs" variant="light" leftSection={<IconFileSearch size={14} />} loading={busy}>
            {t('verify.button')}
          </Button>
        )}
      </FileButton>
      <Modal opened={!!result} onClose={() => setResult(null)} title={t('verify.title')} size="lg">
        {v && (
          <Stack>
            {v.match === 'exact' && (
              <Alert color="green" title={t('verify.exactTitle')}>
                {t('verify.exactText')}
              </Alert>
            )}
            {v.match === 'signed-copy' && (
              <Alert color="green" title={t('verify.signedTitle')}>
                {t('verify.signedText')}
              </Alert>
            )}
            {v.match === 'unknown' && (
              <Alert color="red" title={t('verify.unknownTitle')}>
                {t('verify.unknownText')}
              </Alert>
            )}
            <Table fz="sm" withRowBorders={false}>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td c="dimmed">{t('verify.file')}</Table.Td>
                  <Table.Td>{result!.name}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Td c="dimmed">{t('verify.fileHash')}</Table.Td>
                  <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                    {v.sha256}
                  </Table.Td>
                </Table.Tr>
                {v.report && (
                  <>
                    <Table.Tr>
                      <Table.Td c="dimmed">{t('verify.report')}</Table.Td>
                      <Table.Td>
                        <span className="mono">{v.report.id}</span> {v.report.filename ? `(${v.report.filename})` : ''}
                      </Table.Td>
                    </Table.Tr>
                    {v.report.runId && (
                      <Table.Tr>
                        <Table.Td c="dimmed">{t('verify.run')}</Table.Td>
                        <Table.Td>
                          {v.report.stored ? (
                            <Anchor component={Link} to={`/runs/${v.report.runId}`} className="mono" size="sm">
                              {v.report.runId}
                            </Anchor>
                          ) : (
                            <span className="mono">{v.report.runId}</span>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    )}
                    <Table.Tr>
                      <Table.Td c="dimmed">{t('verify.generated')}</Table.Td>
                      <Table.Td>
                        {t('verify.generatedLine', { date: fmtDate(v.report.generatedAt), user: v.report.generatedBy, seq: v.report.auditSeq })}
                      </Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td c="dimmed">{t('verify.recordedHash')}</Table.Td>
                      <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                        {v.report.sha256}
                      </Table.Td>
                    </Table.Tr>
                    {!v.report.stored && (
                      <Table.Tr>
                        <Table.Td c="dimmed">{t('verify.archive')}</Table.Td>
                        <Table.Td>{t('verify.archiveRemoved')}</Table.Td>
                      </Table.Tr>
                    )}
                  </>
                )}
              </Table.Tbody>
            </Table>
            {v.auditChain && (
              <Alert color={v.auditChain.ok ? 'green' : 'red'} variant="light" p="xs">
                <Text size="sm">
                  {t('verify.chain', { result: v.auditChain.ok ? t('audit:intactText', { count: v.auditChain.checked }) : v.auditChain.message })}
                </Text>
              </Alert>
            )}
          </Stack>
        )}
      </Modal>
    </>
  );
}
