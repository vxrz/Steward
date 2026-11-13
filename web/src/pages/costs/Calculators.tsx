import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowLeft, IconCalculator, IconDownload, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import YAML from 'yaml';
import {
  ISO_4217_CODES,
  type CostCalculatorDetail,
  type CostCalculatorInputDef,
  type CostCalculatorSummary,
  type CostDryRunResult,
  type CostInputValue,
} from '@sm/shared';
import { apiUrl, del, get, notifyError, notifyOk, post, put } from '../../api';
import { QueryState } from '../../components/common';
import { ListPage } from '../../components/page/ListPage';
import { DetailPage } from '../../components/page/DetailPage';
import { ServiceTabs } from '../../components/page/LinkTabs';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { OwningTeams } from '../../components/OwningTeams';
import { confirmDialog } from '../../components/confirm';
import { estimateKeys } from '../../components/costs/Estimates';
import { InputsForm, ResultView } from './Estimate';

/**
 * Calculators (0.21.0, ADR 0035 part 5): the list, and the editor of one – its definition as YAML (inputs, named values,
 * lines whose formulas produce quantities), a draft tried with Calculate (the dry run, nothing stored), Publish as a new
 * version, Export for Git.
 */

const calcPath = (id: string) => `/costs/calculators/${encodeURIComponent(id)}`;
const CURRENCIES = [...ISO_4217_CODES].sort();

const TEMPLATE = `kind: costCalculator
id: my-calculator
name: My calculator
inputs:
  - { key: rate, label: Requests per second, type: number, unit: '{request}/s', default: 10, min: 0 }
let:
  perMonth: inputs.rate * 3600 * const.hoursPerMonth
lines:
  - { key: requests, item: { provider: Invented Provider AG, sku: api-request }, quantity: let.perMonth, unit: '{request}' }
`;

export function CalculatorsPage() {
  const { t } = useTranslation('costs');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: estimateKeys.calculators, queryFn: () => get<CostCalculatorSummary[]>('/costs/calculators') });
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((c) => !needle || [c.name, c.description, ...c.providers].some((x) => x.toLowerCase().includes(needle)));
  const add = async () => {
    try {
      const c = await post<CostCalculatorDetail>('/costs/calculators', {
        definition: TEMPLATE.replace('my-calculator', `calculator-${Date.now().toString(36)}`),
      });
      navigate(calcPath(c.id));
    } catch (err) {
      notifyError(err);
    }
  };
  const columns: DataColumn<CostCalculatorSummary>[] = [
    {
      key: 'name',
      header: t('calculators.columns.name'),
      cell: (c) => (
        <Stack gap={2}>
          <Anchor component={Link} to={calcPath(c.id)} size="sm" fw={500}>
            {c.name}
          </Anchor>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {c.description}
          </Text>
        </Stack>
      ),
      sortValue: (c) => c.name,
    },
    { key: 'providers', header: t('calculators.columns.providers'), cell: (c) => c.providers.join(', ') },
    {
      key: 'version',
      header: t('calculators.columns.version'),
      cell: (c) => (
        <Group gap={4}>
          <Text size="sm">{c.version ? `v${c.version}` : '–'}</Text>
          {c.hasDraft && (
            <Badge size="xs" variant="light" color="yellow">
              {t('calculators.draft')}
            </Badge>
          )}
          {c.source === 'git' && (
            <Badge size="xs" variant="light" color="gray">
              {t('calculators.git')}
            </Badge>
          )}
        </Group>
      ),
      nowrap: true,
    },
    { key: 'inputs', header: t('calculators.columns.inputs'), cell: (c) => c.inputs, nowrap: true },
    { key: 'lines', header: t('calculators.columns.lines'), cell: (c) => c.lines, nowrap: true },
  ];
  return (
    <ListPage
      tabs={<ServiceTabs active="/costs" />}
      testId="calculators-page"
      title={t('calculators.title')}
      description={t('calculators.description')}
      primaryAction={
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => void add()} data-testid="calculator-add">
          {t('calculators.add')}
        </Button>
      }
      actions={
        <Group gap="xs">
          <Button size="xs" variant="subtle" component={Link} to="/costs/price-books" leftSection={<IconArrowLeft size={14} />}>
            {t('prices.title')}
          </Button>
        </Group>
      }
      search={{ value: search, onChange: setSearch, label: t('calculators.search') }}
      empty={{ show: !q.isLoading && !(q.data ?? []).length, icon: IconCalculator, title: t('calculators.empty.title'), text: t('calculators.empty.text') }}
    >
      <QueryState query={q} />
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(c) => c.id}
          ariaLabel={t('calculators.title')}
          rowHref={(c) => calcPath(c.id)}
          testId="calculators-table"
          card={(c) => (
            <Stack gap={2}>
              <Anchor component={Link} to={calcPath(c.id)} size="sm" fw={500}>
                {c.name}
              </Anchor>
              <Text size="xs" c="dimmed">
                {c.providers.join(', ')} · {c.version ? `v${c.version}` : '–'}
              </Text>
            </Stack>
          )}
        />
      )}
    </ListPage>
  );
}

