import { useState } from 'react';
import { ActionIcon, Anchor, Button, Group, Paper, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconFolders, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataDomain } from '@sm/shared';
import { del, notifyError } from '../../api';
import { QueryState } from '../../components/common';
import { ListPage } from '../../components/page/ListPage';
import { confirmDanger } from '../../components/confirm';
import { useSubjectLabel } from '../../components/SubjectsInput';
import { ColorSwatchDot, DomainForm } from '../../components/dataproducts/ObjectForm';
import { useDomains, useInvalidateDataProducts } from './api';
import { useCanManageModule } from './rights';

/**
 * The domains of the data products (ADR 0036 parts 1 and 12, decision 33): two levels – a domain and its sub-domains –
 * with owners and owning teams; the module's managers keep them. A domain's products and data objects are a click away.
 */
export function DataDomainsPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const q = useDomains();
  const canManage = useCanManageModule();
  const invalidate = useInvalidateDataProducts();
  const subject = useSubjectLabel();
  const [editing, setEditing] = useState<{ domain?: DataDomain } | null>(null);
  const all = q.data ?? [];
  const top = all.filter((d) => !d.parentId || !all.some((x) => x.id === d.parentId)).sort((a, b) => a.name.localeCompare(b.name));
  const subs = (id: string) => all.filter((d) => d.parentId === id).sort((a, b) => a.name.localeCompare(b.name));
  const remove = async (d: DataDomain) => {
    if (!(await confirmDanger({ action: 'delete', message: t('domains.deleteConfirm', { name: d.name }) }))) return;
    try {
      await del(`/data-domains/${encodeURIComponent(d.id)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const none = q.isSuccess && all.length === 0;
  const card = (d: DataDomain, sub = false) => (
    <Paper key={d.id} withBorder p="sm" component="article" aria-labelledby={`domain-${d.id}`} data-testid={`domain-${d.key}`} ml={sub ? 'lg' : 0}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Group gap="xs" wrap="nowrap">
            {d.colour && <ColorSwatchDot colour={d.colour} />}
            <Text fw={600} id={`domain-${d.id}`} style={{ overflowWrap: 'anywhere' }}>
              {d.name}
            </Text>
            <Text size="xs" c="dimmed" className="mono">
              {d.key}
            </Text>
          </Group>
          {d.description && (
            <Text size="sm" c="dimmed" lineClamp={2}>
              {d.description}
            </Text>
          )}
          <Group gap="md">
            <Anchor component={Link} to={`/data-products?domain=${encodeURIComponent(d.id)}`} size="sm">
              {t('domains.products', { count: d.products })}
            </Anchor>
            <Anchor component={Link} to={`/data-objects?domain=${encodeURIComponent(d.id)}`} size="sm">
              {t('domains.objects', { count: d.objects })}
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            {[
              d.owners.length ? t('domains.ownersLine', { owners: d.owners.map(subject).join(', ') }) : '',
              d.owningTeams.length ? t('domains.teamsLine', { teams: d.owningTeams.map((x) => x.name).join(', ') }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Stack>
        {d.permissions.includes('edit') && (
          <Group gap={2} wrap="nowrap">
            <Tooltip label={t('common:edit')}>
              <ActionIcon variant="subtle" color="gray" aria-label={t('domains.editNamed', { name: d.name })} onClick={() => setEditing({ domain: d })}>
                <IconPencil size={16} />
              </ActionIcon>
            </Tooltip>
            {d.permissions.includes('manage') && (
              <Tooltip label={t('common:delete')}>
                <ActionIcon variant="subtle" color="red" aria-label={t('domains.deleteNamed', { name: d.name })} onClick={() => void remove(d)}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        )}
      </Group>
    </Paper>
  );
  return (
    <ListPage
      testId="data-domains"
      title={t('domains.title')}
      description={t('domains.description')}
      primaryAction={
        canManage && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="domain-new">
            {t('domains.new')}
          </Button>
        )
      }
      empty={{
        show: none,
        icon: IconFolders,
        title: t('domains.emptyTitle'),
        text: t('domains.emptyText'),
        whoCanAct: canManage ? undefined : t('domains.whoCanAct'),
        action: canManage && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({})}>
            {t('domains.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={q} />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        {top.map((d) => (
          <Stack key={d.id} gap="xs">
            {card(d)}
            {subs(d.id).map((s) => card(s, true))}
          </Stack>
        ))}
      </SimpleGrid>
      {editing && (
        <DomainForm
          domain={editing.domain}
          domains={all}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      )}
    </ListPage>
  );
}
