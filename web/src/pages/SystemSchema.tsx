import { Anchor, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { SystemDetail } from '@sm/shared';
import { get } from '../api';
import { DetailState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { SchemaView } from '../components/dbschema/SchemaView';

/** The database schema of a system without a Steward platform (#222): its tbls imports, changes and exports. */
export function SystemSchemaPage() {
  const { t } = useTranslation(['platforms', 'applications']);
  const { id } = useParams();
  const q = useQuery({ queryKey: ['system', id], queryFn: () => get<SystemDetail>(`/systems/${id}`) });
  const s = q.data;
  if (!s) return <DetailState query={q} back="systems" />;
  return (
    <>
      <DetailHeader
        back={['systems', { to: `/systems/${s.id}`, label: s.name }]}
        title={t('schema.pageTitle', { name: s.name })}
        description={t('schema.pageHelp')}
      />
      <SchemaView
        subject={{ kind: 'system', id: s.id, name: s.name }}
        blockedNote={
          s.platform ? (
            <Text size="sm">
              {t('schema.systemIsPlatformLink')}{' '}
              <Anchor component={Link} to={`/platforms/${s.platform.id}?tab=schema`} size="sm">
                {s.platform.name}
              </Anchor>
            </Text>
          ) : undefined
        }
      />
    </>
  );
}
