import { Anchor, Badge, Card, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconShieldExclamation } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AdvisoryTile, AssetAdvisories } from '@sm/shared';
import { get } from '../../../api';
import { fmtDay } from '../../../format';
import { plantKeys } from '../../../queryKeys';
import { CollapsibleSection } from '../../page/CollapsibleSection';
import { ReasonLine, RemediationBadge, SeverityBadge } from './common';

/**
 * The asset page's "Advisories" (0.14): the advisories that match the asset – affected, possible and dismissed – with
 * the reason and the remediation. Open while one is still open.
 */
export function AssetAdvisoriesSection({ assetId }: { assetId: string }) {
  const { t } = useTranslation('plantAdvisories');
  const q = useQuery({
    queryKey: plantKeys.assetAdvisories(assetId),
    queryFn: () => get<AssetAdvisories>(`/plant/assets/${encodeURIComponent(assetId)}/advisories`),
  });
  // drawn once the answer is there, so it starts open exactly when an advisory is still open
  if (!q.data) return null;
  const d = q.data;
  return (
    <CollapsibleSection
      id="advisories"
      title={t('asset.title')}
      count={d.items.length}
      tone={d.open > 0 ? 'warning' : undefined}
      summary={
        d.open > 0 ? (
          <Badge color="red" size="sm">
            {t('asset.open', { count: d.open })}
          </Badge>
        ) : undefined
      }
      defaultOpen={d.open > 0}
      icon={<IconShieldExclamation size={18} aria-hidden style={{ flex: 'none' }} />}
      testId="section-advisories"
    >
      {d.items.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('asset.none')}
        </Text>
      ) : (
        <Stack gap="xs">
          {d.items.map(({ advisory: a, match: m }) => (
            <Stack key={a.id} gap={2} data-testid="asset-advisory">
              <Group gap="xs" wrap="wrap">
                <SeverityBadge severity={m.severity !== 'unknown' ? m.severity : a.severity} cvss={m.cvss ?? a.cvss} size="xs" />
                <Anchor component={Link} to={`/plant/advisories/${encodeURIComponent(a.id)}`} size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
                  {a.title}
                </Anchor>
                {m.counted ? (
                  <RemediationBadge m={m} />
                ) : (
                  <Badge size="xs" variant="outline" color={m.decision === 'dismissed' ? 'gray' : 'yellow'}>
                    {m.decision === 'dismissed' ? t('asset.dismissed') : t('asset.possible')}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {a.trackingId} · {a.publisher} · {fmtDay(a.updated)}
                {m.fixes.length ? ` · ${t('detail.fix')}: ${m.fixes.map((f) => f.version).join(', ')}` : ''}
              </Text>
              {m.reasons[0] && <ReasonLine r={m.reasons[0]} />}
            </Stack>
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

/** The start page's tile (0.14): open advisories that affect the reader's sites – shown only when there are some. */
export function AdvisoriesCard() {
  const { t } = useTranslation('plantAdvisories');
  const q = useQuery({ queryKey: plantKeys.advisoryTile, queryFn: () => get<AdvisoryTile>('/plant/advisories/summary'), retry: false });
  const d = q.data;
  if (!d || (d.openAdvisories === 0 && d.possibleMatches === 0)) return null;
  return (
    <Card withBorder data-testid="advisories-card">
      <Group gap="xs" mb="xs">
        <IconShieldExclamation size={18} aria-hidden />
        <Title order={2} size="h5">
          <Anchor component={Link} to="/plant/advisories" inherit c="inherit">
            {t('tile.title')}
          </Anchor>
        </Title>
      </Group>
      <Stack gap={4}>
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={600}>
            {t('tile.open', { count: d.openAdvisories })}
          </Text>
          {d.critical > 0 && (
            <Badge color="red" size="sm">
              {t('tile.critical', { count: d.critical })}
            </Badge>
          )}
          {d.high > 0 && (
            <Badge color="orange" size="sm">
              {t('tile.high', { count: d.high })}
            </Badge>
          )}
        </Group>
        {d.openAssets > 0 && <Text size="sm">{t('tile.assets', { count: d.openAssets })}</Text>}
        {d.sites.map((s) => (
          <Anchor key={s.id} component={Link} to={`/plant/advisories?site=${encodeURIComponent(s.id)}&status=open`} size="sm">
            {t('tile.site', { site: s.name, advisories: s.advisories, assets: s.assets })}
          </Anchor>
        ))}
        {d.possibleMatches > 0 && (
          <Text size="sm" c="dimmed">
            {t('tile.possible', { count: d.possibleMatches })}
          </Text>
        )}
      </Stack>
    </Card>
  );
}
