import { useState } from 'react';
import { Anchor, Group, Paper, SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconClipboardCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantCheck } from '@sm/shared';
import { get } from '../api';
import { QueryState } from '../components/common';
import { ListPage } from '../components/page/ListPage';
import { plantKeys } from '../queryKeys';
import { PreviewBadge, usePlantLabel } from '../components/plant/common';
import { ChecksList, useCheckText } from '../components/plant/data';

type Kind = 'all' | 'asset' | 'kpi';

/**
 * What Steward checks in the data of the plant registry (#219): KPI instances whose inputs the asset does not deliver,
 * parameters outside their definition, ratios without their denominator … – for the assets the person may see and
 * every KPI definition, grouped by the record they are on.
 */
export function PlantChecksPage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const text = useCheckText();
  const checks = useQuery({ queryKey: plantKeys.checks, queryFn: () => get<PlantCheck[]>('/plant/checks') });
  const [params, setParams] = useSearchParams();
  const kind = (['asset', 'kpi'].includes(params.get('kind') ?? '') ? params.get('kind') : 'all') as Kind;
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const all = checks.data ?? [];
  const list = all.filter(
    (c) =>
      (kind === 'all' || c.subject.kind === kind) &&
      (!needle || [c.subject.name, c.subject.id, c.job ?? '', text(c)].some((x) => x.toLowerCase().includes(needle))),
  );
  // grouped by the record they are on, in the server's order
  const groups: { key: string; subject: PlantCheck['subject']; checks: PlantCheck[] }[] = [];
  for (const c of list) {
    const key = `${c.subject.kind}:${c.subject.id}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.checks.push(c);
    else groups.push({ key, subject: c.subject, checks: [c] });
  }
  const none = checks.isSuccess && all.length === 0;
  return (
    <ListPage
      testId="plant-checks"
      title={
        <Group gap="sm" component="span">
          <span>{t('checks.title')}</span>
          <PreviewBadge />
        </Group>
      }
      description={t('checks.description', { type: label('asset', true, true) })}
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('checks.search') }}
      empty={{ show: none, icon: IconClipboardCheck, title: t('checks.emptyTitle'), text: t('checks.emptyText') }}
    >
      <QueryState query={checks} />
      {!none && checks.isSuccess && (
        <SegmentedControl
          mb="md"
          size="xs"
          value={kind}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === 'all') next.delete('kind');
            else next.set('kind', v);
            setParams(next, { replace: true });
          }}
          aria-label={t('checks.on')}
          data={[
            { value: 'all', label: t('checks.all', { count: all.length }) },
            { value: 'asset', label: label('asset', true) },
            { value: 'kpi', label: t('kpis.title') },
          ]}
        />
      )}
      {!none && checks.isSuccess && groups.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('checks.noMatch')}
        </Text>
      )}
      <Stack gap="sm" data-testid="check-groups">
        {groups.map((g) => (
          <Paper key={g.key} withBorder p="md" component="section" aria-labelledby={`check-${g.key}`}>
            <Stack gap="xs">
              <Group gap="xs" wrap="wrap">
                <Anchor
                  id={`check-${g.key}`}
                  component={Link}
                  fw={600}
                  to={g.subject.kind === 'asset' ? `/plant/assets/${encodeURIComponent(g.subject.id)}` : `/plant/kpis/${encodeURIComponent(g.subject.id)}`}
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {g.subject.name}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {g.subject.kind === 'asset' ? label('asset') : t('import.kinds.kpi')}
                </Text>
              </Group>
              <ChecksList checks={g.checks} />
            </Stack>
          </Paper>
        ))}
      </Stack>
    </ListPage>
  );
}
