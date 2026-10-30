import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SYSTEM_LIMITS, type ApplicationDetail, type ApplicationSystemLink, type SystemSummary } from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { confirmDanger } from '../confirm';
import { EnvironmentBadge, EnvironmentInput, sortByEnvironment, useEnvironmentList } from './environments';
import { StackBadges } from './ComponentsPanel';

/**
 * "Runs on" (#129): the systems an application runs on, grouped by environment, next to its platforms. Whoever may
 * edit the application adds, changes and removes them.
 */
export function RunsOnPanel({ app, onSaved }: { app: ApplicationDetail; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const list = useEnvironmentList();
  const [editing, setEditing] = useState<ApplicationSystemLink | 'new' | null>(null);
  const editable = app.canEdit && !app.archived;
  const groups = sortByEnvironment(list, [...new Set(app.systems.map((s) => s.environment))], (x) => x);
  const remove = async (l: ApplicationSystemLink) => {
    if (!(await confirmDanger({ action: 'remove', message: t('runsOn.removeConfirm', { name: l.name, environment: l.environment || t('environments.all') }) })))
      return;
    try {
      onSaved(await del<ApplicationDetail>(`/applications/${app.id}/systems/${l.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="application-runs-on">
      <Group justify="space-between">
        <Text fw={600} id="runs-on-title">
          {t('runsOn.title')}
        </Text>
        {editable && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('runsOn.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('runsOn.help')}
      </Text>
      {app.systems.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('runsOn.empty')}
        </Text>
      ) : (
        <Stack gap="sm" aria-labelledby="runs-on-title">
          {groups.map((env) => (
            <Stack key={env} gap={4} data-testid={`runs-on-${env || 'all'}`}>
              <Group gap={6}>
                <EnvironmentBadge value={env} />
              </Group>
              {app.systems
                .filter((s) => s.environment === env)
                .map((l) => (
                  <Paper key={l.id} withBorder p="xs">
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <Stack gap={4} style={{ minWidth: 0 }}>
                        <Group gap={6}>
                          <Anchor component={Link} to={`/systems/${l.systemId}`} size="sm" fw={500}>
                            {l.name}
                          </Anchor>
                          <Badge size="xs" variant="default">
                            {t(`systems.kinds.${l.kind}`)}
                          </Badge>
                          {l.vendor && (
                            <Text span size="xs" c="dimmed">
                              {l.vendor}
                            </Text>
                          )}
                        </Group>
                        {l.note && (
                          <Text size="xs" c="dimmed">
                            {l.note}
                          </Text>
                        )}
                        <StackBadges stack={l.stack} />
                      </Stack>
                      {editable && (
                        <Group gap={0} wrap="nowrap">
                          <ActionIcon variant="subtle" aria-label={t('runsOn.edit', { name: l.name })} onClick={() => setEditing(l)}>
                            <IconEdit size={16} />
                          </ActionIcon>
                          <ActionIcon variant="subtle" color="red" aria-label={t('runsOn.remove', { name: l.name })} onClick={() => void remove(l)}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Group>
                      )}
                    </Group>
                  </Paper>
                ))}
            </Stack>
          ))}
        </Stack>
      )}
      {editing && <RunsOnModal app={app} link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </Stack>
  );
}

function RunsOnModal({
  app,
  link,
  onClose,
  onSaved,
}: {
  app: ApplicationDetail;
  link: ApplicationSystemLink | null;
  onClose: () => void;
  onSaved: (a: ApplicationDetail) => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems'), enabled: !link });
  const [systemId, setSystemId] = useState<string | null>(link?.systemId ?? null);
  const [environment, setEnvironment] = useState(link?.environment ?? '');
  const [note, setNote] = useState(link?.note ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!systemId) return;
    setBusy(true);
    try {
      const body = { environment: environment.trim(), note: note.trim() };
      onSaved(
        link
          ? await put<ApplicationDetail>(`/applications/${app.id}/systems/${link.id}`, body)
          : await post<ApplicationDetail>(`/applications/${app.id}/systems`, { ...body, systemId }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={link ? t('runsOn.editTitle', { name: link.name }) : t('runsOn.addTitle', { name: app.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {link ? (
            <Text size="sm">{link.name}</Text>
          ) : (
            <Select
              label={t('runsOn.system')}
              description={t('runsOn.systemHint')}
              placeholder={t('runsOn.systemPlaceholder')}
              data={(systems.data ?? []).map((s) => ({ value: s.id, label: s.vendor ? `${s.name} (${s.vendor})` : s.name }))}
              value={systemId}
              onChange={setSystemId}
              searchable
              required
              nothingFoundMessage={t('runsOn.noSystems')}
              data-autofocus
            />
          )}
          <EnvironmentInput value={environment} onChange={setEnvironment} />
          <TextInput label={t('runsOn.note')} maxLength={SYSTEM_LIMITS.linkNote} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!systemId}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
