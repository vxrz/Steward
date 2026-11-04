import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconClockHour4, IconDownload, IconLock, IconShieldCheck, IconUsersGroup } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CONTROL_POINTS,
  CONTROL_POINT_GROUPS,
  policyChanges,
  type AssurancePolicySaved,
  type AssurancePolicyVersion,
  type AssurancePolicyView,
  type ControlPoint,
  type FourEyesLevel,
  type PointRule,
  type PolicyChange,
} from '@sm/shared';
import { apiUrl, confirmedDownload, get, notifyError, notifyOk, post, put } from '../../api';
import { useSaveSection } from '../settings/SaveBar';
import { PeriodPicker, periodRange, presetPeriod, validPeriod, type Period } from '../compliance/common';
import { fmtDate } from '../../format';
import { assuranceKeys } from '../../queryKeys';

type Rules = Record<string, PointRule>;
interface Draft {
  rules: Rules;
  amr: string[];
  acr: string[];
  comment: string;
}

const draftOf = (v: AssurancePolicyView): Draft => ({
  rules: Object.fromEntries(CONTROL_POINTS.map((p) => [p.key, { ...v.rules[p.key]!.instance }])),
  amr: [...v.policy.mfa.amrValues],
  acr: [...v.policy.mfa.acrValues],
  comment: '',
});
const asPolicy = (d: Draft) => ({ points: d.rules as Record<string, Partial<PointRule>>, mfa: { amrValues: d.amr, acrValues: d.acr } });

/** Label of a control point (assurance:points.<key>.label) – keys contain dots, which i18next reads as nesting. */
export function usePointText() {
  const { t } = useTranslation('assurance');
  return {
    label: (key: string) => t(`points.${key}.label` as 'title', { defaultValue: key }),
    description: (key: string) => t(`points.${key}.description` as 'title', { defaultValue: '' }),
  };
}

/** One change of the policy in words (pending changes, history). */
function useChangeText() {
  const { t } = useTranslation('assurance');
  const { label } = usePointText();
  const value = (field: PolicyChange['field'], v: unknown): string => {
    if (Array.isArray(v)) return v.length ? v.join(' ') : t('values.none');
    if (v === null) return t('values.window');
    if (typeof v === 'boolean') return v ? t('values.on') : t('values.off');
    if (field === 'fourEyes') return t(`levels.${v as FourEyesLevel}`);
    return String(v);
  };
  return (c: PolicyChange) =>
    t('change', {
      point: c.point.startsWith('mfa.') ? t(`mfaLists.${c.point.slice(4) as 'amrValues'}`) : label(c.point),
      field: t(`fields.${c.field}`),
      from: value(c.field, c.from),
      to: value(c.field, c.to),
    });
}

/**
 * Settings → Assurance policy (#210, docs/ASSURANCE.md): per control point four-eyes and step-up (age, MFA), the
 * baseline locked, the overrides of single items, the pending loosening with approve / reject for another
 * administrator, the history and the assurance report. Saved by the area's save bar.
 */
