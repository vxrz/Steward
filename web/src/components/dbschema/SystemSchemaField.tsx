import { Anchor, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { DbSchemaOverview, SystemDetail } from '@sm/shared';
import { get } from '../../api';
import { Field } from '../records/common';
import { fmtDate, fmtNumber } from '../../format';
import { dbSchemaKeys } from '../../queryKeys';

/**
 * The database schema of a system (#222) on its page: the newest snapshot of its tbls imports with a link to the
 * schema page, or – for who may change the system – the way to the first import. Systems that are a Steward platform
 * keep their schema there.
 */
export function SystemSchemaField({ system }: { system: SystemDetail }) {
  const { t } = useTranslation('platforms');
  const q = useQuery({ queryKey: dbSchemaKeys.overview('system', system.id), queryFn: () => get<DbSchemaOverview>(`/db-schemas/system/${system.id}`) });
  const o = q.data;
  if (!o || o.importBlocked) return null;
  const latest = o.snapshots[0];
  if (!latest && !o.canImport) return null;
  return (
    <Field label={t('schema.title')}>
      <Anchor component={Link} to={`/systems/${system.id}/schema`} size="sm" data-testid="system-schema-link">
        {latest ? t('schema.fieldLatest', { tables: fmtNumber(latest.tables), when: fmtDate(latest.takenAt) }) : t('schema.fieldImport')}
      </Anchor>
      {latest && latest.breaking > 0 && (
        <Text size="xs" c="red">
          {t('schema.breakingCount', { count: latest.breaking })}
        </Text>
      )}
    </Field>
  );
}
