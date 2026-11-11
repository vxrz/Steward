import { useState } from 'react';
import { Anchor, Badge, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconChartBar, IconClipboardCheck, IconFileCertificate, IconListCheck, IconShieldCheck, type Icon as TablerIcon } from '@tabler/icons-react';
import type { Dashboard, EvidencePack, PersonReviewSummary } from '@sm/shared';
import { get } from '../../api';
import { useMe } from '../../auth';
import { fmtNumber, fmtRelative } from '../../format';
import { dashboardKeys } from '../../queryKeys';
import { CollapsibleSection } from '../page/CollapsibleSection';

/** What the start page focuses on: operations (admins, designers, operators), compliance (auditors) or the viewer's dashboards. */
export type StartFocus = 'operations' | 'compliance' | 'viewer';

const fullKey = (user: string) => `sm.start.full.${user}`;

/**
 * The start page focus of the signed-in user from their roles, and whether they asked for the full operations start
 * page instead (remembered per user in this browser).
 */
export function useStartFocus(): { focus: StartFocus; full: boolean; setFull: (v: boolean) => void } {
  const { hasRole, username } = useMe();
  const focus: StartFocus = hasRole('admin') || hasRole('designer') || hasRole('operator') ? 'operations' : hasRole('auditor') ? 'compliance' : 'viewer';
  const [full, setFullState] = useState(() => {
    try {
      return localStorage.getItem(fullKey(username)) === '1';
    } catch {
      return false;
    }
  });
  const setFull = (v: boolean) => {
    setFullState(v);
    try {
      localStorage.setItem(fullKey(username), v ? '1' : '0');
    } catch {
      /* storage blocked: only for this page view */
    }
  };
  return { focus, full: focus !== 'operations' && full, setFull };
}

/** One entry of a start page card: an icon, a link and what it holds. */
function Entry({ icon: Icon, to, label, detail, count }: { icon: TablerIcon; to: string; label: string; detail: string; count?: number }) {
  return (
    <Paper withBorder p="sm" component={Link} to={to} className="clickable" style={{ color: 'inherit', textDecoration: 'none', display: 'block' }}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Icon size={18} aria-hidden style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600}>
              {label}
            </Text>
            {!!count && (
              <Badge size="sm" variant="light" color="violet">
                {fmtNumber(count)}
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" lineClamp={2}>
            {detail}
          </Text>
        </div>
      </Group>
    </Paper>
  );
}

/** Auditors' start page: open person reviews, evidence packs, controls and the audit log (existing lists, no extra API). */
export function ComplianceCard() {
  const { t } = useTranslation('dashboard');
  const { caps } = useMe();
  const reviews = useQuery({ queryKey: ['person-reviews'], queryFn: () => get<PersonReviewSummary[]>('/compliance/person-reviews'), retry: false });
  const packs = useQuery({ queryKey: ['evidence-packs'], queryFn: () => get<EvidencePack[]>('/compliance/evidence-packs'), retry: false });
  const open = (reviews.data ?? []).filter((r) => r.status === 'open').length;
  const submitted = (reviews.data ?? []).filter((r) => r.status === 'submitted').length;
  const ready = (packs.data ?? []).filter((p) => p.status === 'ready').length;
  return (
    // folds like the failed checks (remembered per user); new reviews to do open it again
    <CollapsibleSection
      id="start-compliance"
      testId="start-compliance"
      variant="card"
      size="h5"
      title={t('focus.compliance.title')}
      count={open + submitted || undefined}
      remember="section.dashboard.start-compliance"
      // one id per review to do: more of them than when it was folded open it again
      alertKey={reviews.data ? Array.from({ length: open + submitted }, (_, i) => `review-${i + 1}`).join(',') : undefined}
    >
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="xs">
        <Entry
          icon={IconClipboardCheck}
          to="/compliance/person-reviews"
          label={t('focus.compliance.reviews')}
          count={open + submitted}
          detail={reviews.isError ? '' : open + submitted ? t('focus.compliance.reviewsOpen', { open, submitted }) : t('focus.compliance.reviewsNone')}
        />
        <Entry
          icon={IconFileCertificate}
          to="/compliance/evidence-packs"
          label={t('focus.compliance.evidence')}
          detail={packs.isError ? '' : ready ? t('focus.compliance.evidenceReady', { count: ready }) : t('focus.compliance.evidenceNone')}
        />
        <Entry icon={IconShieldCheck} to="/compliance/controls" label={t('focus.compliance.controls')} detail={t('focus.compliance.controlsText')} />
        {caps.viewAudit && <Entry icon={IconListCheck} to="/audit" label={t('focus.compliance.audit')} detail={t('focus.compliance.auditText')} />}
      </SimpleGrid>
    </CollapsibleSection>
  );
}

/** Viewers' start page: the dashboards they may open. */
export function DashboardsCard() {
  const { t } = useTranslation('dashboard');
  const dashboards = useQuery({ queryKey: dashboardKeys.all, queryFn: () => get<Dashboard[]>('/dashboards') });
  const list = dashboards.data ?? [];
  return (
    <Card withBorder component="section" aria-labelledby="start-dashboards" data-testid="start-dashboards">
      <Group justify="space-between" mb="xs">
        <Title order={2} size="h5" id="start-dashboards">
          {t('focus.viewer.title')}
        </Title>
        <Anchor component={Link} to="/dashboards" size="sm">
          {t('focus.viewer.all')}
        </Anchor>
      </Group>
      {dashboards.isSuccess && !list.length && (
        <Text size="sm" c="dimmed">
          {t('focus.viewer.none')}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="xs">
        {list.slice(0, 9).map((d) => (
          <Entry
            key={d.id}
            icon={IconChartBar}
            to={`/dashboards/${d.id}`}
            label={d.name}
            detail={d.description || t('focus.viewer.updated', { when: fmtRelative(d.updatedAt) })}
          />
        ))}
      </SimpleGrid>
      {list.length > 9 && (
        <Stack mt="xs">
          <Anchor component={Link} to="/dashboards" size="sm">
            {t('focus.viewer.more', { count: list.length - 9 })}
          </Anchor>
        </Stack>
      )}
    </Card>
  );
}
