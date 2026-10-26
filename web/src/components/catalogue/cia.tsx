import { useState } from 'react';
import { Badge, Button, Group, Modal, Paper, Select, Stack, Table, Text, Textarea, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconShieldHalf } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_DIMENSIONS,
  type ApplicationDetail,
  type ApplicationRating,
  type CiaDimension,
  type CiaLevel,
  type CiaScale,
  type ServiceDetail,
  type ServiceProtectionNeed,
} from '@sm/shared';
import { get, notifyError, put } from '../../api';
import { useFieldErrors } from '../common';
import { fmtDate } from '../../format';

/** The CIA scale in use (levels per dimension, lowest first). */
export function useCiaScale() {
  return useQuery({ queryKey: ['cia-scale'], queryFn: () => get<CiaScale>('/catalogue/cia-scale'), staleTime: 60_000 });
}

/** Label and colour of a level: the built-in (BSI) levels in the UI language, custom levels as the administrator named them. */
export function useLevel() {
  const { t } = useTranslation('applications');
  const scale = useCiaScale().data;
  return (d: CiaDimension, key: string | null | undefined): { label: string; description: string; color: string; known: boolean } | null => {
    if (!key) return null;
    const l = scale?.levels[d].find((x) => x.key === key);
    if (!l) return { label: key, description: '', color: 'gray', known: false };
    return { ...levelText(t, scale!, l), color: l.color, known: true };
  };
}

type T = ReturnType<typeof useTranslation<'applications'>>['t'];
export function levelText(t: T, scale: Pick<CiaScale, 'mode'>, l: CiaLevel): { label: string; description: string } {
  if (scale.mode === 'default' && (l.key === 'normal' || l.key === 'high' || l.key === 'very_high'))
    return { label: t(`cia.builtin.${l.key}.label`), description: t(`cia.builtin.${l.key}.description`) };
  return { label: l.label, description: l.description };
}

/** One dimension's level as a badge ("C: High"); flagged ratings show a warning. */
export function LevelBadge({
  dimension,
  level,
  stale,
  short = false,
  size = 'sm',
}: {
  dimension: CiaDimension;
  level: string | null | undefined;
  stale?: boolean;
  short?: boolean;
  size?: 'xs' | 'sm' | 'md';
}) {
  const { t } = useTranslation('applications');
  const lv = useLevel()(dimension, level);
  const dim = short ? t(`cia.short.${dimension}`) : t(`cia.dimensions.${dimension}`);
  const text = t('cia.badge', { dimension: dim, level: lv?.label ?? t('cia.notRated') });
  const badge = (
    <Badge
      size={size}
      variant={lv ? 'light' : 'outline'}
      color={stale ? 'yellow' : (lv?.color ?? 'gray')}
      tt="none"
      leftSection={stale ? <IconAlertTriangle size={11} aria-hidden /> : undefined}
      aria-label={`${t(`cia.dimensions.${dimension}`)}: ${lv?.label ?? t('cia.notRated')}${stale ? ` (${t('cia.needsRerating')})` : ''}`}
    >
      {text}
    </Badge>
  );
  return short ? (
    <Tooltip label={`${t(`cia.dimensions.${dimension}`)}: ${lv?.label ?? t('cia.notRated')}${stale ? ` – ${t('cia.needsRerating')}` : ''}`}>{badge}</Tooltip>
  ) : (
    badge
  );
}

/** The three dimensions of a rating as small badges (lists). */
export function RatingBadges({ rating, size = 'xs' }: { rating: ApplicationRating; size?: 'xs' | 'sm' }) {
  return (
    <Group gap={4} wrap="wrap">
      {CIA_DIMENSIONS.map((d) => (
        <LevelBadge key={d} dimension={d} level={rating[d]?.level} stale={rating[d]?.needsRerating} short size={size} />
      ))}
    </Group>
  );
}

/** The effective protection need of a service as small badges (lists). */
export function NeedBadges({ need, size = 'xs' }: { need: ServiceProtectionNeed; size?: 'xs' | 'sm' }) {
  return (
    <Group gap={4} wrap="wrap">
      {CIA_DIMENSIONS.map((d) => (
        <LevelBadge key={d} dimension={d} level={need[d].effective} stale={need[d].needsRerating > 0} short size={size} />
      ))}
    </Group>
  );
}

/** Options of a dimension's level select, lowest first. */
function useLevelOptions() {
  const { t } = useTranslation('applications');
  const scale = useCiaScale().data;
  return (d: CiaDimension) => (scale?.levels[d] ?? []).map((l) => ({ value: l.key, label: levelText(t, scale!, l).label }));
}

