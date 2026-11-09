import { useState } from 'react';
import {
  Autocomplete,
  Badge,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  addressProblem,
  dataTypeOf,
  IEC_61131_DATA_TYPES,
  KPI_AUDIENCES,
  KPI_COLUMN_KINDS,
  KPI_INPUT_KINDS,
  KPI_METHODOLOGIES,
  KPI_PARAM_TYPES,
  KPI_TIMINGS,
  KPI_TRENDS,
  kpiInputProfiles,
  matchPoints,
  OPC_UA_DATA_TYPES,
  PLANT_AUTH_KINDS,
  PLANT_DIRECTIONS,
  PLANT_ID_RE,
  PLANT_LIMITS,
  PLANT_NAME_RE,
  PLANT_PROTOCOLS,
  PLANT_UNITS,
  PROTOCOL_PORTS,
  unitCode,
  unitSymbol,
  type KpiColumn,
  type KpiComputation,
  type KpiInput,
  type KpiParameter,
  type KpiParamValue,
  type PlantAssignmentInterface,
  type PlantDataPoint,
  type PlantDirection,
  type PlantInterface,
  type PlantKpiInstance,
  type PlantKpiDetail,
  type PlantKpiSummary,
  type PlantProfileDetail,
  type PlantKpiValues,
  type PlantPointOverride,
  type PlantProfileSummary,
  type PlantProfileValues,
  type PlantProtocol,
  type PlantPublication,
  type Translations,
} from '@sm/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { get, notifyError } from '../../api';
import { plantKeys } from '../../queryKeys';
import { useFieldErrors } from '../common';
import { TranslationsInput } from './common';
import { FormButtons, IdInput, useIdField } from './forms';
import { RowsEditor } from './data';

/**
 * The forms of part 2 of the plant registry (#219). Each form edits one part – a profile's own fields, an interface,
 * a data point, a KPI definition's parameter … – and hands the result to `onSave`; the page saves the whole record
 * (a profile or a KPI definition is one record) and shows the server's answer.
 */

type Save<T> = (v: T) => Promise<void>;

/** The modal and form of every part-2 editor: Enter saves, errors are shown, the dialog stays open on failure. */
function FormModal({
  title,
  onClose,
  onSubmit,
  size = 'lg',
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => Promise<boolean | void>;
  size?: string;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened onClose={onClose} size={size} title={title}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSubmit()
            .then((ok) => {
              if (ok === false) setBusy(false);
              else onClose();
            })
            .catch((err: unknown) => {
              notifyError(err);
              setBusy(false);
            });
        }}
      >
        <Stack gap="sm">
          {children}
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

function NameIdInput({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled: boolean; error?: string }) {
  const { t } = useTranslation('plant');
  return (
    <TextInput
      label={t('form.id')}
      description={disabled ? t('form.idFixed') : t('data.nameIdHelp')}
      required
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      disabled={disabled}
      maxLength={120}
      classNames={{ input: 'mono' }}
      error={error}
    />
  );
}

/** An id from a name: letters, digits and _ (data point ids may keep their capitals). */
const nameId = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 120);

const num = (v: string | number) => (typeof v === 'number' ? v : null);
const lines = (v: string) =>
  v
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

const DATA_TYPES = [...OPC_UA_DATA_TYPES, ...IEC_61131_DATA_TYPES];
const UNITS = PLANT_UNITS.map((u) => ({ value: u.code, label: u.code === u.symbol ? u.code : `${u.code} (${u.symbol})` }));

// ---------- device profile ----------

