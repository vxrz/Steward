import { lazy, Suspense } from 'react';
import { Anchor, Badge, Box, Button, Grid, Group, List, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IconListSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { unitSymbol, type PlantDataPointDetail } from '@sm/shared';
import { get } from '../api';
import { DetailState } from '../components/common';
import { useAliasRedirect, useChangeId } from '../components/plant/ids';
import { DetailHeader } from '../components/page/DetailPage';
import { Field } from '../components/records/common';
import { plantKeys } from '../queryKeys';
import { PreviewBadge, useNameOf, usePlantConfig, usePlantLabel } from '../components/plant/common';
import { AssetBriefLink, Breakable, ProtocolBadge, rateText, useAddressHint, useSourceText } from '../components/plant/data';
import { PointCollections } from '../components/plant/CollectorCollections';
import { ShowAll, useShowMore } from '../components/page/ShowAll';

// the lineage picture (#230) loads with the graph library, after the page itself
const PointLineageView = lazy(() => import('./plant/views/AssetFlowView').then((m) => ({ default: m.PointLineageView })));

/**
 * A data point of a device profile (#219): what it is (type, unit, address, access, update rate), which assets
 * deliver it – the profile's assets whose interface is set up and active, unless an override says the asset lacks
 * it – where they publish it, and the KPI definitions that read it.
 */
export function PlantDataPointPage() {
  const { t, i18n } = useTranslation(['plant', 'common', 'plantModel']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const hint = useAddressHint();
  const sourceText = useSourceText();
  const { profileId, pointId } = useParams();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const q = useQuery({
    queryKey: plantKeys.point(profileId, pointId),
    queryFn: () => get<PlantDataPointDetail>(`/plant/profiles/${encodeURIComponent(profileId!)}/points/${encodeURIComponent(pointId!)}`),
  });
  const profileCrumb = { to: `/plant/profiles/${encodeURIComponent(profileId ?? '')}`, label: q.data?.profile.name ?? profileId ?? '' };
  useAliasRedirect([
    [profileId, q.data?.profile.id],
    [pointId, q.data?.point.id],
  ]);
  const canManageCatalogue = !!usePlantConfig().data?.canManageCatalogue;
  const changeId = useChangeId(
    q.data ? { kind: 'data_point', scope: q.data.profile.id, id: q.data.point.id, name: q.data.point.name || q.data.point.id } : null,
    canManageCatalogue,
  );
  // the first 20 assets, "Show all N" for the rest
  const assets = useShowMore(q.data?.assets ?? [], 20);
  if (!q.data) return <DetailState query={q} back={['plantProfiles', profileCrumb]} />;
  const d = q.data;
  const p = d.point;
  const delivering = d.assets.filter((a) => a.delivers).length;
  const why = (a: PlantDataPointDetail['assets'][number]) =>
    a.delivers ? (
      <Badge color="green" variant="light" size="sm" style={{ minWidth: 'max-content' }}>
        {t('point.delivers')}
      </Badge>
    ) : (
      <Badge color="orange" variant="light" size="sm" style={{ minWidth: 'max-content' }}>
        {t(`point.reasons.${a.reason ?? 'interface_inactive'}`)}
      </Badge>
    );
  const pubs = (a: PlantDataPointDetail['assets'][number]) =>
    a.publications.length ? (
      <Stack gap={2}>
        {a.publications.map((x, i) => (
          <Text key={i} size="xs" className="mono code-wrap">
            <Breakable text={[x.target, [x.path, x.name].filter(Boolean).join(' / ')].filter(Boolean).join(': ')} />
          </Text>
        ))}
      </Stack>
    ) : (
      '–'
    );
  return (
    <>
      <DetailHeader
        recent={{ label: `${p.name} · ${d.profile.name}`, kind: 'profile' }}
        back={['plantProfiles', profileCrumb]}
        title={p.name}
        status={
          <>
            <ProtocolBadge protocol={d.interface.protocol} />
            <PreviewBadge />
          </>
        }
        description={t('point.of', { iface: d.interface.name || d.interface.id, group: d.group || t('data.ungrouped') })}
        actions={
          <Button
            size="xs"
            variant="default"
            component={Link}
            to={`/plant/assets?profile=${encodeURIComponent(d.profile.id)}&dataPoint=${encodeURIComponent(p.id)}`}
            leftSection={<IconListSearch size={14} />}
          >
            {t('point.assetList', { type: label('asset', true, true) })}
          </Button>
        }
        menu={changeId.item ? { items: [changeId.item] } : undefined}
      />
      {changeId.modal}
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {p.description && (
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {p.description}
              </Text>
            )}
            {p.description && d.origin.descriptionFrom !== d.profile.id && (
              <Text size="xs" c="dimmed" data-testid="point-description-origin">
                {t('plantModel:describe.inherited', { from: d.origin.descriptionFrom })}
              </Text>
            )}
            <Stack gap="xs" data-testid="point-assets">
              <Title order={2} fz="h4">
                {t('point.deliveredBy', { type: label('asset', true) })}
              </Title>
              <Text size="xs" c="dimmed">
                {t('point.deliveredHelp', { count: delivering, total: d.assets.length })}
              </Text>
              {d.assets.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('profile.noAssets', { type: label('asset', true, true) })}
                </Text>
              ) : narrow ? (
                <Stack gap="xs" role="list" aria-label={t('point.deliveredBy', { type: label('asset', true) })}>
                  {assets.items.map((a) => (
                    <Paper key={a.asset.id} withBorder p="sm" role="listitem">
                      <Stack gap={4}>
                        <AssetBriefLink asset={a.asset} />
                        {why(a)}
                        {a.endpoint && (
                          <Text size="xs" className="mono code-wrap">
                            <Breakable text={a.endpoint} />
                          </Text>
                        )}
                        {pubs(a)}
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={t('point.deliveredBy', { type: label('asset', true) })}>
                  {/* columns sized by their content: identifiers stay whole, the table scrolls when they do not fit */}
                  <Table fz="sm" aria-label={t('point.deliveredBy', { type: label('asset', true) })} miw={600} className="code-keep">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th miw={140}>{label('asset')}</Table.Th>
                        <Table.Th>{t('point.state')}</Table.Th>
                        <Table.Th>{t('assignment.endpoint')}</Table.Th>
                        <Table.Th>{t('assignment.publications')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {assets.items.map((a) => (
                        <Table.Tr key={a.asset.id}>
                          <Table.Td>
                            <AssetBriefLink asset={a.asset} />
                          </Table.Td>
                          <Table.Td>{why(a)}</Table.Td>
                          <Table.Td>
                            <Text size="xs" className="mono code-wrap">
                              {a.endpoint ? <Breakable text={a.endpoint} /> : '–'}
                            </Text>
                          </Table.Td>
                          <Table.Td>{pubs(a)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
              <ShowAll state={assets} id="point-assets" />
            </Stack>
            <Stack gap="xs" data-testid="point-kpis">
              <Title order={2} fz="h4">
                {t('point.kpis')}
              </Title>
              {d.kpis.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('point.noKpis')}
                </Text>
              ) : (
                <List size="sm" spacing={2}>
                  {d.kpis.map((k) => (
                    <List.Item key={k.id}>
                      <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.id)}`} size="sm">
                        {nameOf(k)}
                      </Anchor>
                    </List.Item>
                  ))}
                </List>
              )}
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="md" data-testid="point-facts">
            <Stack gap="sm">
              <Field label={t('form.id')}>
                <span className="mono">{p.id}</span>
              </Field>
              <Field label={t('point.profile')}>
                <Anchor component={Link} to={profileCrumb.to} size="sm">
                  {d.profile.name}
                </Anchor>
                {d.origin.from !== d.profile.id && (
                  <Text size="xs" c="dimmed" data-testid="point-origin">
                    {d.origin.kind === 'overridden'
                      ? t('plantModel:origin.pointOverridden', { from: d.origin.from, fields: d.origin.fields.join(', ') })
                      : t('plantModel:origin.pointInherited', { from: d.origin.from })}
                  </Text>
                )}
              </Field>
              <Field label={t('data.dataType')}>
                <span className="mono">{p.dataType || '–'}</span>
              </Field>
              <Field label={t('data.unit')}>{p.unit ? (unitSymbol(p.unit) === p.unit ? p.unit : `${unitSymbol(p.unit)} (UCUM ${p.unit})`) : '–'}</Field>
              <Field label={t('data.address')}>
                <Text size="sm" className="mono code-wrap">
                  <Breakable text={p.address || '–'} />
                </Text>
                {hint(d.interface.protocol, p.address) && (
                  <Text size="xs" c="dimmed">
                    {hint(d.interface.protocol, p.address)}
                  </Text>
                )}
              </Field>
              <Field label={t('data.access')}>{t(`data.directions.${p.access}`)}</Field>
              <Field label={t('data.updateRate')}>{rateText(p.updateRateMs, i18n.language)}</Field>
              {p.enumValues.length > 0 && (
                <Field label={t('data.enumValues')}>
                  <Group gap={4}>
                    {p.enumValues.map((v) => (
                      <Badge key={v} size="sm" variant="default" tt="none">
                        {v}
                      </Badge>
                    ))}
                  </Group>
                </Field>
              )}
              {p.aliases.length > 0 && (
                <Field label={t('plantModel:aliases.label')}>
                  <Group gap={4} data-testid="point-aliases-view">
                    {p.aliases.map((v) => (
                      <Badge key={v} size="sm" variant="default" tt="none" className="mono">
                        {v}
                      </Badge>
                    ))}
                  </Group>
                </Field>
              )}
              {p.publications.length > 0 && (
                <Field label={t('data.defaultPublications')}>
                  <Stack gap={2}>
                    {p.publications.map((x, i) => (
                      <Text key={i} size="xs" className="mono code-wrap">
                        <Breakable text={[x.target, [x.path, x.name].filter(Boolean).join(' / ')].filter(Boolean).join(': ')} />
                      </Text>
                    ))}
                  </Stack>
                </Field>
              )}
              {p.source && (
                <Field label={t('data.source')}>
                  <Text size="sm" data-testid="point-source-view" style={{ overflowWrap: 'anywhere' }}>
                    {sourceText(p.source)}
                  </Text>
                </Field>
              )}
              {p.notes && (
                <Field label={t('data.notes')}>
                  <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                    {p.notes}
                  </Text>
                </Field>
              )}
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      <Box mt="lg">
        <PointCollections profileId={d.profile.id} pointId={p.id} />
      </Box>
      <Box mt="lg">
        <Suspense fallback={null}>
          <PointLineageView profileId={d.profile.id} pointId={p.id} pointName={p.name} />
        </Suspense>
      </Box>
    </>
  );
}
