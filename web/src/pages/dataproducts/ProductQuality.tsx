import { useState } from 'react';
import { Anchor, Badge, Group, Loader, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { DataElementQuality, DataPersonalFields, DataQualityStatus, DataScorecardHistory } from '@sm/shared';
import { get } from '../../api';
import { ErrorState } from '../../components/common';
import { TableScroll } from '../../components/TableScroll';
import { fmtDay, fmtRelative } from '../../format';
import { dpKeys } from './api';
import { Section } from './parts';

/**
 * Quality, personal fields and the scorecard over time on the pages of the data products module (0.24.0, ADR 0036
 * phase 2): the maturity trend of a product from its daily snapshots (a picture with a table beside it – phones start
 * with the table), the personal and classified fields of the bound contracts (product, element, data object), and an
 * element's quality results per ISO/IEC 25012 dimension.
 */

const enc = encodeURIComponent;
const LEVELS = [0, 1, 2, 3, 4, 5] as const;

/** The maturity of a product over the last 90 days, from the daily snapshots. */
export function ScorecardTrend({ productId, environment }: { productId: string; environment?: string | null }) {
  const { t } = useTranslation('dataProducts');
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [view, setView] = useState<'picture' | 'table' | null>(null);
  const shown = view ?? (narrow ? 'table' : 'picture');
  const q = useQuery({
    queryKey: [...dpKeys.product(productId), 'scorecardHistory', environment ?? ''],
    queryFn: () =>
      get<DataScorecardHistory>(`/data-products/${enc(productId)}/scorecard/history?days=90${environment ? `&environment=${enc(environment)}` : ''}`),
    staleTime: 60_000,
  });
  const points = q.data?.points ?? [];
  return (
    <Section
      title={t('quality.trend.title')}
      testId="product-scorecard-trend"
      actions={
        points.length > 1 && (
          <SegmentedControl
            size="xs"
            value={shown}
            onChange={(v) => setView(v as 'picture' | 'table')}
            data={[
              { value: 'picture', label: t('quality.trend.picture') },
              { value: 'table', label: t('quality.trend.table') },
            ]}
            aria-label={t('quality.trend.view')}
          />
        )
      }
    >
      {q.isLoading && <Loader size="sm" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && points.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('quality.trend.none')}
        </Text>
      )}
      {points.length > 0 && (
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {t('quality.trend.hint', { count: points.length, environment: q.data?.environment ?? '–' })}
          </Text>
          {shown === 'picture' && points.length > 1 ? (
            <TrendPicture points={points} />
          ) : (
            <TableScroll>
              <Table striped withTableBorder fz="sm" data-testid="scorecard-trend-table">
                <Table.Caption>{t('quality.trend.caption')}</Table.Caption>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th scope="col">{t('quality.trend.day')}</Table.Th>
                    <Table.Th scope="col">{t('quality.trend.maturity')}</Table.Th>
                    <Table.Th scope="col">{t('quality.trend.parts')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...points].reverse().map((p) => (
                    <Table.Tr key={p.day}>
                      <Table.Td>{fmtDay(p.day)}</Table.Td>
                      <Table.Td>{t('scorecard.maturity', { level: p.maturity, name: t(`scorecard.levels.${p.maturity}`) })}</Table.Td>
                      <Table.Td>{t('quality.trend.counts', { met: p.met, partial: p.partial, notMet: p.notMet })}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Stack>
      )}
    </Section>
  );
}

/** A step line of the maturity (one series: no legend; levels on the axis; a hover title per day). */
function TrendPicture({ points }: { points: DataScorecardHistory['points'] }) {
  const { t } = useTranslation('dataProducts');
  const W = 600;
  const H = 150;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const x = (i: number) => pad.l + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (level: number) => pad.t + (1 - level / 5) * (H - pad.t - pad.b);
  const path = points.map((p, i) => (i === 0 ? `M${x(0)},${y(p.maturity)}` : `H${x(i)}V${y(p.maturity)}`)).join('');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const summary = t('quality.trend.summary', { from: fmtDay(first.day), to: fmtDay(last.day), start: first.maturity, now: last.maturity });
  const step = (W - pad.l - pad.r) / Math.max(1, points.length - 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={summary} data-testid="scorecard-trend-picture" style={{ maxHeight: 180 }}>
      {LEVELS.map((l) => (
        <g key={l}>
          <line x1={pad.l} x2={W - pad.r} y1={y(l)} y2={y(l)} stroke="var(--mantine-color-default-border)" strokeWidth={1} />
          <text x={pad.l - 6} y={y(l) + 3} textAnchor="end" fontSize={10} fill="var(--mantine-color-dimmed)">
            {l}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--mantine-primary-color-filled)" strokeWidth={2} strokeLinejoin="round" />
      <circle
        cx={x(points.length - 1)}
        cy={y(last.maturity)}
        r={4}
        fill="var(--mantine-primary-color-filled)"
        stroke="var(--mantine-color-body)"
        strokeWidth={2}
      />
      <text x={pad.l} y={H - 6} fontSize={10} fill="var(--mantine-color-dimmed)">
        {fmtDay(first.day)}
      </text>
      <text x={W - pad.r} y={H - 6} fontSize={10} textAnchor="end" fill="var(--mantine-color-dimmed)">
        {fmtDay(last.day)}
      </text>
      {points.map((p, i) => (
        <rect key={p.day} x={x(i) - step / 2} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent">
          <title>{`${fmtDay(p.day)}: ${t('scorecard.maturity', { level: p.maturity, name: t(`scorecard.levels.${p.maturity}`) })}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Where the personal fields of a product, an element or a data object are read. */
const PERSONAL_URL = {
  product: (id: string) => `/data-products/${enc(id)}/personal-fields`,
  element: (id: string) => `/data-elements/${enc(id)}/personal-fields`,
  object: (id: string) => `/data-objects/${enc(id)}/personal-fields`,
};
const PERSONAL_KEY = { product: dpKeys.product, element: dpKeys.element, object: dpKeys.object };

/** The personal and classified fields of the contracts bound to a product's output ports, an element, or a data object's ports. */
export function PersonalFieldsPanel({ kind, id }: { kind: keyof typeof PERSONAL_URL; id: string }) {
  const { t } = useTranslation('dataProducts');
  const q = useQuery({
    queryKey: [...PERSONAL_KEY[kind](id), 'personalFields'],
    queryFn: () => get<DataPersonalFields>(PERSONAL_URL[kind](id)),
    staleTime: 60_000,
  });
  const d = q.data;
  if (d && !d.groups.length && !d.hiddenContracts) return null;
  return (
    <Section title={t('quality.personal.title')} testId="personal-fields">
      {q.isLoading && <Loader size="sm" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d && (
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {t('quality.personal.hint')}
          </Text>
          {d.groups.map((g) => (
            <div key={`${g.contract.id}#${g.version}`}>
              <Group gap="xs" wrap="wrap">
                <Anchor component={Link} to={`/data-contracts/${enc(g.contract.id)}`} size="sm" fw={600}>
                  {g.contract.name}
                </Anchor>
                <Text size="xs" c="dimmed">
                  {t('quality.personal.version', { version: g.version })}
                  {g.ports.length > 0 && ` · ${g.ports.map((p) => `${p.portName}${p.environment ? ` (${p.environment})` : ''}`).join(', ')}`}
                </Text>
              </Group>
              <TableScroll>
                <Table fz="sm" withTableBorder mt={4}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th scope="col">{t('quality.personal.field')}</Table.Th>
                      <Table.Th scope="col">{t('quality.personal.classification')}</Table.Th>
                      <Table.Th scope="col">{t('quality.personal.personal')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {g.fields.map((f) => (
                      <Table.Tr key={`${f.schema}.${f.field}`}>
                        <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                          {f.schema}.{f.field}
                        </Table.Td>
                        <Table.Td>{f.classification ?? '–'}</Table.Td>
                        <Table.Td>
                          {f.personal ? (
                            <Badge size="sm" variant="light" color="grape" tt="none">
                              {t('quality.personal.yes')}
                            </Badge>
                          ) : (
                            t('quality.personal.no')
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </TableScroll>
              {g.more > 0 && (
                <Text size="xs" c="dimmed">
                  {t('quality.personal.more', { count: g.more })}
                </Text>
              )}
            </div>
          ))}
          {d.hiddenContracts > 0 && (
            <Text size="xs" c="dimmed" data-testid="personal-hidden">
              {t('quality.personal.hidden', { count: d.hiddenContracts })}
            </Text>
          )}
        </Stack>
      )}
    </Section>
  );
}

const STATUS_COLOR: Record<DataQualityStatus, string> = { passed: 'green', warning: 'yellow', failed: 'red', error: 'red' };
const SHOWN = 20;

/** An element's quality results of the last 30 days: per dimension, and the newest results. */
export function ElementQualityPanel({ elementId }: { elementId: string }) {
  const { t } = useTranslation('dataProducts');
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: [...dpKeys.element(elementId), 'quality'],
    queryFn: () => get<DataElementQuality>(`/data-elements/${enc(elementId)}/quality`),
    staleTime: 30_000,
  });
  const d = q.data;
  return (
    <Section title={t('quality.element.title')} testId="element-quality">
      {q.isLoading && <Loader size="sm" />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {d && !d.results.length && (
        <Text size="sm" c="dimmed">
          {t('quality.element.none')}
        </Text>
      )}
      {d && d.results.length > 0 && (
        <Stack gap="sm">
          <Group gap="xs" wrap="wrap">
            {d.summary
              .filter((s) => s.tests > 0)
              .map((s) => (
                <Badge key={s.dimension} variant="light" tt="none" color={s.failed ? 'red' : s.warning ? 'yellow' : 'green'}>
                  {t('quality.element.dimension', {
                    dimension: t(`scorecard.parts.${s.dimension}`),
                    passed: s.passed,
                    tests: s.tests,
                  })}
                </Badge>
              ))}
          </Group>
          <TableScroll>
            <Table fz="sm" striped withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('quality.element.test')}</Table.Th>
                  <Table.Th scope="col">{t('quality.element.source')}</Table.Th>
                  <Table.Th scope="col">{t('quality.element.status')}</Table.Th>
                  <Table.Th scope="col">{t('quality.element.when')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {d.results.slice(0, all ? undefined : SHOWN).map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {r.name}
                    </Table.Td>
                    <Table.Td>{t(`quality.sources.${r.source}`)}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light" color={STATUS_COLOR[r.status]} tt="none">
                        {t(`quality.statuses.${r.status}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{fmtRelative(r.observedAt)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
          {!all && d.results.length > SHOWN && (
            <Anchor component="button" size="sm" onClick={() => setAll(true)}>
              {t('quality.element.showAll', { count: d.results.length })}
            </Anchor>
          )}
        </Stack>
      )}
    </Section>
  );
}
