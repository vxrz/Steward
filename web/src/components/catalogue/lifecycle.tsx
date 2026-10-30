import { useState } from 'react';
import { Alert, Badge, Button, Group, List, Modal, NumberInput, Select, Stack, Switch, Text, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconHelpCircle, IconRefresh } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { LIFECYCLE_LIMITS, type LifecycleSettings, type LifecycleState, type LifecycleStatus, type Platform, type StackLifecycle } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { fmtDay, fmtRelative } from '../../format';

/** End of life of the tech stack (#104): coloured badges, and the settings with the state of the data. */

const COLORS: Record<LifecycleState, string> = { supported: 'green', ending: 'yellow', eol: 'red', unknown: 'gray' };
const ICONS: Record<LifecycleState, typeof IconCircleCheck> = {
  supported: IconCircleCheck,
  ending: IconAlertTriangle,
  eol: IconCircleX,
  unknown: IconHelpCircle,
};

/** What the tooltip says about a version's release cycle. */
export function lifecycleText(t: TFunction<'applications'>, lc: StackLifecycle): string {
  if (lc.state === 'unknown') return t('lifecycle.unknown');
  const parts = [t(lc.isLts ? 'lifecycle.cycleLts' : 'lifecycle.cycle', { cycle: lc.cycle })];
  if (lc.eolFrom) {
    const date = fmtDay(lc.eolFrom);
    parts.push(
      lc.state === 'eol'
        ? t('lifecycle.eolSince', { date })
        : lc.daysLeft !== null
          ? t('lifecycle.eolIn', { date, count: lc.daysLeft })
          : t('lifecycle.eolOn', { date }),
    );
  } else parts.push(t('lifecycle.noEolDate'));
  if (lc.latest) parts.push(t('lifecycle.latest', { version: lc.latest }));
  return parts.join(' · ');
}

/**
 * A product with its version, coloured by its end of life. The state is in the text for screen readers and in
 * an icon, not in the colour alone. Without end-of-life data (no refresh yet) the badge looks as before.
 */
export function LifecycleBadge({
  text,
  lifecycle,
  variant = 'light',
  extra,
  role,
}: {
  text: string;
  lifecycle: StackLifecycle | null;
  variant?: 'light' | 'outline';
  /** More lines for the tooltip (e.g. where the entry comes from) */
  extra?: string;
  role?: string;
}) {
  const { t } = useTranslation('applications');
  if (!lifecycle) {
    const badge = (
      <Badge role={role} size="sm" variant={variant} color="gray" tt="none">
        {text}
      </Badge>
    );
    return extra ? <Tooltip label={extra}>{badge}</Tooltip> : badge;
  }
  const Icon = ICONS[lifecycle.state];
  const state = t(`lifecycle.states.${lifecycle.state}`);
  const tip = [lifecycleText(t, lifecycle), extra].filter(Boolean).join('\n');
  return (
    <Tooltip label={tip} multiline maw={360} style={{ whiteSpace: 'pre-line' }}>
      <Badge
        role={role}
        size="sm"
        variant={variant}
        color={COLORS[lifecycle.state]}
        tt="none"
        leftSection={<Icon size={12} aria-hidden />}
        aria-label={`${text}: ${state}`}
        data-lifecycle={lifecycle.state}
      >
        {text}
      </Badge>
    </Tooltip>
  );
}

/** Opens the end-of-life settings and status. */
export function EndOfLifeButton() {
  const { t } = useTranslation('applications');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="default" leftSection={<IconCircleX size={14} />} onClick={() => setOpen(true)}>
        {t('lifecycle.button')}
      </Button>
      {open && <EndOfLifeModal onClose={() => setOpen(false)} />}
    </>
  );
}

function EndOfLifeModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['catalogue-lifecycle'], queryFn: () => get<LifecycleStatus>('/catalogue/lifecycle') });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const [draft, setDraft] = useState<LifecycleSettings | null>(null);
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const [imageText, setImageText] = useState<string | null>(null);
  const s = status.data;
  const settings = draft ?? s?.settings ?? null;
  const eolPlatforms = (platforms.data ?? []).filter((p) => p.kind === 'endoflife-date');
  const patch = (p: Partial<LifecycleSettings>) => settings && setDraft({ ...settings, ...p });
  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['catalogue-lifecycle'] }),
      qc.invalidateQueries({ queryKey: ['application'] }),
      qc.invalidateQueries({ queryKey: ['scorecard'] }),
    ]);
  };

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      await put('/catalogue/lifecycle', draft);
      setDraft(null);
      setImageText(null);
      await refreshAll();
      notifyOk(t('lifecycle.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy('refresh');
    try {
      const r = await post<LifecycleStatus>('/catalogue/lifecycle/refresh', {});
      await refreshAll();
      notifyOk(t('lifecycle.refreshed', { count: r.withData, total: r.products }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal opened onClose={onClose} title={t('lifecycle.title')} size="lg">
      {!s || !settings ? (
        <Text size="sm" c="dimmed">
          {status.isError ? t('common:loadFailed') : t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm" data-testid="lifecycle-settings">
          <Text size="sm" c="dimmed">
            {t('lifecycle.help')}
          </Text>
          {!s.platform && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
              {t('lifecycle.noPlatform')}
            </Alert>
          )}
          <Text size="sm" data-testid="lifecycle-status">
            {s.refreshedAt
              ? t('lifecycle.status', { count: s.withData, total: s.products, when: fmtRelative(s.refreshedAt) })
              : t('lifecycle.neverRefreshed', { count: s.products })}
          </Text>
          {s.errors.length > 0 && (
            <Alert color="red" title={t('lifecycle.errors')}>
              <List size="sm">
                {s.errors.slice(0, 10).map((e) => (
                  <List.Item key={e.product}>
                    {e.product}: {e.error}
                  </List.Item>
                ))}
              </List>
            </Alert>
          )}
          <Select
            label={t('lifecycle.platform')}
            description={t('lifecycle.platformHint')}
            placeholder={s.platform && !settings.platformId ? s.platform.name : t('lifecycle.platformNone')}
            data={eolPlatforms.map((p) => ({ value: p.id, label: p.name }))}
            value={settings.platformId}
            onChange={(v) => patch({ platformId: v })}
            clearable
            disabled={!s.canEdit}
          />
          <NumberInput
            label={t('lifecycle.warnDays')}
            description={t('lifecycle.warnDaysHint')}
            min={LIFECYCLE_LIMITS.warnDaysMin}
            max={LIFECYCLE_LIMITS.warnDaysMax}
            value={settings.warnDays}
            onChange={(v) => patch({ warnDays: typeof v === 'number' ? v : LIFECYCLE_LIMITS.defaultWarnDays })}
            disabled={!s.canEdit}
            w={220}
          />
          <Switch
            label={t('lifecycle.notify')}
            description={t('lifecycle.notifyHint')}
            checked={settings.notify}
            onChange={(e) => patch({ notify: e.currentTarget.checked })}
            disabled={!s.canEdit}
          />
          <Switch
            label={t('lifecycle.scorecard')}
            description={t('lifecycle.scorecardHint')}
            checked={settings.scorecard}
            onChange={(e) => patch({ scorecard: e.currentTarget.checked })}
            disabled={!s.canEdit}
          />
          <Textarea
            label={t('lifecycle.imageMap')}
            description={t('lifecycle.imageMapHint')}
            // i18n-ignore: an example line (image = product id), the same in every language
            placeholder="ghcr.io/acme/base-node = nodejs"
            autosize
            minRows={2}
            maxRows={10}
            classNames={{ input: 'mono' }}
            value={imageText ?? (settings.imageMap ?? []).map((r) => `${r.image} = ${r.product}`).join('\n')}
            onChange={(e) => {
              const text = e.currentTarget.value;
              setImageText(text);
              patch({
                imageMap: text
                  .split('\n')
                  .map((line) => line.split('='))
                  .filter((p) => p.length === 2 && p[0]!.trim() && p[1]!.trim())
                  .map(([image, product]) => ({ image: image!.trim(), product: product!.trim() })),
              });
            }}
            disabled={!s.canEdit}
          />
          {!s.canEdit && (
            <Text size="xs" c="dimmed">
              {t('lifecycle.adminOnly')}
            </Text>
          )}
          <Group justify="space-between" mt="xs">
            {s.canRefresh ? (
              <Button
                variant="default"
                leftSection={<IconRefresh size={16} />}
                onClick={() => void refresh()}
                loading={busy === 'refresh'}
                disabled={!s.platform}
              >
                {t('lifecycle.refresh')}
              </Button>
            ) : (
              <span />
            )}
            {s.canEdit && (
              <Button onClick={() => void save()} loading={busy === 'save'} disabled={!draft}>
                {t('common:save')}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
