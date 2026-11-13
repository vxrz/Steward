import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Alert, Badge, Button, Collapse, Group, Stack, TagsInput, Text } from '@mantine/core';
import { IconChevronDown, IconEye, IconEyeOff, IconHelpCircle, IconPencil, IconRefresh, IconUserQuestion } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_GOVERNANCE_LIMITS,
  DATA_IDENTITY_RE,
  type DataActualRead,
  type DataActualView,
  type DataDeclaredConsumer,
  type DataDeclaredState,
  type DataPort,
  type DataProduct,
} from '@sm/shared';
import { post, put } from '../../../api';
import { FormModal } from '../../../components/FormModal';
import { useSubjectLabel } from '../../../components/SubjectsInput';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate, fmtDay, fmtNumber } from '../../../format';
import { CardTable, HiddenCount } from '../parts';
import { govKeys, useActual, useInvalidateGovernance } from './api';

const enc = encodeURIComponent;

/** A registration's state in words and an icon (never colour alone). */
export function DeclaredStateBadge({ state }: { state: DataDeclaredState | 'notRegistered' }) {
  const { t } = useTranslation('dataProductGovernance');
  const look = {
    seen: { color: 'green', Icon: IconEye },
    silent: { color: 'orange', Icon: IconEyeOff },
    unknown: { color: 'gray', Icon: IconHelpCircle },
    notRegistered: { color: 'red', Icon: IconUserQuestion },
  }[state];
  return (
    <Badge size="sm" variant="light" color={look.color} tt="none" leftSection={<look.Icon size={12} aria-hidden />} data-testid={`actual-state-${state}`}>
      {t(`actual.states.${state}`)}
    </Badge>
  );
}

function ReadLine({ r }: { r: DataActualRead }) {
  const { t } = useTranslation('dataProductGovernance');
  const platform = r.platformName ?? t('actual.hiddenPlatform');
  const text =
    r.status === 'ok'
      ? t('actual.read.ok', { platform, date: fmtDate(r.readAt), user: r.readBy, days: r.windowDays })
      : r.status === 'notAvailable'
        ? t('actual.read.notAvailable', { platform })
        : r.status === 'noObjects'
          ? t('actual.read.noObjects', { platform })
          : t('actual.read.failed', { platform, message: r.message || '–' });
  return (
    <Text size="xs" c={r.status === 'failed' ? 'red' : r.status === 'notAvailable' ? 'orange' : 'dimmed'} data-testid={`actual-read-${r.status}`}>
      {text}
    </Text>
  );
}

/**
 * Who really reads an output port (ADR 0036 phase 2, declared against actual): what the platforms said at the last
 * read – Snowflake users and roles from ACCESS_HISTORY, Kafka consumer groups – beside the registrations, with
 * _registered but silent_ and _not registered_. Opens on demand; _Read now_ for who may change the product.
 */