export function ProfileFormModal({
  profile,
  bases = [],
  onClose,
  onSave,
}: {
  profile?: PlantProfileValues;
  /** The profiles it may extend (0.11.0) */
  bases?: { value: string; label: string }[];
  onClose: () => void;
  onSave: Save<PlantProfileValues>;
}) {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  const [name, setName] = useState(profile?.name ?? '');
  const [base, setBase] = useState<string | null>(profile?.extends ?? null);
  const id = useIdField(profile?.id);
  const [manufacturer, setManufacturer] = useState(profile?.manufacturer ?? '');
  const [model, setModel] = useState(profile?.model ?? '');
  const [version, setVersion] = useState(profile?.version ?? '');
  const [category, setCategory] = useState(profile?.category ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [notes, setNotes] = useState(profile?.notes ?? '');
  const [template, setTemplate] = useState(profile?.template ?? false);
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required'), id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid') });
  return (
    <FormModal
      title={profile ? t('profile.editTitle', { name: profile.name }) : t('profile.newTitle')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({
          id: id.id,
          name: name.trim(),
          manufacturer: manufacturer.trim(),
          model: model.trim(),
          version: version.trim(),
          category: category.trim(),
          description,
          notes,
          interfaces: profile?.interfaces ?? [],
          extends: base,
          template,
          // another base has other interfaces and data points: what changed the old one's goes
          interfaceOverrides: base && base === profile?.extends ? profile.interfaceOverrides : [],
          pointOverrides: base && base === profile?.extends ? profile.pointOverrides : [],
        });
      }}
    >
      <TextInput
        label={t('form.name')}
        required
        data-autofocus
        maxLength={PLANT_LIMITS.name}
        value={name}
        onChange={(e) => {
          setName(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('name')}
      />
      <IdInput value={id.id} onChange={id.set} disabled={!!profile} error={v.error('id')} />
      <Select
        label={t('plantModel:extends.label')}
        description={t('plantModel:extends.help')}
        data={bases}
        value={base}
        onChange={setBase}
        clearable
        searchable
        data-testid="profile-extends"
      />
      <Switch
        label={t('plantModel:template.label')}
        description={t('plantModel:template.help')}
        checked={template}
        onChange={(e) => setTemplate(e.currentTarget.checked)}
        data-testid="profile-template"
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label={t('asset.manufacturer')} maxLength={200} value={manufacturer} onChange={(e) => setManufacturer(e.currentTarget.value)} />
        <TextInput label={t('asset.model')} maxLength={200} value={model} onChange={(e) => setModel(e.currentTarget.value)} />
        <TextInput
          label={t('profile.version')}
          description={t('profile.versionHelp')}
          maxLength={60}
          value={version}
          onChange={(e) => setVersion(e.currentTarget.value)}
        />
        <TextInput
          label={t('profile.category')}
          description={t('profile.categoryHelp')}
          maxLength={100}
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value)}
        />
      </SimpleGrid>
      <Textarea
        label={t('form.description')}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('data.notes')} autosize minRows={2} maxRows={6} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function InterfaceFormModal({
  iface,
  taken,
  inherited = false,
  baseProtocol,
  onClose,
  onSave,
}: {
  iface?: PlantInterface;
  /** An inherited interface (0.11.0): its protocol stays; what differs from the base becomes an override */
  inherited?: boolean;
  /** 0.13: the base's protocol of an inherited interface – "other" leaves it to this profile */
  baseProtocol?: PlantProtocol;
  /** Interface ids of the profile */
  taken: string[];
  onClose: () => void;
  onSave: Save<PlantInterface>;
}) {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  // 0.13: an inherited interface of protocol "other" (a base across protocols) gets its protocol here
  const protocolOpen = inherited && baseProtocol === 'other';
  const [name, setName] = useState(iface?.name ?? '');
  const [id, setId] = useState(iface?.id ?? '');
  const [ownId, setOwnId] = useState(!!iface);
  const [protocol, setProtocol] = useState<PlantProtocol>(iface?.protocol ?? 'opc_ua');
  const [direction, setDirection] = useState<PlantDirection>(iface?.direction ?? 'read');
  const [port, setPort] = useState<number | ''>(iface?.defaultPort ?? PROTOCOL_PORTS.opc_ua ?? '');
  const [auth, setAuth] = useState(iface?.authentication ?? 'none');
  const [client, setClient] = useState(iface?.client ?? '');
  const [version, setVersion] = useState(iface?.version ?? '');
  const [description, setDescription] = useState(iface?.description ?? '');
  const [notes, setNotes] = useState(iface?.notes ?? '');
  const v = useFieldErrors({
    id: (!PLANT_NAME_RE.test(id) && t('data.nameIdInvalid')) || (!iface && taken.includes(id) && t('data.idTaken')),
  });
  return (
    <FormModal
      title={iface ? t('data.editInterface', { name: iface.name || iface.id }) : t('data.newInterface')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({
          id,
          name: name.trim(),
          protocol,
          direction,
          defaultPort: port === '' ? null : port,
          authentication: auth,
          client: client.trim(),
          version: version.trim(),
          description,
          notes,
          groups: iface?.groups ?? [],
          fileSets: iface?.fileSets ?? [],
        });
      }}
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('form.name')}
          data-autofocus
          maxLength={PLANT_LIMITS.name}
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            if (!ownId) setId(nameId(e.currentTarget.value).replace(/_/g, '-'));
          }}
        />
        <Select
          label={t('data.protocol')}
          data={PLANT_PROTOCOLS.map((p) => ({ value: p, label: t(`data.protocols.${p}`) }))}
          value={protocol}
          disabled={inherited && !protocolOpen}
          description={protocolOpen ? t('plantModel:protocolOther.help') : undefined}
          data-testid="interface-protocol"
          onChange={(x) => {
            if (!x) return;
            const next = x as PlantProtocol;
            // the usual port of the protocol, unless one was typed
            if (port === '' || port === PROTOCOL_PORTS[protocol]) setPort(PROTOCOL_PORTS[next] ?? '');
            setProtocol(next);
          }}
          allowDeselect={false}
        />
      </SimpleGrid>
      <NameIdInput
        value={id}
        onChange={(x) => {
          setOwnId(true);
          setId(x);
        }}
        disabled={!!iface}
        error={v.error('id')}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('data.direction')}
          description={t('data.directionHelp')}
          data={PLANT_DIRECTIONS.map((d) => ({ value: d, label: t(`data.directions.${d}`) }))}
          value={direction}
          onChange={(x) => x && setDirection(x as PlantDirection)}
          allowDeselect={false}
        />
        <NumberInput
          label={t('data.defaultPort')}
          min={1}
          max={65535}
          allowDecimal={false}
          value={port}
          onChange={(x) => setPort(typeof x === 'number' ? x : '')}
        />
        <Select
          label={t('data.authentication')}
          data={PLANT_AUTH_KINDS.map((a) => ({ value: a, label: t(`data.auth.${a}`) }))}
          value={auth}
          onChange={(x) => x && setAuth(x as typeof auth)}
          allowDeselect={false}
        />
        <TextInput
          label={t('data.client')}
          description={t('data.clientHelp')}
          maxLength={200}
          value={client}
          onChange={(e) => setClient(e.currentTarget.value)}
        />
        <TextInput label={t('data.version')} maxLength={60} value={version} onChange={(e) => setVersion(e.currentTarget.value)} />
      </SimpleGrid>
      <Textarea
        label={t('form.description')}
        autosize
        minRows={2}
        maxRows={5}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function DataPointFormModal({
  point,
  protocol,
  group,
  groups,
  taken,
  inherited = false,
  onClose,
  onSave,
}: {
  point?: PlantDataPoint;
  /** An inherited data point (0.11.0): its group stays; what differs from the base becomes an override */
  inherited?: boolean;
  protocol: PlantProtocol;
  group: string;
  /** The interface's group names */
  groups: string[];
  /** Data point ids of the whole profile */
  taken: string[];
  onClose: () => void;
  onSave: (p: PlantDataPoint, group: string) => Promise<void>;
}) {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  const [name, setName] = useState(point?.name ?? '');
  const [id, setId] = useState(point?.id ?? '');
  const [ownId, setOwnId] = useState(!!point);
  const [groupName, setGroupName] = useState(group);
  const [dataType, setDataType] = useState(point?.dataType ?? '');
  const [unit, setUnit] = useState(point?.unit ?? '');
  const [address, setAddress] = useState(point?.address ?? '');
  const [access, setAccess] = useState<PlantDirection>(point?.access ?? 'read');
  const [rate, setRate] = useState<number | ''>(point?.updateRateMs ?? '');
  const [values, setValues] = useState<string[]>(point?.enumValues ?? []);
  const [aliases, setAliases] = useState<string[]>(point?.aliases ?? []);
  const [description, setDescription] = useState(point?.description ?? '');
  const [notes, setNotes] = useState(point?.notes ?? '');
  const [pubs, setPubs] = useState(point?.publications ?? []);
  const addressError = addressProblem(protocol, address.trim());
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: (!PLANT_NAME_RE.test(id) && t('data.nameIdInvalid')) || (id !== point?.id && taken.includes(id) && t('data.idTaken')),
    dataType: dataType.trim() !== '' && dataTypeOf(dataType) === null && t('data.dataTypeInvalid'),
    address: !!addressError && (protocol === 'opc_ua' ? t('data.addressOpcUa') : t('data.addressModbus')),
  });
  return (
    <FormModal
      title={point ? t('data.editPoint', { name: point.name }) : t('data.newPoint')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave(
          {
            id,
            name: name.trim(),
            description,
            dataType: dataType.trim() ? dataTypeOf(dataType)! : '',
            unit: unitCode(unit),
            address: address.trim(),
            access,
            updateRateMs: num(rate),
            enumValues: values,
            aliases,
            notes,
            publications: pubs.map((x) => ({ target: x.target.trim(), path: x.path.trim(), name: x.name.trim() })).filter((x) => x.target || x.path || x.name),
          },
          groupName.trim(),
        );
      }}
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('form.name')}
          required
          data-autofocus
          maxLength={PLANT_LIMITS.name}
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            if (!ownId) setId(nameId(e.currentTarget.value));
          }}
          error={v.error('name')}
        />
        <Autocomplete
          label={t('data.group')}
          description={t('data.groupHelp')}
          data={groups.filter(Boolean)}
          value={groupName}
          onChange={setGroupName}
          maxLength={200}
          disabled={inherited}
        />
      </SimpleGrid>
      <NameIdInput
        value={id}
        onChange={(x) => {
          setOwnId(true);
          setId(x);
        }}
        disabled={!!point}
        error={v.error('id')}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Autocomplete
          label={t('data.dataType')}
          description={t('data.dataTypeHelp')}
          data={DATA_TYPES}
          value={dataType}
          onChange={setDataType}
          maxLength={40}
          error={v.error('dataType')}
          limit={40}
        />
        <Autocomplete label={t('data.unit')} description={t('data.unitHelp')} data={UNITS} value={unit} onChange={setUnit} maxLength={40} limit={60} />
      </SimpleGrid>
      <TextInput
        label={t('data.address')}
        description={t(`data.addressHelp.${protocol === 'opc_ua' || protocol === 'modbus_tcp' || protocol === 'mqtt' ? protocol : 'other'}`)}
        maxLength={500}
        classNames={{ input: 'mono' }}
        value={address}
        onChange={(e) => setAddress(e.currentTarget.value)}
        error={v.error('address')}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('data.access')}
          data={PLANT_DIRECTIONS.map((d) => ({ value: d, label: t(`data.directions.${d}`) }))}
          value={access}
          onChange={(x) => x && setAccess(x as PlantDirection)}
          allowDeselect={false}
        />
        <NumberInput
          label={t('data.updateRateMs')}
          min={0}
          max={31 * 86_400_000}
          allowDecimal={false}
          thousandSeparator=" "
          value={rate}
          onChange={(x) => setRate(typeof x === 'number' ? x : '')}
        />
      </SimpleGrid>
      <TagsInput label={t('data.enumValues')} description={t('data.enumValuesHelp')} value={values} onChange={setValues} maxTags={200} clearable />
      <TagsInput
        label={t('plantModel:aliases.label')}
        description={t('plantModel:aliases.help')}
        value={aliases}
        onChange={setAliases}
        maxTags={50}
        clearable
        data-testid="point-aliases"
      />
      <Textarea
        label={t('form.description')}
        autosize
        minRows={1}
        maxRows={5}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
      <RowsEditor
        title={t('data.defaultPublications')}
        help={t('data.defaultPublicationsHelp')}
        value={pubs}
        onChange={setPubs}
        fields={[
          { key: 'target', label: t('data.target') },
          { key: 'path', label: t('data.path'), mono: true, max: 500 },
          { key: 'name', label: t('data.pubName'), mono: true },
        ]}
        empty={() => ({ target: '', path: '', name: '' })}
        addLabel={t('data.addPublication')}
        removeLabel={(i) => t('data.removeRow', { n: i + 1 })}
        max={10}
      />
    </FormModal>
  );
}

