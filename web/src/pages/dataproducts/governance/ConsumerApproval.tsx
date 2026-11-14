import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Checkbox, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconTool } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataConsumer, DataConsumerFulfilment, DataPort, DataProduct } from '@sm/shared';
import { notifyOk, post } from '../../../api';
import { useFieldErrors } from '../../../components/common';
import { FormModal } from '../../../components/FormModal';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDay } from '../../../format';
import { useAccessSettings, useInvalidateGovernance } from './api';

const enc = encodeURIComponent;

/**
 * The documented access of a registration (0.25.1, ADR 0038 part 3): _documented_ with who decided it elsewhere and
 * when, or _approval not documented_ for the IT maintainers to complete; and the fulfilment – the ticket reference
 * and the process run – as links.
 */
export function ConsumerApproval({ c }: { c: DataConsumer }) {
  const { t } = useTranslation('dataProductGovernance');
  return (
    <Stack gap={2}>
      <Badge
        size="sm"
        variant="light"
        tt="none"
        color={c.approval === 'documented' ? 'green' : 'orange'}
        data-testid={`consumer-approval-${c.approval}`}
        style={{ alignSelf: 'flex-start' }}
      >
        {t(`documented.approval.${c.approval}`)}
      </Badge>
      {c.decision && (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {t('documented.decidedLine', { names: c.decision.decidedBy.map((d) => d.name).join(', '), date: fmtDay(c.decision.decidedOn) })}
        </Text>
      )}
      {c.ticketId && (
        <Anchor component={Link} to={`/tickets/${enc(c.ticketId)}`} size="xs">
          {t('documented.ticket')}
        </Anchor>
      )}
      {c.runId && (
        <Anchor component={Link} to={`/runs/${enc(c.runId)}`} size="xs">
          {t('documented.run')}
        </Anchor>
      )}
    </Stack>
  );
}

/** _Fulfil_: record the platform ticket and start the platform team's process (as the product's settings name them). */
export function FulfilButton({ p, port, c, name }: { p: DataProduct; port: DataPort; c: DataConsumer; name: string }) {
  const { t } = useTranslation('dataProductGovernance');
  const settings = useAccessSettings(p.id);
  const [open, setOpen] = useState(false);
  const s = settings.data;
  const canTicket = !!s?.ticketSource && !c.ticketId;
  const canProcess = !!s?.process && !c.runId;
  if (!canTicket && !canProcess) return null;
  return (
    <>
      <Tooltip label={t('documented.fulfil')}>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('documented.fulfilNamed', { name })}
          onClick={() => setOpen(true)}
          data-testid="consumer-fulfil"
        >
          <IconTool size={14} />
        </ActionIcon>
      </Tooltip>
      {open && (
        <FulfilForm
          p={p}
          port={port}
          c={c}
          canTicket={canTicket}
          processName={canProcess ? (s?.process?.name ?? null) : undefined}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FulfilForm({
  p,
  port,
  c,
  canTicket,
  processName,
  onClose,
}: {
  p: DataProduct;
  port: DataPort;
  c: DataConsumer;
  canTicket: boolean;
  /** undefined: no process to start; null: one the reader may not see by name */
  processName: string | null | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const invalidate = useInvalidateGovernance();
  const [number, setNumber] = useState('');
  const [url, setUrl] = useState('');
  const [start, setStart] = useState(processName !== undefined);
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    url: !!url.trim() && !/^https?:\/\/\S+$/i.test(url.trim()) && t('documented.urlInvalid'),
    what: !number.trim() && !start && t('documented.fulfilNothing'),
  });
  const save = () =>
    run(async () => {
      const r = await post<DataConsumerFulfilment>(`/data-products/${enc(p.id)}/ports/${enc(port.id)}/consumers/${enc(c.id)}/fulfilment`, {
        ticket: canTicket && number.trim() ? { externalNumber: number.trim(), externalUrl: url.trim() } : null,
        startProcess: processName !== undefined && start,
      });
      notifyOk(r.problems.length ? t('documented.fulfilProblems', { list: r.problems.join('; ') }) : t('documented.fulfilled'));
      invalidate();
      onClose();
    });
  return (
    <FormModal onClose={onClose} title={t('documented.fulfilTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('documented.fulfilHelp')}
          </Text>
          {canTicket && (
            <>
              <TextInput label={t('documented.ticketNumber')} value={number} onChange={(e) => setNumber(e.currentTarget.value)} data-testid="fulfil-ticket" />
              <TextInput label={t('documented.ticketUrl')} value={url} onChange={(e) => setUrl(e.currentTarget.value)} error={v.error('url')} />
            </>
          )}
          {processName !== undefined && (
            <Checkbox
              label={t('documented.startProcess', { name: processName ?? t('settings.hiddenProcess') })}
              checked={start}
              onChange={(e) => setStart(e.currentTarget.checked)}
              data-testid="fulfil-process"
            />
          )}
          {v.error('what') && (
            <Text size="sm" c="red">
              {v.error('what')}
            </Text>
          )}
          <FormButtons busy={busy} submit={t('documented.fulfil')} testId="fulfil-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
