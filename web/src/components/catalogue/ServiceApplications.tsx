import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { APPLICATION_ROLES, type ApplicationRole, type ApplicationSummary, type ServiceApplication, type ServiceDetail } from '@sm/shared';
import { del, get, notifyError, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { RatingBadges } from './cia';

/** The role of an application in a service, as text. */
export function useRoleLabel() {
  const { t } = useTranslation('applications');
  return (role: ApplicationRole | null, text: string) => (role === 'other' ? text || t('roles.other') : role ? t(`roles.${role}`) : t('roles.none'));
}

/**
 * The applications a service consists of: role, CIA rating and – through them – the Steward platforms they integrate.
 * Service editors add applications, change the role and remove them.
 */
export function ServiceApplicationsPanel({ service, onSaved }: { service: ServiceDetail; onSaved: (s: ServiceDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const roleLabel = useRoleLabel();
  const [editing, setEditing] = useState<ServiceApplication | 'new' | null>(null);
  const remove = async (a: ServiceApplication) => {
    if (!(await confirmDanger({ action: 'remove', message: t('serviceApps.removeConfirm', { name: a.name }) }))) return;
    try {
      onSaved(await del<ServiceDetail>(`/services/${service.id}/applications/${a.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="service-applications">
      <Group justify="space-between">
        <Text fw={600} id="service-applications-title">
          {t('serviceApps.title')}
        </Text>
        {service.canEdit && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('serviceApps.add')}
          </Button>
        )}
      </Group>
      {service.applications.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('serviceApps.empty')}
        </Text>
      ) : (
        <Stack gap="xs" role="list" aria-labelledby="service-applications-title">
          {service.applications.map((a) => (
            <Paper key={a.id} withBorder p="sm" role="listitem">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Anchor component={Link} to={`/applications/${a.id}`} fw={600} size="sm">
                      {a.name}
                    </Anchor>
                    <Badge size="xs" variant="default" tt="none">
                      {roleLabel(a.role, a.roleText)}
                    </Badge>
                    {a.archived && (
                      <Badge size="xs" variant="outline" color="gray">
                        {t('archived')}
                      </Badge>
                    )}
                  </Group>
                  <RatingBadges rating={a.rating} />
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {a.integrations.length === 0 ? (
                      t('serviceApps.noIntegrations')
                    ) : (
                      <>
                        {t('serviceApps.integrations')}
                        {a.integrations.map((i, n) => (
                          <span key={i.platformId ?? `hidden-${n}`}>
                            {n > 0 && ', '}
                            {i.visible && i.path ? (
                              <Anchor component={Link} to={i.path} size="xs">
                                {i.name}
                              </Anchor>
                            ) : (
                              <Text span size="xs" fs="italic">
                                {t('integrations.notVisible')}
                              </Text>
                            )}
                          </span>
                        ))}
                      </>
                    )}
                  </Text>
                </Stack>
                {service.canEdit && (
                  <Group gap={2} wrap="nowrap">
                    <ActionIcon variant="subtle" aria-label={t('serviceApps.editRole', { name: a.name })} onClick={() => setEditing(a)}>
                      <IconEdit size={16} />
                    </ActionIcon>
                    <ActionIcon variant="subtle" color="red" aria-label={t('serviceApps.remove', { name: a.name })} onClick={() => void remove(a)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Group>
                )}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {editing && <ServiceApplicationModal service={service} current={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </Stack>
  );
}

function ServiceApplicationModal({
  service,
  current,
  onClose,
  onSaved,
}: {
  service: ServiceDetail;
  current: ServiceApplication | null;
  onClose: () => void;
  onSaved: (s: ServiceDetail) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const apps = useQuery({ queryKey: ['applications', false], queryFn: () => get<ApplicationSummary[]>('/applications'), enabled: !current });
  const taken = new Set(service.applications.map((a) => a.id));
  const [appId, setAppId] = useState<string | null>(current?.id ?? null);
  const [role, setRole] = useState<string | null>(current?.role ?? null);
  const [roleText, setRoleText] = useState(current?.roleText ?? '');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    app: !appId && t('common:validation.required'),
    roleText: role === 'other' && !roleText.trim() && t('common:validation.required'),
  });
  const save = async () => {
    if (!v.validate() || !appId) return;
    setBusy(true);
    try {
      onSaved(await put<ServiceDetail>(`/services/${service.id}/applications/${appId}`, { role, roleText: role === 'other' ? roleText.trim() : '' }));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={current ? t('serviceApps.editTitle', { name: current.name }) : t('serviceApps.addTitle', { name: service.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {!current && (
            <Select
              label={t('serviceApps.application')}
              data={(apps.data ?? []).filter((a) => !taken.has(a.id)).map((a) => ({ value: a.id, label: a.vendor ? `${a.name} (${a.vendor})` : a.name }))}
              value={appId}
              onChange={setAppId}
              searchable
              required
              nothingFoundMessage={t('noMatch')}
              error={v.error('app')}
              data-autofocus
            />
          )}
          <Select
            label={t('serviceApps.role')}
            placeholder={t('roles.none')}
            data={APPLICATION_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            value={role}
            onChange={setRole}
            clearable
          />
          {role === 'other' && (
            <TextInput
              label={t('serviceApps.roleText')}
              value={roleText}
              onChange={(e) => setRoleText(e.currentTarget.value)}
              maxLength={80}
              required
              error={v.error('roleText')}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
