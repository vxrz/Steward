import { useState } from 'react';
import { Alert, Button, Group, List, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Platform, PlatformConfirmReview } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { confirmDialog } from '../confirm';

type ReviewedIdentity = PlatformConfirmReview['identities'][number];

/** What the confirmation seals for one identity, and what it resets or removes (0.9.0). */
function IdentityReview({ identity }: { identity: ReviewedIdentity }) {
  const { t } = useTranslation('platforms');
  const mcp =
    identity.mcp.mode === 'writes'
      ? t('identities.mcp.writes', { mode: t(`identities.mcp.writeModes.${identity.mcp.writes ?? 'confirm'}`) })
      : t(`identities.mcp.${identity.mcp.mode}`);
  const vars = Object.entries(identity.variables);
  return (
    <Stack gap={4} data-testid={`confirm-identity-${identity.action}`}>
      <Text size="sm" fw={600}>
        {t('integrity.review.identity', { name: identity.name })}
      </Text>
      {identity.action === 'remove' ? (
        <Text size="sm" c="red">
          {t('integrity.review.remove')}
        </Text>
      ) : (
        <List size="sm" spacing={2}>
          <List.Item>{t('integrity.review.mcp', { mode: mcp })}</List.Item>
          <List.Item>
            {t('integrity.review.credentials', { keys: identity.secretKeys.length ? identity.secretKeys.join(', ') : t('identities.noCredentials') })}
          </List.Item>
        </List>
      )}
      {identity.action === 'reset' && (
        <>
          <Text size="sm" c="red">
            {t('integrity.review.reset')}
          </Text>
          <List size="sm" spacing={2}>
            {vars.length > 0 && <List.Item>{t('integrity.review.variables', { vars: vars.map(([k, v]) => `${k} = ${v}`).join(', ') })}</List.Item>}
            {identity.signIn && <List.Item>{t('integrity.review.signIn', { type: identity.signIn.type, url: identity.signIn.url ?? '–' })}</List.Item>}
            {identity.flags.length > 0 && <List.Item>{t('integrity.review.flags', { flags: identity.flags.join(', ') })}</List.Item>}
          </List>
        </>
      )}
    </Stack>
  );
}

/**
 * Shown when the platform's connection settings fail their integrity check (changed directly in the
 * database). No requests go to the platform until an administrator reviews the settings and confirms them.
 * The dialog shows what the platform page does not: the identities' MCP mode and credential names, and the settings the
 * confirmation resets or the identities it removes (0.9.0).
 */
export function PlatformIntegrityAlert({ platform, canConfirm }: { platform: Platform; canConfirm: boolean }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (platform.integrity !== 'mismatch' && platform.integrity !== 'unsealed') return null;
  const confirm = async () => {
    setBusy(true);
    try {
      const review = await get<PlatformConfirmReview>(`/platforms/${platform.id}/confirm-config`);
      const message = (
        <Stack gap="sm">
          <Text size="sm">{t('integrity.confirmQuestion', { url: review.baseUrl })}</Text>
          {review.identities.map((i) => (
            <IdentityReview key={i.id} identity={i} />
          ))}
        </Stack>
      );
      if (!(await confirmDialog({ action: 'confirm', message, danger: false }))) return;
      await post(`/platforms/${platform.id}/confirm-config`);
      notifyOk(t('integrity.confirmed'));
      void qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('integrity.title')} mb="md">
      <Text size="sm">{t('integrity.text', { url: platform.baseUrl })}</Text>
      <Group mt="xs">
        {canConfirm ? (
          <Button size="xs" color="red" variant="light" loading={busy} onClick={confirm}>
            {t('integrity.confirm')}
          </Button>
        ) : (
          <Text size="xs">{t('integrity.askAdmin')}</Text>
        )}
      </Group>
    </Alert>
  );
}
