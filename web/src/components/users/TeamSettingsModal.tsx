import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, Modal, PasswordInput, SegmentedControl, Select, Stack, Switch, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowBackUp, IconSend } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { Team, TeamChannel, TeamSettings } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';

type Draft = Omit<TeamChannel, 'hasUrl'> & { url: string };

/**
 * A team's settings (#136): its own channel for messages about its resources. Without one the team uses the instance
 * channel – shown as the default, with the way back to it when the team overrides it.
 */
export function TeamSettingsModal({ team, onClose }: { team: Team; onClose: () => void }) {
  const { t } = useTranslation(['users', 'common']);
  const qc = useQueryClient();
  const key = ['team-settings', team.id];
  const q = useQuery({ queryKey: key, queryFn: () => get<TeamSettings>(`/teams/${team.id}/settings`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'reset' | 'test' | null>(null);
  const s = q.data;
  useEffect(() => {
    if (s?.channel) setDraft({ enabled: s.channel.enabled, format: s.channel.format, mode: s.channel.mode, url: '' });
  }, [s]);

  const save = async (channel: Draft | null, what: 'save' | 'reset') => {
    setBusy(what);
    try {
      const body = channel
        ? { channel: { enabled: channel.enabled, format: channel.format, mode: channel.mode, ...(channel.url ? { url: channel.url } : {}) } }
        : { channel: null };
      const saved = await put<TeamSettings>(`/teams/${team.id}/settings`, body);
      qc.setQueryData(key, saved);
      if (!saved.channel) setDraft(null);
      notifyOk(what === 'reset' ? t('teamSettings.resetDone') : t('teamSettings.saved'));
    } catch (e) {
      notifyError(e, t('teamSettings.notSaved'));
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await post<{ ok: boolean; error?: string }>(`/teams/${team.id}/settings/test`);
      if (r.ok) notifyOk(t('teamSettings.testSent'));
      else notifyError(new Error(r.error ?? ''), t('teamSettings.testFailed'));
    } finally {
      setBusy(null);
    }
  };

  const overrides = !!s?.channel;
  return (
    <Modal opened onClose={onClose} title={t('teamSettings.title', { name: team.name })} size="lg">
      {s && (
        <Stack>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <div>
              <Title order={3} size="h5">
                {t('teamSettings.channel')}
              </Title>
              <Text size="xs" c="dimmed">
                {t('teamSettings.channelHint')}
              </Text>
            </div>
            <Badge variant="light" color={overrides ? 'grape' : 'gray'} data-testid="team-channel-scope">
              {overrides ? t('teamSettings.overrides') : t('teamSettings.inherited')}
            </Badge>
          </Group>

          {!draft ? (
            <Alert variant="light" color="gray">
              <Text size="sm">
                {s.instance.teamsEnabled || s.instance.webhookEnabled ? t('teamSettings.usesInstance') : t('teamSettings.usesInstanceNone')}
              </Text>
              {s.canChange && (
                <Group mt="xs">
                  <Button size="xs" variant="light" onClick={() => setDraft({ enabled: true, format: 'teams', mode: 'also', url: '' })}>
                    {t('teamSettings.useOwn')}
                  </Button>
                  <Button size="xs" variant="subtle" component={Link} to="/settings/notifications">
                    {t('teamSettings.instanceLink')}
                  </Button>
                </Group>
              )}
            </Alert>
          ) : (
            <Stack gap="sm">
              <Switch
                label={t('teamSettings.enabled')}
                checked={draft.enabled}
                disabled={!s.canChange}
                onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })}
              />
              <Select
                label={t('teamSettings.format')}
                disabled={!s.canChange}
                data={[
                  { value: 'teams', label: t('teamSettings.formats.teams') },
                  { value: 'json', label: t('teamSettings.formats.json') },
                ]}
                value={draft.format}
                allowDeselect={false}
                onChange={(v) => v && setDraft({ ...draft, format: v as Draft['format'] })}
              />
              <PasswordInput
                label={t('teamSettings.url')}
                description={s.channel?.hasUrl ? t('teamSettings.urlStored') : t('teamSettings.urlHint')}
                disabled={!s.canChange}
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.currentTarget.value })}
                autoComplete="off"
              />
              <div>
                <Text size="sm" fw={500} mb={4}>
                  {t('teamSettings.mode')}
                </Text>
                <SegmentedControl
                  fullWidth
                  disabled={!s.canChange}
                  value={draft.mode}
                  onChange={(v) => setDraft({ ...draft, mode: v as Draft['mode'] })}
                  data={[
                    { value: 'also', label: t('teamSettings.modes.also') },
                    { value: 'instead', label: t('teamSettings.modes.instead') },
                  ]}
                />
                <Text size="xs" c="dimmed" mt={4}>
                  {t(`teamSettings.modeHints.${draft.mode}`)}
                </Text>
              </div>
              {s.canChange && (
                <Group justify="space-between">
                  <Button
                    variant="subtle"
                    leftSection={<IconArrowBackUp size={14} />}
                    loading={busy === 'reset'}
                    onClick={() => (overrides ? save(null, 'reset') : setDraft(null))}
                  >
                    {t('teamSettings.backToDefault')}
                  </Button>
                  <Group>
                    {s.channel?.hasUrl && (
                      <Button variant="default" leftSection={<IconSend size={14} />} loading={busy === 'test'} onClick={test}>
                        {t('teamSettings.test')}
                      </Button>
                    )}
                    <Button loading={busy === 'save'} onClick={() => save(draft, 'save')}>
                      {t('common:save')}
                    </Button>
                  </Group>
                </Group>
              )}
            </Stack>
          )}
          {!s.canChange && (
            <Text size="xs" c="dimmed">
              {t('teamSettings.readOnly')}
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}
