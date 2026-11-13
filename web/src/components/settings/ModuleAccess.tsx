import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Group, List, Loader, Modal, Radio, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconShieldLock, IconUsers } from '@tabler/icons-react';
import type { ModuleAccessInput, ModuleAccessMode, ModuleAccessPreview, ModuleAccessView, ModuleId } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { MODULE_ACCESS_LIMITS } from '../../../../shared/src/modules';
import { BRAND } from '../../../../shared/src/brand';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { QueryState } from '../common';
import { SubjectsInput, useSubjectLabel } from '../SubjectsInput';
import { visibilityKey } from '../../modules';

export const moduleAccessKey = (id: ModuleId) => ['settings', 'modules', id, 'access'] as const;

const sameList = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** How many names a preview list shows before "and n more". */
const SHOWN = 12;

/**
 * Settings → Modules → Who may use it (0.21.0, ADR 0034): everyone signed in, or selected teams and users. Before
 * saving, the dialog shows who would gain and who would lose the module (and the teams that own items of it but would
 * not use it). Widening asks for the step-up access.grant (the API layer opens the confirmation); narrowing is
 * confirmed here, with the list of who loses it. Administrators and auditors always use every module.
 */
export function ModuleAccessModal({ id, name, onClose, onSaved }: { id: ModuleId; name: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['modules', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: moduleAccessKey(id), queryFn: () => get<ModuleAccessView>(`/settings/modules/${id}/access`) });
  const [mode, setMode] = useState<ModuleAccessMode>('everyone');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = useSubjectLabel();
  useEffect(() => {
    if (!q.data) return;
    setMode(q.data.mode);
    setSubjects(q.data.grants.map((g) => g.subject.toLowerCase()));
  }, [q.data]);

  const saved = useMemo(() => (q.data?.mode === 'selected' ? q.data.grants.map((g) => g.subject.toLowerCase()) : []), [q.data]);
  const body: ModuleAccessInput = { mode, grants: mode === 'selected' ? subjects.map((subject) => ({ subject })) : [] };
  const dirty = !!q.data && (mode !== q.data.mode || (mode === 'selected' && !sameList(subjects, saved)));
  const [draft] = useDebouncedValue(JSON.stringify(body), 300);
  const preview = useQuery({
    queryKey: [...moduleAccessKey(id), 'preview', draft],
    queryFn: () => post<ModuleAccessPreview>(`/settings/modules/${id}/access/preview`, JSON.parse(draft) as ModuleAccessInput),
    enabled: dirty,
    retry: false,
  });
  // the preview of exactly this draft (not of one typed a moment ago)
  const current = dirty && draft === JSON.stringify(body) ? preview.data : undefined;

  const save = async () => {
    if (!current) return;
    // narrowing: confirmed in the dialog, with who loses the module (decision 10); widening: the step-up confirms
    if (!current.widens && !confirming) return setConfirming(true);
    setBusy(true);
    try {
      const next = await put<ModuleAccessView>(`/settings/modules/${id}/access`, body);
      qc.setQueryData(moduleAccessKey(id), next);
      // the sidebar, the pages and the search follow who uses the module
      void qc.invalidateQueries({ queryKey: ['auth'] });
      void qc.invalidateQueries({ queryKey: visibilityKey });
      notifyOk(t('access.saved', { name }));
      onSaved();
    } catch (e) {
      notifyError(e, t('access.notSaved'));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const people = (list: ModuleAccessPreview['gains']) => (
    <List size="sm" spacing={2}>
      {list.slice(0, SHOWN).map((p) => (
        <List.Item key={p.username}>{p.displayName && p.displayName !== p.username ? `${p.displayName} (${p.username})` : p.username}</List.Item>
      ))}
      {list.length > SHOWN && <List.Item>{t('access.more', { count: list.length - SHOWN })}</List.Item>}
    </List>
  );

  return (
    <Modal opened onClose={onClose} title={t('access.title', { name })} size="lg">
      <QueryState query={q} />
      {q.data && !confirming && (
        <Stack gap="sm" data-testid="module-access-dialog">
          <Text size="sm" c="dimmed">
            {t('access.intro', { brand: BRAND.name })}
          </Text>
          <Radio.Group label={t('access.modeLabel')} value={mode} onChange={(v) => setMode(v as ModuleAccessMode)}>
            <Stack gap="xs" mt={6}>
              <Radio
                value="everyone"
                label={t('access.mode.everyone')}
                description={t('access.modeHint.everyone', { brand: BRAND.name })}
                data-testid="module-access-everyone"
              />
              <Radio value="selected" label={t('access.mode.selected')} description={t('access.modeHint.selected')} data-testid="module-access-selected" />
            </Stack>
          </Radio.Group>
          {mode === 'selected' && (
            <SubjectsInput
              label={t('access.subjects')}
              description={t('access.subjectsHint')}
              value={subjects}
              onChange={setSubjects}
              max={MODULE_ACCESS_LIMITS.grants}
            />
          )}
          {q.data.grants.some((g) => !g.known) && mode === 'selected' && (
            <Text size="xs" c="dimmed">
              {t('access.unknownHint')}
            </Text>
          )}
          <div aria-live="polite" data-testid="module-access-preview">
            {!dirty ? (
              <Text size="sm" c="dimmed">
                {q.data.mode === 'selected'
                  ? q.data.grants.length
                    ? t('access.now.selected', { subjects: q.data.grants.map((g) => label(g.subject)).join(', ') })
                    : t('access.now.nobody')
                  : t('access.now.everyone')}
              </Text>
            ) : !current ? (
              preview.error ? (
                <Text size="sm" c="red">
                  {t('access.previewFailed')}
                </Text>
              ) : (
                <Group gap="xs">
                  <Loader size="xs" />
                  <Text size="sm" c="dimmed">
                    {t('access.previewing')}
                  </Text>
                </Group>
              )
            ) : (
              <Stack gap="xs">
                <Text size="sm" fw={600}>
                  {t('access.previewTitle')}
                </Text>
                {!current.gains.length && !current.loses.length && <Text size="sm">{t('access.nobodyChanges')}</Text>}
                {current.gains.length > 0 && (
                  <div data-testid="module-access-gains">
                    <Text size="sm">{t('access.gains', { count: current.gains.length })}</Text>
                    {people(current.gains)}
                  </div>
                )}
                {current.loses.length > 0 && (
                  <div data-testid="module-access-loses">
                    <Text size="sm">{t('access.loses', { count: current.loses.length })}</Text>
                    {people(current.loses)}
                  </div>
                )}
                {current.owningTeamsWithout.length > 0 && (
                  <Alert color="orange" variant="light" p="xs" icon={<IconAlertTriangle size={16} />} data-testid="module-access-owning">
                    {t('access.owningTeamsWithout', { teams: current.owningTeamsWithout.join(', ') })}
                  </Alert>
                )}
                {current.widens && (
                  <Text size="xs" c="dimmed">
                    <IconShieldLock size={12} aria-hidden /> {t('access.widensHint')}
                  </Text>
                )}
              </Stack>
            )}
          </div>
          <Group justify="flex-end" wrap="wrap">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => void save()} loading={busy} disabled={!dirty || !current} data-testid="module-access-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      )}
      {q.data && confirming && current && (
        <Stack gap="sm" data-testid="module-access-confirm">
          <Alert color="orange" variant="light" icon={<IconUsers size={16} />} title={t('access.confirmTitle', { name })}>
            {current.loses.length ? t('access.confirmLoses', { count: current.loses.length }) : t('access.confirmNobody')}
          </Alert>
          {current.loses.length > 0 && people(current.loses)}
          <Group justify="flex-end" wrap="wrap">
            <Button variant="default" onClick={() => setConfirming(false)}>
              {t('common:back')}
            </Button>
            <Button color="orange" onClick={() => void save()} loading={busy} data-testid="module-access-confirm-save">
              {t('access.confirm')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/** The access of a module in its row: everyone signed in, or selected teams and users. */
export function ModuleAccessBadge({ mode }: { mode: ModuleAccessMode }) {
  const { t } = useTranslation('modules');
  return (
    <Badge
      size="sm"
      variant="light"
      color={mode === 'selected' ? 'grape' : 'gray'}
      leftSection={mode === 'selected' ? <IconShieldLock size={11} aria-hidden /> : null}
    >
      {t(`access.mode.${mode}`)}
    </Badge>
  );
}
