import { useState } from 'react';
import { Alert, Checkbox, NumberInput, Paper, Select, SimpleGrid, Stack, TagsInput, Text, Textarea, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  CIA_DIMENSIONS,
  classificationRank,
  DATA_CLASSIFICATIONS,
  DATA_PRODUCT_CRITICALITIES,
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_LIMITS as L,
  DATA_PRODUCT_TYPES,
  DATA_VALUE_TIERS,
  type CiaDimension,
  type DataClassification,
  type DataDomain,
  type DataExternalRef,
  type DataProduct,
  type DataProductCriticality,
  type DataProductInput,
  type DataProductLifecycle,
  type DataProductType,
  type DataRating,
  type DataValueTier,
  type RatingFloor,
  type RatingFloorDimension,
} from '@sm/shared';
import { post, put } from '../../api';
import { FormModal } from '../FormModal';
import { SubjectsInput } from '../SubjectsInput';
import { useFieldErrors } from '../common';
import { levelText, useCiaScale } from '../catalogue/cia';
import { ExternalRefsInput, FormButtons, isHttpUrl, keyFromName, refsToSend, useBusy, validKey } from './form';

/** The domains as options, sub-domains under their domain ("Sales → Orders"). */
export function domainOptions(domains: DataDomain[] | undefined): { value: string; label: string }[] {
  const all = domains ?? [];
  const byId = new Map(all.map((d) => [d.id, d]));
  return all
    .map((d) => ({ value: d.id, label: d.parentId && byId.get(d.parentId) ? `${byId.get(d.parentId)!.name} → ${d.name}` : d.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The micros of an amount and back (value per year). */
const toMicros = (n: number | string) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) : null);
const fromMicros = (m: number | null) => (m === null ? '' : m / 1e6);

/** A data product: create (key from the name) or change every field of the product (the API replaces the whole entry). */
export function ProductForm({
  product,
  domains,
  onClose,
  onSaved,
}: {
  product?: DataProduct;
  domains: DataDomain[] | undefined;
  onClose: () => void;
  onSaved: (p: DataProduct) => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const p = product;
  const [name, setName] = useState(p?.name ?? '');
  const [key, setKey] = useState(p?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!p);
  const [description, setDescription] = useState(p?.description ?? '');
  const [purpose, setPurpose] = useState(p?.purpose ?? '');
  const [type, setType] = useState<DataProductType | null>(p?.type ?? null);
  const [domainId, setDomainId] = useState<string | null>(p?.domain && !p.domain.hidden ? p.domain.id : null);
  const [owners, setOwners] = useState<string[]>(p?.owners ?? []);
  const [channel, setChannel] = useState(p?.support.channel ?? '');
  const [supportUrl, setSupportUrl] = useState(p?.support.url ?? '');
  const [hours, setHours] = useState(p?.support.hours ?? '');
  const [criticality, setCriticality] = useState<DataProductCriticality | null>(p?.criticality ?? null);
  const [tier, setTier] = useState<string | null>(p?.tier ? String(p.tier) : null);
  const [version, setVersion] = useState(p?.version ?? '');
  const [valueStatement, setValueStatement] = useState(p?.valueStatement ?? '');
  const [valueTier, setValueTier] = useState<DataValueTier | null>(p?.valueTier ?? null);
  const [valueAmount, setValueAmount] = useState<number | string>(fromMicros(p?.valueAmount ?? null));
  const [valueCurrency, setValueCurrency] = useState(p?.valueCurrency ?? '');
  const [tags, setTags] = useState<string[]>(p?.tags ?? []);
  const [refs, setRefs] = useState<DataExternalRef[]>(p?.externalRefs ?? []);
  const [busy, run] = useBusy();
  const amount = toMicros(valueAmount);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    key: !validKey(key) && t('form.keyInvalid'),
    supportUrl: !!supportUrl.trim() && !isHttpUrl(supportUrl) && t('common:validation.url'),
    valueCurrency: amount !== null && !/^[A-Z]{3}$/.test(valueCurrency.trim().toUpperCase()) && t('common:validation.currency'),
    refs: refsToSend(refs).some((r) => !isHttpUrl(r.url)) && t('form.refUrlInvalid'),
  });
  const save = () =>
    run(async () => {
      const body: DataProductInput = {
        key: key.trim(),
        name: name.trim(),
        description,
        purpose,
        type,
        domainId,
        owners,
        support: { channel: channel.trim(), url: supportUrl.trim(), hours: hours.trim() },
        criticality,
        tier: tier ? (Number(tier) as 1 | 2 | 3) : null,
        version: version.trim(),
        valueStatement,
        valueTier,
        valueAmount: amount,
        valueCurrency: amount !== null ? valueCurrency.trim().toUpperCase() : null,
        successorId: p?.successor && !p.successor.hidden ? p.successor.id : null,
        tags,
        externalRefs: refsToSend(refs),
      };
      const saved = p ? await put<DataProduct>(`/data-products/${encodeURIComponent(p.id)}`, body) : await post<DataProduct>('/data-products', body);
      onSaved(saved);
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} size="xl" title={p ? t('product.editTitle', { name: p.name }) : t('product.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('form.name')}
              required
              maxLength={L.name}
              value={name}
              onChange={(e) => {
                const n = e.currentTarget.value;
                setName(n);
                if (!keyTouched) setKey(keyFromName(n));
              }}
              error={v.error('name')}
              data-autofocus
              data-testid="product-name"
            />
            <TextInput
              label={t('form.key')}
              description={t('form.keyHint')}
              required
              maxLength={L.key}
              value={key}
              onChange={(e) => {
                setKey(e.currentTarget.value);
                setKeyTouched(true);
              }}
              error={v.error('key')}
              className="mono"
              data-testid="product-key"
            />
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('form.type')}
              description={t('form.typeHint')}
              data={DATA_PRODUCT_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
              value={type}
              onChange={(x) => setType(x as DataProductType | null)}
              clearable
              placeholder={t('form.notSet')}
              data-testid="product-type"
            />
            <Select
              label={t('form.domain')}
              data={domainOptions(domains)}
              value={domainId}
              onChange={setDomainId}
              clearable
              searchable
              placeholder={p?.domain?.hidden ? t('hidden.domain') : t('form.notSet')}
              nothingFoundMessage={t('form.noDomain')}
              data-testid="product-domain"
            />
          </SimpleGrid>
          <Textarea label={t('form.description')} description={t('form.markdown')} autosize minRows={2} maxRows={8} maxLength={L.description} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          <Textarea label={t('form.purpose')} description={t('form.purposeHint')} autosize minRows={2} maxRows={8} maxLength={L.description} value={purpose} onChange={(e) => setPurpose(e.currentTarget.value)} />
          <SubjectsInput
            label={t('form.owners')}
            description={t('form.ownersHint')}
            value={owners}
            onChange={setOwners}
            max={L.subjects}
            scope={{ kind: 'data_product', id: p?.id }}
            saved={p?.owners}
          />
          <Paper withBorder p="sm">
            <Text size="sm" fw={600} mb="xs">
              {t('form.support')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <TextInput label={t('form.supportChannel')} maxLength={L.short} value={channel} onChange={(e) => setChannel(e.currentTarget.value)} />
              <TextInput label={t('form.supportUrl')} maxLength={L.url} value={supportUrl} onChange={(e) => setSupportUrl(e.currentTarget.value)} error={v.error('supportUrl')} />
              <TextInput label={t('form.supportHours')} maxLength={L.short} value={hours} onChange={(e) => setHours(e.currentTarget.value)} />
            </SimpleGrid>
          </Paper>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select
              label={t('form.criticality')}
              data={DATA_PRODUCT_CRITICALITIES.map((x) => ({ value: x, label: t(`criticality.${x}`) }))}
              value={criticality}
              onChange={(x) => setCriticality(x as DataProductCriticality | null)}
              clearable
              placeholder={t('form.notSet')}
            />
            <Select
              label={t('form.tier')}
              description={t('form.tierHint')}
              data={['1', '2', '3'].map((x) => ({ value: x, label: t('tier', { tier: x }) }))}
              value={tier}
              onChange={setTier}
              clearable
              placeholder={t('form.notSet')}
            />
            <TextInput label={t('form.version')} description={t('form.versionHint')} maxLength={60} value={version} onChange={(e) => setVersion(e.currentTarget.value)} />
          </SimpleGrid>
          <Paper withBorder p="sm">
            <Text size="sm" fw={600}>
              {t('form.value')}
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              {t('form.valueHint')}
            </Text>
            <Stack gap="xs">
              <Textarea label={t('form.valueStatement')} autosize minRows={1} maxRows={4} maxLength={L.text} value={valueStatement} onChange={(e) => setValueStatement(e.currentTarget.value)} />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <Select
                  label={t('form.valueTier')}
                  data={DATA_VALUE_TIERS.map((x) => ({ value: x, label: t(`valueTier.${x}`) }))}
                  value={valueTier}
                  onChange={(x) => setValueTier(x as DataValueTier | null)}
                  clearable
                  placeholder={t('form.notSet')}
                />
                <NumberInput label={t('form.valueAmount')} min={0} thousandSeparator decimalScale={2} value={valueAmount} onChange={setValueAmount} />
                <TextInput
                  label={t('form.valueCurrency')}
                  maxLength={3}
                  value={valueCurrency}
                  onChange={(e) => setValueCurrency(e.currentTarget.value.toUpperCase())}
                  error={v.error('valueCurrency')}
                  placeholder="EUR"
                />
              </SimpleGrid>
            </Stack>
          </Paper>
          <TagsInput label={t('form.tags')} value={tags} onChange={setTags} maxTags={L.tags} clearable />
          <ExternalRefsInput value={refs} onChange={setRefs} error={!!v.error('refs')} />
          <FormButtons busy={busy} submit={p ? undefined : t('product.create')} testId="product-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * The lifecycle of a product (ADR 0036 part 3): proposed → draft → active → deprecated → retired. Deprecated needs a
 * sunset date (asked here, before the server says so) and may name a successor; retiring while consumers are
 * registered asks to confirm.
 */
export function LifecycleForm({
  product,
  products,
  onClose,
  onSaved,
}: {
  product: DataProduct;
  /** Other products the reader may see (the successor) */
  products: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (p: DataProduct) => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const [to, setTo] = useState<DataProductLifecycle>(product.lifecycle);
  const [sunset, setSunset] = useState(product.sunsetDate ?? '');
  const [successor, setSuccessor] = useState<string | null>(product.successor && !product.successor.hidden ? product.successor.id : null);
  const [confirm, setConfirm] = useState(false);
  const [busy, run] = useBusy();
  const consumers = product.ports.reduce((n, x) => n + x.consumers.registered + x.consumers.derived, 0);
  const outputs = product.ports.filter((x) => x.direction === 'output').length;
  const needsSunset = to === 'deprecated';
  const v = useFieldErrors({
    sunset: needsSunset && !/^\d{4}-\d{2}-\d{2}$/.test(sunset) && t('lifecycleForm.sunsetRequired'),
    confirm: to === 'retired' && consumers > 0 && !confirm && t('lifecycleForm.confirmRequired'),
  });
  const save = () =>
    run(async () => {
      const saved = await post<DataProduct>(`/data-products/${encodeURIComponent(product.id)}/lifecycle`, {
        lifecycle: to,
        ...(to === 'deprecated' || to === 'retired' ? { sunsetDate: sunset || null, successorId: successor } : {}),
        confirm,
      });
      onSaved(saved);
    }, t('lifecycleForm.notChanged'));
  const problems = [
    to === 'active' && !product.owners.length && t('lifecycleForm.needsOwner'),
    to === 'active' && !outputs && t('lifecycleForm.needsOutputPort'),
  ].filter((x): x is string => !!x);
  return (
    <FormModal onClose={onClose} title={t('lifecycleForm.title', { name: product.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('lifecycleForm.to')}
            data={DATA_PRODUCT_LIFECYCLES.map((x) => ({ value: x, label: t(`lifecycle.${x}`) }))}
            value={to}
            onChange={(x) => x && setTo(x as DataProductLifecycle)}
            allowDeselect={false}
            data-testid="lifecycle-to"
          />
          <Text size="sm" c="dimmed">
            {t(`lifecycleForm.hints.${to}`)}
          </Text>
          {problems.length > 0 && (
            <Alert color="orange" variant="light" data-testid="lifecycle-problems">
              {problems.join(' ')}
            </Alert>
          )}
          {(to === 'deprecated' || to === 'retired') && (
            <>
              <TextInput
                type="date"
                label={t('lifecycleForm.sunset')}
                description={t('lifecycleForm.sunsetHint')}
                required={needsSunset}
                value={sunset}
                onChange={(e) => setSunset(e.currentTarget.value)}
                error={v.error('sunset')}
                data-testid="lifecycle-sunset"
              />
              <Select
                label={t('lifecycleForm.successor')}
                data={products.filter((x) => x.id !== product.id).map((x) => ({ value: x.id, label: x.name }))}
                value={successor}
                onChange={setSuccessor}
                clearable
                searchable
                placeholder={t('form.notSet')}
              />
            </>
          )}
          {to === 'retired' && consumers > 0 && (
            <Checkbox
              label={t('lifecycleForm.confirm', { count: consumers })}
              checked={confirm}
              onChange={(e) => setConfirm(e.currentTarget.checked)}
              error={v.error('confirm')}
              data-testid="lifecycle-confirm"
            />
          )}
          <FormButtons busy={busy} submit={t('lifecycleForm.change')} testId="lifecycle-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

type RatingValues = Record<CiaDimension, { level: string | null; justification: string }>;

/**
 * A CIA rating of a product or a data object on the instance's scale, with a justification per dimension. A product
 * also has a classification and – where it is below what its data objects need (the rating floor) – a reason per
 * dimension: the warning disappears once one is given; nothing is ever blocked.
 */
export function RatingForm({
  title,
  url,
  rating,
  classification,
  floor,
  reasons,
  onClose,
  onSaved,
}: {
  title: string;
  url: string;
  rating: DataRating;
  /** A product: its classification and floor (a data object keeps its classification in its own form) */
  classification?: DataClassification | null;
  floor?: RatingFloor;
  reasons?: Partial<Record<RatingFloorDimension, string>>;
  onClose: () => void;
  onSaved: (x: unknown) => void;
}) {
  const { t } = useTranslation(['dataProducts', 'applications', 'common']);
  const { t: ta } = useTranslation('applications');
  const scale = useCiaScale().data;
  const options = (d: CiaDimension) => (scale?.levels[d] ?? []).map((l) => ({ value: l.key, label: levelText(ta, scale!, l).label }));
  const init = (d: CiaDimension) => ({
    level: rating[d] && !rating[d]!.needsRerating ? rating[d]!.level : null,
    justification: rating[d]?.justification ?? '',
  });
  const [values, setValues] = useState<RatingValues>({ confidentiality: init('confidentiality'), integrity: init('integrity'), availability: init('availability') });
  const [cls, setCls] = useState<DataClassification | null>(classification ?? null);
  const [why, setWhy] = useState<Partial<Record<RatingFloorDimension, string>>>(reasons ?? {});
  const [busy, run] = useBusy();
  const isProduct = floor !== undefined;
  // the dimensions still below the floor with the values of the form: only those take a reason
  const rank = (d: CiaDimension, k: string | null) => (k ? (scale?.levels[d] ?? []).findIndex((l) => l.key === k) : -1);
  const below = new Set(
    (floor?.findings ?? [])
      .filter((f) =>
        f.dimension === 'classification' ? classificationRank(cls) < classificationRank(f.floor) : rank(f.dimension, values[f.dimension].level) < rank(f.dimension, f.floor),
      )
      .map((f) => f.dimension),
  );
  const v = useFieldErrors({
    confidentiality: !!values.confidentiality.level && !values.confidentiality.justification.trim() && t('common:validation.required'),
    integrity: !!values.integrity.level && !values.integrity.justification.trim() && t('common:validation.required'),
    availability: !!values.availability.level && !values.availability.justification.trim() && t('common:validation.required'),
  });
  const set = (d: CiaDimension, patch: Partial<RatingValues[CiaDimension]>) => setValues((x) => ({ ...x, [d]: { ...x[d], ...patch } }));
  const save = () =>
    run(async () => {
      const dims = Object.fromEntries(
        CIA_DIMENSIONS.map((d) => [d, values[d].level ? { level: values[d].level, justification: values[d].justification.trim() } : null]),
      );
      const body = isProduct
        ? {
            ...dims,
            classification: cls,
            // only where the product is below its objects: elsewhere there is nothing to explain (DATA_PRODUCT_RATING_REASON)
            reasons: Object.fromEntries((floor?.findings ?? []).map((f) => [f.dimension, below.has(f.dimension) ? why[f.dimension]?.trim() || null : null])),
          }
        : dims;
      onSaved(await put(url, body));
    }, t('form.notSaved'));
  const reasonField = (d: RatingFloorDimension) =>
    below.has(d) && (
      <Textarea
        label={t('rating.reasonLabel')}
        description={t('rating.reasonHint')}
        autosize
        minRows={2}
        maxLength={2000}
        value={why[d] ?? ''}
        onChange={(e) => {
          const text = e.currentTarget.value;
          setWhy((x) => ({ ...x, [d]: text }));
        }}
        data-testid={`rating-reason-${d}`}
      />
    );
  return (
    <FormModal onClose={onClose} title={title} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {isProduct ? t('rating.productHelp') : t('rating.objectHelp')}
          </Text>
          {CIA_DIMENSIONS.map((d) => {
            const finding = floor?.findings.find((f) => f.dimension === d);
            return (
              <Paper key={d} withBorder p="sm">
                <Stack gap="xs">
                  <Select
                    label={t(`applications:cia.dimensions.${d}`)}
                    placeholder={t('applications:cia.notRated')}
                    data={options(d)}
                    value={values[d].level}
                    onChange={(x) => set(d, { level: x })}
                    clearable
                    data-testid={`rating-${d}`}
                  />
                  {finding && (
                    <Text size="xs" c="orange">
                      {t('rating.floorHint', { level: options(d).find((o) => o.value === finding.floor)?.label ?? finding.floor })}
                    </Text>
                  )}
                  {values[d].level && (
                    <Textarea
                      label={t('applications:cia.justification')}
                      description={t('applications:cia.justificationHelp')}
                      value={values[d].justification}
                      onChange={(e) => set(d, { justification: e.currentTarget.value })}
                      autosize
                      minRows={2}
                      maxRows={6}
                      maxLength={2000}
                      required
                      error={v.error(d)}
                      data-testid={`rating-justification-${d}`}
                    />
                  )}
                  {reasonField(d)}
                </Stack>
              </Paper>
            );
          })}
          {isProduct && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                <Select
                  label={t('rating.classification')}
                  data={DATA_CLASSIFICATIONS.map((x) => ({ value: x, label: t(`classification.${x}`) }))}
                  value={cls}
                  onChange={(x) => setCls(x as DataClassification | null)}
                  clearable
                  placeholder={t('form.notSet')}
                />
                {floor?.highestClassification && (
                  <Text size="xs" c="dimmed">
                    {t('rating.highestClassification', { value: t(`classification.${floor.highestClassification}`) })}
                  </Text>
                )}
                {reasonField('classification')}
              </Stack>
            </Paper>
          )}
          <FormButtons busy={busy} testId="rating-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
