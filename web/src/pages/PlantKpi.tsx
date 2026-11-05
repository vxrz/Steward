import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Code, Grid, Group, List, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconAlertTriangle, IconDownload, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { KpiColumn, KpiInput, KpiParameter, PlantKpiDetail, PlantKpiValues, PlantProfileSummary } from '@sm/shared';
import { apiUrl, del, get, notifyError, put } from '../api';
import { DetailState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge, useNameOf, usePlantLabel } from '../components/plant/common';
import { AssetBriefLink, Breakable, ChecksList, RowMenu, UnitText } from '../components/plant/data';
import { ComputationModal, KpiColumnModal, KpiFormModal, KpiInputModal, KpiParameterModal } from '../components/plant/dataForms';
import { SourceLine } from './PlantSite';

const valuesOf = (k: PlantKpiDetail): PlantKpiValues => ({
  id: k.id,
  name: k.name,
  names: k.names,
  category: k.category,
  type: k.type,
  description: k.description,
  formula: k.formula,
  unit: k.unit,
  rangeMin: k.rangeMin,
  rangeMax: k.rangeMax,
  trend: k.trend,
  timing: k.timing,
  audience: k.audience,
  methodology: k.methodology,
  strategy: k.strategy,
  implementation: k.implementation,
  dynamicColumns: k.dynamicColumns,
  inputs: k.inputs,
  parameters: k.parameters,
  columns: k.columns,
  computation: k.computation,
  notes: k.notes,
});

type Dialog =
  | { kind: 'kpi' }
  | { kind: 'input'; index: number | null }
  | { kind: 'param'; index: number | null }
  | { kind: 'column'; index: number | null }
  | { kind: 'computation' };

/** A list with one item replaced (index) or added (null). */
const putAt = <T,>(list: T[], index: number | null, item: T) => (index === null ? [...list, item] : list.map((x, i) => (i === index ? item : x)));