// ---------- KPI definitions ----------

export function KpiFormModal({ kpi, onClose, onSave }: { kpi?: PlantKpiValues; onClose: () => void; onSave: Save<PlantKpiValues> }) {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  const [name, setName] = useState(kpi?.name ?? '');
  const id = useIdField(kpi?.id);
  const [names, setNames] = useState<Translations>(kpi?.names ?? {});
  const [category, setCategory] = useState(kpi?.category ?? '');
  const [type, setType] = useState(kpi?.type ?? '');
  const [description, setDescription] = useState(kpi?.description ?? '');
  const [formula, setFormula] = useState(kpi?.formula ?? '');
  const [unit, setUnit] = useState(kpi?.unit ?? '');
  const [rangeMin, setRangeMin] = useState<number | ''>(kpi?.rangeMin ?? '');
  const [rangeMax, setRangeMax] = useState<number | ''>(kpi?.rangeMax ?? '');
  const [trend, setTrend] = useState<string | null>(kpi?.trend ?? null);
  const [timing, setTiming] = useState<string | null>(kpi?.timing ?? null);
  const [audience, setAudience] = useState<string[]>(kpi?.audience ?? []);
  const [methodology, setMethodology] = useState<string | null>(kpi?.methodology ?? null);
  const [strategy, setStrategy] = useState(kpi?.strategy ?? '');
  const [implementation, setImplementation] = useState(kpi?.implementation ?? '');
  const [dynamicColumns, setDynamicColumns] = useState(kpi?.dynamicColumns ?? false);
  const [rollUp, setRollUp] = useState(kpi?.rollUp === 'parts');
  const [notes, setNotes] = useState(kpi?.notes ?? '');
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid'),
    range: rangeMin !== '' && rangeMax !== '' && rangeMin > rangeMax && t('kpi.rangeInvalid'),
  });
  return (
    <FormModal
      title={kpi ? t('kpi.editTitle', { name: kpi.name }) : t('kpi.newTitle')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({
          id: id.id,
          name: name.trim(),
          names,
          category: category.trim(),
          type: type.trim(),
          description,
          formula: formula.trim(),
          unit: unitCode(unit),
          rangeMin: num(rangeMin),
          rangeMax: num(rangeMax),
          trend: (trend as PlantKpiValues['trend']) ?? null,
          timing: (timing as PlantKpiValues['timing']) ?? null,
          audience: audience as PlantKpiValues['audience'],
          methodology: (methodology as PlantKpiValues['methodology']) ?? null,
          strategy: strategy.trim(),
          implementation: implementation.trim(),
          dynamicColumns,
          rollUp: rollUp ? 'parts' : 'none',
          notes,
          inputs: kpi?.inputs ?? [],
          parameters: kpi?.parameters ?? [],
          columns: kpi?.columns ?? [],
          computation: kpi?.computation ?? { summary: '', diagram: '', steps: [], identities: [], limits: [] },
        });
      }}
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('form.name')}
          required
          data-autofocus
          maxLength={PLANT_LIMITS.name}
          value={name}
          onChange={(e) => {
            setName(e.currentTarget.value);
            id.follow(e.currentTarget.value);
          }}
          error={v.error('name')}
        />
        <TextInput
          label={t('kpi.category')}
          description={t('kpi.categoryHelp')}
          maxLength={100}
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value)}
        />
      </SimpleGrid>
      <IdInput value={id.id} onChange={id.set} disabled={!!kpi} error={v.error('id')} />
      <TranslationsInput value={names} onChange={setNames} />
      <Textarea
        label={t('form.description')}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Text size="sm" fw={600} mt="xs">
        {t('kpi.iso')}
      </Text>
      <TextInput
        label={t('kpi.formula')}
        description={t('kpi.formulaHelp')}
        maxLength={2000}
        classNames={{ input: 'mono' }}
        value={formula}
        onChange={(e) => setFormula(e.currentTarget.value)}
      />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Autocomplete label={t('data.unit')} data={UNITS} value={unit} onChange={setUnit} maxLength={40} limit={60} />
        <NumberInput label={t('kpi.rangeMin')} value={rangeMin} onChange={(x) => setRangeMin(typeof x === 'number' ? x : '')} error={v.error('range')} />
        <NumberInput label={t('kpi.rangeMax')} value={rangeMax} onChange={(x) => setRangeMax(typeof x === 'number' ? x : '')} />
      </SimpleGrid>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label={t('kpi.trend')} data={KPI_TRENDS.map((x) => ({ value: x, label: t(`kpi.trends.${x}`) }))} value={trend} onChange={setTrend} clearable />
        <Select
          label={t('kpi.timing')}
          data={KPI_TIMINGS.map((x) => ({ value: x, label: t(`kpi.timings.${x}`) }))}
          value={timing}
          onChange={setTiming}
          clearable
        />
        <MultiSelect
          label={t('kpi.audience')}
          data={KPI_AUDIENCES.map((x) => ({ value: x, label: t(`kpi.audiences.${x}`) }))}
          value={audience}
          onChange={setAudience}
          clearable
        />
        <Select
          label={t('kpi.methodology')}
          data={KPI_METHODOLOGIES.map((x) => ({ value: x, label: t(`kpi.methodologies.${x}`) }))}
          value={methodology}
          onChange={setMethodology}
          clearable
        />
      </SimpleGrid>
      <Text size="sm" fw={600} mt="xs">
        {t('kpi.implementationTitle')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label={t('kpi.type')} maxLength={100} value={type} onChange={(e) => setType(e.currentTarget.value)} />
        <TextInput
          label={t('kpi.strategy')}
          description={t('kpi.strategyHelp')}
          maxLength={200}
          value={strategy}
          onChange={(e) => setStrategy(e.currentTarget.value)}
        />
      </SimpleGrid>
      <TextInput
        label={t('kpi.implementation')}
        description={t('kpi.implementationHelp')}
        maxLength={500}
        classNames={{ input: 'mono' }}
        value={implementation}
        onChange={(e) => setImplementation(e.currentTarget.value)}
      />
      <Switch
        label={t('kpi.dynamicColumns')}
        description={t('kpi.dynamicColumnsHelp')}
        checked={dynamicColumns}
        onChange={(e) => setDynamicColumns(e.currentTarget.checked)}
      />
      <Switch
        label={t('plantModel:rollUp.label')}
        description={t('plantModel:rollUp.help')}
        checked={rollUp}
        onChange={(e) => setRollUp(e.currentTarget.checked)}
        data-testid="kpi-roll-up"
      />
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

/** A profile's data points as choices (loaded when a profile is chosen), with their unit (0.12.0). */
export function usePointOptions(profileId: string | null | undefined): { value: string; label: string; unit: string }[] {
  const q = useQuery({
    queryKey: plantKeys.profile(profileId),
    queryFn: () => get<PlantProfileDetail>(`/plant/profiles/${encodeURIComponent(profileId!)}`),
    enabled: !!profileId,
  });
  return (q.data?.interfaces ?? []).flatMap((i) =>
    i.groups.flatMap((g) => g.dataPoints.map((d) => ({ value: d.id, label: `${d.name} (${d.id})`, unit: d.unit }))),
  );
}

/** 0.13: the data points of several profiles (resolved), by profile id – for a KPI input's mapping. */
function useProfilePoints(ids: string[]): Map<string, PlantDataPoint[]> {
  const qs = useQueries({
    queries: ids.map((id) => ({
      queryKey: plantKeys.profile(id),
      queryFn: () => get<PlantProfileDetail>(`/plant/profiles/${encodeURIComponent(id)}`),
    })),
  });
  return new Map(
    ids.flatMap((id, i) => {
      const d = qs[i]?.data;
      return d ? [[id, d.interfaces.flatMap((x) => x.groups.flatMap((g) => g.dataPoints))] as [string, PlantDataPoint[]]] : [];
    }),
  );
}

/**
 * A KPI input: its kind, the device profiles it reads (0.13: any of several – the data points are the first one's)
 * with a data point mapping per other profile (suggested by the matching of "Extract base profile"), the units it
 * expects and notes.
 */
export function KpiInputModal({
  input,
  profiles,
  onClose,
  onSave,
}: {
  input?: KpiInput;
  profiles: PlantProfileSummary[];
  onClose: () => void;
  onSave: Save<KpiInput>;
}) {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  const [kind, setKind] = useState(input?.kind ?? 'data_point');
  const [chosen, setChosen] = useState<string[]>(input ? kpiInputProfiles(input) : []);
  const [points, setPoints] = useState<string[]>(input?.dataPoints ?? []);
  const [units, setUnits] = useState<Record<string, string>>(input?.units ?? {});
  // per other profile, the data point chosen for an input's data point ('' : none chosen)
  const [mapping, setMapping] = useState<Record<string, Record<string, string>>>(input?.mapping ?? {});
  const [notes, setNotes] = useState(input?.notes ?? '');
  const first = kind === 'data_point' ? (chosen[0] ?? null) : null;
  const others = kind === 'data_point' ? chosen.slice(1) : [];
  const options = usePointOptions(first);
  const known = useProfilePoints(kind === 'data_point' ? chosen : []);
  const unitOf = new Map(options.map((o) => [o.value, o.unit]));
  // data points that are named but not in the profile (any more) stay choosable, so they can be removed
  const data = [...(options ?? []), ...points.filter((p) => !(options ?? []).some((o) => o.value === p)).map((p) => ({ value: p, label: p }))];
  // the suggestions: the input's data points (as the first profile has them) matched in each other profile
  const suggested = new Map(
    others.map((o) => {
      const mine = points.map((p) => known.get(first ?? '')?.find((d) => d.id === p) ?? { id: p, name: p, unit: '', aliases: [] });
      return [o, matchPoints(mine, known.get(o) ?? [])] as const;
    }),
  );
  const target = (o: string, p: string, i: number): string | null => {
    const set = mapping[o]?.[p];
    if (set !== undefined) return set || null;
    return suggested.get(o)?.[i]?.point.id ?? null;
  };
  return (
    <FormModal
      title={input ? t('kpi.editInput') : t('kpi.newInput')}
      size={others.length ? 'xl' : 'md'}
      onClose={onClose}
      onSubmit={async () => {
        // 0.12.0: the units it expects (a data point without one: its unit in the profile)
        const expected = Object.fromEntries(
          points.filter((p) => units[p]?.trim() && unitCode(units[p]!) !== unitOf.get(p)).map((p) => [p, unitCode(units[p]!)]),
        );
        // 0.13: the mapping – only where the other profile's id differs
        const map: Record<string, Record<string, string>> = {};
        for (const o of others) {
          const m = Object.fromEntries(points.flatMap((p, i) => (target(o, p, i) && target(o, p, i) !== p ? [[p, target(o, p, i)!]] : [])));
          if (Object.keys(m).length) map[o] = m;
        }
        await onSave({
          kind,
          profile: kind === 'data_point' ? (first ?? '') : '',
          ...(kind === 'data_point' && chosen.length > 1 ? { profiles: chosen } : {}),
          dataPoints: kind === 'data_point' ? points : [],
          ...(kind === 'data_point' && Object.keys(expected).length ? { units: expected } : {}),
          ...(kind === 'data_point' && Object.keys(map).length ? { mapping: map } : {}),
          notes,
        });
      }}
    >
      <Select
        label={t('kpi.inputKind')}
        data={KPI_INPUT_KINDS.map((k) => ({ value: k, label: t(`kpi.inputKinds.${k}`) }))}
        value={kind}
        onChange={(x) => x && setKind(x as KpiInput['kind'])}
        allowDeselect={false}
      />
      {kind === 'data_point' && (
        <>
          <MultiSelect
            label={t('plantModel:anyOf.profiles')}
            description={t('plantModel:anyOf.profilesHelp')}
            data={profiles.map((p) => ({ value: p.id, label: p.name }))}
            value={chosen}
            onChange={(x) => {
              // another first profile: other data points
              if (x[0] !== chosen[0]) setPoints([]);
              setChosen(x);
            }}
            searchable
            clearable
            maxValues={20}
            data-testid="kpi-input-profiles"
          />
          <MultiSelect
            label={first ? t('plantModel:anyOf.dataPoints', { profile: profiles.find((p) => p.id === first)?.name ?? first }) : t('kpi.dataPoints')}
            data={data}
            value={points}
            onChange={setPoints}
            searchable
            disabled={!first}
            maxValues={500}
            nothingFoundMessage={t('data.noPoints')}
            data-testid="kpi-input-points"
          />
          {others.length > 0 && points.length > 0 && (
            <Stack gap={4} data-testid="kpi-input-mapping">
              <Text size="sm" fw={500}>
                {t('plantModel:anyOf.mapping')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('plantModel:anyOf.mappingHelp')}
              </Text>
              <div className="table-scroll">
                <Table fz="xs" withTableBorder aria-label={t('plantModel:anyOf.mapping')}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('plantModel:anyOf.inputPoint')}</Table.Th>
                      {others.map((o) => (
                        <Table.Th key={o}>{profiles.find((p) => p.id === o)?.name ?? o}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {points.map((p, i) => (
                      <Table.Tr key={p}>
                        <Table.Td className="mono">{p}</Table.Td>
                        {others.map((o) => {
                          const list = known.get(o) ?? [];
                          const value = target(o, p, i);
                          const hint = suggested.get(o)?.[i];
                          const name = profiles.find((x) => x.id === o)?.name ?? o;
                          return (
                            <Table.Td key={o}>
                              <Select
                                size="xs"
                                aria-label={t('plantModel:anyOf.pointIn', { point: p, profile: name })}
                                data={list.map((d) => ({ value: d.id, label: `${d.name} (${d.id}${d.unit ? `, ${unitSymbol(d.unit)}` : ''})` }))}
                                value={value && list.some((d) => d.id === value) ? value : null}
                                onChange={(x) => setMapping((m) => ({ ...m, [o]: { ...(m[o] ?? {}), [p]: x ?? '' } }))}
                                searchable
                                clearable
                                placeholder={list.some((d) => d.id === p) ? p : t('plantModel:anyOf.missing')}
                                error={!value && known.has(o) && !list.some((d) => d.id === p) ? t('plantModel:anyOf.missing') : undefined}
                                w={220}
                                data-testid={`kpi-map-${p}-${o}`}
                              />
                              {hint && value === hint.point.id && (
                                <Group gap={2} mt={2}>
                                  {hint.by.map((b) => (
                                    <Badge key={b} size="xs" variant="light" color="gray" tt="none">
                                      {t(`plantModel:extract.by.${b}`)}
                                    </Badge>
                                  ))}
                                </Group>
                              )}
                            </Table.Td>
                          );
                        })}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Stack>
          )}
          {points.length > 0 && points.length <= 30 && (
            <Stack gap={4} data-testid="kpi-input-units">
              <Text size="sm" fw={500}>
                {t('plantModel:units.label')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('plantModel:units.help')}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                {points.map((p) => (
                  <Autocomplete
                    key={p}
                    size="xs"
                    label={p}
                    placeholder={unitOf.get(p) ? t('plantModel:units.fromProfile', { unit: unitOf.get(p) }) : t('plantModel:units.none')}
                    data={UNITS}
                    value={units[p] ?? ''}
                    onChange={(x) => setUnits((u) => ({ ...u, [p]: x }))}
                    maxLength={40}
                    limit={60}
                    data-testid={`kpi-input-unit-${p}`}
                  />
                ))}
              </SimpleGrid>
            </Stack>
          )}
        </>
      )}
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

const paramValueOf = (type: KpiParameter['type'], raw: string): KpiParamValue => {
  const v = raw.trim();
  if (!v) return null;
  if (type === 'boolean') return v === 'true';
  if (type === 'number' || type === 'integer') return Number.isFinite(Number(v)) ? Number(v) : v;
  return v;
};

export function KpiParameterModal({
  param,
  taken,
  onClose,
  onSave,
}: {
  param?: KpiParameter;
  /** Names and aliases of the other parameters */
  taken: string[];
  onClose: () => void;
  onSave: Save<KpiParameter>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [name, setName] = useState(param?.name ?? '');
  const [aliases, setAliases] = useState<string[]>(param?.aliases ?? []);
  const [type, setType] = useState<KpiParameter['type']>(param?.type ?? 'number');
  const [def, setDef] = useState(param?.default === null || param?.default === undefined ? '' : String(param.default));
  const [required, setRequired] = useState(param?.required ?? false);
  const [min, setMin] = useState<number | ''>(param?.min ?? '');
  const [max, setMax] = useState<number | ''>(param?.max ?? '');
  const [unit, setUnit] = useState(param?.unit ?? '');
  const [description, setDescription] = useState(param?.description ?? '');
  const clash = [name, ...aliases].find((n) => taken.includes(n));
  const v = useFieldErrors({
    name: (!PLANT_NAME_RE.test(name) && t('data.nameIdInvalid')) || (!!clash && t('kpi.paramTaken', { name: clash })),
    aliases: aliases.some((a) => !PLANT_NAME_RE.test(a)) && t('data.nameIdInvalid'),
    range: min !== '' && max !== '' && min > max && t('kpi.rangeInvalid'),
  });
  return (
    <FormModal
      title={param ? t('kpi.editParameter', { name: param.name }) : t('kpi.newParameter')}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({ name, aliases, type, default: paramValueOf(type, def), required, min: num(min), max: num(max), unit: unitCode(unit), description });
      }}
    >
      <TextInput
        label={t('kpi.paramName')}
        required
        data-autofocus
        maxLength={120}
        classNames={{ input: 'mono' }}
        value={name}
        onChange={(e) => setName(e.currentTarget.value.trim())}
        error={v.error('name')}
      />
      <TagsInput label={t('kpi.aliases')} description={t('kpi.aliasesHelp')} value={aliases} onChange={setAliases} maxTags={10} error={v.error('aliases')} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('kpi.paramType')}
          data={KPI_PARAM_TYPES.map((x) => ({ value: x, label: t(`kpi.paramTypes.${x}`) }))}
          value={type}
          onChange={(x) => x && setType(x as KpiParameter['type'])}
          allowDeselect={false}
        />
        {type === 'boolean' ? (
          <Select
            label={t('kpi.default')}
            data={[
              { value: 'true', label: t('yes') },
              { value: 'false', label: t('no') },
            ]}
            value={def || null}
            onChange={(x) => setDef(x ?? '')}
            clearable
          />
        ) : (
          <TextInput label={t('kpi.default')} maxLength={2000} value={def} onChange={(e) => setDef(e.currentTarget.value)} />
        )}
        {(type === 'number' || type === 'integer') && (
          <>
            <NumberInput label={t('kpi.min')} value={min} onChange={(x) => setMin(typeof x === 'number' ? x : '')} error={v.error('range')} />
            <NumberInput label={t('kpi.max')} value={max} onChange={(x) => setMax(typeof x === 'number' ? x : '')} />
          </>
        )}
        <Autocomplete label={t('data.unit')} data={UNITS} value={unit} onChange={setUnit} maxLength={40} limit={60} />
      </SimpleGrid>
      <Switch label={t('kpi.required')} description={t('kpi.requiredHelp')} checked={required} onChange={(e) => setRequired(e.currentTarget.checked)} />
      <Textarea
        label={t('form.description')}
        autosize
        minRows={1}
        maxRows={5}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
    </FormModal>
  );
}

export function KpiColumnModal({
  column,
  columns,
  onClose,
  onSave,
}: {
  column?: KpiColumn;
  /** Every column name of the definition */
  columns: string[];
  onClose: () => void;
  onSave: Save<KpiColumn>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [name, setName] = useState(column?.name ?? '');
  const [kind, setKind] = useState<KpiColumn['kind']>(column?.kind ?? 'sum');
  const [scope, setScope] = useState(column?.scope ?? '');
  const [unit, setUnit] = useState(column?.unit ?? '');
  const [numerator, setNumerator] = useState<string | null>(column?.numerator || null);
  const [denominator, setDenominator] = useState<string | null>(column?.denominator || null);
  const [scale, setScale] = useState<number | ''>(column?.scale ?? '');
  const [description, setDescription] = useState(column?.description ?? '');
  const others = columns.filter((c) => c !== column?.name);
  const v = useFieldErrors({
    name: (!PLANT_NAME_RE.test(name) && t('data.nameIdInvalid')) || (others.includes(name) && t('kpi.columnTaken')),
  });
  const refs = others.filter((c) => c !== name);
  return (
    <FormModal
      title={column ? t('kpi.editColumn', { name: column.name }) : t('kpi.newColumn')}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        const ratio = kind === 'ratio';
        await onSave({
          name,
          kind,
          scope: scope.trim(),
          unit: unitCode(unit),
          numerator: ratio ? (numerator ?? '') : '',
          denominator: ratio ? (denominator ?? '') : '',
          scale: ratio ? num(scale) : null,
          description,
        });
      }}
    >
      <TextInput
        label={t('kpi.columnName')}
        required
        data-autofocus
        maxLength={120}
        classNames={{ input: 'mono' }}
        value={name}
        onChange={(e) => setName(e.currentTarget.value.trim())}
        error={v.error('name')}
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('kpi.columnKind')}
          description={t(`kpi.columnKindsHelp.${kind}`)}
          data={KPI_COLUMN_KINDS.map((x) => ({ value: x, label: t(`kpi.columnKinds.${x}`) }))}
          value={kind}
          onChange={(x) => x && setKind(x as KpiColumn['kind'])}
          allowDeselect={false}
        />
        <Autocomplete label={t('data.unit')} data={UNITS} value={unit} onChange={setUnit} maxLength={40} limit={60} />
        <TextInput label={t('kpi.scope')} description={t('kpi.scopeHelp')} maxLength={60} value={scope} onChange={(e) => setScope(e.currentTarget.value)} />
      </SimpleGrid>
      {kind === 'ratio' && (
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select label={t('kpi.numerator')} data={refs} value={numerator} onChange={setNumerator} searchable clearable />
          <Select
            label={t('kpi.denominator')}
            description={t('kpi.denominatorHelp')}
            data={refs}
            value={denominator}
            onChange={setDenominator}
            searchable
            clearable
          />
          <NumberInput label={t('kpi.scale')} description={t('kpi.scaleHelp')} value={scale} onChange={(x) => setScale(typeof x === 'number' ? x : '')} />
        </SimpleGrid>
      )}
      <Textarea
        label={t('form.description')}
        autosize
        minRows={1}
        maxRows={5}
        maxLength={8000}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
    </FormModal>
  );
}

export function ComputationModal({ value, onClose, onSave }: { value: KpiComputation; onClose: () => void; onSave: Save<KpiComputation> }) {
  const { t } = useTranslation(['plant', 'common']);
  const [summary, setSummary] = useState(value.summary);
  const [diagram, setDiagram] = useState(value.diagram);
  const [steps, setSteps] = useState(value.steps);
  const [identities, setIdentities] = useState(value.identities);
  const [limits, setLimits] = useState(value.limits.join('\n'));
  return (
    <FormModal
      title={t('kpi.editComputation')}
      onClose={onClose}
      onSubmit={async () => {
        await onSave({
          summary,
          diagram,
          steps: steps.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), does: s.does.trim(), why: s.why.trim() })),
          identities: identities.filter((x) => x.relation.trim()).map((x) => ({ relation: x.relation.trim(), note: x.note.trim() })),
          limits: lines(limits),
        });
      }}
    >
      <Textarea
        label={t('kpi.summary')}
        data-autofocus
        autosize
        minRows={2}
        maxRows={6}
        maxLength={8000}
        value={summary}
        onChange={(e) => setSummary(e.currentTarget.value)}
      />
      <RowsEditor
        title={t('kpi.steps')}
        value={steps}
        onChange={setSteps}
        fields={[
          { key: 'name', label: t('kpi.stepName'), required: true },
          { key: 'does', label: t('kpi.stepDoes'), long: true },
          { key: 'why', label: t('kpi.stepWhy'), long: true },
        ]}
        empty={() => ({ name: '', does: '', why: '' })}
        addLabel={t('kpi.addStep')}
        removeLabel={(i) => t('data.removeRow', { n: i + 1 })}
      />
      <RowsEditor
        title={t('kpi.identities')}
        help={t('kpi.identitiesHelp')}
        value={identities}
        onChange={setIdentities}
        fields={[
          { key: 'relation', label: t('kpi.relation'), mono: true, max: 1000 },
          { key: 'note', label: t('data.notes'), long: true },
        ]}
        empty={() => ({ relation: '', note: '' })}
        addLabel={t('kpi.addIdentity')}
        removeLabel={(i) => t('data.removeRow', { n: i + 1 })}
      />
      <Textarea
        label={t('kpi.limits')}
        description={t('kpi.limitsHelp')}
        autosize
        minRows={2}
        maxRows={8}
        value={limits}
        onChange={(e) => setLimits(e.currentTarget.value)}
      />
      <Textarea
        label={t('kpi.diagram')}
        description={t('kpi.diagramHelp')}
        autosize
        minRows={2}
        maxRows={10}
        maxLength={8000}
        classNames={{ input: 'mono' }}
        value={diagram}
        onChange={(e) => setDiagram(e.currentTarget.value)}
      />
    </FormModal>
  );
}