export function AssurancePolicyPanel() {
  const { t } = useTranslation(['assurance', 'common']);
  const qc = useQueryClient();
  const view = useQuery({ queryKey: assuranceKeys.policy, queryFn: () => get<AssurancePolicyView>('/assurance/policy') });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (view.data) setDraft(draftOf(view.data));
  }, [view.data]);
  const saved = view.data;
  const changes = useMemo(() => (saved && draft ? policyChanges(saved.policy, asPolicy(draft)) : []), [saved, draft]);
  const loosens = changes.filter((c) => c.direction === 'loosen').length;
  const dirty = changes.length > 0;
  const save = async () => {
    if (!draft) return;
    try {
      const r = await put<AssurancePolicySaved>('/assurance/policy', { ...asPolicy(draft), comment: draft.comment.trim() || undefined });
      notifyOk(r.pending ? t('savedPending') : r.applied.length ? t('saved') : t('unchanged'));
      await qc.invalidateQueries({ queryKey: assuranceKeys.all });
    } catch (e) {
      notifyError(e);
    }
  };
  useSaveSection('assurance', { dirty, save, reset: () => saved && setDraft(draftOf(saved)) });
  if (!saved || !draft) return null;
  const setRule = (key: string, patch: Partial<PointRule>) => setDraft({ ...draft, rules: { ...draft.rules, [key]: { ...draft.rules[key]!, ...patch } } });
  return (
    <Stack data-testid="assurance-policy">
      <Card withBorder>
        <Group gap="xs" mb="xs" wrap="nowrap">
          <IconShieldCheck size={18} aria-hidden />
          <Title order={5}>{t('title')}</Title>
          <Badge variant="light" color="gray" data-testid="assurance-version">
            {t('version', { version: saved.policy.version })}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {t('intro')}
        </Text>
        <Text size="sm" mt={4} data-testid="assurance-since">
          {saved.since ? t('since', { date: fmtDate(saved.since) }) : t('defaults')}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          {t('docs')}
        </Text>
      </Card>
      {saved.pending && <PendingChange view={saved} />}
      {CONTROL_POINT_GROUPS.map((g) => (
        <PointGroup key={g} group={g} view={saved} rules={draft.rules} onChange={setRule} />
      ))}
      <Card withBorder>
        <Title order={6} mb={4}>
          {t('mfa.title')}
        </Title>
        <Text size="sm" c="dimmed" mb="xs">
          {t('mfa.hint')}
        </Text>
        <Group grow align="flex-start" wrap="wrap">
          <TagsInput label={t('mfa.amr')} value={draft.amr} onChange={(v) => setDraft({ ...draft, amr: v })} maxTags={20} miw={220} />
          <TagsInput label={t('mfa.acr')} value={draft.acr} onChange={(v) => setDraft({ ...draft, acr: v })} maxTags={20} miw={220} />
        </Group>
      </Card>
      {dirty && (
        <Card withBorder>
          {loosens > 0 && (
            <Alert color="orange" variant="light" mb="xs" data-testid="assurance-loosens">
              {t('loosens', { count: loosens })}
            </Alert>
          )}
          <Textarea
            label={t('comment')}
            value={draft.comment}
            onChange={(e) => setDraft({ ...draft, comment: e.currentTarget.value })}
            maxLength={1000}
            autosize
            minRows={1}
          />
        </Card>
      )}
      <Overrides view={saved} />
      <History />
      <ReportCard />
    </Stack>
  );
}

