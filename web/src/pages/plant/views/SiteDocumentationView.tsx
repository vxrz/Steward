import { useState } from 'react';
import { Anchor, Badge, Button, Group, List, NumberInput, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PLANT_DOC_REVIEW_LIMITS, type PlantDocHealth, type PlantDocHealthGroup, type PlantSiteDetail } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../../api';
import { fmtDay } from '../../../format';
import { QueryState } from '../../../components/common';
import { CollapsibleSection, SectionGroup, SectionGroupControls } from '../../../components/page/CollapsibleSection';

/**
 * Documentation health of a site (0.14, docs/PLANT.md "Documentation health"): the real gaps – assets without a
 * profile, devices without a VLAN, data paths and collections without a sink, collections without items, KPIs a machine
 * could have but nobody collects – and, as gentle hints, documentation not confirmed for longer than its review
 * interval. Each entry links to where to fix it. A list of folding sections, for phones too.
 */

export const docHealthKey = (siteId: string) => ['plant', 'documentation', siteId];

function Items({ group }: { group: PlantDocHealthGroup<string> }) {
  const { t } = useTranslation('plantDocs');
  return (
    <Stack gap={4}>
      <List size="sm" spacing={4} listStyleType="none" pl={0}>
        {group.items.map((x) => (
          <List.Item key={x.id}>
            <Anchor component={Link} to={x.path} size="sm">
              {x.name}
            </Anchor>
            {x.detail && (
              <Text span size="xs" c="dimmed">
                {' '}
                · {x.detail}
              </Text>
            )}
            {x.dueAt && (
              <Text size="xs" c="dimmed">
                {x.confirmation ? t('current.confirmedBy', { user: x.confirmation.by, date: fmtDay(x.confirmation.at) }) : t('current.never')}
                {' · '}
                {t('health.dueSince', { date: fmtDay(x.dueAt) })}
              </Text>
            )}
          </List.Item>
        ))}
      </List>
      {group.total > group.items.length && (
        <Text size="xs" c="dimmed">
          {t('health.more', { count: group.total - group.items.length })}
        </Text>
      )}
    </Stack>
  );
}

export function SiteDocumentationView({ siteId }: { siteId: string }) {
  const { t } = useTranslation('plantDocs');
  const q = useQuery({ queryKey: docHealthKey(siteId), queryFn: () => get<PlantDocHealth>(`/plant/sites/${encodeURIComponent(siteId)}/documentation`) });
  const h = q.data;
  if (!h) return <QueryState query={q} rows={4} />;
  const gaps = h.gaps.filter((g) => g.total > 0);
  const hints = h.hints.filter((g) => g.total > 0);
  const types = Object.entries(h.typeMonths);
  return (
    <SectionGroup controls="none">
      <Stack gap="md" data-testid="doc-health">
        <Paper withBorder p="sm">
          <Stack gap={4}>
            <Text size="sm">{h.reviewMonths ? t('health.interval', { count: h.reviewMonths }) : t('health.noInterval')}</Text>
            {types.length > 0 && (
              <Text size="xs" c="dimmed">
                {t('health.typeIntervals', { list: types.map(([k, m]) => `${k}: ${m}`).join(', ') })}
              </Text>
            )}
            <Text size="xs" c="dimmed" data-testid="doc-health-confirmed">
              {t('health.confirmed', { confirmed: h.confirmed, count: h.assets })}
            </Text>
          </Stack>
        </Paper>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <Text size="sm" c="dimmed">
            {t('health.help')}
          </Text>
          <SectionGroupControls />
        </Group>
        {!gaps.length && !hints.length && (
          <Text size="sm" c="dimmed" data-testid="doc-health-clean">
            {t('health.clean')}
          </Text>
        )}
        {gaps.map((g) => (
          <CollapsibleSection
            key={g.kind}
            id={`gap-${g.kind}`}
            testId={`doc-gap-${g.kind}`}
            order={3}
            size="h5"
            title={t(`health.gaps.${g.kind}`)}
            description={t(`health.gapsHelp.${g.kind}`)}
            count={g.total}
            defaultOpen={g.total <= 10}
            collapseOnPhone
          >
            <Items group={g} />
          </CollapsibleSection>
        ))}
        {hints.map((g) => (
          <CollapsibleSection
            key={g.kind}
            id={`hint-${g.kind}`}
            testId={`doc-hint-${g.kind}`}
            order={3}
            size="h5"
            title={
              <Group gap={6} component="span">
                <span>{t(`health.hints.${g.kind}`)}</span>
                <Badge size="xs" variant="light" color="blue" tt="none">
                  {t('health.hintBadge')}
                </Badge>
              </Group>
            }
            description={t(`health.hintsHelp.${g.kind}`)}
            count={g.total}
            defaultOpen={false}
          >
            <Items group={g} />
          </CollapsibleSection>
        ))}
      </Stack>
    </SectionGroup>
  );
}

/**
 * The site's review interval (a setting of the site, beside "Changes need a second person" and the access list): how
 * often its documentation should be confirmed as still current – a gentle hint when due, never an alert.
 */
export function SiteDocReviewSetting({ site, onSaved }: { site: PlantSiteDetail; onSaved: (s: PlantSiteDetail) => void }) {
  const { t } = useTranslation('plantDocs');
  const qc = useQueryClient();
  const [months, setMonths] = useState<number | ''>(site.docReviewMonths ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = (months || null) !== (site.docReviewMonths ?? null);
  const save = async () => {
    setBusy(true);
    try {
      const next = await put<PlantSiteDetail>(`/plant/sites/${encodeURIComponent(site.id)}/doc-review`, { months: months || null });
      onSaved(next);
      void qc.invalidateQueries({ queryKey: ['plant', 'documentation'] });
      void qc.invalidateQueries({ queryKey: ['plant', 'documents'] });
      notifyOk(t('review.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group align="flex-end" gap="xs" wrap="wrap" data-testid="site-doc-review">
      <NumberInput
        label={t('review.label')}
        description={t('review.help')}
        min={1}
        max={PLANT_DOC_REVIEW_LIMITS.monthsMax}
        value={months}
        onChange={(v) => setMonths(typeof v === 'number' ? v : '')}
        placeholder={t('review.none')}
        rightSection={<Text size="xs">{t('review.months')}</Text>}
        rightSectionWidth={70}
        w={{ base: '100%', sm: 320 }}
      />
      <Button size="xs" variant="default" disabled={!dirty} loading={busy} onClick={() => void save()}>
        {t('review.save')}
      </Button>
    </Group>
  );
}
