import { useState } from 'react';
import { Alert, Button, Group, List, Select, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { OWNED_KINDS, type OwnedKind, type Team } from '@sm/shared';
import { del, notifyError } from '../../api';
import { FormModal, FormModalCancel } from '../FormModal';

/** What deleting a team would do (GET /api/teams/:id/deletion, server/src/auth/team-deletion.ts). */
export interface TeamDeletionPreview {
  soleOwned: Partial<Record<OwnedKind, number>>;
  soleOwnedTotal: number;
  shared: number;
}

/**
 * Deleting a team that alone owns items (review 0.20.0): the items move to a team the administrator chooses, so that
 * deleting never opens them to the whole instance. A team with members gains access – the server asks for the step-up.
 */
export function TeamDeleteModal({
  team,
  teams,
  preview,
  onClose,
  onDeleted,
}: {
  team: Team;
  teams: Team[];
  preview: TeamDeletionPreview;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation(['users', 'access']);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const others = teams.filter((x) => x.id !== team.id);
  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await del(`/teams/${encodeURIComponent(team.id)}?moveTo=${encodeURIComponent(target)}`);
      onDeleted();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal dirty={!!target} onClose={onClose} title={t('teams.deleteMove.title', { name: team.name })} size="lg">
      <Stack gap="sm">
        <Text size="sm">{t('teams.deleteMove.intro', { name: team.name, count: preview.soleOwnedTotal })}</Text>
        <div>
          <Text size="sm" fw={500}>
            {t('teams.deleteMove.kinds')}
          </Text>
          <List size="sm" data-testid="team-delete-kinds">
            {OWNED_KINDS.filter((k) => preview.soleOwned[k]).map((k) => (
              <List.Item key={k}>
                {t(`access:owning.bulk.kinds.${k}`)}: {preview.soleOwned[k]}
              </List.Item>
            ))}
          </List>
        </div>
        {preview.shared > 0 && (
          <Text size="sm" c="dimmed">
            {t('teams.deleteMove.shared', { count: preview.shared })}
          </Text>
        )}
        {others.length ? (
          <Select
            label={t('teams.deleteMove.target')}
            description={t('teams.deleteMove.targetHint')}
            data={others.map((x) => ({ value: x.id, label: x.name }))}
            value={target}
            onChange={setTarget}
            searchable
            required
            data-testid="team-delete-target"
            comboboxProps={{ withinPortal: true }}
          />
        ) : (
          <Alert color="yellow">{t('teams.deleteMove.noOther')}</Alert>
        )}
        <Group justify="flex-end">
          <FormModalCancel />
          <Button color="red" disabled={!target} loading={busy} onClick={submit} data-testid="team-delete-submit">
            {t('teams.deleteMove.submit')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}
