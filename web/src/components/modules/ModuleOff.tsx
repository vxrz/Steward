import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { IconLock, IconPuzzleOff } from '@tabler/icons-react';
import type { ModuleId } from '@sm/shared';
import { EmptyState, PageHeader } from '../common';
import { useMe } from '../../auth';
import { moduleNotYours, useModuleOn } from '../../modules';

/**
 * A page of a switched-off module (U10): says that the area is off and who can turn it on – nothing else (no names,
 * no counts). Administrators get the link to Settings → Modules. A module the person does not use (ADR 0034) says so.
 */
export function ModuleOffPage({ module }: { module: ModuleId }) {
  const { t } = useTranslation('modules');
  const { caps } = useMe();
  // on, but not used by the person (ADR 0034): who can change that is an administrator – no link, nothing more
  if (moduleNotYours(caps, module))
    return (
      <>
        <PageHeader title={t(`items.${module}.name`)} />
        <EmptyState icon={IconLock} title={t('notYours.title')} testId="module-not-yours">
          {t('notYours.text')}
        </EmptyState>
      </>
    );
  return (
    <>
      <PageHeader title={t(`items.${module}.name`)} />
      <EmptyState
        icon={IconPuzzleOff}
        title={t('off.title')}
        testId="module-off"
        action={
          caps.manageSettings ? (
            <Button component={Link} to="/settings/modules">
              {t('off.open')}
            </Button>
          ) : undefined
        }
      >
        {caps.manageSettings ? t('off.textAdmin') : t('off.text')}
      </EmptyState>
    </>
  );
}

/** The page while its module is on, the "switched off" page otherwise. */
export function ModuleGate({ module, children }: { module: ModuleId; children: ReactNode }) {
  return useModuleOn(module) ? <>{children}</> : <ModuleOffPage module={module} />;
}

/** Only while the module is on (parts of other pages: a tab, a panel, a setting). */
export function IfModule({ module, children }: { module: ModuleId; children: ReactNode }) {
  return useModuleOn(module) ? <>{children}</> : null;
}
