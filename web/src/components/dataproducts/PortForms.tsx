import { useState } from 'react';
import { Alert, MultiSelect, NumberInput, Paper, SegmentedControl, Select, SimpleGrid, Stack, TagsInput, Text, Textarea, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DATA_AGREEMENT_KINDS,
  DATA_CONSUMER_KINDS,
  DATA_PORT_LIFECYCLES,
  DATA_PORT_TYPES,
  DATA_FILE_FORMATS,
  DATA_PORT_PARTITION_KEYS,
  type DataFileFormat,
  DATA_PRODUCT_LIMITS as L,
  type ApplicationSummary,
  type DataAgreementKind,
  type DataConsumer,
  type DataConsumerInput,
  type DataContractDetail,
  type DataContractSummary,
  type DataObjectives,
  type DataObjectSummary,
  type DataPage,
  type DataPort,
  type DataPortDirection,
  type DataPortInput,
  type DataPortLifecycle,
  type DataPortType,
  type DataProductSummary,
  type ServiceSummary,
  type Subject,
} from '@sm/shared';
import { get, getOptional, post, put } from '../../api';
import { FormModal } from '../FormModal';
import { SubjectsInput } from '../SubjectsInput';
import { useFieldErrors } from '../common';
import { useModuleOn } from '../../modules';
import { ElementPicker, type PickedElement } from './ElementPicker';
import { FormButtons, isHttpUrl, useBusy } from './form';