function PointGroup({
  group,
  view,
  rules,
  onChange,
}: {
  group: string;
  view: AssurancePolicyView;
  rules: Rules;
  onChange: (key: string, patch: Partial<PointRule>) => void;
}) {
  const { t } = useTranslation('assurance');
  const points = CONTROL_POINTS.filter((p) => p.group === group);
  return (
    <Card withBorder p="sm" data-testid={`assurance-group-${group}`}>
      <Title order={6} mb="xs">
        {t(`groups.${group as 'identity'}`)}
      </Title>
      <Table.ScrollContainer minWidth={720}>
        <Table verticalSpacing="xs" layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="36%">{t('columns.point')}</Table.Th>
              <Table.Th w="20%">{t('columns.fourEyes')}</Table.Th>
              <Table.Th w="14%">{t('columns.stepUp')}</Table.Th>
              <Table.Th w="18%">{t('columns.maxAge')}</Table.Th>
              <Table.Th w="12%">{t('columns.mfa')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {points.map((p) => (
              <PointRow key={p.key} p={p} rule={rules[p.key]!} windowMinutes={view.windowMinutes} onChange={(patch) => onChange(p.key, patch)} />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

function Locked({ children }: { children: string }) {
  const { t } = useTranslation('assurance');
  return (
    <Tooltip label={t('baseline')} withArrow>
      <Badge variant="light" color="gray" tt="none" size="md" leftSection={<IconLock size={12} aria-hidden />} data-locked>
        {children}
        <VisuallyHidden> – {t('baseline')}</VisuallyHidden>
      </Badge>
    </Tooltip>
  );
}

function NotAvailable() {
  const { t } = useTranslation('assurance');
  return (
    <Text size="sm" c="dimmed" aria-label={t('notSupported')}>
      –
    </Text>
  );
}

function PointRow({
  p,
  rule,
  windowMinutes,
  onChange,
}: {
  p: ControlPoint;
  rule: PointRule;
  windowMinutes: number;
  onChange: (patch: Partial<PointRule>) => void;
}) {
  const { t } = useTranslation('assurance');
  const { label, description } = usePointText();
  const name = label(p.key);
  const levels = p.fourEyesLevels ?? [];
  const isNew = p.supports.stepUp && !p.defaults.stepUp;
  return (
    <Table.Tr data-testid={`assurance-row-${p.key}`}>
      <Table.Td>
        <Group gap={6} wrap="nowrap" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={500}>
              {name}{' '}
              {isNew && (
                <Badge size="xs" variant="light" color="blue">
                  {t('newPoint')}
                </Badge>
              )}
            </Text>
            <Text size="xs" c="dimmed">
              {description(p.key)}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {p.key}
            </Text>
          </div>
        </Group>
      </Table.Td>
      <Table.Td>
        {!p.supports.fourEyes ? (
          <NotAvailable />
        ) : p.baseline.fourEyes || levels.length < 2 ? (
          <Locked>{t(`levels.${rule.fourEyes ?? 'required'}`)}</Locked>
        ) : (
          <Select
            size="xs"
            aria-label={t('fourEyesLabel', { point: name })}
            allowDeselect={false}
            data={levels.map((l) => ({ value: l, label: t(`levels.${l}`) }))}
            value={rule.fourEyes}
            onChange={(v) => v && onChange({ fourEyes: v as FourEyesLevel })}
            data-testid={`assurance-foureyes-${p.key}`}
          />
        )}
      </Table.Td>
      <Table.Td>
        {!p.supports.stepUp ? (
          <NotAvailable />
        ) : p.baseline.stepUp ? (
          <Locked>{t('values.always')}</Locked>
        ) : (
          <Switch
            aria-label={t('stepUpLabel', { point: name })}
            checked={rule.stepUp}
            onChange={(e) => onChange({ stepUp: e.currentTarget.checked, ...(e.currentTarget.checked ? {} : { maxAgeMinutes: null, mfa: false }) })}
            data-testid={`assurance-stepup-${p.key}`}
          />
        )}
      </Table.Td>
      <Table.Td>
        {p.supports.stepUp && rule.stepUp ? (
          <NumberInput
            size="xs"
            aria-label={t('maxAgeLabel', { point: name })}
            placeholder={t('maxAgePlaceholder', { count: windowMinutes })}
            min={1}
            max={windowMinutes}
            allowDecimal={false}
            value={rule.maxAgeMinutes ?? ''}
            onChange={(v) => onChange({ maxAgeMinutes: typeof v === 'number' && v > 0 ? Math.min(v, windowMinutes) : null })}
            leftSection={<IconClockHour4 size={14} aria-hidden />}
            maw={110}
          />
        ) : (
          <NotAvailable />
        )}
      </Table.Td>
      <Table.Td>
        {p.supports.stepUp && rule.stepUp ? (
          <Switch aria-label={t('mfaLabel', { point: name })} checked={rule.mfa} onChange={(e) => onChange({ mfa: e.currentTarget.checked })} />
        ) : (
          <NotAvailable />
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function PendingChange({ view }: { view: AssurancePolicyView }) {
  const { t } = useTranslation(['assurance', 'errors']);
  const qc = useQueryClient();
  const describe = useChangeText();
  const p = view.pending!;
  const [busy, setBusy] = useState(false);
  const act = async (what: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await post(`/assurance/policy/changes/${p.id}/${what}`, {});
      notifyOk(what === 'approve' ? t('pending.approved') : p.canApprove ? t('pending.rejected') : t('pending.withdrawn'));
      await qc.invalidateQueries({ queryKey: assuranceKeys.all });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert color="orange" variant="light" title={t('pending.title')} icon={<IconUsersGroup size={18} />} data-testid="assurance-pending">
      <Stack gap={6}>
        <Text size="sm">{t('pending.by', { user: p.requestedBy, date: fmtDate(p.requestedAt), expires: fmtDate(p.expiresAt) })}</Text>
        {p.comment && <Text size="sm">{t('pending.reason', { comment: p.comment })}</Text>}
        <ul style={{ margin: 0, paddingInlineStart: 20 }}>
          {p.changes.map((c) => (
            <li key={`${c.point}.${c.field}`}>
              <Text size="sm">{describe(c)}</Text>
            </li>
          ))}
        </ul>
        {!p.canApprove && p.canReject && (
          <Text size="xs" c="dimmed">
            {t('errors:codes.FOUR_EYES_POLICY')}
          </Text>
        )}
        <Group gap="xs">
          {p.canApprove && (
            <Button size="xs" onClick={() => act('approve')} loading={busy} data-testid="assurance-approve">
              {t('pending.approve')}
            </Button>
          )}
          {p.canReject && (
            <Button size="xs" variant="default" onClick={() => act('reject')} loading={busy} data-testid="assurance-reject">
              {p.canApprove ? t('pending.reject') : t('pending.withdraw')}
            </Button>
          )}
        </Group>
      </Stack>
    </Alert>
  );
}

function Overrides({ view }: { view: AssurancePolicyView }) {
  const { t } = useTranslation('assurance');
  const { label } = usePointText();
  const rows = view.overrides;
  return (
    <Card withBorder p="sm" data-testid="assurance-overrides">
      <Title order={6} mb={4}>
        {t('overrides.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="xs">
        {t('overrides.hint')}
      </Text>
      {!rows.length ? (
        <Text size="sm">{t('overrides.empty')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('columns.point')}</Table.Th>
                <Table.Th>{t('overrides.item')}</Table.Th>
                <Table.Th>{t('overrides.own')}</Table.Th>
                <Table.Th>{t('overrides.applies')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((o, i) => (
                <Table.Tr key={`${o.point}-${o.link}-${i}`}>
                  <Table.Td>
                    <Text size="sm">{label(o.point)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {t(`overrides.kinds.${o.kind}`)}
                    </Text>
                    <Anchor component={Link} to={o.link} size="sm">
                      {o.label}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {o.value}
                    </Text>
                  </Table.Td>
                  <Table.Td miw={110}>
                    <Group gap={4} wrap="nowrap">
                      {o.effective.fourEyes && (
                        <Badge size="sm" variant="light" tt="none" style={{ flexShrink: 0 }}>
                          {t('overrides.fourEyes')}
                        </Badge>
                      )}
                      {o.effective.stepUp && (
                        <Badge size="sm" variant="light" color="grape" tt="none" style={{ flexShrink: 0 }}>
                          {t('overrides.stepUp')}
                        </Badge>
                      )}
                      {!o.effective.fourEyes && !o.effective.stepUp && <Text size="sm">{t('overrides.neither')}</Text>}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function History() {
  const { t } = useTranslation('assurance');
  const describe = useChangeText();
  const history = useQuery({ queryKey: assuranceKeys.history, queryFn: () => get<AssurancePolicyVersion[]>('/assurance/policy/history') });
  const rows = [...(history.data ?? [])].reverse();
  return (
    <Card withBorder p="sm" data-testid="assurance-history">
      <Title order={6} mb="xs">
        {t('history.title')}
      </Title>
      {!rows.length ? (
        <Text size="sm">{t('history.empty')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={600}>
          <Table verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('history.version')}</Table.Th>
                <Table.Th>{t('history.at')}</Table.Th>
                <Table.Th>{t('history.by')}</Table.Th>
                <Table.Th>{t('history.approvedBy')}</Table.Th>
                <Table.Th>{t('history.what')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.slice(0, 50).map((v) => (
                <Table.Tr key={v.seq}>
                  <Table.Td>{v.version}</Table.Td>
                  <Table.Td>{fmtDate(v.at)}</Table.Td>
                  <Table.Td>{v.by}</Table.Td>
                  <Table.Td>{v.approvedBy ?? '–'}</Table.Td>
                  <Table.Td>
                    {v.changes.map((c) => (
                      <Text size="xs" key={`${c.point}.${c.field}`}>
                        {describe(c)}
                      </Text>
                    ))}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

/** The link of the assurance report of a period (PDF/A; ?format=json for the JSON). */
export const assuranceReportUrl = (p: { from: string; to: string }, lang: string, format: 'pdf' | 'json' = 'pdf') =>
  apiUrl(
    `/assurance/report?from=${encodeURIComponent(p.from)}&to=${encodeURIComponent(p.to)}&lang=${lang}&format=${format}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  );

function ReportCard() {
  const { t } = useTranslation(['assurance', 'compliance']);
  const [period, setPeriod] = useState<Period>(presetPeriod('90'));
  const [lang, setLang] = useState<'en' | 'de'>('en');
  const ok = validPeriod(period);
  const range = ok ? periodRange(period) : null;
  return (
    <Card withBorder p="sm" data-testid="assurance-report">
      <Title order={6} mb={4}>
        {t('report.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="xs">
        {t('report.hint')}
      </Text>
      <Stack gap="xs">
        <PeriodPicker value={period} onChange={setPeriod} />
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select
            label={t('report.language')}
            allowDeselect={false}
            data={[
              { value: 'en', label: t('compliance:packs.langEn') },
              { value: 'de', label: t('compliance:packs.langDe') },
            ]}
            value={lang}
            onChange={(v) => setLang((v as 'en') ?? 'en')}
            w={{ base: '100%', xs: 200 }}
          />
          <Button
            component="a"
            href={range ? assuranceReportUrl(range, lang) : undefined}
            onClick={confirmedDownload('exportAuditLog')}
            leftSection={<IconDownload size={16} aria-hidden />}
            disabled={!range}
            data-testid="assurance-report-download"
          >
            {t('report.download')}
          </Button>
          <Button
            component="a"
            variant="default"
            href={range ? assuranceReportUrl(range, lang, 'json') : undefined}
            onClick={confirmedDownload('exportAuditLog')}
            disabled={!range}
          >
            {t('report.json')}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
