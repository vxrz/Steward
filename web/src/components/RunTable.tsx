import { Badge, Table, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import type { RunSummary } from '@sm/shared';
import { fmtDate, runDuration } from '../format';
import { StatusBadge } from './common';

export function RunTable({ runs, compact = false }: { runs: RunSummary[]; compact?: boolean }) {
  const navigate = useNavigate();
  if (!runs.length) return <Text c="dimmed" size="sm">No runs yet.</Text>;
  return (
    <div className="table-scroll">
      <Table highlightOnHover fz="sm" verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Status</Table.Th>
            <Table.Th>Process</Table.Th>
            <Table.Th>Started</Table.Th>
            {!compact && <Table.Th>Duration</Table.Th>}
            {!compact && <Table.Th>By</Table.Th>}
            <Table.Th>Result</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((r) => (
            <Table.Tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
              <Table.Td>
                <StatusBadge status={r.status} />
                {r.dryRun && (
                  <Badge ml={4} size="xs" color="yellow" variant="light">
                    dry
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {r.processName}
                </Text>
              </Table.Td>
              <Table.Td className="nowrap">{fmtDate(r.startedAt)}</Table.Td>
              {!compact && <Table.Td className="nowrap">{runDuration(r.startedAt, r.finishedAt)}</Table.Td>}
              {!compact && (
                <Table.Td>
                  {r.actor}
                  {r.trigger === 'schedule' && (
                    <Badge ml={4} size="xs" variant="outline">
                      scheduled
                    </Badge>
                  )}
                </Table.Td>
              )}
              <Table.Td>
                <Text size="xs" c={r.stats.checksFailed || r.stats.failedSteps ? 'red' : 'dimmed'}>
                  {[
                    r.stats.openTasks ? `${r.stats.openTasks} task(s) waiting` : '',
                    r.stats.writes ? `${r.stats.writes} change(s)` : '',
                    r.stats.skippedWrites ? `${r.stats.skippedWrites} simulated` : '',
                    r.stats.checksPassed + r.stats.checksFailed ? `checks ${r.stats.checksPassed}/${r.stats.checksPassed + r.stats.checksFailed} ok` : '',
                    r.stats.failedSteps ? `${r.stats.failedSteps} failed step(s)` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || (r.error ?? '')}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}