function Section({ title, help, action, children, testId }: { title: string; help?: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Stack gap="xs" data-testid={testId}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title order={2} fz="h4">
            {title}
          </Title>
          {help && (
            <Text size="xs" c="dimmed">
              {help}
            </Text>
          )}
        </div>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

/**
 * A KPI definition (#219): its ISO 22400-2 attributes, the data points it reads, its parameters, the columns it writes
 * (sum, ratio, ignore), how it is computed and what it cannot tell, what Steward finds wrong with it, the assets with
 * an instance and those that could have one.
 */
export function PlantKpiPage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const { kpiId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const q = useQuery({ queryKey: plantKeys.kpi(kpiId), queryFn: () => get<PlantKpiDetail>(`/plant/kpis/${encodeURIComponent(kpiId!)}`) });
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles') });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const k = q.data;
  useEffect(() => {
    if (k?.canManage && search.get('edit') === '1') {
      setDialog({ kind: 'kpi' });
      setSearch({}, { replace: true });
    }
  }, [k?.canManage, search, setSearch]);
  if (!k) return <DetailState query={q} back="plantKpis" />;
  const base = `/plant/kpis/${encodeURIComponent(k.id)}`;
  const values = valuesOf(k);
  const save = async (next: PlantKpiValues) => {
    const { id: _id, ...body } = next;
    qc.setQueryData(plantKeys.kpi(kpiId), await put<PlantKpiDetail>(base, body));
    void qc.invalidateQueries({ queryKey: plantKeys.kpis });
    void qc.invalidateQueries({ queryKey: plantKeys.checks });
  };
  const removeFrom = async <K extends 'inputs' | 'parameters' | 'columns'>(key: K, index: number, what: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t('kpi.removeConfirm', { what }) }))) return;
    await save({ ...values, [key]: values[key].filter((_, i) => i !== index) }).catch(notifyError);
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('kpi.deleteConfirm', { name: k.name }) }))) return;
    try {
      await del(base);
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      navigate('/plant/kpis');
    } catch (e) {
      notifyError(e);
    }
  };
  const add = (kind: 'input' | 'param' | 'column', text: string) =>
    k.canManage && (
      <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setDialog({ kind, index: null })}>
        {text}
      </Button>
    );
  type Fact = { label: string; value: ReactNode };
  const facts: (Fact | false | '' | null)[] = [
    k.unit && { label: t('data.unit'), value: <UnitText unit={k.unit} /> },
    (k.rangeMin !== null || k.rangeMax !== null) && { label: t('kpi.range'), value: `${k.rangeMin ?? '…'} – ${k.rangeMax ?? '…'}` },
    k.trend && { label: t('kpi.trend'), value: t(`kpi.trends.${k.trend}`) },
    k.timing && { label: t('kpi.timing'), value: t(`kpi.timings.${k.timing}`) },
    k.audience.length > 0 && { label: t('kpi.audience'), value: k.audience.map((a) => t(`kpi.audiences.${a}`)).join(', ') },
    k.methodology && { label: t('kpi.methodology'), value: t(`kpi.methodologies.${k.methodology}`) },
  ];
  const iso = facts.filter((x): x is Fact => !!x);
  const c = k.computation;
  return (
    <>
      <DetailHeader
        recent={{ label: nameOf(k), kind: 'kpi' }}
        back="plantKpis"
        title={nameOf(k)}
        status={
          <>
            {k.category && <Badge variant="default">{k.category}</Badge>}
            {k.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        description={k.description || undefined}
        actions={
          <>
            {k.canManage && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setDialog({ kind: 'kpi' })}>
                {t('common:edit')}
              </Button>
            )}
            {k.canManage && <DuplicateButton kind="kpi-definition" id={k.id} />}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/plant/export?kpi=${encodeURIComponent(k.id)}`)}
              download
              leftSection={<IconDownload size={14} />}
            >
              {t('export.one')}
            </Button>
          </>
        }
        menu={
          k.canManage ? { items: [{ label: t('kpi.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'kpi-delete' }] } : undefined
        }
      />
      <CopiedFromNote kind="kpi-definition" id={k.id} pathOf={(id) => `/plant/kpis/${encodeURIComponent(id)}`} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {k.checks.length > 0 && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={t('checks.problems', { count: k.checks.length })}>
                <ChecksList checks={k.checks} testId="kpi-checks" />
              </Alert>
            )}
            {(k.formula || iso.length > 0) && (
              <Paper withBorder p="md" data-testid="kpi-iso">
                <Stack gap="xs">
                  <Title order={2} fz="h5">
                    {t('kpi.iso')}
                  </Title>
                  {k.formula && (
                    <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {k.formula}
                    </Code>
                  )}
                  {iso.length > 0 && (
                    <Group gap="lg" wrap="wrap">
                      {iso.map((x) => (
                        <Field key={x.label} label={x.label}>
                          {x.value}
                        </Field>
                      ))}
                    </Group>
                  )}
                </Stack>
              </Paper>
            )}
            <Section title={t('kpi.inputs')} help={t('kpi.inputsHelp')} action={add('input', t('kpi.addInput'))} testId="kpi-inputs">
              {k.inputs.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('kpi.noInputs')}
                </Text>
              ) : (
                <Stack gap="xs">
                  {k.inputs.map((input, i) => (
                    <Paper key={i} withBorder p="sm">
                      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                        <Stack gap={4} style={{ minWidth: 0 }}>
                          {input.kind === 'data_point' ? (
                            <>
                              {input.profile ? (
                                k.profileNames[input.profile] ? (
                                  <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(input.profile)}`} size="sm" fw={500} w="fit-content">
                                    {k.profileNames[input.profile]}
                                  </Anchor>
                                ) : (
                                  <Text size="sm" c="orange.8" className="mono">
                                    {input.profile}
                                  </Text>
                                )
                              ) : (
                                <Text size="sm">{t('kpi.anyProfile')}</Text>
                              )}
                              <Group gap={4} wrap="wrap">
                                {input.dataPoints.map((d) =>
                                  input.profile && k.profileNames[input.profile] ? (
                                    <Badge
                                      key={d}
                                      variant="default"
                                      tt="none"
                                      size="sm"
                                      component={Link}
                                      to={`/plant/profiles/${encodeURIComponent(input.profile)}/points/${encodeURIComponent(d)}`}
                                      style={{ cursor: 'pointer' }}
                                    >
                                      <span className="mono">{d}</span>
                                    </Badge>
                                  ) : (
                                    <Badge key={d} variant="default" tt="none" size="sm">
                                      <span className="mono">{d}</span>
                                    </Badge>
                                  ),
                                )}
                              </Group>
                            </>
                          ) : (
                            <Text size="sm" fw={500}>
                              {t('kpi.inputKinds.other')}
                            </Text>
                          )}
                          {input.notes && (
                            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
                              {input.notes}
                            </Text>
                          )}
                        </Stack>
                        {k.canManage && (
                          <RowMenu
                            label={t('kpi.inputActions', { n: i + 1 })}
                            onEdit={() => setDialog({ kind: 'input', index: i })}
                            onRemove={() => void removeFrom('inputs', i, t('kpi.inputN', { n: i + 1 }))}
                          />
                        )}
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              )}
            </Section>
            <Section title={t('kpi.parameters')} help={t('kpi.parametersHelp')} action={add('param', t('kpi.addParameter'))} testId="kpi-parameters">
              {k.parameters.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('kpi.noParameters')}
                </Text>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={t('kpi.parameters')}>
                  <Table fz="sm" aria-label={t('kpi.parameters')} layout="fixed" miw={600}>
                    <colgroup>
                      <col style={{ width: '26%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '13%' }} />
                      <col style={{ width: '15%' }} />
                      <col />
                      {k.canManage && <col style={{ width: 40 }} />}
                    </colgroup>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('kpi.paramName')}</Table.Th>
                        <Table.Th>{t('kpi.paramType')}</Table.Th>
                        <Table.Th>{t('kpi.default')}</Table.Th>
                        <Table.Th>{t('kpi.range')}</Table.Th>
                        <Table.Th>{t('form.description')}</Table.Th>
                        {k.canManage && <Table.Th aria-label={t('actions')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {k.parameters.map((p, i) => (
                        <Table.Tr key={p.name}>
                          <Table.Td>
                            <Text size="sm" className="mono code-wrap" fw={500}>
                              <Breakable text={p.name} />
                            </Text>
                            {p.aliases.length > 0 && (
                              <Text size="xs" c="dimmed" className="mono code-wrap">
                                {t('kpi.aliasesAre', { aliases: p.aliases.join(', ') })}
                              </Text>
                            )}
                            {p.required && (
                              <Badge size="xs" variant="light" color="blue">
                                {t('kpi.requiredBadge')}
                              </Badge>
                            )}
                          </Table.Td>
                          <Table.Td>{t(`kpi.paramTypes.${p.type}`)}</Table.Td>
                          <Table.Td className="mono">
                            {p.default === null ? '–' : String(p.default)}
                            {p.unit && <Text span size="xs" c="dimmed">{` ${p.unit}`}</Text>}
                          </Table.Td>
                          <Table.Td>{p.min === null && p.max === null ? '–' : `${p.min ?? '…'} – ${p.max ?? '…'}`}</Table.Td>
                          <Table.Td>
                            <Text size="xs" style={{ whiteSpace: 'pre-line' }}>
                              {p.description || '–'}
                            </Text>
                          </Table.Td>
                          {k.canManage && (
                            <Table.Td>
                              <RowMenu
                                label={t('kpi.paramActions', { name: p.name })}
                                onEdit={() => setDialog({ kind: 'param', index: i })}
                                onRemove={() => void removeFrom('parameters', i, p.name)}
                              />
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Section>
            <Section title={t('kpi.columns')} help={t('kpi.columnsHelp')} action={add('column', t('kpi.addColumn'))} testId="kpi-columns">
              {k.dynamicColumns && (
                <Text size="xs" c="dimmed">
                  {t('kpi.dynamicColumnsNote')}
                </Text>
              )}
              {k.columns.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('kpi.noColumns')}
                </Text>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={t('kpi.columns')}>
                  <Table fz="sm" aria-label={t('kpi.columns')} layout="fixed" miw={600}>
                    <colgroup>
                      <col style={{ width: '25%' }} />
                      <col style={{ width: '22%' }} />
                      <col style={{ width: '8%' }} />
                      <col style={{ width: '10%' }} />
                      <col />
                      {k.canManage && <col style={{ width: 40 }} />}
                    </colgroup>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('kpi.columnName')}</Table.Th>
                        <Table.Th>{t('kpi.columnKind')}</Table.Th>
                        <Table.Th>{t('data.unit')}</Table.Th>
                        <Table.Th>{t('kpi.scope')}</Table.Th>
                        <Table.Th>{t('form.description')}</Table.Th>
                        {k.canManage && <Table.Th aria-label={t('actions')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {k.columns.map((col, i) => (
                        <Table.Tr key={col.name}>
                          <Table.Td className="mono code-wrap">
                            <Breakable text={col.name} />
                          </Table.Td>
                          <Table.Td>
                            <Badge size="sm" variant="light" color={col.kind === 'ratio' ? 'blue' : col.kind === 'ignore' ? 'gray' : 'teal'}>
                              {t(`kpi.columnKinds.${col.kind}`)}
                            </Badge>
                            {col.kind === 'ratio' && (
                              <Text size="xs" c="dimmed" className="mono code-wrap">
                                <Breakable text={`${col.numerator || '?'} / ${col.denominator || '?'}${col.scale !== null ? ` × ${col.scale}` : ''}`} />
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <UnitText unit={col.unit} />
                          </Table.Td>
                          <Table.Td>{col.scope || '–'}</Table.Td>
                          <Table.Td>
                            <Text size="xs" style={{ whiteSpace: 'pre-line' }}>
                              {col.description || '–'}
                            </Text>
                          </Table.Td>
                          {k.canManage && (
                            <Table.Td>
                              <RowMenu
                                label={t('kpi.columnActions', { name: col.name })}
                                onEdit={() => setDialog({ kind: 'column', index: i })}
                                onRemove={() => void removeFrom('columns', i, col.name)}
                              />
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Section>
            <Section
              title={t('kpi.computation')}
              action={
                k.canManage && (
                  <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={() => setDialog({ kind: 'computation' })}>
                    {t('common:edit')}
                  </Button>
                )
              }
              testId="kpi-computation"
            >
              {!c.summary && !c.steps.length && !c.identities.length && !c.limits.length && !c.diagram ? (
                <Text size="sm" c="dimmed">
                  {t('kpi.noComputation')}
                </Text>
              ) : (
                <Stack gap="sm">
                  {c.summary && (
                    <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                      {c.summary}
                    </Text>
                  )}
                  {c.steps.length > 0 && (
                    <List type="ordered" size="sm" spacing={4}>
                      {c.steps.map((s, i) => (
                        <List.Item key={i}>
                          <Text size="sm" fw={500} span>
                            {s.name}
                          </Text>
                          {s.does && <Text size="sm">{s.does}</Text>}
                          {s.why && (
                            <Text size="xs" c="dimmed">
                              {t('kpi.why', { why: s.why })}
                            </Text>
                          )}
                        </List.Item>
                      ))}
                    </List>
                  )}
                  {c.identities.length > 0 && (
                    <Stack gap={4}>
                      <Text size="sm" fw={600}>
                        {t('kpi.identities')}
                      </Text>
                      {c.identities.map((x, i) => (
                        <div key={i}>
                          <Code>{x.relation}</Code>
                          {x.note && (
                            <Text size="xs" c="dimmed">
                              {x.note}
                            </Text>
                          )}
                        </div>
                      ))}
                    </Stack>
                  )}
                  {c.limits.length > 0 && (
                    <Stack gap={4}>
                      <Text size="sm" fw={600}>
                        {t('kpi.limits')}
                      </Text>
                      <List size="sm" spacing={2}>
                        {c.limits.map((x, i) => (
                          <List.Item key={i}>{x}</List.Item>
                        ))}
                      </List>
                    </Stack>
                  )}
                  {c.diagram && (
                    <Stack gap={4}>
                      <Text size="sm" fw={600}>
                        {t('kpi.diagram')}
                      </Text>
                      {/* focusable: it may scroll (keyboard access to the scroll region) */}
                      <Code block style={{ maxHeight: 320, overflow: 'auto' }} tabIndex={0} role="region" aria-label={t('kpi.diagram')}>
                        {c.diagram}
                      </Code>
                    </Stack>
                  )}
                </Stack>
              )}
            </Section>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            <Paper withBorder p="md" data-testid="kpi-instances">
              <Stack gap="xs">
                <Title order={2} fz="h5">
                  {t('kpi.instancesOn', { type: label('asset', true) })}
                </Title>
                {k.instances.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('kpi.noInstances')}
                  </Text>
                ) : (
                  <Stack gap={6}>
                    {k.instances.map((x) => (
                      <Stack key={`${x.asset.id}:${x.job}`} gap={0}>
                        <AssetBriefLink asset={x.asset} />
                        <Group gap={6}>
                          <Text size="xs" c="dimmed" className="mono">
                            {x.job}
                          </Text>
                          {!x.active && (
                            <Badge size="xs" variant="default">
                              {t('assignment.inactive')}
                            </Badge>
                          )}
                          {x.problems > 0 && (
                            <Badge size="xs" color="orange" variant="light">
                              {t('checks.problems', { count: x.problems })}
                            </Badge>
                          )}
                        </Group>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>
            <Paper withBorder p="md" data-testid="kpi-candidates">
              <Stack gap="xs">
                <Title order={2} fz="h5">
                  {t('kpi.candidates', { type: label('asset', true) })}
                </Title>
                <Text size="xs" c="dimmed">
                  {t('kpi.candidatesHelp')}
                </Text>
                {k.candidates.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('kpi.noCandidates')}
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {k.candidates.map((a) => (
                      <AssetBriefLink key={a.id} asset={a} />
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Field label={t('form.id')}>
                  <span className="mono">{k.id}</span>
                </Field>
                {k.type && <Field label={t('kpi.type')}>{k.type}</Field>}
                {k.strategy && (
                  <Field label={t('kpi.strategy')}>
                    <span className="mono">{k.strategy}</span>
                  </Field>
                )}
                {k.implementation && (
                  <Field label={t('kpi.implementation')}>
                    <Text size="sm" className="mono code-wrap">
                      <Breakable text={k.implementation} />
                    </Text>
                  </Field>
                )}
                {k.notes && (
                  <Field label={t('data.notes')}>
                    <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                      {k.notes}
                    </Text>
                  </Field>
                )}
                <SourceLine importId={k.importId} />
                <Text size="xs" c="dimmed">
                  {t('changedBy', { user: k.updatedBy, date: fmtDate(k.updatedAt) })}
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
      {dialog?.kind === 'kpi' && <KpiFormModal kpi={values} onClose={() => setDialog(null)} onSave={save} />}
      {dialog?.kind === 'input' && (
        <KpiInputModal
          input={dialog.index === null ? undefined : k.inputs[dialog.index]}
          profiles={profiles.data ?? []}
          onClose={() => setDialog(null)}
          onSave={(x: KpiInput) => save({ ...values, inputs: putAt(values.inputs, dialog.index, x) })}
        />
      )}
      {dialog?.kind === 'param' && (
        <KpiParameterModal
          param={dialog.index === null ? undefined : k.parameters[dialog.index]}
          taken={k.parameters.filter((_, i) => i !== dialog.index).flatMap((p) => [p.name, ...p.aliases])}
          onClose={() => setDialog(null)}
          onSave={(x: KpiParameter) => save({ ...values, parameters: putAt(values.parameters, dialog.index, x) })}
        />
      )}
      {dialog?.kind === 'column' && (
        <KpiColumnModal
          column={dialog.index === null ? undefined : k.columns[dialog.index]}
          columns={k.columns.map((x) => x.name)}
          onClose={() => setDialog(null)}
          onSave={(x: KpiColumn) => save({ ...values, columns: putAt(values.columns, dialog.index, x) })}
        />
      )}
      {dialog?.kind === 'computation' && (
        <ComputationModal value={k.computation} onClose={() => setDialog(null)} onSave={(computation) => save({ ...values, computation })} />
      )}
    </>
  );
}
