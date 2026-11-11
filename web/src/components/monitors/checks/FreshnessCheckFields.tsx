import { Group, NumberInput, SegmentedControl, Select, TagsInput, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { INFLUX_LIMITS, checkPlatformKinds, influxVersionOf, type CheckDef, type CheckOf, type FreshnessSource, type Platform } from '@sm/shared';
import { ExpressionInput } from '../../editor/ExpressionInput';
import { Hint, KeyValueEditor } from '../../common';
import { PlatformSelect, FreshnessFields, BodyInput, num, type CheckFieldsProps, type FieldError, type Patch } from './common';

/** The fields of one source: switching to another source clears them, so they are not saved with it (they would be refused). */
const SOURCE_FIELDS: Record<FreshnessSource, string[]> = {
  insightsHub: [],
  platform: ['method', 'headers', 'body'],
  influxdb: ['database', 'bucket', 'retentionPolicy', 'measurement', 'fields', 'tags', 'groupBy', 'expectedSeries', 'lookbackHours'],
};

/** The newest timestamp of an Insights Hub time series, of the series of an InfluxDB measurement or of an API answer. */
export function FreshnessCheckFields({ c, set, platforms, disabled, err, observedDelay }: CheckFieldsProps<'freshness'>) {
  const { t } = useTranslation('monitors');
  const switchSource = (v: string) => {
    const source = v as FreshnessSource;
    const cleared = Object.fromEntries(
      (Object.keys(SOURCE_FIELDS) as FreshnessSource[]).filter((k) => k !== source).flatMap((k) => SOURCE_FIELDS[k].map((f) => [f, undefined])),
    );
    // the platform of another source is of another kind (an InfluxDB check reads an InfluxDB platform)
    const kinds = checkPlatformKinds({ type: 'freshness', source });
    const keep = !kinds.length || platforms.some((p) => p.id === c.platform && kinds.includes(p.kind));
    set({ ...cleared, source, ...(keep ? {} : { platform: '' }) } as Partial<CheckDef>);
  };
  return (
    <>
      <SegmentedControl
        size="xs"
        disabled={disabled}
        value={c.source}
        onChange={switchSource}
        data-field="source"
        data={[
          { value: 'insightsHub', label: t('form.sourceInsightsHub') },
          { value: 'influxdb', label: t('form.sourceInfluxdb') },
          { value: 'platform', label: t('form.sourcePlatform') },
        ]}
      />
      <PlatformSelect
        value={c.platform}
        onChange={(v) => set({ platform: v })}
        platforms={platforms}
        kinds={checkPlatformKinds(c)}
        disabled={disabled}
        error={err('platform')}
      />
      {c.source === 'insightsHub' ? (
        <>
          <Group grow align="flex-start">
            <TextInput
              error={err('assetId')}
              data-field="assetId"
              label={t('form.assetId')}
              required
              disabled={disabled}
              value={c.assetId ?? ''}
              onChange={(e) => set({ assetId: e.currentTarget.value })}
              classNames={{ input: 'mono' }}
            />
            <TextInput
              error={err('aspect')}
              data-field="aspect"
              label={t('form.aspect')}
              required
              disabled={disabled}
              value={c.aspect ?? ''}
              onChange={(e) => set({ aspect: e.currentTarget.value })}
            />
          </Group>
          <TagsInput
            error={err('variables')}
            data-field="variables"
            label={t('form.variables')}
            description={t('form.variablesHint')}
            required
            disabled={disabled}
            value={c.variables ?? []}
            onChange={(v) => set({ variables: v })}
          />
          <Hint>{t('form.sharedCall')}</Hint>
        </>
      ) : c.source === 'influxdb' ? (
        <InfluxFields c={c} set={set} platforms={platforms} disabled={disabled} err={err} />
      ) : (
        <>
          <Group grow align="flex-start">
            <Select
              error={err('method')}
              data-field="method"
              label={t('form.method')}
              data={['GET', 'POST']}
              allowDeselect={false}
              disabled={disabled}
              value={c.method ?? 'GET'}
              onChange={(v) => set({ method: v === 'POST' ? 'POST' : undefined, ...(v === 'POST' ? {} : { body: undefined }) })}
              maw={120}
            />
            <TextInput
              error={err('path')}
              data-field="path"
              label={t('form.path')}
              required
              disabled={disabled}
              value={c.path ?? ''}
              onChange={(e) => set({ path: e.currentTarget.value })}
              style={{ flex: 4 }}
              classNames={{ input: 'mono' }}
            />
          </Group>
          <div data-field="headers">
            <Text size="sm" fw={500}>
              {t('form.headers')}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {t('form.headersHint')}
            </Text>
            <KeyValueEditor value={c.headers} onChange={(v) => set({ headers: v as Record<string, string> | undefined })} />
            {err('headers') && (
              <Text size="xs" c="red" mt={4}>
                {err('headers')}
              </Text>
            )}
          </div>
          {c.method === 'POST' && <BodyInput value={c.body} onChange={(v) => set({ body: v })} disabled={disabled} error={err('body')} />}
          <ExpressionInput
            error={err('timestamp')}
            data-field="timestamp"
            label={t('form.timestamp')}
            description={t('form.timestampHint')}
            required
            preview={false}
            value={c.timestamp ?? ''}
            onChange={(v) => set({ timestamp: v || undefined })}
          />
        </>
      )}
      <FreshnessFields c={c} set={set} disabled={disabled} what="data" err={err} observedDelay={observedDelay} />
    </>
  );
}

/**
 * The InfluxDB source (0.18.0): what to read – the platform's variable version decides the dialect (1.x InfluxQL, 2.x
 * Flux) and whether it is a database or a bucket. Steward writes the query from these fields.
 */
function InfluxFields({
  c,
  set,
  platforms,
  disabled,
  err,
}: {
  c: CheckOf<'freshness'>;
  set: Patch;
  platforms: Platform[];
  disabled?: boolean;
  err: FieldError;
}) {
  const { t } = useTranslation('monitors');
  const version = influxVersionOf(platforms.find((p) => p.id === c.platform)?.config?.variables);
  // 2.x reads a bucket, 1.x a database; the other name is kept as it is when the platform changes
  const container = version === '2' ? 'bucket' : 'database';
  const containerValue = (version === '2' ? (c.bucket ?? c.database) : (c.database ?? c.bucket)) ?? '';
  const setContainer = (v: string) => set({ database: undefined, bucket: undefined, [container]: v || undefined });
  return (
    <>
      {!version && c.platform && <Hint>{t('form.influxNoVersion')}</Hint>}
      <Group grow align="flex-start">
        <TextInput
          error={err('database') ?? err('bucket')}
          data-field="database"
          label={t(version === '2' ? 'form.influxBucket' : version ? 'form.influxDatabase' : 'form.influxDatabaseOrBucket')}
          required
          disabled={disabled}
          value={containerValue}
          onChange={(e) => setContainer(e.currentTarget.value)}
          classNames={{ input: 'mono' }}
        />
        {version === '1' && (
          <TextInput
            error={err('retentionPolicy')}
            data-field="retentionPolicy"
            label={t('form.influxRetentionPolicy')}
            description={t('form.influxRetentionPolicyHint')}
            disabled={disabled}
            value={c.retentionPolicy ?? ''}
            onChange={(e) => set({ retentionPolicy: e.currentTarget.value || undefined })}
            classNames={{ input: 'mono' }}
          />
        )}
        <TextInput
          error={err('measurement')}
          data-field="measurement"
          label={t('form.influxMeasurement')}
          required
          disabled={disabled}
          value={c.measurement ?? ''}
          onChange={(e) => set({ measurement: e.currentTarget.value || undefined })}
          classNames={{ input: 'mono' }}
        />
      </Group>
      <TagsInput
        error={err('fields')}
        data-field="fields"
        label={t('form.influxFields')}
        description={t('form.influxFieldsHint', { max: INFLUX_LIMITS.fields })}
        disabled={disabled}
        maxTags={INFLUX_LIMITS.fields}
        value={c.fields ?? []}
        onChange={(v) => set({ fields: v.length ? v : undefined })}
      />
      <div data-field="tags">
        <Text size="sm" fw={500}>
          {t('form.influxTags')}
        </Text>
        <Text size="xs" c="dimmed" mb={4}>
          {t('form.influxTagsHint')}
        </Text>
        <KeyValueEditor
          value={c.tags}
          onChange={(v) => set({ tags: v && Object.keys(v).length ? (v as Record<string, string>) : undefined })}
          keyLabel={t('form.influxTagKey')}
          valueLabel={t('form.influxTagValue')}
        />
        {err('tags') && (
          <Text size="xs" c="red" mt={4}>
            {err('tags')}
          </Text>
        )}
      </div>
      <Group grow align="flex-start">
        <TextInput
          error={err('groupBy')}
          data-field="groupBy"
          label={t('form.influxGroupBy')}
          description={t('form.influxGroupByHint')}
          disabled={disabled}
          value={c.groupBy ?? ''}
          onChange={(e) => set({ groupBy: e.currentTarget.value || undefined, ...(e.currentTarget.value ? {} : { expectedSeries: undefined }) })}
          classNames={{ input: 'mono' }}
        />
        <NumberInput
          error={err('lookbackHours')}
          data-field="lookbackHours"
          label={t('form.influxLookback')}
          description={t('form.influxLookbackHint', { max: INFLUX_LIMITS.maxLookbackHours })}
          placeholder={String(INFLUX_LIMITS.defaultLookbackHours)}
          min={1}
          max={INFLUX_LIMITS.maxLookbackHours}
          allowDecimal={false}
          disabled={disabled}
          value={c.lookbackHours ?? ''}
          onChange={(v) => set({ lookbackHours: num(v) })}
        />
      </Group>
      {c.groupBy && (
        <TagsInput
          error={err('expectedSeries')}
          data-field="expectedSeries"
          label={t('form.influxExpected')}
          description={t('form.influxExpectedHint', { tag: c.groupBy })}
          disabled={disabled}
          maxTags={INFLUX_LIMITS.expectedSeries}
          value={c.expectedSeries ?? []}
          onChange={(v) => set({ expectedSeries: v.length ? v : undefined })}
        />
      )}
      <Hint>{t('form.influxHint', { max: INFLUX_LIMITS.series })}</Hint>
    </>
  );
}
