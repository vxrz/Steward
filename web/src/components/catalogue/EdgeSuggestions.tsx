import { Anchor, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'react';
import type { EdgeSuggestion, EdgeSuggestions } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { fmtNumber, fmtRelative } from '../../format';
import { CollapsibleSection } from '../page/CollapsibleSection';

/**
 * The inbox of the Industrial Edge installations readout (0.25.0, ADR 0037 part 3, docs/APPLICATIONS.md#industrial-edge-devices):
 * what IEM says runs where, compared with the catalogue. Nothing is created on its own: a person confirms each
 * suggestion (with the right to change its target) or dismisses it. Shown only when there is a readout the reader may see.
 */
export function EdgeSuggestionsSection({ canRestore }: { canRestore: boolean }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['systems', 'edge-suggestions'], queryFn: () => get<EdgeSuggestions>('/systems/edge-suggestions') });
  const [busy, setBusy] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const e = q.data;
  if (!e?.readout) return null;
  // the card goes with its buttons: the focus moves to the next suggestion's first button, or to the section's
  // heading when it was the last one (WCAG 2.4.3)
  const keepFocus = (index: number) => {
    const cards = box.current?.querySelectorAll<HTMLElement>('[data-testid="edge-suggestion"]') ?? [];
    const next = cards[Math.min(index, cards.length - 1)]?.querySelector<HTMLElement>('button');
    (next ?? document.querySelector<HTMLElement>('[data-testid="edge-suggestions-toggle"]'))?.focus();
  };
  const act = async (s: EdgeSuggestion, what: 'confirm' | 'dismiss') => {
    setBusy(s.key);
    const index = e.suggestions.findIndex((x) => x.key === s.key);
    try {
      await post(`/systems/edge-suggestions/${what}`, { key: s.key });
      notifyOk(t(what === 'confirm' ? 'edgeSuggestions.confirmed' : 'edgeSuggestions.dismissedOne'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['systems'] }),
        qc.invalidateQueries({ queryKey: ['system'] }),
        qc.invalidateQueries({ queryKey: ['application'] }),
      ]);
      requestAnimationFrame(() => keepFocus(index));
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(null);
    }
  };
  const restore = async () => {
    try {
      await post('/systems/edge-suggestions/restore', {});
      notifyOk(t('edgeSuggestions.restored'));
      await qc.invalidateQueries({ queryKey: ['systems', 'edge-suggestions'] });
      requestAnimationFrame(() => keepFocus(0));
    } catch (err) {
      notifyError(err);
    }
  };
  const text = (s: EdgeSuggestion) =>
    s.kind === 'createSystem'
      ? t('edgeSuggestions.createSystem', { device: s.deviceName })
      : s.kind === 'linkSystem'
        ? t('edgeSuggestions.linkSystem', { device: s.deviceName, system: s.system?.name ?? '' })
        : t(s.application ? 'edgeSuggestions.addApplication' : 'edgeSuggestions.newApplication', {
            app: s.appVersion ? `${s.appTitle} ${s.appVersion}` : s.appTitle,
            system: s.system?.name ?? '',
          });
  const action = (s: EdgeSuggestion) =>
    s.kind === 'createSystem'
      ? t('edgeSuggestions.doCreateSystem')
      : s.kind === 'linkSystem'
        ? t('edgeSuggestions.doLinkSystem')
        : s.application
          ? t('edgeSuggestions.doAddApplication')
          : t('edgeSuggestions.doNewApplication');
  return (
    <CollapsibleSection
      id="edge-suggestions"
      title={t('edgeSuggestions.title')}
      description={t('edgeSuggestions.help', {
        title: e.readout.title,
        when: fmtRelative(e.readout.updatedAt),
        count: e.readout.devices,
        devices: fmtNumber(e.readout.devices),
      })}
      count={e.suggestions.length}
      defaultOpen={e.suggestions.length > 0}
      testId="edge-suggestions"
      collapseOnPhone
    >
      <Stack gap="xs" mb="md" ref={box}>
        {e.suggestions.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('edgeSuggestions.none')}
          </Text>
        )}
        {e.suggestions.map((s) => (
          <Paper key={s.key} withBorder p="sm" data-testid="edge-suggestion">
            <Group justify="space-between" align="flex-start" gap="sm">
              <Stack gap={2} style={{ minWidth: 0, flex: '1 1 16rem' }}>
                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {text(s)}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('edgeSuggestions.deviceLine', { id: s.deviceId })}
                  {s.system && (
                    <>
                      {' · '}
                      <Anchor component={Link} to={`/systems/${encodeURIComponent(s.system.id)}`} size="xs">
                        {s.system.name}
                      </Anchor>
                    </>
                  )}
                </Text>
                {!s.canConfirm && (
                  <Text size="xs" c="dimmed">
                    {t('edgeSuggestions.noRight')}
                  </Text>
                )}
              </Stack>
              {s.canConfirm && (
                <Group gap="xs" wrap="wrap">
                  <Button size="xs" loading={busy === s.key} onClick={() => void act(s, 'confirm')}>
                    {action(s)}
                  </Button>
                  <Button size="xs" variant="default" disabled={busy === s.key} onClick={() => void act(s, 'dismiss')}>
                    {t('edgeSuggestions.dismiss')}
                  </Button>
                </Group>
              )}
            </Group>
          </Paper>
        ))}
        {(e.dismissed > 0 || e.hidden > 0) && (
          <Group gap="sm" wrap="wrap">
            {e.dismissed > 0 && (
              <Text size="xs" c="dimmed">
                {t('edgeSuggestions.dismissedCount', { count: e.dismissed })}
              </Text>
            )}
            {e.dismissed > 0 && canRestore && (
              <Button size="xs" variant="subtle" onClick={() => void restore()}>
                {t('edgeSuggestions.restore')}
              </Button>
            )}
            {e.hidden > 0 && (
              <Text size="xs" c="dimmed">
                {t('edgeSuggestions.hidden', { count: e.hidden })}
              </Text>
            )}
          </Group>
        )}
      </Stack>
    </CollapsibleSection>
  );
}
