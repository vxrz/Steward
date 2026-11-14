import { useEffect, useRef } from 'react';
import { Badge, Button, CopyButton, Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconAddressBook, IconCheck, IconCopy, IconDownload, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataConsumerContacts, DataProduct } from '@sm/shared';
import { apiUrl, get } from '../../../api';
import { QueryState } from '../../../components/common';
import { useContactRoleLabel } from '../../../components/contacts';
import { CardTable, Section } from '../parts';
import { govKeys } from './api';

const enc = encodeURIComponent;

/**
 * The contacts of a product's registered consumers (0.25.1, ADR 0038 part 6) – where the notices of a deprecation, a
 * breaking change or a review lead: Steward never e-mails a contact, the IT maintainers inform them. Names and roles
 * for every reader; e-mail addresses, _Copy e-mail addresses_ and the CSV for who may change the product. Opened with
 * `?contacts=all` or `?contacts=<port id>` on the Ports tab.
 */
export function ConsumerContactsPanel({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProductGovernance');
  const roleLabel = useContactRoleLabel();
  const [params, setParams] = useSearchParams();
  const which = params.get('contacts');
  const portId = which && which !== 'all' ? which : null;
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: [...govKeys.all, 'consumerContacts', p.id, portId ?? ''],
    queryFn: () => get<DataConsumerContacts>(`/data-products/${enc(p.id)}/consumer-contacts${portId ? `?port=${enc(portId)}` : ''}`),
    enabled: !!which,
  });
  useEffect(() => {
    if (which && q.isSuccess) ref.current?.scrollIntoView({ block: 'start' });
  }, [which, q.isSuccess]);
  const close = () =>
    setParams(
      (x) => {
        x.delete('contacts');
        return x;
      },
      { replace: true },
    );
  const open = () =>
    setParams(
      (x) => {
        x.set('contacts', 'all');
        return x;
      },
      { replace: true },
    );
  if (!which)
    return p.ports.some((x) => x.direction === 'output' && x.consumers.registered > 0) ? (
      <Group>
        <Button size="xs" variant="default" leftSection={<IconAddressBook size={14} />} onClick={open} data-testid="consumer-contacts-open">
          {t('contactsList.open')}
        </Button>
      </Group>
    ) : null;
  const v = q.data;
  type Entry = DataConsumerContacts['entries'][number];
  type Row = { key: string; e: Entry; c: Entry['contacts'][number] | null };
  const rows: Row[] = (v?.entries ?? []).flatMap((e): Row[] =>
    e.contacts.length ? e.contacts.map((c, i) => ({ key: `${e.consumerId}:${i}`, e, c })) : [{ key: e.consumerId, e, c: null }],
  );
  const emails = [...new Set(rows.flatMap((r) => (r.c?.email && r.c.status === 'active' ? [r.c.email] : [])))];
  const port = portId ? p.ports.find((x) => x.id === portId) : null;
  return (
    <div ref={ref}>
      <Section
        title={port ? t('contactsList.titlePort', { port: `${port.name}${port.version ? ` ${port.version}` : ''}` }) : t('contactsList.title')}
        testId="consumer-contacts"
        actions={
          <Group gap="xs">
            {v?.withEmail && emails.length > 0 && (
              <CopyButton value={emails.join('; ')}>
                {({ copied, copy }) => (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                    onClick={copy}
                    data-testid="consumer-contacts-copy"
                  >
                    {copied ? t('contactsList.copied') : t('contactsList.copy', { count: emails.length })}
                  </Button>
                )}
              </CopyButton>
            )}
            {v?.withEmail && (
              <Button
                size="xs"
                variant="default"
                component="a"
                href={apiUrl(`/data-products/${enc(p.id)}/consumer-contacts.csv${portId ? `?port=${enc(portId)}` : ''}`)}
                leftSection={<IconDownload size={14} />}
                data-testid="consumer-contacts-csv"
              >
                {t('contactsList.csv')}
              </Button>
            )}
            <Button size="xs" variant="subtle" leftSection={<IconX size={14} />} onClick={close} aria-label={t('contactsList.close')}>
              {t('contactsList.close')}
            </Button>
          </Group>
        }
      >
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {v?.withEmail ? t('contactsList.helpMaintainer') : t('contactsList.helpReader')}
          </Text>
          <QueryState query={q} />
          {v && !rows.length && (
            <Text size="sm" c="dimmed">
              {t('contactsList.none')}
            </Text>
          )}
          {rows.length > 0 && (
            <CardTable
              ariaLabel={t('contactsList.title')}
              rows={rows}
              rowKey={(r) => r.key}
              rowTestId={() => 'consumer-contact-row'}
              columns={[
                { key: 'port', header: t('contactsList.port'), cell: (r) => <span className="mono">{r.e.portName}</span> },
                { key: 'consumer', header: t('contactsList.consumer'), cell: (r) => r.e.consumer },
                {
                  key: 'contact',
                  header: t('contactsList.contact'),
                  cell: (r) =>
                    r.c ? (
                      <Group gap={6} wrap="wrap">
                        <Text size="sm">{r.c.name}</Text>
                        <Badge size="sm" variant="light" tt="none">
                          {roleLabel(r.c.role)}
                        </Badge>
                        {r.c.status === 'left' && (
                          <Badge size="sm" color="gray" variant="outline" tt="none">
                            {t('contactsList.left')}
                          </Badge>
                        )}
                      </Group>
                    ) : (
                      <Text size="sm" c="orange">
                        {t('contactsList.noContact')}
                      </Text>
                    ),
                },
                ...(v?.withEmail ? [{ key: 'email', header: t('contactsList.email'), cell: (r: Row) => r.c?.email || '–' }] : []),
              ]}
            />
          )}
        </Stack>
      </Section>
    </div>
  );
}
