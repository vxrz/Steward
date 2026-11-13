import { useState } from 'react';
import { Anchor, Button, Card, Group, Loader, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconPuzzle, IconUsers } from '@tabler/icons-react';
import type { ModuleId, ModuleState, ModulesView } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../../shared/src/brand';
import { get, notifyError, notifyOk, put } from '../../api';
import { QueryState } from '../common';
import { MaturityBadge } from '../modules/MaturityBadge';
import { visibilityKey } from '../../modules';
import { ModuleAccessBadge, ModuleAccessModal } from './ModuleAccess';

export const modulesKey = ['settings', 'modules'] as const;

/**
 * Settings → Modules (0.11.0, ADR 0016): every optional area with its maturity and a switch. Switching asks for a
 * step-up (the API layer opens the dialog) and applies to everyone; the data of a switched-off area stays. The plant
 * registry and its map are switched in their own cards below. Who may use a module (0.21.0, ADR 0034): everyone signed
 * in, or selected teams and users – per restrictable module, in its own dialog (ModuleAccess.tsx).
 */
export function ModulesCard() {
  const { t } = useTranslation('modules');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: modulesKey, queryFn: () => get<ModulesView>('/settings/modules') });
  const [busy, setBusy] = useState<ModuleId | null>(null);
  const [access, setAccess] = useState<ModuleId | null>(null);
  const byId = new Map((q.data?.modules ?? []).map((m) => [m.id, m]));
  const name = (id: ModuleId) => t(`items.${id}.name`, { brand: BRAND.name });
  const toggle = async (m: ModuleState, enabled: boolean) => {
    setBusy(m.id);
    try {
      const next = await put<ModulesView>(`/settings/modules/${m.id}`, { enabled });
      qc.setQueryData(modulesKey, next);
      // the sidebar, the pages and the search follow the switch
      void qc.invalidateQueries({ queryKey: ['auth'] });
      void qc.invalidateQueries({ queryKey: visibilityKey });
      notifyOk(enabled ? t('switchedOn', { name: name(m.id) }) : t('switchedOff', { name: name(m.id) }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card withBorder data-testid="modules-card">
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconPuzzle size={18} aria-hidden />
        <Title order={2} size="h5">
          {t('title')}
        </Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('intro', { brand: BRAND.name })}
      </Text>
      <QueryState query={q} />
      <Stack gap="sm" component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {(q.data?.modules ?? []).map((m) => {
          const requires = m.requires ? byId.get(m.requires) : undefined;
          const own = m.id === 'plant' || m.id === 'plantMap';
          return (
            <li key={m.id} data-testid={`module-${m.id}`}>
              <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Text size="sm" fw={600} id={`module-${m.id}-name`}>
                      {name(m.id)}
                    </Text>
                    <MaturityBadge maturity={m.maturity} />
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t(`items.${m.id}.description`, { brand: BRAND.name })}
                  </Text>
                  {(own || (requires && !requires.enabled)) && (
                    <Text size="xs" c="dimmed">
                      {m.id === 'plantMap' ? t('mapSettings') : own ? t('ownSettings') : t('requires', { name: name(requires!.id) })}
                    </Text>
                  )}
                  {m.restrictable && (
                    <Group gap={6} mt={4} wrap="wrap" data-testid={`module-${m.id}-access-mode`} data-mode={m.accessMode}>
                      <Text size="xs" c="dimmed">
                        {t('access.usedBy')}
                      </Text>
                      <ModuleAccessBadge mode={m.accessMode} />
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconUsers size={12} aria-hidden />}
                        onClick={() => setAccess(m.id)}
                        aria-label={t('access.openLabel', { name: name(m.id) })}
                        data-testid={`module-${m.id}-access`}
                      >
                        {t('access.open')}
                      </Button>
                    </Group>
                  )}
                </div>
                {own ? (
                  <Text size="xs" fw={600} c={m.enabled ? 'green' : 'dimmed'} style={{ flexShrink: 0 }} data-testid={`module-${m.id}-state`}>
                    {m.enabled ? t('state.on') : t('state.off')}
                  </Text>
                ) : (
                  <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
                    {busy === m.id && <Loader size="xs" />}
                    <Switch
                      checked={m.enabled}
                      disabled={busy !== null}
                      onChange={(e) => void toggle(m, e.currentTarget.checked)}
                      aria-label={t('switchLabel', { name: name(m.id) })}
                    />
                  </Group>
                )}
              </Group>
            </li>
          );
        })}
      </Stack>
      {access && (
        <ModuleAccessModal
          id={access}
          name={name(access)}
          onClose={() => setAccess(null)}
          onSaved={() => {
            setAccess(null);
            void qc.invalidateQueries({ queryKey: modulesKey });
          }}
        />
      )}
      <Text size="xs" mt="sm">
        <Anchor href={`${BRAND.repoUrl}/blob/HEAD/docs/MODULES.md`} target="_blank" rel="noopener">
          {t('docs')}
        </Anchor>
      </Text>
    </Card>
  );
}
