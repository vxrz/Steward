import { useEffect, useState } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBuildingFactory2, IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import {
  LOCALES,
  PLANT_FIELD_KEY_RE,
  PLANT_FIELD_KINDS,
  PLANT_DOC_REVIEW_LIMITS,
  PLANT_LIMITS,
  PLANT_RECORD_TYPES,
  PLANT_SOURCE_TYPE_ID,
  type PlantFieldDef,
  type PlantFieldKind,
  type PlantSettings,
} from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { plantKeys } from '../../queryKeys';
import { useSaveSection } from '../settings/SaveBar';
import { PlantAliasesCard } from './ids';
import { useRecordTypes, useTypeName } from '../records/common';

/**
 * Settings → Modules → Plant registry (#218): the switch (off by default; off, the module's pages and routes are gone
 * and its data is kept), the enterprise's name, own display names of the record types and own fields per record type.
 */
export function PlantSettingsCard() {
  const { t } = useTranslation(['plant', 'settings', 'plantDocs']);
  const qc = useQueryClient();
  const recordTypes = useRecordTypes();
  const typeName = useTypeName();
  const q = useQuery({ queryKey: plantKeys.settings, queryFn: () => get<PlantSettings>('/settings/plant') });
  const [d, setD] = useState<PlantSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data) setD(q.data);
  }, [q.data]);
  const fieldsValid =
    !!d &&
    PLANT_RECORD_TYPES.every((type) => {
      const defs = d.fields[type] ?? [];
      const keys = defs.map((f) => f.key);
      return (
        defs.every((f) => PLANT_FIELD_KEY_RE.test(f.key) && f.label.trim() && (f.kind !== 'select' || f.options.length)) && new Set(keys).size === keys.length
      );
    });
  const dirty = !!d && !!q.data && JSON.stringify(d) !== JSON.stringify(q.data);
  const save = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const next = await put<PlantSettings>('/settings/plant', {
        enabled: d.enabled,
        enterprise: d.enterprise,
        labels: d.labels,
        fields: d.fields,
        documentReview: d.documentReview ?? {},
      });
      qc.setQueryData(plantKeys.settings, next);
      // the sidebar's Plant area and the link kinds follow the switch
      void qc.invalidateQueries({ queryKey: ['auth'] });
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      // Settings → Modules shows the switch's state, too (ADR 0016)
      void qc.invalidateQueries({ queryKey: ['settings', 'modules'] });
      notifyOk(t('settings.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const inBar = useSaveSection('plant', { dirty, valid: fieldsValid, save, reset: () => q.data && setD(q.data) });
  if (!d) return null;
  const langs = LOCALES.map((l) => l.code);
  const setLabel = (type: (typeof PLANT_RECORD_TYPES)[number], lang: string, which: 'one' | 'other', value: string) => {
    const cur = d.labels[type]?.[lang] ?? { one: '', other: '' };
    setD({ ...d, labels: { ...d.labels, [type]: { ...d.labels[type], [lang]: { ...cur, [which]: value } } } });
  };
  const setFields = (type: (typeof PLANT_RECORD_TYPES)[number], defs: PlantFieldDef[]) => setD({ ...d, fields: { ...d.fields, [type]: defs } });
  // 0.14: review intervals per document type (living documents people write; not the generated gateway configurations)
  const docTypes = (recordTypes.data ?? []).filter((x) => x.workflow === 'document' && !x.archived && x.id !== PLANT_SOURCE_TYPE_ID);
  const setReview = (key: string, months: number | null) => {
    const next = { ...(d.documentReview ?? {}) };
    if (months) next[key] = months;
    else delete next[key];
    setD({ ...d, documentReview: next });
  };
  return (
    <>
      <Card withBorder data-testid="plant-settings">
        <Group gap="xs" mb="xs" wrap="nowrap">
          <IconBuildingFactory2 size={18} aria-hidden />
          <Title order={5}>{t('settings.title')}</Title>
          <Badge color="grape" variant="light" size="sm">
            {t('preview')}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          <Trans t={t} i18nKey="settings.description" components={{ b: <b /> }} />
        </Text>
        <Stack gap="sm">
          <Switch
            label={t('settings.enabled')}
            description={t('settings.enabledHelp')}
            checked={d.enabled}
            onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })}
            data-testid="plant-enabled"
          />
          {q.data?.enabled && !d.enabled && (
            <Alert color="yellow" p="xs">
              <Text size="sm">{t('settings.turningOff')}</Text>
            </Alert>
          )}
          {d.enabled && (
            <>
              <TextInput
                label={t('settings.enterprise')}
                description={t('settings.enterpriseHelp')}
                maxLength={PLANT_LIMITS.name}
                value={d.enterprise}
                onChange={(e) => setD({ ...d, enterprise: e.currentTarget.value })}
                maw={420}
              />
              <Accordion variant="contained" multiple>
                <Accordion.Item value="labels">
                  <Accordion.Control>{t('settings.labels')}</Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb="xs">
                      {t('settings.labelsHelp')}
                    </Text>
                    <div className="table-scroll">
                      <Table fz="sm" aria-label={t('settings.labels')}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('settings.recordType')}</Table.Th>
                            {langs.map((l) => (
                              <Table.Th key={l}>{LOCALES.find((x) => x.code === l)!.nativeName}</Table.Th>
                            ))}
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {PLANT_RECORD_TYPES.map((type) => (
                            <Table.Tr key={type}>
                              <Table.Td className="nowrap">{t(`types.${type}.one`)}</Table.Td>
                              {langs.map((l) => (
                                <Table.Td key={l}>
                                  <Group gap={4} wrap="nowrap">
                                    <TextInput
                                      size="xs"
                                      aria-label={t('settings.labelOne', { type: t(`types.${type}.one`), language: l })}
                                      placeholder={t(`types.${type}.one`, { lng: l })}
                                      value={d.labels[type]?.[l]?.one ?? ''}
                                      onChange={(e) => setLabel(type, l, 'one', e.currentTarget.value)}
                                      maxLength={60}
                                      miw={110}
                                    />
                                    <TextInput
                                      size="xs"
                                      aria-label={t('settings.labelOther', { type: t(`types.${type}.one`), language: l })}
                                      placeholder={t(`types.${type}.other`, { lng: l })}
                                      value={d.labels[type]?.[l]?.other ?? ''}
                                      onChange={(e) => setLabel(type, l, 'other', e.currentTarget.value)}
                                      maxLength={60}
                                      miw={110}
                                    />
                                  </Group>
                                </Table.Td>
                              ))}
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  </Accordion.Panel>
                </Accordion.Item>
                <Accordion.Item value="documentReview">
                  <Accordion.Control>{t('plantDocs:settings.title')}</Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb="xs">
                      {t('plantDocs:settings.help')}
                    </Text>
                    <div className="table-scroll">
                      <Table fz="sm" aria-label={t('plantDocs:settings.title')} data-testid="plant-doc-review-types">
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('plantDocs:settings.type')}</Table.Th>
                            <Table.Th>{t('plantDocs:settings.months')}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {docTypes.map((rt) => (
                            <Table.Tr key={rt.id}>
                              <Table.Td>{typeName(rt)}</Table.Td>
                              <Table.Td>
                                <NumberInput
                                  size="xs"
                                  min={1}
                                  max={PLANT_DOC_REVIEW_LIMITS.monthsMax}
                                  aria-label={t('plantDocs:settings.monthsFor', { type: typeName(rt) })}
                                  value={d.documentReview?.[rt.key] ?? ''}
                                  onChange={(v) => setReview(rt.key, typeof v === 'number' ? v : null)}
                                  w={120}
                                />
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  </Accordion.Panel>
                </Accordion.Item>
                <Accordion.Item value="fields">
                  <Accordion.Control>{t('settings.fields')}</Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb="xs">
                      {t('settings.fieldsHelp')}
                    </Text>
                    <Stack gap="md">
                      {PLANT_RECORD_TYPES.map((type) => (
                        <FieldDefsEditor key={type} title={t(`types.${type}.other`)} defs={d.fields[type] ?? []} onChange={(defs) => setFields(type, defs)} />
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            </>
          )}
          {!inBar && (
            <Group justify="flex-end">
              <Button size="xs" onClick={() => void save()} loading={busy} disabled={!fieldsValid || !dirty}>
                {t('settings.save')}
              </Button>
            </Group>
          )}
        </Stack>
      </Card>
      {/* the old ids of renamed entries (0.11.0) */}
      {q.data?.enabled && <PlantAliasesCard />}
    </>
  );
}

function FieldDefsEditor({ title, defs, onChange }: { title: string; defs: PlantFieldDef[]; onChange: (d: PlantFieldDef[]) => void }) {
  const { t } = useTranslation('plant');
  const set = (i: number, patch: Partial<PlantFieldDef>) => onChange(defs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {title}
      </Text>
      {defs.map((f, i) => (
        <Group key={i} gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label={t('settings.fieldKey')}
            value={f.key}
            onChange={(e) => set(i, { key: e.currentTarget.value.toLowerCase() })}
            error={!PLANT_FIELD_KEY_RE.test(f.key) || defs.filter((x) => x.key === f.key).length > 1 ? true : undefined}
            classNames={{ input: 'mono' }}
            maxLength={40}
            style={{ flex: '1 1 120px' }}
          />
          <TextInput
            size="xs"
            label={t('settings.fieldLabel')}
            value={f.label}
            onChange={(e) => set(i, { label: e.currentTarget.value })}
            maxLength={100}
            style={{ flex: '2 1 150px' }}
          />
          <Select
            size="xs"
            label={t('settings.fieldKind')}
            data={PLANT_FIELD_KINDS.map((k) => ({ value: k, label: t(`fieldKinds.${k}`) }))}
            value={f.kind}
            onChange={(v) => v && set(i, { kind: v as PlantFieldKind })}
            allowDeselect={false}
            style={{ flex: '1 1 120px' }}
          />
          {f.kind === 'select' && (
            <TagsInput
              size="xs"
              label={t('settings.fieldOptions')}
              value={f.options}
              onChange={(v) => set(i, { options: v })}
              maxTags={PLANT_LIMITS.fieldOptions}
              error={!f.options.length ? true : undefined}
              style={{ flex: '2 1 180px' }}
            />
          )}
          <Checkbox size="xs" label={t('settings.fieldRequired')} checked={f.required} onChange={(e) => set(i, { required: e.currentTarget.checked })} mb={6} />
          <ActionIcon
            variant="subtle"
            color="red"
            mb={2}
            aria-label={t('settings.fieldRemove', { name: f.label || f.key || '–' })}
            onClick={() => onChange(defs.filter((_, j) => j !== i))}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        size="xs"
        variant="default"
        w="fit-content"
        leftSection={<IconPlus size={14} />}
        onClick={() => onChange([...defs, { key: '', label: '', labels: {}, kind: 'text', required: false, options: [], help: '' }])}
        disabled={defs.length >= PLANT_LIMITS.fieldDefs}
      >
        {t('settings.fieldAdd')}
      </Button>
    </Stack>
  );
}
