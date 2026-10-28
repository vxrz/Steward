import { useState } from 'react';
import { Badge, Button, Modal, Stack, Table, Text } from '@mantine/core';
import { IconFlask } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MonitorStatus } from '@sm/shared';
import { notifyError, post } from '../../api';
import { MonitorStatusBadge } from './status';

interface TestResult {
  checkId: string;
  name: string;
  type: string;
  status: MonitorStatus | null;
  message: string;
  recorded: boolean;
  skipped: boolean;
}

/** Test run of a monitor (#105): its platform checks against recorded responses; nothing is stored. */
export function TestRunButton({ monitorId }: { monitorId: string }) {
  const { t } = useTranslation('monitors');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult[] | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setResult((await post<{ checks: TestResult[] }>(`/monitors/${monitorId}/test-run`, {})).checks);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="xs" variant="default" leftSection={<IconFlask size={14} />} loading={busy} onClick={() => void run()}>
        {t('testRun.button')}
      </Button>
      {result && (
        <Modal opened onClose={() => setResult(null)} title={t('testRun.title')} size="lg">
          <Stack gap="sm" data-testid="monitor-test-run">
            <Text size="sm" c="dimmed">
              {t('testRun.help')}
            </Text>
            <div className="table-scroll">
              <Table fz="sm" aria-label={t('testRun.title')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('testRun.check')}</Table.Th>
                    <Table.Th>{t('testRun.result')}</Table.Th>
                    <Table.Th>{t('testRun.message')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {result.map((c) => (
                    <Table.Tr key={c.checkId}>
                      <Table.Td>{c.name}</Table.Td>
                      <Table.Td>
                        {c.skipped || !c.status ? (
                          <Badge size="sm" variant="outline" color="gray">
                            {t('testRun.skipped')}
                          </Badge>
                        ) : (
                          <MonitorStatusBadge status={c.status} size="sm" />
                        )}
                        {!c.skipped && !c.recorded && (
                          <Badge ml={4} size="xs" color="orange" variant="light">
                            {t('testRun.notRecorded')}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                          {c.message}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </Stack>
        </Modal>
      )}
    </>
  );
}
