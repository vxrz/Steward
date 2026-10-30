import { useState } from 'react';
import { Badge, Button, Checkbox, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  OBJECTIVE_LIMITS,
  OBJECTIVE_WINDOWS,
  type GatusEndpointState,
  type GatusMetricsSource,
  type ObjectiveDetail,
  type ObjectiveStatus,
  type ObjectiveSummary,
  type ObjectiveTargets,
  type ObjectiveWindow,
  type ScorecardPart,
  type ScorecardPartStatus,
  type ServiceScorecard,
  SCORECARD_PARTS,
} from '@sm/shared';
import { get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { TONE, useFieldErrors } from '../common';
import { fmtNumber } from '../../format';

/** Colours of the part statuses (the label always says the status, too). */
/** The parts to show: "Tech stack" only while it is turned on in the end-of-life settings (#104). */
export function shownParts(cards: Pick<ServiceScorecard, 'lifecycle'>[]): ScorecardPart[] {
  const lifecycle = cards.some((c) => c.lifecycle?.enabled);
  return SCORECARD_PARTS.filter((p) => p !== 'lifecycle' || lifecycle);
}

export const PART_COLORS: Record<ScorecardPartStatus | 'hidden', string> = {
  ok: TONE.ok,
  attention: TONE.bad,
  pending: TONE.soon,
  none: TONE.neutral,
  hidden: TONE.neutral,
};
export const OBJECTIVE_COLORS: Record<ObjectiveStatus, string> = { met: TONE.ok, below: TONE.bad, noData: TONE.neutral };

export const fmtPct = (x: number | null | undefined) => (x === null || x === undefined ? '–' : `${fmtNumber(x, { maximumFractionDigits: 2 })} %`);

export function PartBadge({ status, size = 'sm' }: { status: ScorecardPartStatus | 'hidden'; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('scorecard');
  return (
    <Badge size={size} color={PART_COLORS[status]} variant="light" tt="none" data-testid="part-status" data-status={status}>
      {t(`statuses.${status}`)}
    </Badge>
  );
}

export function ObjectiveStatusBadge({ status, size = 'sm' }: { status: ObjectiveStatus; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('scorecard');
  return (
    <Badge size={size} color={OBJECTIVE_COLORS[status]} variant="light" tt="none" data-testid="objective-status" data-status={status}>
      {t(`objectiveStatuses.${status}`)}
    </Badge>
  );
}

/** "Attention needed" or "OK" for a whole service. */
export function AttentionBadge({ attention, size = 'sm' }: { attention: boolean; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('scorecard');
  return (
    <Badge size={size} color={attention ? TONE.bad : TONE.ok} variant={attention ? 'filled' : 'light'} tt="none" data-testid="attention">
      {attention ? t('attention') : t('allGood')}
    </Badge>
  );
}

const emptyTargets = (): Record<ObjectiveWindow, number | ''> => ({ h1: '', h24: '', d7: '', d30: '' });

/** Create or edit an availability objective of a service. */
export function ObjectiveFormModal({
  serviceId,
  applications,
  objective,
  onClose,
  onSaved,
}: {
  serviceId: string;
  applications: { id: string; name: string }[];
  objective?: ObjectiveSummary;
  onClose: () => void;
  onSaved: (o: ObjectiveDetail) => void;
}) {
  const { t } = useTranslation(['scorecard', 'common']);
  // an editor who may not see the objective's platform keeps it as it is and changes the targets only
  const hiddenPlatform = !!objective && !objective.platformVisible;
  const sources = useQuery({ queryKey: ['gatus-sources'], queryFn: () => getOptional<GatusMetricsSource[]>('/gatus/sources', []) });
  // Prometheus platforms (#110): the figures come from a PromQL query with $window
  const proms = useQuery({
    queryKey: ['platforms', 'prometheus'],
    queryFn: async () => (await getOptional<{ id: string; name: string; kind: string }[]>('/platforms', [])).filter((p) => p.kind === 'prometheus'),
  });
  const [platformId, setPlatformId] = useState<string | null>(objective?.platformId ?? null);
  const isProm = !!platformId && (proms.data ?? []).some((p) => p.id === platformId);
  const endpoints = useQuery({
    queryKey: ['gatus-endpoints', platformId],
    queryFn: () => get<GatusEndpointState[]>(`/gatus/sources/${encodeURIComponent(platformId!)}/endpoints`),
    enabled: !!platformId && !hiddenPlatform && !isProm,
  });
  const [endpointKey, setEndpointKey] = useState<string | null>(objective?.endpointKey ?? null);
  const [name, setName] = useState(objective?.name ?? '');
  const [description, setDescription] = useState(objective?.description ?? '');
  const [applicationId, setApplicationId] = useState<string | null>(objective?.applicationId ?? null);
  const [targets, setTargets] = useState<Record<ObjectiveWindow, number | ''>>(() => {
    const out = emptyTargets();
    if (objective) for (const w of OBJECTIVE_WINDOWS) out[w] = objective.targets[w] ?? '';
    else out.h24 = 99;
    return out;
  });
  const [notify, setNotify] = useState(objective?.notify ?? false);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    platform: !hiddenPlatform && !platformId && t('common:validation.required'),
    endpoint: !hiddenPlatform && !endpointKey && t('common:validation.required'),
    query: !hiddenPlatform && isProm && !!endpointKey && !endpointKey.includes('$window') && t('form.promWindowMissing'),
    targets: OBJECTIVE_WINDOWS.every((w) => targets[w] === '') && t('form.targetsRequired'),
  });
  const source = (sources.data ?? []).find((x) => x.platformId === platformId);
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      description,
      applicationId,
      ...(hiddenPlatform ? {} : { platformId, endpointKey }),
      targets: Object.fromEntries(OBJECTIVE_WINDOWS.map((w) => [w, targets[w] === '' ? null : targets[w]])) as ObjectiveTargets,
      notify,
    };
    try {
      const saved = objective
        ? await put<ObjectiveDetail>(`/objectives/${objective.id}`, body)
        : await post<ObjectiveDetail>('/objectives', { serviceId, ...body });
      notifyOk(t('form.saved'));
      onSaved(saved);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={objective ? t('form.editOf', { name: objective.name }) : t('form.add')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {hiddenPlatform ? (
            <Text size="sm" c="dimmed">
              {t('form.platformHidden')}
            </Text>
          ) : (
            <>
              <Select
                label={t('form.platform')}
                description={t('form.platformHint')}
                data={[
                  ...(sources.data ?? []).map((x) => ({ value: x.platformId, label: x.platformName })),
                  ...(proms.data ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
                value={platformId}
                onChange={(x) => {
                  setPlatformId(x);
                  setEndpointKey(null);
                }}
                nothingFoundMessage={t('form.noSources')}
                required
                error={v.error('platform')}
              />
              {source && !source.fetchUptimes && (
                <Text size="xs" c="orange.8" data-testid="uptimes-off">
                  {t('form.uptimesOff')}
                </Text>
              )}
              {isProm ? (
                <Textarea
                  label={t('form.promQuery')}
                  description={t('form.promQueryHint')}
                  value={endpointKey ?? ''}
                  onChange={(e) => setEndpointKey(e.currentTarget.value || null)}
                  autosize
                  minRows={2}
                  maxLength={500}
                  classNames={{ input: 'mono' }}
                  required
                  error={v.error('endpoint') || v.error('query')}
                />
              ) : (
                <Select
                  label={t('form.endpoint')}
                  data={(endpoints.data ?? []).map((e) => ({ value: e.key, label: e.group ? `${e.group}/${e.name}` : e.name || e.key }))}
                  value={endpointKey}
                  onChange={(x) => {
                    setEndpointKey(x);
                    const e = (endpoints.data ?? []).find((y) => y.key === x);
                    if (e && !name.trim()) setName(e.name || e.key);
                  }}
                  searchable
                  disabled={!platformId}
                  required
                  error={v.error('endpoint')}
                />
              )}
            </>
          )}
          <TextInput
            label={t('form.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={OBJECTIVE_LIMITS.name}
            required
            error={v.error('name')}
          />
          {applications.length > 0 && (
            <Select
              label={t('form.application')}
              placeholder={t('form.wholeService')}
              data={applications.map((a) => ({ value: a.id, label: a.name }))}
              value={applicationId}
              onChange={setApplicationId}
              clearable
            />
          )}
          <div>
            <Text size="sm" fw={500} id="objective-targets">
              {t('form.targets')}
            </Text>
            <Text size="xs" c="dimmed" mb={6}>
              {t('form.targetsHint')}
            </Text>
            <SimpleGrid cols={{ base: 2, sm: 4 }} role="group" aria-labelledby="objective-targets">
              {OBJECTIVE_WINDOWS.map((w) => (
                <NumberInput
                  key={w}
                  label={t(`windows.${w}`)}
                  aria-label={t('form.targetOf', { window: t(`windows.${w}`) })}
                  min={0}
                  max={100}
                  decimalScale={2}
                  suffix=" %"
                  value={targets[w]}
                  onChange={(x) => setTargets((cur) => ({ ...cur, [w]: typeof x === 'number' ? x : '' }))}
                  error={w === 'h1' ? v.error('targets') : undefined}
                />
              ))}
            </SimpleGrid>
          </div>
          <Textarea
            label={t('form.description')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            maxLength={OBJECTIVE_LIMITS.description}
            autosize
            minRows={2}
          />
          <Checkbox label={t('form.notify')} description={t('form.notifyHint')} checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