export function ActualConsumers({ p, port, environment }: { p: DataProduct; port: DataPort; environment: string }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const [open, setOpen] = useState(false);
  const q = useActual(p.id, port.id, environment, open);
  const invalidate = useInvalidateGovernance();
  const [busy, run] = useBusy();
  const [editing, setEditing] = useState<DataDeclaredConsumer | null>(null);
  const subject = useSubjectLabel();
  const canEdit = p.permissions.includes('edit');
  const v = q.data;
  const qc = useQueryClient();
  // the answer of the read is the port's new view: shown at once. It used to wait for the re-read of every data products
  // query on the page (product, health, scorecard, members, …) – seven requests behind the browser's six connections,
  // the view last – which under load took longer than a person (or a test) waits. The rest is read again after.
  const read = () =>
    run(async () => {
      const view = await post<DataActualView>(`/data-products/${enc(p.id)}/ports/${enc(port.id)}/actual/read`, { environment });
      qc.setQueryData(govKeys.actual(p.id, port.id, environment), view);
      invalidate();
    });
  const who = (d: DataDeclaredConsumer) => (d.label === null ? t('actual.hiddenConsumer') : d.subject ? subject(d.subject) : d.label);
  const notRegistered = (v?.actual ?? []).filter((a) => !a.registeredAs.length);
  return (
    <div>
      <Button
        size="compact-sm"
        variant="subtle"
        leftSection={<IconEye size={14} />}
        rightSection={<IconChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} aria-hidden />}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="port-actual-toggle"
        // grows with a wrapped summary, never below the 24 px of a target (WCAG 2.5.8)
        h="auto"
        mih={26}
        maw="100%"
        styles={{ label: { whiteSpace: 'normal', textAlign: 'left' } }}
      >
        {v ? t('actual.summary', { seen: v.counts.seen, silent: v.counts.silent, notRegistered: v.counts.notRegistered }) : t('actual.title')}
      </Button>
      <Collapse expanded={open}>
        {open && (
          <Stack gap="xs" mt="xs" data-testid="port-actual">
            <Text size="xs" c="dimmed">
              {t('actual.help', { environment })}
            </Text>
            {v && !v.reads.length && (
              <Text size="sm" c="dimmed">
                {t('actual.neverRead')}
              </Text>
            )}
            {v?.reads.map((r, i) => (
              <ReadLine key={r.platformId ?? `hidden-${i}`} r={r} />
            ))}
            {v?.canRead && canEdit && (
              <Group>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconRefresh size={14} />}
                  loading={busy}
                  onClick={() => void read()}
                  data-testid="actual-read-now"
                >
                  {t('actual.readNow')}
                </Button>
              </Group>
            )}
            {v && v.declared.length > 0 && (
              <CardTable
                ariaLabel={t('actual.declaredTitle', { name: port.name })}
                rows={v.declared}
                rowKey={(d) => d.consumerId}
                rowTestId={() => 'actual-declared-row'}
                columns={[
                  {
                    key: 'who',
                    header: t('actual.who'),
                    cell: (d) => (
                      <>
                        <span style={{ overflowWrap: 'anywhere' }}>{who(d)}</span>
                        {d.endDate && (
                          <Text size="xs" c="dimmed">
                            {t('actual.until', { date: fmtDay(d.endDate) })}
                          </Text>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'state',
                    header: t('actual.state'),
                    cell: (d) => (
                      <>
                        <DeclaredStateBadge state={d.state} />
                        {d.seenAs.length > 0 && (
                          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                            {d.seenAs.join(', ')}
                          </Text>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'identities',
                    header: t('actual.identities'),
                    cell: (d) => (
                      <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {d.identities.join(', ') || '–'}
                      </span>
                    ),
                  },
                  ...(canEdit
                    ? [
                        {
                          key: 'actions',
                          header: t('actual.actions'),
                          actions: true,
                          cell: (d: DataDeclaredConsumer) => (
                            <ActionIcon variant="subtle" color="gray" aria-label={t('actual.editIdentities', { name: who(d) })} onClick={() => setEditing(d)}>
                              <IconPencil size={14} />
                            </ActionIcon>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            )}
            {v && (notRegistered.length > 0 || v.hiddenActual > 0) && (
              <>
                <Text size="sm" fw={600}>
                  {t('actual.notRegisteredTitle')}
                </Text>
                {notRegistered.length > 0 && (
                  <CardTable
                    ariaLabel={t('actual.notRegisteredTitle')}
                    rows={notRegistered}
                    rowKey={(a) => `${a.platformId}:${a.kind}:${a.name}`}
                    rowTestId={() => 'actual-unregistered-row'}
                    columns={[
                      {
                        key: 'reader',
                        header: t('actual.reader'),
                        cell: (a) => (
                          <>
                            <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {a.name}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {t(`actual.kinds.${a.kind}`)}
                              {a.detail && ` · ${a.detail}`}
                            </Text>
                          </>
                        ),
                      },
                      { key: 'platform', header: t('actual.platform'), cell: (a) => a.platformName },
                      {
                        key: 'objects',
                        header: t('actual.objects'),
                        cell: (a) => (
                          <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                            {a.objects.join(', ')}
                          </span>
                        ),
                      },
                      { key: 'reads', header: t('actual.reads'), nowrap: true, cell: (a) => (a.reads === null ? '–' : fmtNumber(a.reads)) },
                      { key: 'lastSeen', header: t('actual.lastSeen'), nowrap: true, cell: (a) => (a.lastSeen ? fmtDate(a.lastSeen) : '–') },
                    ]}
                  />
                )}
                <HiddenCount count={v.hiddenActual} />
                {canEdit && (
                  <Alert variant="light" color="blue" p="xs">
                    {t('actual.registerHint')}
                  </Alert>
                )}
              </>
            )}
          </Stack>
        )}
      </Collapse>
      {editing && (
        <IdentitiesForm
          productId={p.id}
          portId={port.id}
          consumer={editing}
          suggestions={(v?.actual ?? []).map((a) => `${a.kind}:${a.name}`)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/** The platform identities of a registration (user:, role:, group:) – how Steward knows it is the one reading. */
function IdentitiesForm({
  productId,
  portId,
  consumer,
  suggestions,
  onClose,
  onSaved,
}: {
  productId: string;
  portId: string;
  consumer: DataDeclaredConsumer;
  suggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const [value, setValue] = useState<string[]>(consumer.identities);
  const [busy, run] = useBusy();
  const bad = value.filter((x) => !DATA_IDENTITY_RE.test(x.trim()));
  const save = () =>
    run(async () => {
      await put(`/data-products/${enc(productId)}/ports/${enc(portId)}/consumers/${enc(consumer.consumerId)}/identities`, {
        identities: value.map((x) => x.trim()),
      });
      onSaved();
    });
  return (
    <FormModal onClose={onClose} title={t('actual.identitiesTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad.length) void save();
        }}
      >
        <Stack gap="sm">
          <TagsInput
            label={t('actual.identities')}
            description={t('actual.identitiesHelp')}
            data={[...new Set(suggestions)]}
            value={value}
            onChange={setValue}
            maxTags={DATA_GOVERNANCE_LIMITS.identitiesPerConsumer}
            error={bad.length ? t('actual.identitiesInvalid', { list: bad.join(', ') }) : undefined}
            data-testid="identities-input"
          />
          <FormButtons busy={busy} testId="identities-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
