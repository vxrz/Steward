import { useMemo } from 'react';
import { Alert, Anchor, Button, Group, Paper, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconFileTypeCsv, IconFileTypePdf } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataRopaEntry } from '@sm/shared';
import { apiUrl } from '../../../api';
import { QueryState } from '../../../components/common';
import { DataTable } from '../../../components/DataTable';
import { ListPage } from '../../../components/page/ListPage';
import { useSubjectLabel } from '../../../components/SubjectsInput';
import { qs, useDomains } from '../api';
import { HiddenCount, PersonalDataBadge, RefLink } from '../parts';
import { useRopa } from './api';

const enc = encodeURIComponent;

/**
 * Data → Records of processing (ADR 0036 part 17, GDPR Art. 30): per data object with personal data, the products that
 * process it, purposes, legal basis, categories of data and subjects, recipients (registered consumers and consuming
 * products), retention and the platforms with their suppliers and DPA – a working view for the data protection
 * officer, exported as CSV or PDF. What the reader may not see is counted, never named.
 */
export function RecordsOfProcessingPage() {
  const { t } = useTranslation(['dataProductGovernance', 'dataProducts']);
  const [params, setParams] = useSearchParams();
  const domain = params.get('domain') ?? '';
  const personalData = params.get('personalData') ?? '';
  const text = params.get('q') ?? '';
  const query = qs({ domain, personalData, q: text });
  const q = useRopa(query);
  const domains = useDomains();
  const subject = useSubjectLabel();
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  const list = (xs: string[], hidden = 0) => (
    <Stack gap={2}>
      {xs.length
        ? xs.map((x, i) => (
            <Text key={i} size="sm" style={{ overflowWrap: 'anywhere' }}>
              {x}
            </Text>
          ))
        : !hidden && <Text size="sm">–</Text>}
      <HiddenCount count={hidden} />
    </Stack>
  );
  const recipients = (e: DataRopaEntry) => e.recipients.map((r) => `${r.kind === 'team' || r.kind === 'user' ? subject(r.label) : r.label} (${r.via})`);
  const basis = (e: DataRopaEntry) => (e.legalBasis ? t(`dataProducts:objects.legalBases.${e.legalBasis}`) : '–');
  const processors = (e: DataRopaEntry) =>
    e.processors.map((p) =>
      [
        p.platform,
        p.supplier,
        p.contract,
        p.supplier ? (p.personalData === null ? t('ropa.pdUnknown') : p.personalData ? t('ropa.pdYes') : t('ropa.pdNo')) : '',
        p.supplier ? t(`ropa.dpa.${(p.dpa ?? 'unknown') as 'inPlace' | 'missing' | 'unknown'}`) : '',
      ]
        .filter(Boolean)
        .join(' – '),
    );
  return (
    <ListPage
      title={t('ropa.title')}
      description={t('ropa.help')}
      testId="ropa-page"
      search={{ value: text, onChange: (v) => set('q', v), label: t('ropa.search'), placeholder: t('ropa.search') }}
      activeFilters={[domain, personalData].filter(Boolean).length}
      filters={
        <Group gap="xs" wrap="wrap">
          <Select
            size="xs"
            label={t('ropa.domain')}
            placeholder={t('ropa.allDomains')}
            data={(domains.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
            value={domain || null}
            onChange={(v) => set('domain', v ?? '')}
            clearable
            w={{ base: '100%', xs: 220 }}
            data-testid="ropa-domain"
          />
          <SegmentedControl
            size="xs"
            aria-label={t('ropa.personalData')}
            value={personalData || 'all'}
            onChange={(v) => set('personalData', v === 'all' ? '' : v)}
            data={[
              { value: 'all', label: t('ropa.all') },
              { value: 'personal', label: t('dataProducts:personalData.personal') },
              { value: 'special', label: t('dataProducts:personalData.special') },
            ]}
          />
        </Group>
      }
      actions={
        <>
          <Button
            component="a"
            href={apiUrl(`/data-products/records-of-processing.csv?${query}`)}
            size="xs"
            variant="default"
            leftSection={<IconFileTypeCsv size={14} />}
            data-testid="ropa-csv"
          >
            {t('ropa.csv')}
          </Button>
          <Button
            component="a"
            href={apiUrl(`/data-products/records-of-processing.pdf?${query}`)}
            size="xs"
            variant="default"
            leftSection={<IconFileTypePdf size={14} />}
            data-testid="ropa-pdf"
          >
            {t('ropa.pdf')}
          </Button>
        </>
      }
    >
      <Alert variant="light" color="blue" p="xs" mb="sm">
        {t('ropa.disclaimer')}
      </Alert>
      <QueryState query={q} />
      {q.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed" data-testid="ropa-empty">
          {t('ropa.empty')}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          testId="ropa-table"
          ariaLabel={t('ropa.title')}
          rows={rows}
          rowKey={(e) => e.object.id}
          columns={[
            {
              key: 'object',
              header: t('ropa.object'),
              cell: (e) => (
                <Stack gap={2}>
                  <Anchor component={Link} to={`/data-objects/${enc(e.object.id)}`} size="sm" fw={600}>
                    {e.object.name}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {[e.domain ? (e.domain.hidden ? t('ropa.hiddenDomain') : e.domain.name) : null, e.object.key].filter(Boolean).join(' · ')}
                  </Text>
                  <PersonalDataBadge value={e.personalData} size="xs" />
                </Stack>
              ),
              sortValue: (e) => e.object.name,
            },
            {
              key: 'data',
              header: t('ropa.categories'),
              cell: (e) => (
                <Stack gap={2}>
                  <Text size="sm">{e.categories.join(', ') || '–'}</Text>
                  {e.specialCategories.length > 0 && (
                    <Text size="xs" c="red">
                      {t('ropa.special', { list: e.specialCategories.join(', ') })}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    {t('ropa.subjects', { list: e.subjects.join(', ') || '–' })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: 'basis',
              header: t('ropa.legalBasis'),
              cell: (e) => (
                <Stack gap={2}>
                  <Text size="sm">{basis(e)}</Text>
                  {e.purposes.length > 0 && (
                    <Text size="xs" c="dimmed">
                      {t('ropa.purposes', { list: e.purposes.join(', ') })}
                    </Text>
                  )}
                </Stack>
              ),
            },
            {
              key: 'products',
              header: t('ropa.products'),
              cell: (e) => (
                <Stack gap={2}>
                  {e.products.map((p) => (
                    <div key={p.product.id}>
                      <RefLink r={p.product} base="/data-products" />
                      {p.purpose && (
                        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                          {p.purpose}
                        </Text>
                      )}
                    </div>
                  ))}
                  {!e.products.length && !e.hiddenProducts && <Text size="sm">–</Text>}
                  <HiddenCount count={e.hiddenProducts} />
                </Stack>
              ),
            },
            {
              key: 'recipients',
              header: t('ropa.recipients'),
              cell: (e) => list(recipients(e), e.hiddenRecipients),
            },
            { key: 'processors', header: t('ropa.processors'), cell: (e) => list(processors(e), e.hiddenProcessors) },
            {
              key: 'retention',
              header: t('ropa.retention'),
              cell: (e) => (
                <Stack gap={2}>
                  <Text size="sm">{e.retention || '–'}</Text>
                  {e.deletionRule && (
                    <Text size="xs" c="dimmed">
                      {e.deletionRule}
                    </Text>
                  )}
                </Stack>
              ),
            },
          ]}
          card={(e) => (
            <Paper withBorder p="sm" component="article" aria-labelledby={`ropa-${e.object.id}`} data-testid="ropa-card">
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Anchor id={`ropa-${e.object.id}`} component={Link} to={`/data-objects/${enc(e.object.id)}`} fw={600}>
                    {e.object.name}
                  </Anchor>
                  <PersonalDataBadge value={e.personalData} size="xs" />
                </Group>
                {/* everything the table says: a DPO reads the Art. 30 view on a phone too */}
                <Text size="xs">
                  {t('ropa.legalBasis')}: {basis(e)}
                </Text>
                {e.purposes.length > 0 && <Text size="xs">{t('ropa.purposes', { list: e.purposes.join(', ') })}</Text>}
                <Text size="xs">
                  {t('ropa.categories')}: {e.categories.join(', ') || '–'}
                </Text>
                {e.specialCategories.length > 0 && (
                  <Text size="xs" c="red">
                    {t('ropa.special', { list: e.specialCategories.join(', ') })}
                  </Text>
                )}
                <Text size="xs">{t('ropa.subjects', { list: e.subjects.join(', ') || '–' })}</Text>
                <Text size="xs">
                  {t('ropa.products')}: {e.products.map((p) => p.product.name).join(', ') || '–'}
                </Text>
                <HiddenCount count={e.hiddenProducts} />
                <Text size="xs">
                  {t('ropa.recipients')}: {recipients(e).join(', ') || '–'}
                </Text>
                <HiddenCount count={e.hiddenRecipients} />
                <Text size="xs">
                  {t('ropa.processors')}: {processors(e).join('; ') || '–'}
                </Text>
                <HiddenCount count={e.hiddenProcessors} />
                <Text size="xs">
                  {t('ropa.retention')}: {e.retention || '–'}
                  {e.deletionRule && ` – ${e.deletionRule}`}
                </Text>
              </Stack>
            </Paper>
          )}
        />
      )}
    </ListPage>
  );
}
