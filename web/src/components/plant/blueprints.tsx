import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Anchor, Badge, Group, MultiSelect, Select, Stack, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BLUEPRINT_LIMITS,
  BLUEPRINT_WHY,
  BLUEPRINT_IMPORTANCES,
  PLANT_ID_RE,
  type BlueprintImportance,
  type BlueprintState,
  type BlueprintWhy,
  type PlantBlueprintSignal,
  type PlantBlueprintValues,
  type PlantKpiSummary,
} from '@sm/shared';
import { get, notifyError } from '../../api';
import { plantKeys } from '../../queryKeys';
import { TONE, useFieldErrors } from '../common';
import { FormModal } from '../FormModal';
import { FormButtons, IdInput, useIdField } from './forms';

/** The colour of a signal's state (the label says it as well). */
export const STATE_COLOR: Record<BlueprintState, string> = {
  covered: TONE.ok,
  missing: TONE.bad,
  notCollected: TONE.attention,
  notApplicable: TONE.neutral,
};

export function StateBadge({ state, size = 'sm' }: { state: BlueprintState; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantBlueprints');
  return (
    <Badge size={size} variant="light" color={STATE_COLOR[state]} tt="none" data-testid={`state-${state}`}>
      {t(`coverage.states.${state}`)}
    </Badge>
  );
}

const IMPORTANCE_COLOR: Record<BlueprintImportance, string> = { must: TONE.bad, should: TONE.active, nice: TONE.neutral };

export function ImportanceBadge({ importance, size = 'xs' }: { importance: BlueprintImportance; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantBlueprints');
  return (
    <Badge size={size} variant="outline" color={IMPORTANCE_COLOR[importance]} tt="none">
      {t(`signals.importances.${importance}`)}
    </Badge>
  );
}

/** The reasons a signal matters, as small badges. */
export function WhyBadges({ why }: { why: BlueprintWhy[] }) {
  const { t } = useTranslation('plantBlueprints');
  if (why.length === 0) return null;
  return (
    <Group gap={4}>
      {why.map((w) => (
        <Badge key={w} size="xs" variant="default" tt="none">
          {t(`signals.whys.${w}`)}
        </Badge>
      ))}
    </Group>
  );
}

type Save<T> = (v: T) => Promise<void>;

/** The modal of the blueprint editors: Enter saves, errors are shown, the dialog stays open on failure. */
function Form({
  title,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => Promise<boolean | void>;
  children: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <FormModal onClose={onClose} size="lg" title={title}>
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
    </FormModal>
  );
}

/** A machine blueprint's own fields (the signals have their own editor). */
export type BlueprintFields = Omit<PlantBlueprintValues, 'signals'>;

export function BlueprintFormModal({ blueprint, onClose, onSave }: { blueprint?: BlueprintFields; onClose: () => void; onSave: Save<BlueprintFields> }) {
  const { t } = useTranslation(['plantBlueprints', 'plant', 'common']);
  const [name, setName] = useState(blueprint?.name ?? '');
  const id = useIdField(blueprint?.id);
  const [description, setDescription] = useState(blueprint?.description ?? '');
  const [reference, setReference] = useState(blueprint?.reference ?? '');
  const [version, setVersion] = useState(blueprint?.version ?? '');
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required'), id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid') });
  return (
    <Form
      title={blueprint ? t('form.editTitle', { name: blueprint.name }) : t('form.newTitle')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({ id: id.id, name: name.trim(), description, reference: reference.trim(), version: version.trim() });
      }}
    >
      <TextInput
        label={t('form.name')}
        required
        data-autofocus
        data-testid="blueprint-name"
        maxLength={BLUEPRINT_LIMITS.name}
        value={name}
        onChange={(e) => {
          setName(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('name')}
      />
      <IdInput value={id.id} onChange={id.set} disabled={!!blueprint} error={v.error('id')} />
      <Textarea
        label={t('form.description')}
        autosize
        minRows={2}
        maxRows={8}
        maxLength={BLUEPRINT_LIMITS.text}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Group grow align="flex-start">
        <TextInput
          label={t('form.reference')}
          description={t('form.referenceHelp')}
          maxLength={BLUEPRINT_LIMITS.name}
          value={reference}
          onChange={(e) => setReference(e.currentTarget.value)}
        />
        <TextInput label={t('form.version')} maxLength={60} value={version} onChange={(e) => setVersion(e.currentTarget.value)} />
      </Group>
    </Form>
  );
}

