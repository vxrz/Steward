import { Anchor, Code, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconExternalLink } from '@tabler/icons-react';
import type { PublicApiStatus } from '@sm/shared';
import { getOptional } from '../api';

/** Effective configuration of the public REST API (/api/v1); null on servers without it. */
export function usePublicApi() {
  return useQuery({ queryKey: ['public-api'], queryFn: () => getOptional<PublicApiStatus | null>('/public-api', null), staleTime: 60000 });
}

export const origin = () => (typeof window !== 'undefined' ? window.location.origin : 'http://<host>');

/** Link to the Swagger UI (only rendered when the documentation is enabled for the current user). */
export function ApiDocsLink({ status }: { status: PublicApiStatus | null | undefined }) {
  if (!status?.docsUrl) return null;
  return (
    <Anchor href={status.docsUrl} target="_blank" rel="noopener" size="sm">
      <Group gap={4} component="span" wrap="nowrap">
        API documentation <IconExternalLink size={14} />
      </Group>
    </Anchor>
  );
}

/** Base URL of the REST API plus the documentation link (profile page, settings). */
export function PublicApiInfo({ status }: { status: PublicApiStatus | null | undefined }) {
  if (!status) return null;
  if (!status.enabled) {
    return (
      <Text size="sm" c="dimmed">
        The REST API (<Code>/api/v1</Code>) is turned off on this server.
      </Text>
    );
  }
  return (
    <Group gap="sm" wrap="wrap">
      <Text size="sm">
        REST API base URL: <Code>{`${origin()}${status.basePath}`}</Code> (read-only, OpenAPI 3.1, version {status.apiVersion})
      </Text>
      <ApiDocsLink status={status} />
    </Group>
  );
}
