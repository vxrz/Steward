import { useTranslation } from 'react-i18next';
import { IconLock } from '@tabler/icons-react';
import type { VisibilityArea } from '@sm/shared';
import { EmptyState } from '../common';
import { useAreaVisibility } from '../../modules';

/**
 * Honest empty states (U3): when a list is empty for the person but holds entries they may not see, it says so – and
 * who to ask – instead of "nothing yet". The server only tells that such entries exist (GET /api/me/visibility),
 * never how many or which.
 */
export function useHiddenByPermissions(area: VisibilityArea | undefined): boolean {
  return useAreaVisibility(area)?.hiddenByPermissions === true;
}

export function RestrictedEmpty({ compact }: { compact?: boolean }) {
  const { t } = useTranslation('modules');
  return (
    <EmptyState icon={IconLock} title={t('restricted.title')} compact={compact} testId="empty-restricted">
      {t('restricted.text')}
    </EmptyState>
  );
}