/** One signal: name, meaning, why it matters, importance, known-as names. The id is made from the name and stays. */
export function SignalFormModal({
  signal,
  taken,
  onClose,
  onSave,
}: {
  signal?: PlantBlueprintSignal;
  /** Ids of the other signals of the blueprint */
  taken: string[];
  onClose: () => void;
  onSave: Save<PlantBlueprintSignal>;
}) {
  const { t } = useTranslation(['plantBlueprints', 'plant', 'common']);
  const [name, setName] = useState(signal?.name ?? '');
  const id = useIdField(signal?.id);
  const [meaning, setMeaning] = useState(signal?.meaning ?? '');
  const [why, setWhy] = useState<string[]>(signal?.why ?? []);
  const [importance, setImportance] = useState<BlueprintImportance>(signal?.importance ?? 'should');
  const [aliases, setAliases] = useState<string[]>(signal?.aliases ?? []);
  const [kpis, setKpis] = useState<string[]>(signal?.kpis ?? []);
  // the KPI definitions the reader may see; a link to one that is not in the list (gone, or not theirs) stays as it is
  const defs = useQuery({ queryKey: plantKeys.kpis, queryFn: () => get<PlantKpiSummary[]>('/plant/kpis') });
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: (!PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid')) || (taken.includes(id.id) && t('plant:data.idTaken')),
  });
  return (
    <Form
      title={signal ? t('signals.editTitle', { name: signal.name }) : t('signals.newTitle')}
      onClose={onClose}
      onSubmit={async () => {
        if (!v.validate()) return false;
        await onSave({
          id: id.id,
          name: name.trim(),
          meaning,
          why: why as BlueprintWhy[],
          importance,
          aliases: aliases.map((a) => a.trim()).filter(Boolean),
          kpis,
        });
      }}
    >
      <TextInput
        label={t('signals.name')}
        required
        data-autofocus
        data-testid="signal-name"
        maxLength={BLUEPRINT_LIMITS.name}
        value={name}
        onChange={(e) => {
          setName(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('name')}
      />
      {signal ? null : <IdInput value={id.id} onChange={id.set} disabled={false} error={v.error('id')} />}
      <Textarea
        label={t('signals.meaning')}
        description={t('signals.meaningHelp')}
        autosize
        minRows={2}
        maxRows={6}
        maxLength={BLUEPRINT_LIMITS.text}
        value={meaning}
        onChange={(e) => setMeaning(e.currentTarget.value)}
        data-testid="signal-meaning"
      />
      <Select
        label={t('signals.importance')}
        data={BLUEPRINT_IMPORTANCES.map((i) => ({ value: i, label: t(`signals.importances.${i}`) }))}
        value={importance}
        onChange={(x) => x && setImportance(x as BlueprintImportance)}
        allowDeselect={false}
        data-testid="signal-importance"
      />
      <MultiSelect
        label={t('signals.why')}
        data={BLUEPRINT_WHY.map((w) => ({ value: w, label: t(`signals.whys.${w}`) }))}
        value={why}
        onChange={setWhy}
        data-testid="signal-why"
      />
      <TagsInput
        label={t('signals.aliases')}
        description={t('signals.aliasesHelp')}
        maxTags={BLUEPRINT_LIMITS.aliases}
        value={aliases}
        onChange={setAliases}
        data-testid="signal-aliases"
      />
      <MultiSelect
        label={t('signals.kpis')}
        description={t('signals.kpisHelp')}
        searchable
        data={(defs.data ?? []).map((k) => ({ value: k.id, label: k.name }))}
        value={kpis.filter((k) => (defs.data ?? []).some((d) => d.id === k))}
        onChange={(next) => setKpis([...kpis.filter((k) => !(defs.data ?? []).some((d) => d.id === k)), ...next])}
        data-testid="signal-kpis"
      />
    </Form>
  );
}

/** The KPI definitions a signal feeds, as links (the names come from the KPI list the reader may see). */
export function KpiLinks({ kpis }: { kpis: string[] }) {
  const { t } = useTranslation('plantBlueprints');
  const defs = useQuery({ queryKey: plantKeys.kpis, queryFn: () => get<PlantKpiSummary[]>('/plant/kpis'), enabled: kpis.length > 0 });
  if (!kpis.length) return null;
  const name = (id: string) => defs.data?.find((d) => d.id === id)?.name ?? id;
  return (
    <Group gap={6} data-testid="signal-kpi-links">
      <Text size="xs" c="dimmed">
        {t('signals.kpis')}:
      </Text>
      {kpis.map((k) => (
        <Anchor key={k} component={Link} to={`/plant/kpis/${encodeURIComponent(k)}`} size="xs">
          {name(k)}
        </Anchor>
      ))}
    </Group>
  );
}