// ---------- assignments ----------

export function AssignmentFormModal({
  profileId,
  firmware: firmware0,
  notes: notes0,
  profiles,
  onClose,
  onSave,
}: {
  profileId: string | null;
  firmware: string;
  notes: string;
  profiles: PlantProfileSummary[];
  onClose: () => void;
  onSave: (v: { profileId: string | null; firmware: string; notes: string }) => Promise<void>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [profile, setProfile] = useState<string | null>(profileId);
  const [firmware, setFirmware] = useState(firmware0);
  const [notes, setNotes] = useState(notes0);
  return (
    <FormModal
      title={t('assignment.editTitle')}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        await onSave({ profileId: profile, firmware: firmware.trim(), notes });
      }}
    >
      <Select
        label={t('assignment.profile')}
        description={profile !== profileId && profileId ? t('assignment.profileChangeHelp') : t('assignment.profileHelp')}
        data={profiles.map((p) => ({ value: p.id, label: [p.name, [p.manufacturer, p.model].filter(Boolean).join(' ')].filter(Boolean).join(' – ') }))}
        value={profile}
        onChange={setProfile}
        searchable
        clearable
        data-autofocus
        nothingFoundMessage={t('profiles.noMatch')}
      />
      <TextInput
        label={t('assignment.firmware')}
        description={t('assignment.firmwareHelp')}
        maxLength={100}
        value={firmware}
        onChange={(e) => setFirmware(e.currentTarget.value)}
      />
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function AssignmentInterfaceModal({
  iface,
  value,
  onClose,
  onSave,
}: {
  iface: PlantInterface;
  value: PlantAssignmentInterface | undefined;
  onClose: () => void;
  onSave: Save<PlantAssignmentInterface>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [active, setActive] = useState(value?.active ?? true);
  const [endpoint, setEndpoint] = useState(value?.endpoint ?? '');
  const [notes, setNotes] = useState(value?.notes ?? '');
  return (
    <FormModal
      title={t('assignment.interfaceTitle', { name: iface.name || iface.id })}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        await onSave({ interface: iface.id, active, endpoint: endpoint.trim(), notes });
      }}
    >
      <Switch label={t('assignment.active')} description={t('assignment.activeHelp')} checked={active} onChange={(e) => setActive(e.currentTarget.checked)} />
      <TextInput
        label={t('assignment.endpoint')}
        description={t(
          `assignment.endpointHelp.${iface.protocol === 'opc_ua' || iface.protocol === 'modbus_tcp' || iface.protocol === 'mqtt' ? iface.protocol : 'other'}`,
        )}
        maxLength={2000}
        classNames={{ input: 'mono' }}
        value={endpoint}
        onChange={(e) => setEndpoint(e.currentTarget.value)}
        data-autofocus
      />
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function OverrideModal({
  value,
  points,
  onClose,
  onSave,
}: {
  value?: PlantPointOverride;
  points: { value: string; label: string }[];
  onClose: () => void;
  onSave: Save<PlantPointOverride>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [point, setPoint] = useState<string | null>(value?.dataPoint ?? null);
  const [available, setAvailable] = useState(value?.available ?? true);
  const [address, setAddress] = useState(value?.address ?? '');
  const [unit, setUnit] = useState(value?.unit ?? '');
  const [dataType, setDataType] = useState(value?.dataType ?? '');
  const [rate, setRate] = useState<number | ''>(value?.updateRateMs ?? '');
  const [notes, setNotes] = useState(value?.notes ?? '');
  const v = useFieldErrors({
    point: !point && t('common:validation.required'),
    dataType: dataType.trim() !== '' && dataTypeOf(dataType) === null && t('data.dataTypeInvalid'),
  });
  return (
    <FormModal
      title={value ? t('assignment.editOverride', { name: value.dataPoint }) : t('assignment.newOverride')}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({
          dataPoint: point!,
          available,
          address: address.trim() || null,
          unit: unit.trim() ? unitCode(unit) : null,
          dataType: dataType.trim() ? dataTypeOf(dataType) : null,
          updateRateMs: num(rate),
          notes,
        });
      }}
    >
      <Select
        label={t('data.point')}
        required
        data={points}
        value={point}
        onChange={setPoint}
        searchable
        disabled={!!value}
        error={v.error('point')}
        data-autofocus
      />
      <Switch
        label={t('assignment.available')}
        description={t('assignment.availableHelp')}
        checked={available}
        onChange={(e) => setAvailable(e.currentTarget.checked)}
      />
      {available && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label={t('data.address')}
            description={t('assignment.overrideHelp')}
            maxLength={500}
            classNames={{ input: 'mono' }}
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
          />
          <Autocomplete
            label={t('data.dataType')}
            data={DATA_TYPES}
            value={dataType}
            onChange={setDataType}
            maxLength={40}
            limit={40}
            error={v.error('dataType')}
          />
          <Autocomplete label={t('data.unit')} data={UNITS} value={unit} onChange={setUnit} maxLength={40} limit={60} />
          <NumberInput label={t('data.updateRateMs')} min={0} allowDecimal={false} value={rate} onChange={(x) => setRate(typeof x === 'number' ? x : '')} />
        </SimpleGrid>
      )}
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function PublicationModal({
  value,
  points,
  onClose,
  onSave,
}: {
  value?: PlantPublication;
  points: { value: string; label: string }[];
  onClose: () => void;
  onSave: Save<PlantPublication>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [point, setPoint] = useState<string | null>(value?.dataPoint ?? null);
  const [target, setTarget] = useState(value?.target ?? '');
  const [path, setPath] = useState(value?.path ?? '');
  const [name, setName] = useState(value?.name ?? '');
  const [by, setBy] = useState(value?.publishedBy ?? '');
  const [notes, setNotes] = useState(value?.notes ?? '');
  const v = useFieldErrors({ point: !point && t('common:validation.required') });
  return (
    <FormModal
      title={value ? t('assignment.editPublication') : t('assignment.newPublication')}
      size="md"
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({ dataPoint: point!, target: target.trim(), path: path.trim(), name: name.trim(), publishedBy: by.trim(), notes });
      }}
    >
      <Select label={t('data.point')} required data={points} value={point} onChange={setPoint} searchable error={v.error('point')} data-autofocus />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('data.target')}
          description={t('data.targetHelp')}
          maxLength={200}
          value={target}
          onChange={(e) => setTarget(e.currentTarget.value)}
        />
        <TextInput label={t('assignment.publishedBy')} maxLength={200} value={by} onChange={(e) => setBy(e.currentTarget.value)} />
        <TextInput
          label={t('data.path')}
          description={t('data.pathHelp')}
          maxLength={500}
          classNames={{ input: 'mono' }}
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
        />
        <TextInput
          label={t('data.pubName')}
          description={t('data.pubNameHelp')}
          maxLength={200}
          classNames={{ input: 'mono' }}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </SimpleGrid>
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function KpiInstanceModal({
  value,
  kpis,
  jobs,
  defaultKpi,
  onClose,
  onSave,
}: {
  value?: PlantKpiInstance;
  kpis: PlantKpiSummary[];
  /** Job names of the other KPI instances of the asset */
  jobs: string[];
  defaultKpi?: string;
  onClose: () => void;
  onSave: Save<PlantKpiInstance>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [kpi, setKpi] = useState<string | null>(value?.kpi ?? defaultKpi ?? null);
  const [job, setJob] = useState(value?.job ?? '');
  const [active, setActive] = useState(value?.active ?? true);
  const [params, setParams] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(value?.params ?? {}).map(([k, v]) => [k, v === null ? '' : String(v)])),
  );
  const [dashboard, setDashboard] = useState(value?.dashboard ?? '');
  const [dataset, setDataset] = useState(value?.dataset ?? '');
  const [notes, setNotes] = useState(value?.notes ?? '');
  // the definition's parameters, loaded when it is chosen
  const def = useQuery({
    queryKey: plantKeys.kpi(kpi),
    queryFn: () => get<PlantKpiDetail>(`/plant/kpis/${encodeURIComponent(kpi!)}`),
    enabled: !!kpi,
  }).data;
  const known = new Set((def?.parameters ?? []).flatMap((p) => [p.name, ...p.aliases]));
  const others = Object.keys(params).filter((k) => !known.has(k));
  const v = useFieldErrors({
    kpi: !kpi && t('common:validation.required'),
    job: (!job.trim() && t('common:validation.required')) || (jobs.includes(job.trim()) && t('assignment.jobTaken')),
  });
  const typeOf = (k: string) => def?.parameters.find((p) => p.name === k || p.aliases.includes(k))?.type ?? 'string';
  return (
    <FormModal
      title={value ? t('assignment.editKpi', { job: value.job }) : t('assignment.newKpi')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        const out = Object.fromEntries(
          Object.entries(params)
            .filter(([, x]) => x.trim() !== '')
            .map(([k, x]) => [k, paramValueOf(typeOf(k), x)]),
        );
        await onSave({ kpi: kpi!, job: job.trim(), active, params: out, dashboard: dashboard.trim() || null, dataset: dataset.trim() || null, notes });
      }}
    >
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('assignment.kpi')}
          required
          data={kpis.map((k) => ({ value: k.id, label: k.name }))}
          value={kpi}
          onChange={setKpi}
          searchable
          error={v.error('kpi')}
          data-autofocus
        />
        <TextInput
          label={t('assignment.job')}
          description={t('assignment.jobHelp')}
          required
          maxLength={200}
          classNames={{ input: 'mono' }}
          value={job}
          onChange={(e) => setJob(e.currentTarget.value)}
          error={v.error('job')}
        />
      </SimpleGrid>
      <Switch label={t('assignment.kpiActive')} checked={active} onChange={(e) => setActive(e.currentTarget.checked)} />
      {def && def.parameters.length > 0 && (
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            {t('kpi.parameters')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {def.parameters.map((p) => {
              // a value given under an alias stays under it
              const key = [p.name, ...p.aliases].find((n) => params[n] !== undefined) ?? p.name;
              const label = `${p.name}${p.unit ? ` (${p.unit})` : ''}`;
              const set = (x: string) => setParams({ ...params, [key]: x });
              const desc = [
                p.description,
                p.default !== null ? t('assignment.defaultIs', { value: String(p.default) }) : '',
                key !== p.name ? t('assignment.viaAlias', { alias: key }) : '',
              ]
                .filter(Boolean)
                .join(' · ');
              return p.type === 'boolean' ? (
                <Select
                  key={p.name}
                  label={label}
                  description={desc || undefined}
                  required={p.required && p.default === null}
                  data={[
                    { value: 'true', label: t('yes') },
                    { value: 'false', label: t('no') },
                  ]}
                  value={params[key] || null}
                  onChange={(x) => set(x ?? '')}
                  clearable
                />
              ) : (
                <TextInput
                  key={p.name}
                  label={label}
                  description={desc || undefined}
                  required={p.required && p.default === null}
                  placeholder={p.default !== null ? String(p.default) : undefined}
                  inputMode={p.type === 'number' || p.type === 'integer' ? 'decimal' : undefined}
                  maxLength={2000}
                  classNames={{ input: 'mono' }}
                  value={params[key] ?? ''}
                  onChange={(e) => set(e.currentTarget.value)}
                />
              );
            })}
          </SimpleGrid>
        </Stack>
      )}
      {others.length > 0 && (
        <RowsEditor
          title={t('assignment.otherParams')}
          help={t('assignment.otherParamsHelp')}
          value={others.map((k) => ({ key: k, value: params[k]! }))}
          onChange={(rows) =>
            setParams({ ...Object.fromEntries(Object.entries(params).filter(([k]) => known.has(k))), ...Object.fromEntries(rows.map((r) => [r.key, r.value])) })
          }
          fields={[
            { key: 'key', label: t('kpi.paramName'), mono: true },
            { key: 'value', label: t('assignment.value'), mono: true },
          ]}
          empty={() => ({ key: '', value: '' })}
          addLabel={t('assignment.addParam')}
          removeLabel={(i) => t('data.removeRow', { n: i + 1 })}
        />
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('assignment.dashboard')}
          description={t('assignment.dashboardHelp')}
          maxLength={100}
          classNames={{ input: 'mono' }}
          value={dashboard}
          onChange={(e) => setDashboard(e.currentTarget.value)}
        />
        <TextInput
          label={t('assignment.dataset')}
          description={t('assignment.datasetHelp')}
          maxLength={200}
          classNames={{ input: 'mono' }}
          value={dataset}
          onChange={(e) => setDataset(e.currentTarget.value)}
        />
      </SimpleGrid>
      <Textarea label={t('data.notes')} autosize minRows={1} maxRows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}
