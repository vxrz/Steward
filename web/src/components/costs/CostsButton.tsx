import { Button } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCoin } from '@tabler/icons-react';
import type { CostScope } from '@sm/shared';
import { SCOPE_PATH } from './common';
import { useModuleOn } from '../../modules';

/** The way from a service, application or platform to its costs (#226). */
export function CostsButton({ scope, id }: { scope: CostScope; id: string }) {
  const { t } = useTranslation('nav');
  // the costs module switched off (ADR 0016): no button
  if (!useModuleOn('costs')) return null;
  return (
    <Button component={Link} to={SCOPE_PATH(scope, id)} size="xs" variant="default" leftSection={<IconCoin size={14} />} data-testid="open-costs">
      {t('items.costs')}
    </Button>
  );
}
