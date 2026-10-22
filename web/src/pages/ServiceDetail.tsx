import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { IconArchive, IconArchiveOff, IconEdit, IconExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ServiceDetail } from '@sm/shared';
import { del, get, notifyError, post } from '../api';
import { PageHeader, subjectLabel } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field, LinksPanel } from '../components/records/common';
import { fmtDate } from '../format';
import { errorText } from '../i18n/errors';
import { CriticalityBadge, ServiceFormModal } from './Services';
import { TicketsPanel } from '../components/tickets/TicketsPanel';

export function ServiceDetailPage() {
  const { t } = useTranslation(['services', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['service', id], queryFn: () => get<ServiceDetail>(`/services/${id}`) });
  const [editing, setEditing] = useState(false);
  const refresh = (s?: ServiceDetail) => {
    if (s) qc.setQueryData(['service', id], s);
    else void qc.invalidateQueries({ queryKey: ['service', id] });
    void qc.invalidateQueries({ queryKey: ['services'] });
  };
  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const s = q.data;
  if (!s) return null;
  const archive = async () => {
    if (!s.archived && !confirm(t('archiveConfirm', { name: s.name }))) return;
    try {
      refresh(await post<ServiceDetail>(`/services/${s.id}/archive`, { archived: !s.archived }));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <PageHeader
        back="services"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{s.name}</span>
            <CriticalityBadge value={s.criticality} />
            {s.archived && (
              <Badge variant="outline" color="gray">
                {t('archived')}
              </Badge>
            )}
          </Group>
        }
        description={t('detailLine', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
        actions={
          s.canEdit && (
            <>
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
              <Button size="xs" variant="default" leftSection={s.archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />} onClick={archive}>
                {s.archived ? t('restore') : t('archive')}
              </Button>
            </>
          )
        }
      />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {s.description.trim() ? <MarkdownView text={s.description} /> : <Text c="dimmed">{t('noDescription')}</Text>}
            <LinksPanel
              links={s.links}
              backlinks={s.backlinks}
              canEdit={s.canEdit}
              self={{ kind: 'service', id: s.id }}
              onAdd={async (l) => {
                await post(`/services/${s.id}/links`, l);
                refresh();
              }}
              onRemove={async (lid) => {
                await del(`/services/${s.id}/links/${lid}`);
                refresh();
              }}
            />
            <TicketsPanel kind="service" id={s.id} label={s.name} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('contacts')}>
                {s.contacts.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('noContacts')}
                  </Text>
                ) : (
                  s.contacts.map((c) => (
                    <Text key={`${c.role}${c.email}`} size="sm">
                      {t(`contactRoles.${c.role}`)}:{' '}
                      <Anchor href={`mailto:${c.email}`} size="sm">
                        {c.name ? `${c.name} <${c.email}>` : c.email}
                      </Anchor>
                    </Text>
                  ))
                )}
              </Field>
              <Field label={t('owners')}>
                <Text size="sm">{s.owners.map(subjectLabel).join(', ') || '–'}</Text>
              </Field>
              <Field label={t('cmdb')}>
                {s.cmdb ? (
                  <Text size="sm">
                    {[s.cmdb.system, s.cmdb.id].filter(Boolean).join(' · ')}
                    {s.cmdb.url && (
                      <>
                        {' '}
                        <Anchor href={s.cmdb.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                          {t('openCmdb')} <IconExternalLink size={12} aria-hidden />
                        </Anchor>
                      </>
                    )}
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    {t('noCmdb')}
                  </Text>
                )}
              </Field>
              {s.tags.length > 0 && (
                <Field label={t('tags')}>
                  <Group gap={4}>
                    {s.tags.map((tag) => (
                      <Badge key={tag} size="sm" variant="default">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Field>
              )}
              <Text size="xs" c="dimmed">
                {t('created', { user: s.createdBy, date: fmtDate(s.createdAt) })}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && <ServiceFormModal service={s} onClose={() => setEditing(false)} onSaved={(x) => refresh(x)} />}
    </>
  );
}