const enc = encodeURIComponent;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Objectives of a port (or what a binding sets differently): freshness, availability, completeness, update schedule, retention. */
function ObjectivesInput({ value, onChange, inherited }: { value: DataObjectives; onChange: (v: DataObjectives) => void; inherited?: DataObjectives }) {
  const { t } = useTranslation('dataProducts');
  const num = (v: number | string) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hint = (k: keyof DataObjectives) =>
    inherited && inherited[k] !== null && inherited[k] !== undefined ? t('objectives.inherited', { value: String(inherited[k]) }) : undefined;
  return (
    <Paper withBorder p="sm">
      <Text size="sm" fw={600}>
        {t('objectives.title')}
      </Text>
      <Text size="xs" c="dimmed" mb="xs">
        {inherited ? t('objectives.bindingHint') : t('objectives.hint')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <NumberInput
          label={t('objectives.freshness')}
          description={hint('freshnessMinutes') ?? t('objectives.freshnessHint')}
          min={1}
          max={60 * 24 * 366}
          allowDecimal={false}
          value={value.freshnessMinutes ?? ''}
          onChange={(v) => onChange({ ...value, freshnessMinutes: num(v) })}
          data-testid="objective-freshness"
        />
        <NumberInput
          label={t('objectives.availability')}
          description={hint('availabilityPct') ?? t('objectives.availabilityHint')}
          min={0}
          max={100}
          decimalScale={2}
          suffix=" %"
          value={value.availabilityPct ?? ''}
          onChange={(v) => onChange({ ...value, availabilityPct: num(v) })}
        />
        <NumberInput
          label={t('objectives.completeness')}
          description={hint('completenessPct') ?? t('objectives.completenessHint')}
          min={0}
          max={100}
          decimalScale={2}
          suffix=" %"
          value={value.completenessPct ?? ''}
          onChange={(v) => onChange({ ...value, completenessPct: num(v) })}
          data-testid="objective-completeness"
        />
        <TextInput
          label={t('objectives.schedule')}
          description={hint('updateSchedule')}
          maxLength={L.short}
          value={value.updateSchedule ?? ''}
          onChange={(e) => onChange({ ...value, updateSchedule: e.currentTarget.value || null })}
        />
        <TextInput
          label={t('objectives.retention')}
          description={hint('retention')}
          maxLength={L.short}
          value={value.retention ?? ''}
          onChange={(e) => onChange({ ...value, retention: e.currentTarget.value || null })}
        />
      </SimpleGrid>
    </Paper>
  );
}

/** Objectives without empty entries (a binding sends only what differs). */
const objectivesToSend = (o: DataObjectives): DataObjectives =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')) as DataObjectives;

type SourceKind = 'port' | 'element' | 'text';

/**
 * A port of a product (ADR 0036 part 7): direction, name, type, version, its own lifecycle (deprecated needs a sunset
 * date), the data objects it exposes or needs, objectives, and – for an input port – where the data comes from:
 * another product's output port, an element of a source system, or a text. A port keeps its direction.
 */
export function PortForm({
  productId,
  port,
  direction,
  ports,
  onClose,
  onSaved,
}: {
  productId: string;
  port?: DataPort;
  direction: DataPortDirection;
  /** The product's ports (the successor of a deprecated one) */
  ports: DataPort[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const x = port;
  const [name, setName] = useState(x?.name ?? '');
  const [type, setType] = useState<DataPortType>(x?.type ?? 'table');
  const [version, setVersion] = useState(x?.version ?? '');
  const [description, setDescription] = useState(x?.description ?? '');
  const [lifecycle, setLifecycle] = useState<DataPortLifecycle>(x?.lifecycle ?? 'draft');
  const [sunset, setSunset] = useState(x?.sunsetDate ?? '');
  const [successor, setSuccessor] = useState<string | null>(x?.successorId ?? null);
  const [objectives, setObjectives] = useState<DataObjectives>(x?.objectives ?? {});
  const [objectIds, setObjectIds] = useState<string[]>(x?.objects.declared.filter((o) => !o.hidden).map((o) => o.id!) ?? []);
  // 0.25.0: a file port's format and partition keys
  const [fileFormat, setFileFormat] = useState<DataFileFormat | null>(x?.fileFormat ?? null);
  const [partitioning, setPartitioning] = useState<string[]>(x?.partitioning ?? []);
  const src = x?.source;
  const [sourceKind, setSourceKind] = useState<SourceKind>(src?.kind ?? 'port');
  const [sourceProduct, setSourceProduct] = useState<string | null>(src?.kind === 'port' && !src.product.hidden ? src.product.id : null);
  const [sourcePort, setSourcePort] = useState<string | null>(src?.kind === 'port' ? src.portId : null);
  const [sourceElement, setSourceElement] = useState<PickedElement[]>(src?.kind === 'element' ? [{ id: src.elementId, label: src.elementId }] : []);
  const [sourceText, setSourceText] = useState(src?.kind === 'text' ? src.text : '');
  const [busy, run] = useBusy();
  const objects = useQuery({ queryKey: ['dataProducts', 'objects', 'options'], queryFn: () => get<DataPage<DataObjectSummary>>('/data-objects?limit=100') });
  const products = useQuery({
    queryKey: ['dataProducts', 'products', 'options'],
    queryFn: () => get<DataPage<DataProductSummary>>('/data-products?limit=100'),
    enabled: direction === 'input',
  });
  const sourcePorts = useQuery({
    queryKey: ['dataProducts', 'product', sourceProduct ?? '', 'ports'],
    queryFn: () => get<DataPort[]>(`/data-products/${enc(sourceProduct!)}/ports`),
    enabled: direction === 'input' && sourceKind === 'port' && !!sourceProduct,
  });
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    sunset: lifecycle === 'deprecated' && !isDate(sunset) && t('lifecycleForm.sunsetRequired'),
    source:
      direction === 'input' &&
      ((sourceKind === 'port' && !sourcePort) || (sourceKind === 'element' && !sourceElement.length) || (sourceKind === 'text' && !sourceText.trim())) &&
      t('ports.sourceRequired'),
  });
  const save = () =>
    run(async () => {
      const body: DataPortInput = {
        direction,
        name: name.trim(),
        type,
        version: version.trim(),
        description,
        lifecycle,
        sunsetDate: lifecycle === 'deprecated' || lifecycle === 'retired' ? sunset || null : null,
        successorId: lifecycle === 'deprecated' || lifecycle === 'retired' ? successor : null,
        objectives: objectivesToSend(objectives),
        source:
          direction === 'output'
            ? null
            : sourceKind === 'port'
              ? { kind: 'port', portId: sourcePort! }
              : sourceKind === 'element'
                ? { kind: 'element', elementId: sourceElement[0]!.id }
                : { kind: 'text', text: sourceText.trim() },
        objectIds,
        ...(type === 'file' ? { fileFormat, partitioning } : {}),
      };
      if (x) await put(`/data-products/${enc(productId)}/ports/${enc(x.id)}`, body);
      else await post(`/data-products/${enc(productId)}/ports`, body);
      onSaved();
    }, t('form.notSaved'));
  const title = x ? t('ports.editTitle', { name: x.name }) : direction === 'output' ? t('ports.newOutput') : t('ports.newInput');
  return (
    <FormModal onClose={onClose} size="lg" title={title}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          {direction === 'output' && x === undefined && (
            <Text size="sm" c="dimmed">
              {t('ports.apiRule')}
            </Text>
          )}
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput
              label={t('ports.name')}
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
              data-testid="port-name"
            />
            <Select
              label={t('ports.type')}
              data={DATA_PORT_TYPES.map((k) => ({ value: k, label: t(`portTypes.${k}`) }))}
              value={type}
              onChange={(k) => k && setType(k as DataPortType)}
              allowDeselect={false}
            />
            <TextInput
              label={t('ports.version')}
              description={t('ports.versionHint')}
              maxLength={60}
              value={version}
              onChange={(e) => setVersion(e.currentTarget.value)}
              data-testid="port-version"
            />
          </SimpleGrid>
          {type === 'file' && (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('ports.fileFormat')}
                description={t('ports.fileFormatHint')}
                data={DATA_FILE_FORMATS.map((f) => ({ value: f, label: t(`fileFormats.${f}`) }))}
                value={fileFormat}
                onChange={(f) => setFileFormat((f as DataFileFormat | null) ?? null)}
                clearable
                data-testid="port-file-format"
              />
              <TagsInput
                label={t('ports.partitioning')}
                description={t('ports.partitioningHint')}
                value={partitioning}
                onChange={(v) => setPartitioning(v.map((k) => k.trim()).filter(Boolean))}
                maxTags={DATA_PORT_PARTITION_KEYS}
                clearable
                classNames={{ input: 'mono' }}
                data-testid="port-partitioning"
              />
            </SimpleGrid>
          )}
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={L.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          {direction === 'input' && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text size="sm" fw={600} id="port-source-label">
                  {t('ports.source')}
                </Text>
                <SegmentedControl
                  aria-labelledby="port-source-label"
                  value={sourceKind}
                  onChange={(k) => setSourceKind(k as SourceKind)}
                  data={(['port', 'element', 'text'] as const).map((k) => ({ value: k, label: t(`ports.sourceKinds.${k}`) }))}
                  fullWidth
                />
                {sourceKind === 'port' && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Select
                      label={t('ports.sourceProduct')}
                      data={(products.data?.items ?? []).filter((p) => p.id !== productId).map((p) => ({ value: p.id, label: p.name }))}
                      value={sourceProduct}
                      onChange={(p) => {
                        setSourceProduct(p);
                        setSourcePort(null);
                      }}
                      searchable
                      placeholder={src?.kind === 'port' && src.product.hidden ? t('hidden.product') : undefined}
                      data-testid="port-source-product"
                    />
                    <Select
                      label={t('ports.sourcePort')}
                      data={(sourcePorts.data ?? [])
                        .filter((p) => p.direction === 'output')
                        .map((p) => ({
                          value: p.id,
                          label: [p.name, p.version, p.lifecycle !== 'active' ? t(`lifecycle.${p.lifecycle}`) : ''].filter(Boolean).join(' · '),
                        }))}
                      value={sourcePort}
                      onChange={setSourcePort}
                      disabled={!sourceProduct}
                      error={v.error('source')}
                      data-testid="port-source-port"
                    />
                  </SimpleGrid>
                )}
                {sourceKind === 'element' && (
                  <ElementPicker
                    label={t('ports.sourceElement')}
                    value={sourceElement}
                    onChange={(e) => setSourceElement(e.slice(-1))}
                    max={1}
                    error={v.error('source')}
                  />
                )}
                {sourceKind === 'text' && (
                  <TextInput
                    label={t('ports.sourceText')}
                    description={t('ports.sourceTextHint')}
                    maxLength={L.text}
                    value={sourceText}
                    onChange={(e) => setSourceText(e.currentTarget.value)}
                    error={v.error('source')}
                  />
                )}
              </Stack>
            </Paper>
          )}
          <MultiSelect
            label={direction === 'output' ? t('ports.objectsOut') : t('ports.objectsIn')}
            description={t('ports.objectsHint')}
            data={(objects.data?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
            value={objectIds}
            onChange={setObjectIds}
            searchable
            clearable
            maxValues={L.objectsPerPort}
          />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select
              label={t('ports.lifecycle')}
              data={DATA_PORT_LIFECYCLES.map((k) => ({ value: k, label: t(`lifecycle.${k}`) }))}
              value={lifecycle}
              onChange={(k) => k && setLifecycle(k as DataPortLifecycle)}
              allowDeselect={false}
              data-testid="port-lifecycle"
            />
            {(lifecycle === 'deprecated' || lifecycle === 'retired') && (
              <TextInput
                type="date"
                label={t('lifecycleForm.sunset')}
                required={lifecycle === 'deprecated'}
                value={sunset}
                onChange={(e) => setSunset(e.currentTarget.value)}
                error={v.error('sunset')}
              />
            )}
            {(lifecycle === 'deprecated' || lifecycle === 'retired') && (
              <Select
                label={t('ports.successor')}
                data={ports
                  .filter((p) => p.id !== x?.id && p.direction === direction)
                  .map((p) => ({ value: p.id, label: [p.name, p.version].filter(Boolean).join(' ') }))}
                value={successor}
                onChange={setSuccessor}
                clearable
              />
            )}
          </SimpleGrid>
          {(lifecycle === 'deprecated' || lifecycle === 'retired') && direction === 'output' && (
            <Alert color="orange" variant="light">
              {t('ports.deprecateNotice')}
            </Alert>
          )}
          {direction === 'output' && <ObjectivesInput value={objectives} onChange={setObjectives} />}
          <FormButtons busy={busy} testId="port-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * A port in one environment (a binding): the elements of that environment it exposes (or reads), the data contract and
 * the version and ODCS server it is held to, and the objectives that differ there. Bound elements become members.
 */
export function BindingForm({
  productId,
  port,
  environment,
  names,
  onClose,
  onSaved,
}: {
  productId: string;
  port: DataPort;
  environment: string;
  /** Names of the elements bound now (from the product's members) */
  names: Map<string, PickedElement>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const contractsOn = useModuleOn('dataContracts');
  const b = port.bindings.find((x) => x.environment === environment);
  const [elements, setElements] = useState<PickedElement[]>((b?.elementIds ?? []).map((id) => names.get(id) ?? { id, label: id }));
  const [contractId, setContractId] = useState<string | null>(b?.contractId ?? null);
  const [contractVersion, setContractVersion] = useState<number | string>(b?.contractVersion ?? '');
  const [server, setServer] = useState<string | null>(b?.contractServer ?? null);
  const [objectives, setObjectives] = useState<DataObjectives>(b?.objectives ?? {});
  const [busy, run] = useBusy();
  const contracts = useQuery({
    queryKey: ['dataProducts', 'contracts'],
    queryFn: () => getOptional<DataContractSummary[]>('/data-contracts', []),
    enabled: contractsOn && port.direction === 'output',
  });
  const contract = useQuery({
    queryKey: ['dataProducts', 'contract', contractId ?? ''],
    queryFn: () => get<DataContractDetail>(`/data-contracts/${enc(contractId!)}`),
    enabled: contractsOn && !!contractId,
    retry: false,
  });
  const chosen = (contracts.data ?? []).find((c) => c.id === contractId);
  const save = () =>
    run(async () => {
      await put(`/data-products/${enc(productId)}/ports/${enc(port.id)}/bindings/${enc(environment)}`, {
        elementIds: elements.map((e) => e.id),
        contractId,
        contractVersion: contractId && typeof contractVersion === 'number' ? contractVersion : null,
        contractServer: contractId ? server : null,
        objectives: objectivesToSend(objectives),
      });
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} size="lg" title={t('bindings.title', { port: port.name, environment })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <ElementPicker
            label={port.direction === 'output' ? t('bindings.elementsOut') : t('bindings.elementsIn')}
            description={t('bindings.elementsHint', { environment, max: L.elementsPerBinding })}
            value={elements}
            onChange={setElements}
            environment={environment}
            max={L.elementsPerBinding}
            testId="binding-elements"
          />
          {port.direction === 'output' && contractsOn && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Text size="sm" fw={600}>
                  {t('bindings.contract')}
                </Text>
                <Select
                  label={t('bindings.contractLabel')}
                  description={t('bindings.contractHint')}
                  data={(contracts.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.key})` }))}
                  value={contractId}
                  onChange={(c) => {
                    setContractId(c);
                    setServer(null);
                    setContractVersion('');
                  }}
                  searchable
                  clearable
                  placeholder={b?.contract?.hidden ? t('hidden.contract') : t('bindings.noContract')}
                  nothingFoundMessage={t('bindings.noContracts')}
                  data-testid="binding-contract"
                />
                {contractId && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <NumberInput
                      label={t('bindings.version')}
                      description={t('bindings.versionHint', { n: chosen?.currentVersion ?? '–' })}
                      min={1}
                      max={chosen?.currentVersion}
                      allowDecimal={false}
                      value={contractVersion}
                      onChange={setContractVersion}
                    />
                    <Select
                      label={t('bindings.server')}
                      description={t('bindings.serverHint')}
                      data={(contract.data?.facts.servers ?? []).map((s) => ({ value: s.server, label: `${s.server} (${s.type})` }))}
                      value={server}
                      onChange={setServer}
                      clearable
                    />
                  </SimpleGrid>
                )}
              </Stack>
            </Paper>
          )}
          {port.direction === 'output' && <ObjectivesInput value={objectives} onChange={setObjectives} inherited={port.objectives} />}
          <FormButtons busy={busy} testId="binding-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * A registered consumer of an output port (ADR 0036 part 7): who (a team, a user, an application, a service, a
 * product, or a text), the purpose, since and until when, the agreement and whom to tell when the port changes.
 */
export function ConsumerForm({
  productId,
  portId,
  consumer,
  onClose,
  onSaved,
}: {
  productId: string;
  portId: string;
  consumer?: DataConsumer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const c = consumer;
  const [kind, setKind] = useState<DataConsumerInput['kind']>(c?.kind ?? 'team');
  const [refId, setRefId] = useState<string | null>(c?.refId ?? null);
  const [subject, setSubject] = useState<string | null>(c?.subject ?? null);
  const [text, setText] = useState(c?.text ?? '');
  const [purpose, setPurpose] = useState(c?.purpose ?? '');
  const [since, setSince] = useState(c?.since ?? '');
  const [endDate, setEndDate] = useState(c?.endDate ?? '');
  const [agreementKind, setAgreementKind] = useState<DataAgreementKind | null>(c?.agreement?.kind ?? null);
  const [agreementRef, setAgreementRef] = useState(c?.agreement?.ref ?? '');
  const [agreementLabel, setAgreementLabel] = useState(c?.agreement?.label ?? '');
  const [contacts, setContacts] = useState<string[]>(c?.contacts ?? []);
  const [busy, run] = useBusy();
  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => getOptional<Subject[]>('/subjects', []),
    enabled: kind === 'team' || kind === 'user',
    staleTime: 60_000,
  });
  const apps = useQuery({
    queryKey: ['dataProducts', 'applications'],
    queryFn: () => get<ApplicationSummary[]>('/applications'),
    enabled: kind === 'application',
  });
  const services = useQuery({ queryKey: ['dataProducts', 'services'], queryFn: () => get<ServiceSummary[]>('/services'), enabled: kind === 'service' });
  const products = useQuery({
    queryKey: ['dataProducts', 'products', 'options'],
    queryFn: () => get<DataPage<DataProductSummary>>('/data-products?limit=100'),
    enabled: kind === 'product',
  });
  const refOptions =
    kind === 'application'
      ? (apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))
      : kind === 'service'
        ? (services.data ?? []).map((s) => ({ value: s.id, label: s.name }))
        : (products.data?.items ?? []).filter((p) => p.id !== productId).map((p) => ({ value: p.id, label: p.name }));
  const v = useFieldErrors({
    who:
      ((kind === 'team' || kind === 'user') && !subject) ||
      ((kind === 'application' || kind === 'service' || kind === 'product') && !refId) ||
      (kind === 'text' && !text.trim())
        ? t('consumers.whoRequired')
        : false,
    since: !!since && !isDate(since) && t('common:validation.invalid'),
    agreement: !!agreementKind && (!agreementRef.trim() || (agreementKind === 'url' && !isHttpUrl(agreementRef))) && t('consumers.agreementInvalid'),
  });
  const save = () =>
    run(async () => {
      const body: DataConsumerInput = {
        kind,
        refId: kind === 'application' || kind === 'service' || kind === 'product' ? refId : null,
        subject: kind === 'team' || kind === 'user' ? subject : null,
        text: kind === 'text' ? text.trim() : '',
        purpose,
        since: since || null,
        endDate: endDate || null,
        agreement: agreementKind ? { kind: agreementKind, ref: agreementRef.trim(), label: agreementLabel.trim() } : null,
        contacts,
      };
      const base = `/data-products/${enc(productId)}/ports/${enc(portId)}/consumers`;
      if (c) await put(`${base}/${enc(c.id)}`, body);
      else await post(base, body);
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} size="lg" title={c ? t('consumers.editTitle') : t('consumers.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('consumers.kind')}
              data={DATA_CONSUMER_KINDS.map((k) => ({ value: k, label: t(`consumers.kinds.${k}`) }))}
              value={kind}
              onChange={(k) => {
                if (!k) return;
                setKind(k as DataConsumerInput['kind']);
                setRefId(null);
                setSubject(null);
              }}
              allowDeselect={false}
              data-testid="consumer-kind"
            />
            {(kind === 'team' || kind === 'user') && (
              <Select
                label={t('consumers.who')}
                data={(subjects.data ?? []).filter((s) => s.kind === kind).map((s) => ({ value: s.value, label: s.label }))}
                value={subject}
                onChange={setSubject}
                searchable
                error={v.error('who')}
                data-testid="consumer-subject"
              />
            )}
            {(kind === 'application' || kind === 'service' || kind === 'product') && (
              <Select
                label={t('consumers.who')}
                data={refOptions}
                value={refId}
                onChange={setRefId}
                searchable
                error={v.error('who')}
                placeholder={c && !c.label ? t('hidden.item') : undefined}
              />
            )}
            {kind === 'text' && (
              <TextInput
                label={t('consumers.who')}
                maxLength={L.short}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                error={v.error('who')}
                data-testid="consumer-text"
              />
            )}
          </SimpleGrid>
          <Textarea
            label={t('consumers.purpose')}
            autosize
            minRows={2}
            maxLength={L.text}
            value={purpose}
            onChange={(e) => setPurpose(e.currentTarget.value)}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="date" label={t('consumers.since')} value={since} onChange={(e) => setSince(e.currentTarget.value)} error={v.error('since')} />
            <TextInput type="date" label={t('consumers.endDate')} value={endDate} onChange={(e) => setEndDate(e.currentTarget.value)} />
          </SimpleGrid>
          <Paper withBorder p="sm">
            <Text size="sm" fw={600} mb="xs">
              {t('consumers.agreement')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Select
                label={t('consumers.agreementKind')}
                data={DATA_AGREEMENT_KINDS.map((k) => ({ value: k, label: t(`consumers.agreementKinds.${k}`) }))}
                value={agreementKind}
                onChange={(k) => setAgreementKind(k as DataAgreementKind | null)}
                clearable
                placeholder={t('consumers.noAgreement')}
              />
              {agreementKind && (
                <TextInput
                  label={agreementKind === 'url' ? t('consumers.agreementUrl') : t('consumers.agreementRef')}
                  maxLength={L.url}
                  value={agreementRef}
                  onChange={(e) => setAgreementRef(e.currentTarget.value)}
                  error={v.error('agreement')}
                />
              )}
              {agreementKind && (
                <TextInput
                  label={t('consumers.agreementLabel')}
                  maxLength={L.short}
                  value={agreementLabel}
                  onChange={(e) => setAgreementLabel(e.currentTarget.value)}
                />
              )}
            </SimpleGrid>
          </Paper>
          <SubjectsInput label={t('consumers.contacts')} description={t('consumers.contactsHint')} value={contacts} onChange={setContacts} max={L.subjects} />
          <FormButtons busy={busy} testId="consumer-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