/** The CIA rating of an application: per dimension the level, the justification, who rated it and when. */
export function RatingPanel({ app, onSaved }: { app: ApplicationDetail; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const [editing, setEditing] = useState(false);
  const level = useLevel();
  return (
    <Stack gap="xs" data-testid="cia-rating">
      <Group justify="space-between">
        <Text fw={600} id="cia-rating-title">
          {t('cia.title')}
        </Text>
        {app.canEdit && (
          <Button size="xs" variant="default" leftSection={<IconShieldHalf size={14} />} onClick={() => setEditing(true)}>
            {t('cia.rate')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('cia.help')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" aria-labelledby="cia-rating-title">
          <Table.Tbody>
            {CIA_DIMENSIONS.map((d) => {
              const r = app.rating[d];
              return (
                <Table.Tr key={d}>
                  <Table.Th scope="row" w="30%">
                    {t(`cia.dimensions.${d}`)}
                  </Table.Th>
                  <Table.Td>
                    {r ? (
                      <Stack gap={2}>
                        <Group gap={6}>
                          <Badge color={r.needsRerating ? 'yellow' : (level(d, r.level)?.color ?? 'gray')} variant="light" tt="none">
                            {level(d, r.level)?.label ?? r.level}
                          </Badge>
                          {r.needsRerating && (
                            <Badge color="yellow" variant="outline" tt="none" leftSection={<IconAlertTriangle size={11} aria-hidden />}>
                              {t('cia.needsRerating')}
                            </Badge>
                          )}
                        </Group>
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {r.justification}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t('cia.ratedBy', { user: r.ratedBy, date: fmtDate(r.ratedAt) })}
                          {r.previousLabel &&
                            (r.needsRerating
                              ? ` · ${t('cia.needsReratingHint', { label: r.previousLabel })}`
                              : ` · ${t('cia.mapped', { label: r.previousLabel })}`)}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('cia.notRated')}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </div>
      {editing && <RatingModal app={app} onClose={() => setEditing(false)} onSaved={onSaved} />}
    </Stack>
  );
}

function RatingModal({ app, onClose, onSaved }: { app: ApplicationDetail; onClose: () => void; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const options = useLevelOptions();
  const valid = (d: CiaDimension, k: string | undefined) => !!k && options(d).some((o) => o.value === k);
  const init = (d: CiaDimension) => ({
    level: valid(d, app.rating[d]?.level) && !app.rating[d]?.needsRerating ? app.rating[d]!.level : null,
    justification: app.rating[d]?.justification ?? '',
  });
  const [values, setValues] = useState({ confidentiality: init('confidentiality'), integrity: init('integrity'), availability: init('availability') });
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    confidentiality: !!values.confidentiality.level && !values.confidentiality.justification.trim() && t('common:validation.required'),
    integrity: !!values.integrity.level && !values.integrity.justification.trim() && t('common:validation.required'),
    availability: !!values.availability.level && !values.availability.justification.trim() && t('common:validation.required'),
  });
  const set = (d: CiaDimension, patch: Partial<{ level: string | null; justification: string }>) => setValues((x) => ({ ...x, [d]: { ...x[d], ...patch } }));
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      const body = {
        confidentiality: values.confidentiality.level
          ? { level: values.confidentiality.level, justification: values.confidentiality.justification.trim() }
          : null,
        integrity: values.integrity.level ? { level: values.integrity.level, justification: values.integrity.justification.trim() } : null,
        availability: values.availability.level ? { level: values.availability.level, justification: values.availability.justification.trim() } : null,
      };
      onSaved(await put<ApplicationDetail>(`/applications/${app.id}/rating`, body));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('cia.rateTitle', { name: app.name })} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="md">
          {CIA_DIMENSIONS.map((d) => (
            <Paper key={d} withBorder p="sm">
              <Stack gap="xs">
                <Select
                  label={t(`cia.dimensions.${d}`)}
                  placeholder={t('cia.notRated')}
                  data={options(d)}
                  value={values[d].level}
                  onChange={(x) => set(d, { level: x })}
                  clearable
                />
                {values[d].level && (
                  <Textarea
                    label={`${t('cia.justification')} (${t(`cia.dimensions.${d}`)})`}
                    description={t('cia.justificationHelp')}
                    value={values[d].justification}
                    onChange={(e) => set(d, { justification: e.currentTarget.value })}
                    autosize
                    minRows={2}
                    maxRows={6}
                    maxLength={2000}
                    required
                    error={v.error(d)}
                  />
                )}
              </Stack>
            </Paper>
          ))}
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

/** The protection need of a service: per dimension derived (maximum principle), override and effective level. */
export function ProtectionNeedPanel({ service, onSaved }: { service: ServiceDetail; onSaved: (s: ServiceDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const level = useLevel();
  const [editing, setEditing] = useState(false);
  const names = new Map(service.applications.map((a) => [a.id, a.name]));
  return (
    <Stack gap="xs" data-testid="protection-need">
      <Group justify="space-between">
        <Text fw={600} id="protection-need-title">
          {t('need.title')}
        </Text>
        {service.canEdit && (
          <Button size="xs" variant="default" leftSection={<IconShieldHalf size={14} />} onClick={() => setEditing(true)}>
            {t('need.override')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('need.help')}
      </Text>
      <div className="table-scroll">
        <Table fz="sm" aria-labelledby="protection-need-title">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('need.dimension')}</Table.Th>
              <Table.Th>{t('need.effective')}</Table.Th>
              <Table.Th>{t('need.basis')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {CIA_DIMENSIONS.map((d) => {
              const n = service.protectionNeed[d];
              const eff = level(d, n.effective);
              return (
                <Table.Tr key={d}>
                  <Table.Th scope="row">{t(`cia.dimensions.${d}`)}</Table.Th>
                  <Table.Td className="nowrap">
                    {eff ? (
                      <Badge color={eff.color} variant="light" tt="none">
                        {eff.label}
                      </Badge>
                    ) : (
                      <Text span size="sm" c="dimmed">
                        {t('cia.notRated')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    <Stack gap={2}>
                      <Text size="sm">
                        {t('need.derived')}: {level(d, n.derived)?.label ?? t('cia.notRated')}
                        {n.derivedFrom.length > 0 && ` (${t('need.derivedFrom', { names: n.derivedFrom.map((id) => names.get(id) ?? id).join(', ') })})`}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {n.total ? t('need.rated', { rated: n.rated, total: n.total }) : t('need.noApplications')}
                        {n.needsRerating > 0 && ` · ${t('need.stale', { count: n.needsRerating })}`}
                      </Text>
                      {n.override && (
                        <Text size="xs" c={n.override.needsRerating ? 'yellow' : undefined} data-testid={`override-${d}`}>
                          {n.override.needsRerating
                            ? t('need.overrideNeedsRerating', { label: n.override.previousLabel ?? n.override.level })
                            : t('need.overridden', { user: n.override.setBy, date: fmtDate(n.override.setAt), reason: n.override.reason })}
                        </Text>
                      )}
                    </Stack>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </div>
      {editing && <OverrideModal service={service} onClose={() => setEditing(false)} onSaved={onSaved} />}
    </Stack>
  );
}

const DERIVED = '__derived';

function OverrideModal({ service, onClose, onSaved }: { service: ServiceDetail; onClose: () => void; onSaved: (s: ServiceDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const options = useLevelOptions();
  const level = useLevel();
  const init = (d: CiaDimension) => {
    const o = service.protectionNeed[d].override;
    return { level: o && !o.needsRerating ? o.level : DERIVED, reason: o?.reason ?? '' };
  };
  const [values, setValues] = useState({ confidentiality: init('confidentiality'), integrity: init('integrity'), availability: init('availability') });
  const [busy, setBusy] = useState(false);
  const need = (d: CiaDimension) => values[d].level !== DERIVED && !values[d].reason.trim() && t('common:validation.required');
  const v = useFieldErrors({ confidentiality: need('confidentiality'), integrity: need('integrity'), availability: need('availability') });
  const set = (d: CiaDimension, patch: Partial<{ level: string; reason: string }>) => setValues((x) => ({ ...x, [d]: { ...x[d], ...patch } }));
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const dim = (d: CiaDimension) => (values[d].level === DERIVED ? null : { level: values[d].level, reason: values[d].reason.trim() });
    try {
      onSaved(
        await put<ServiceDetail>(`/services/${service.id}/protection-need`, {
          confidentiality: dim('confidentiality'),
          integrity: dim('integrity'),
          availability: dim('availability'),
        }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('need.overrideTitle', { name: service.name })} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="md">
          {CIA_DIMENSIONS.map((d) => {
            const derived = level(d, service.protectionNeed[d].derived)?.label ?? t('cia.notRated');
            return (
              <Paper key={d} withBorder p="sm">
                <Stack gap="xs">
                  <Select
                    label={t(`cia.dimensions.${d}`)}
                    data={[{ value: DERIVED, label: `${t('need.useDerived')} (${derived})` }, ...options(d)]}
                    value={values[d].level}
                    onChange={(x) => set(d, { level: x ?? DERIVED })}
                    allowDeselect={false}
                  />
                  {values[d].level !== DERIVED && (
                    <Textarea
                      label={`${t('need.reason')} (${t(`cia.dimensions.${d}`)})`}
                      description={t('need.reasonHelp')}
                      value={values[d].reason}
                      onChange={(e) => set(d, { reason: e.currentTarget.value })}
                      autosize
                      minRows={2}
                      maxRows={6}
                      maxLength={2000}
                      required
                      error={v.error(d)}
                    />
                  )}
                </Stack>
              </Paper>
            );
          })}
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
