import { useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, List, Modal, Paper, SimpleGrid, Stack, Text, Textarea, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconCheck, IconDownload, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ADVISORY_LIMITS, type AdvisoryAssetMatch, type AdvisoryDetail, type AdvisorySiteState } from '@sm/shared';
import { apiUrl, del, get, notifyError, put } from '../api';
import { DetailState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { CollapsibleSection, SectionGroup } from '../components/page/CollapsibleSection';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { fmtDate, fmtDay } from '../format';
import { plantKeys } from '../queryKeys';
import { PreviewBadge } from '../components/plant/common';
import {
  AdvisoryStatusBadge,
  DecisionModal,
  ReasonLine,
  RemediationBadge,
  RemediationModal,
  SeverityBadge,
  zoneText,
} from '../components/plant/advisories/common';

/**
 * One security advisory (0.14, docs/ADVISORIES.md): what it says (summary, vulnerabilities with their remediations and
 * the fixed firmware, references, where it came from and how it was checked) and what it means here – the affected
 * assets by site and zone (with the zone's SL-T), the possible matches to confirm or dismiss, the remediation per
 * asset, and a site's "not applicable".
 */
export function PlantAdvisoryPage() {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const { advisoryId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: plantKeys.advisory(advisoryId), queryFn: () => get<AdvisoryDetail>(`/plant/advisories/${encodeURIComponent(advisoryId!)}`) });
  const [decide, setDecide] = useState<{ m: AdvisoryAssetMatch; decision: 'confirmed' | 'dismissed' } | null>(null);
  const [fix, setFix] = useState<AdvisoryAssetMatch | null>(null);
  const [siteNa, setSiteNa] = useState<AdvisorySiteState | null>(null);
  const a = q.data;
  if (!a) return <DetailState query={q} back="plantAdvisories" />;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['plant', 'advisories'] });
  const undo = async (m: AdvisoryAssetMatch) => {
    try {
      await put(`/plant/advisories/${encodeURIComponent(a.id)}/assets/${encodeURIComponent(m.assetId)}/decision`, { decision: null });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const applies = async (s: AdvisorySiteState) => {
    try {
      await put(`/plant/advisories/${encodeURIComponent(a.id)}/sites/${encodeURIComponent(s.siteId)}`, { notApplicable: false });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'remove', message: t('detail.deleteConfirm', { id: a.trackingId }) }))) return;
    try {
      await del(`/plant/advisories/${encodeURIComponent(a.id)}`);
      void qc.invalidateQueries({ queryKey: ['plant', 'advisories'] });
      navigate('/plant/advisories');
    } catch (e) {
      notifyError(e);
    }
  };
  const affected = a.matches.filter((m) => m.counted);
  const possible = a.matches.filter((m) => !m.counted && m.decision === null);
  const dismissed = a.matches.filter((m) => m.decision === 'dismissed');
  const siteIds = [...new Set([...affected.map((m) => m.siteId), ...a.siteStates.map((s) => s.siteId)])];
  const stateOf = (siteId: string) => a.siteStates.find((s) => s.siteId === siteId);
  const decided = (m: AdvisoryAssetMatch) =>
    m.decision && m.decidedBy ? t('match.decidedBy', { decision: t(`decision.${m.decision}`), by: m.decidedBy, at: fmtDate(m.decidedAt) }) : null;

  const matchRow = (m: AdvisoryAssetMatch, mode: 'affected' | 'possible' | 'dismissed') => (
    <Paper key={m.assetId} withBorder p="sm" data-testid={`advisory-match-${m.assetId}`}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs" wrap="wrap">
            <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(m.assetId)}`} fw={500} style={{ overflowWrap: 'anywhere' }}>
              {m.assetName}
            </Anchor>
            <Text size="xs" c="dimmed">
              {[m.manufacturer, m.model].filter(Boolean).join(' ')}
              {m.firmware ? ` · ${t('detail.firmware')} ${m.firmware}` : ''}
            </Text>
            {mode === 'possible' && (
              <Badge size="sm" variant="outline" color="yellow">
                {t('kind.possible')}
              </Badge>
            )}
            {mode === 'affected' && <RemediationBadge m={m} />}
            {m.siteNotApplicable && (
              <Badge size="sm" variant="light" color="gray">
                {t('detail.notApplicableBadge')}
              </Badge>
            )}
          </Group>
          {m.canManage && (
            <Group gap="xs" wrap="wrap">
              {mode === 'affected' && (
                <Button size="xs" variant="default" onClick={() => setFix(m)} data-testid="remediation-open">
                  {t('fix.set')}
                </Button>
              )}
              {mode === 'possible' && (
                <Button
                  size="xs"
                  leftSection={<IconCheck size={14} aria-hidden />}
                  onClick={() => setDecide({ m, decision: 'confirmed' })}
                  data-testid="match-confirm"
                >
                  {t('match.confirm')}
                </Button>
              )}
              {mode !== 'dismissed' && m.decision === null && (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconX size={14} aria-hidden />}
                  onClick={() => setDecide({ m, decision: 'dismissed' })}
                  data-testid="match-dismiss"
                >
                  {t('match.dismiss')}
                </Button>
              )}
              {m.decision !== null && (
                <Button size="xs" variant="subtle" onClick={() => void undo(m)} data-testid="match-undo">
                  {t('match.undo')}
                </Button>
              )}
            </Group>
          )}
        </Group>
        {m.reasons.map((r, i) => (
          <ReasonLine key={i} r={r} />
        ))}
        {decided(m) && (
          <Text size="xs" c="dimmed">
            {decided(m)}
            {m.decisionReason ? ` – ${m.decisionReason}` : ''}
          </Text>
        )}
        {mode === 'affected' && m.fixes.length > 0 && (
          <Text size="xs" data-testid="match-fix">
            {t('detail.fix')}: {m.fixes.map((f) => (f.from === 'range' ? t('detail.fixFromRange', { version: f.version }) : f.version)).join(', ')}
          </Text>
        )}
        {mode === 'affected' && m.remediation.status !== 'open' && (
          <Text size="xs" c="dimmed">
            {[
              m.remediation.status === 'planned' && (m.remediation.windowTitle || m.remediation.changeSetTitle)
                ? t('fix.planned', { what: [m.remediation.windowTitle, m.remediation.changeSetTitle].filter(Boolean).join(', ') })
                : '',
              m.remediation.until ? `${t('fix.until')} ${fmtDay(m.remediation.until)}` : '',
              m.remediation.reason,
              m.remediation.note,
              m.remediation.by ? t('fix.by', { by: m.remediation.by, at: fmtDate(m.remediation.at) }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        {mode === 'affected' && m.remediation.windowId && (
          <Anchor component={Link} to={`/maintenance?open=${encodeURIComponent(m.remediation.windowId)}`} size="xs">
            {m.remediation.windowTitle ?? m.remediation.windowId}
          </Anchor>
        )}
        {mode === 'affected' && m.remediation.changeSetId && (
          <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(m.remediation.changeSetId)}`} size="xs">
            {m.remediation.changeSetTitle ?? m.remediation.changeSetId}
          </Anchor>
        )}
      </Stack>
    </Paper>
  );

  /** The affected assets of a site, by zone (an asset in several zones is listed in each). */
  const bySite = (siteId: string) => {
    const list = affected.filter((m) => m.siteId === siteId);
    const zones = new Map<string, { label: string; items: AdvisoryAssetMatch[] }>();
    for (const m of list) {
      const keys = m.zones.length ? m.zones.map((z) => ({ key: z.id, label: zoneText(t, z) })) : [{ key: '', label: t('detail.zoneNone') }];
      for (const k of keys) {
        const g = zones.get(k.key) ?? { label: k.label, items: [] };
        g.items.push(m);
        zones.set(k.key, g);
      }
    }
    return [...zones.entries()].sort(([x], [y]) => (x === '' ? 1 : y === '' ? -1 : x.localeCompare(y)));
  };

  return (
    <>
      <DetailHeader
        back="plantAdvisories"
        title={a.title}
        status={
          <>
            <SeverityBadge severity={a.severity} cvss={a.cvss} size="md" />
            <AdvisoryStatusBadge status={a.status} />
            <PreviewBadge />
          </>
        }
        description={
          <Text size="sm" c="dimmed">
            {a.trackingId} · {a.publisher} · {t('detail.version')} {a.version} · {fmtDay(a.updated)}
          </Text>
        }
        actions={
          <>
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/plant/advisories/${encodeURIComponent(a.id)}/document`)}
              leftSection={<IconDownload size={14} aria-hidden />}
            >
              {t('detail.download')}
            </Button>
            {a.canDelete && (
              <Button size="xs" variant="default" color="red" leftSection={<IconTrash size={14} aria-hidden />} onClick={() => void remove()}>
                {t('detail.delete')}
              </Button>
            )}
          </>
        }
      />
      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <SectionGroup rememberScope="plant-advisory">
            <Stack>
              {a.summary && (
                <Paper withBorder p="md">
                  <Title order={2} size="h4" mb="xs">
                    {t('detail.summary')}
                  </Title>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {a.summary}
                  </Text>
                </Paper>
              )}
              <CollapsibleSection
                id="affected"
                title={t('detail.affected')}
                count={affected.length}
                tone={a.status === 'open' ? 'warning' : undefined}
                description={t('detail.affectedHint')}
              >
                <Stack gap="md" data-testid="advisory-affected">
                  {siteIds.length === 0 && (
                    <Text size="sm" c="dimmed">
                      {t('detail.noAffected')}
                    </Text>
                  )}
                  {siteIds.map((sid) => {
                    const st = stateOf(sid);
                    const name = st?.siteName ?? affected.find((m) => m.siteId === sid)?.siteName ?? sid;
                    return (
                      <Stack key={sid} gap="xs" data-testid={`advisory-site-${sid}`}>
                        <Group justify="space-between" wrap="wrap">
                          <Anchor component={Link} to={`/plant/sites/${encodeURIComponent(sid)}`} fw={600}>
                            {name}
                          </Anchor>
                          {st?.notApplicable ? (
                            <Group gap="xs" wrap="wrap">
                              <Text size="xs" c="dimmed">
                                {t('detail.siteNaBy', { reason: st.reason, by: st.by ?? '', at: fmtDate(st.at) })}
                              </Text>
                              {st.canManage && (
                                <Button size="xs" variant="subtle" onClick={() => void applies(st)}>
                                  {t('detail.siteNaUndo')}
                                </Button>
                              )}
                            </Group>
                          ) : (
                            (st?.canManage ?? affected.some((m) => m.siteId === sid && m.canManage)) && (
                              <Button
                                size="xs"
                                variant="subtle"
                                onClick={() =>
                                  setSiteNa(st ?? { siteId: sid, siteName: name, notApplicable: false, reason: '', by: null, at: null, canManage: true })
                                }
                                data-testid="site-not-applicable"
                              >
                                {t('detail.siteNa', { site: name })}
                              </Button>
                            )
                          )}
                        </Group>
                        {bySite(sid).map(([key, g]) => (
                          <Stack key={key || 'none'} gap={6}>
                            <Text size="sm" fw={500} c="dimmed">
                              {g.label}
                            </Text>
                            {g.items.map((m) => matchRow(m, 'affected'))}
                          </Stack>
                        ))}
                      </Stack>
                    );
                  })}
                  {a.hiddenMatches > 0 && (
                    <Text size="sm" c="dimmed">
                      {t('detail.hidden', { count: a.hiddenMatches })}
                    </Text>
                  )}
                </Stack>
              </CollapsibleSection>
              {possible.length > 0 && (
                <CollapsibleSection id="possible" title={t('detail.possible')} count={possible.length} tone="warning" description={t('detail.possibleHint')}>
                  <Stack gap="xs" data-testid="advisory-possible">
                    {possible.map((m) => matchRow(m, 'possible'))}
                  </Stack>
                </CollapsibleSection>
              )}
              {dismissed.length > 0 && (
                <CollapsibleSection id="dismissed" title={t('detail.dismissed')} count={dismissed.length} defaultOpen={false}>
                  <Stack gap="xs">{dismissed.map((m) => matchRow(m, 'dismissed'))}</Stack>
                </CollapsibleSection>
              )}
              <CollapsibleSection id="vulnerabilities" title={t('detail.vulnerabilities')} count={a.vulnerabilities.length}>
                <Stack gap="sm">
                  {a.vulnerabilities.map((v, i) => (
                    <Paper key={`${v.cve}-${i}`} withBorder p="sm">
                      <Stack gap={4}>
                        <Group gap="xs" wrap="wrap">
                          <Text fw={600}>{v.cve || v.title || '–'}</Text>
                          <SeverityBadge severity={v.severity} cvss={v.cvss} size="xs" />
                          {v.cwe && (
                            <Text size="xs" c="dimmed">
                              {v.cwe}
                            </Text>
                          )}
                        </Group>
                        {v.cve && v.title && <Text size="sm">{v.title}</Text>}
                        {v.summary && (
                          <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
                            {v.summary}
                          </Text>
                        )}
                        {v.vector && (
                          <Text size="xs" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                            {v.vector}
                          </Text>
                        )}
                        {v.exploitation && (
                          <Text size="xs">
                            {t('detail.exploitation')}: {v.exploitation}
                          </Text>
                        )}
                        {v.remediations.length > 0 && (
                          <>
                            <Text size="xs" fw={600} mt={4}>
                              {t('detail.remediations')}
                            </Text>
                            <List size="sm" spacing={4}>
                              {v.remediations.map((r, j) => (
                                <List.Item key={j}>
                                  <Badge size="xs" variant="light" mr={6}>
                                    {t(`detail.remediationCategory.${r.category}`)}
                                  </Badge>
                                  {r.details}
                                  {r.url && (
                                    <>
                                      {' '}
                                      <Anchor href={r.url} target="_blank" rel="noopener noreferrer" size="sm">
                                        {new URL(r.url).host}
                                      </Anchor>
                                    </>
                                  )}
                                </List.Item>
                              ))}
                            </List>
                          </>
                        )}
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </CollapsibleSection>
              {a.profiles.length > 0 && (
                <CollapsibleSection
                  id="profiles"
                  title={t('detail.profiles')}
                  count={a.profiles.length}
                  description={t('detail.profilesHint')}
                  defaultOpen={false}
                >
                  <Stack gap={4}>
                    {a.profiles.map((p) => (
                      <Group key={p.id} gap="xs" wrap="wrap">
                        <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(p.id)}`} size="sm">
                          {p.name}
                        </Anchor>
                        <Badge size="xs" variant="light" color={p.kind === 'exact' ? 'red' : 'yellow'}>
                          {t(`kind.${p.kind}`)}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {p.text}
                        </Text>
                      </Group>
                    ))}
                  </Stack>
                </CollapsibleSection>
              )}
              <CollapsibleSection id="products" title={t('detail.products')} count={a.products.length + a.moreProducts} defaultOpen={false}>
                <List size="sm" spacing={2}>
                  {a.products.map((p) => (
                    <List.Item key={p.id}>
                      {p.fullName}
                      {p.partOf ? ` (${p.partOf})` : ''}
                    </List.Item>
                  ))}
                </List>
                {a.moreProducts > 0 && (
                  <Text size="sm" c="dimmed">
                    {t('detail.moreProducts', { count: a.moreProducts })}
                  </Text>
                )}
              </CollapsibleSection>
            </Stack>
          </SectionGroup>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="md">
            <Title order={2} size="h4" mb="sm">
              {t('detail.facts')}
            </Title>
            <SimpleGrid cols={1} spacing="xs">
              <Field label={t('detail.publisher')}>{a.publisher}</Field>
              <Field label={t('detail.trackingId')}>{a.trackingId}</Field>
              <Field label={t('detail.version')}>{a.version}</Field>
              <Field label={t('detail.published')}>{fmtDate(a.published)}</Field>
              <Field label={t('detail.updated')}>{fmtDate(a.updated)}</Field>
              <Field label={t('detail.category')}>{a.category}</Field>
              {a.tlp && <Field label={t('detail.tlp')}>{a.tlp}</Field>}
              <Field label={t('detail.integrity')}>
                <Text size="sm" data-testid="advisory-integrity">
                  {t(`integrity.${a.integrity}`)}
                </Text>
                <Text size="xs" c="dimmed" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
                  SHA-256 {a.sha256}
                </Text>
              </Field>
              {a.signatureUrl && (
                <Field label={t('detail.signature')}>
                  <Anchor href={a.signatureUrl} target="_blank" rel="noopener noreferrer" size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {a.signatureUrl.split('/').pop()}
                  </Anchor>{' '}
                  <Text span size="xs" c="dimmed">
                    ({t('detail.signatureNote')})
                  </Text>
                </Field>
              )}
              <Field label={t('detail.source')}>
                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {a.origin === 'upload'
                    ? `${t('origin.upload')}${a.fileName ? ` (${a.fileName})` : ''} – ${a.createdBy}, ${fmtDate(a.createdAt)}`
                    : a.sourceName
                      ? t('origin.feed', { source: a.sourceName })
                      : t('origin.feedUnknown')}
                </Text>
                {a.url && (
                  <Anchor href={a.url} target="_blank" rel="noopener noreferrer" size="xs" style={{ overflowWrap: 'anywhere' }}>
                    {a.url}
                  </Anchor>
                )}
              </Field>
              {a.references.length > 0 && (
                <Field label={t('detail.references')}>
                  <Stack gap={2}>
                    {a.references.slice(0, 20).map((r, i) => (
                      <Anchor key={i} href={r.url} target="_blank" rel="noopener noreferrer" size="sm" style={{ overflowWrap: 'anywhere' }}>
                        {r.summary || r.url}
                      </Anchor>
                    ))}
                  </Stack>
                </Field>
              )}
            </SimpleGrid>
          </Paper>
        </Grid.Col>
      </Grid>
      {decide && <DecisionModal advisoryId={a.id} match={decide.m} decision={decide.decision} onClose={() => setDecide(null)} onSaved={refresh} />}
      {fix && <RemediationModal advisoryId={a.id} match={fix} onClose={() => setFix(null)} onSaved={refresh} />}
      {siteNa && <SiteNaModal advisoryId={a.id} site={siteNa} onClose={() => setSiteNa(null)} onSaved={refresh} />}
    </>
  );
}

function SiteNaModal({ advisoryId, site, onClose, onSaved }: { advisoryId: string; site: AdvisorySiteState; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/plant/advisories/${encodeURIComponent(advisoryId)}/sites/${encodeURIComponent(site.siteId)}`, { notApplicable: true, reason: reason.trim() });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('detail.siteNa', { site: site.siteName })}>
      <Stack>
        <Textarea
          label={t('detail.siteNaReason')}
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          maxLength={ADVISORY_LIMITS.reasonChars}
          autosize
          minRows={2}
          data-autofocus
          data-testid="site-na-reason"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!reason.trim()} data-testid="site-na-save">
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
