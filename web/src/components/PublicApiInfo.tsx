import { Anchor, Code, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconExternalLink } from '@tabler/icons-react';
import type { PublicApiStatus } from '@sm/shared';
import { Trans, useTranslation } from 'react-i18next';
import { getOptional } from '../api';
import { appUrl, withBase } from '../basePath';

/** Effective configuration of the public REST API (/api/v1); null on servers without it. */
export function usePublicApi() {
  return useQuery({ queryKey: ['public-api'], queryFn: () => getOptional<PublicApiStatus | null>('/public-api', null), staleTime: 60000 });
}

/** Absolute URL of this Steward (origin + base path) for copy-paste snippets. */
export const origin = () => appUrl();

/** Link to the Swagger UI (only rendered when the documentation is enabled for the current user). */
export function ApiDocsLink({ status }: { status: PublicApiStatus | null | undefined }) {
  const { t } = useTranslation('settings');
  if (!status?.docsUrl) return null;
  return (
    <Anchor href={withBase(status.docsUrl)} target="_blank" rel="noopener" size="sm">
      <Group gap={4} component="span" wrap="nowrap">
        {t('publicApi.docs')} <IconExternalLink size={14} />
      </Group>
    </Anchor>
  );
}

/** Base URL of the REST API plus the documentation link (profile page, settings). */
export function PublicApiInfo({ status }: { status: PublicApiStatus | null | undefined }) {
  const { t } = useTranslation('settings');
  if (!status) return null;
  if (!status.enabled) {
    return (
      <Text size="sm" c="dimmed">
        <Trans t={t} i18nKey="publicApi.off" values={{ path: '/api/v1' }} components={{ c: <Code /> }} />
      </Text>
    );
  }
  return (
    <Group gap="sm" wrap="wrap">
      <Text size="sm">
        <Trans t={t} i18nKey="publicApi.baseUrl" values={{ url: `${origin()}${status.basePath}`, version: status.apiVersion }} components={{ c: <Code /> }} />
      </Text>
      <ApiDocsLink status={status} />
    </Group>
  );
}