/** The inputs of a definition being edited (YAML read in the browser; the server checks it again). */
function inputsOf(text: string): CostCalculatorInputDef[] {
  try {
    const raw = YAML.parse(text) as { inputs?: unknown };
    return Array.isArray(raw?.inputs)
      ? (raw.inputs as CostCalculatorInputDef[]).filter((i) => i && typeof i.key === 'string' && typeof i.type === 'string')
      : [];
  } catch {
    return [];
  }
}

export function CalculatorPage() {
  const { t } = useTranslation('costs');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: estimateKeys.calculator(id), queryFn: () => get<CostCalculatorDetail>(`/costs/calculators/${encodeURIComponent(id)}`) });
  const c = q.data;
  const [text, setText] = useState('');
  const [inputs, setInputs] = useState<Map<string, CostInputValue>>(new Map());
  const [currency, setCurrency] = useState('USD');
  const [result, setResult] = useState<CostDryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (c) setText(c.draft ?? c.definition);
  }, [c]);
  const defs = useMemo(() => inputsOf(text), [text]);
  if (!c) return <QueryState query={q} />;
  const save = async (publish: boolean) => {
    setBusy(true);
    try {
      const r = await put<CostCalculatorDetail>(`/costs/calculators/${encodeURIComponent(c.id)}`, { definition: text, publish });
      qc.setQueryData(estimateKeys.calculator(id), r);
      void qc.invalidateQueries({ queryKey: estimateKeys.calculators });
      notifyOk(publish ? t('calculators.published', { version: r.version }) : t('calculators.draftSaved'));
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const calculate = async () => {
    setBusy(true);
    try {
      setResult(
        await post<CostDryRunResult>('/costs/calculate', {
          variants: [{ ...(c.canEdit ? { definition: text } : { calculatorId: c.id }), currency, inputs: [...inputs].map(([key, value]) => ({ key, value })) }],
        }),
      );
    } catch (err) {
      notifyError(err);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ action: 'delete', message: t('calculators.removeConfirm', { name: c.name }) }))) return;
    try {
      await del(`/costs/calculators/${encodeURIComponent(c.id)}`);
      void qc.invalidateQueries({ queryKey: estimateKeys.calculators });
      navigate('/costs/calculators');
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <DetailPage
      back={[
        { to: '/costs', label: t('title') },
        { to: '/costs/calculators', label: t('calculators.title') },
      ]}
      title={c.name}
      status={
        <Group gap={4}>
          <Badge size="xs" variant="outline" color="gray">
            {c.version ? `v${c.version}` : t('calculators.unpublished')}
          </Badge>
          {c.hasDraft && (
            <Badge size="xs" variant="light" color="yellow">
              {t('calculators.draft')}
            </Badge>
          )}
        </Group>
      }
      description={c.description || t('calculators.pageHelp')}
      actions={
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            component="a"
            href={apiUrl(`/costs/calculators/${encodeURIComponent(c.id)}/export`)}
            leftSection={<IconDownload size={14} />}
          >
            {t('calculators.export')}
          </Button>
          {c.canEdit && (
            <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove()}>
              {t('calculators.remove')}
            </Button>
          )}
        </Group>
      }
    >
      <Stack gap="lg" data-testid="calculator-page">
        <Alert color="gray" variant="light">
          {t('calculators.quantitiesOnly')}
        </Alert>
        {c.checked && (
          <Text size="xs" c="dimmed">
            {t('calculators.checked', { date: c.checked })}
          </Text>
        )}
        <Textarea
          label={t('calculators.definition')}
          description={t('calculators.definitionHelp')}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={14}
          maxRows={40}
          readOnly={!c.canEdit}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
          spellCheck={false}
          data-testid="calculator-definition"
        />
        {c.canEdit && (
          <Group gap="xs">
            <Button variant="default" loading={busy} onClick={() => void save(false)} data-testid="calculator-save-draft">
              {t('calculators.saveDraft')}
            </Button>
            <Button loading={busy} onClick={() => void save(true)} data-testid="calculator-publish">
              {t('calculators.publish')}
            </Button>
          </Group>
        )}
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Title order={3} size="h5">
              {t('calculators.tryTitle')}
            </Title>
            <Text size="xs" c="dimmed">
              {t('calculators.tryHelp')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Select label={t('estimates.new.currency')} searchable data={CURRENCIES} value={currency} onChange={(v) => v && setCurrency(v)} />
            </SimpleGrid>
            <InputsForm defs={defs} values={inputs} disabled={false} onChange={setInputs} />
            <Group>
              <Button leftSection={<IconPlayerPlay size={14} />} loading={busy} onClick={() => void calculate()} data-testid="calculator-calculate">
                {t('calculators.calculate')}
              </Button>
            </Group>
          </Stack>
        </Paper>
        {result && <ResultView r={result.variants[0]!.result} />}
        {c.versions.length > 0 && (
          <Stack gap={4}>
            <Title order={3} size="h5">
              {t('calculators.versions')}
            </Title>
            {c.versions.map((v) => (
              <Text key={v.number} size="sm">
                {t('calculators.versionLine', { n: v.number, at: v.publishedAt.slice(0, 10), by: v.publishedBy })}
              </Text>
            ))}
          </Stack>
        )}
        <OwningTeams kind="cost_calculator" id={c.id} />
      </Stack>
    </DetailPage>
  );
}
