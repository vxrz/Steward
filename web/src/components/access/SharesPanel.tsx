import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconShare, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  SHARE_ACTION_RIGHTS,
  SHARE_LEVELS,
  levelIncludes,
  type AccessPreview,
  type OwnedKind,
  type ResourceAccessView,
  type ShareAction,
  type ShareInput,
  type ShareLevel,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { subjectOptionLabel, useSubjectLabel, useSubjects } from '../SubjectsInput';
import { capFirst, fmtDayOnly } from '../../format';

/** One share as the form edits it (end date as a day, empty: none). */
interface Draft {
  subject: string;
  level: ShareLevel;
  actions: ShareAction[];
  until: string;
  known: boolean;
  /** Custom: the exact rights of a migrated access-list entry (kept while the share is left as it is) */
  custom: string[] | null;
}

const toDraft = (v: ResourceAccessView): Draft[] =>
  (v.shares ?? []).map((s) => ({
    subject: s.subject,
    level: s.level,
    actions: [...s.actions],
    until: s.expiresAt ? s.expiresAt.slice(0, 10) : '',
    known: s.known,
    custom: s.rights?.length ? [...s.rights] : null,
  }));
const toInput = (d: Draft[]): ShareInput[] => d.map((s) => ({ subject: s.subject, level: s.level, actions: s.actions, expiresAt: s.until || null }));
const same = (a: Draft[], b: Draft[]) => JSON.stringify(toInput(a)) === JSON.stringify(toInput(b));

export const accessKey = (kind: OwnedKind, id: string) => ['access-shares', kind, id] as const;

/**
 * The shares of an item (ADR 0033, #290): its scope (the whole instance, its owning teams, or Restricted), _Shared
 * with_ – a user, a team or a role with View, Edit or Manage, the kind's action rights and an optional end date – and
 * the shares its owners imply (read-only). Who manages the item changes the list; before saving it says who gains
 * and who loses what, a widening asks for the step-up (the API helper asks and retries). One component for every
 * kind that is switched to shares.
 */
export function SharesPanel({
  kind,
  id,
  onOwningTeams,
}: {
  kind: OwnedKind;
  id: string;
  /** Who may set the owning teams: the way to their field (the panel above), from a scope of the whole instance */
  onOwningTeams?: () => void;
}) {
  const { t } = useTranslation(['access', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: accessKey(kind, id), queryFn: () => get<ResourceAccessView>(`/access/${kind}/${id}/shares`) });
  const v = q.data;
  const [draft, setDraft] = useState<Draft[]>([]);
  const [preview, setPreview] = useState<{ kind: 'shares' | 'scope'; result: AccessPreview; restricted?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (v) setDraft(toDraft(v));
  }, [v]);
  const subjectName = useSubjectLabel();
  // stable for the memoised rows (a long list re-renders only the row that changed); changing a share replaces its
  // Custom rights with its level and action rights
  const update = useCallback(
    (subject: string, change: Partial<Draft>) => setDraft((d) => d.map((s) => (s.subject === subject ? { ...s, ...change, custom: null } : s))),
    [],
  );
  const remove = useCallback((subject: string) => {
    setDraft((d) => d.filter((s) => s.subject !== subject));
    // the button goes with its row: keep the keyboard focus in the panel (WCAG 2.4.3)
    requestAnimationFrame(() => heading.current?.focus());
  }, []);
  // a share just added: its level field takes the focus (WCAG 2.4.3) – the Add button is disabled again
  const [added, setAdded] = useState<string | null>(null);
  const focused = useCallback(() => setAdded(null), []);
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  // the levels the kind offers (a platform and a site: View and Manage; an identity: View with "use")
  const levelData = useMemo(
    () =>
      (v?.levels ?? []).map((l) => ({
        value: l,
        label: t(`owning.level.${l}`),
        disabled: !(v!.held === 'all' || (!!v!.held.level && levelIncludes(v!.held.level, l))),
      })),
    [v, t],
  );

  if (q.isLoading)
    return (
      <Paper withBorder p="md" mb="md">
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm">{t('shares.loading')}</Text>
        </Group>
      </Paper>
    );
  if (q.error || !v)
    return (
      <Alert color="red" mb="md" title={t('shares.title')}>
        {t('shares.loadFailed')}
      </Alert>
    );

  const dirty = !same(draft, toDraft(v));
  const changed = () => {
    void qc.invalidateQueries({ queryKey: accessKey(kind, id) });
    void qc.invalidateQueries({ queryKey: ['access-explain', kind, id] });
    void qc.invalidateQueries({ queryKey: [kind] });
  };
  const done = (saved: ResourceAccessView, message: string) => {
    qc.setQueryData(accessKey(kind, id), saved);
    changed();
    notifyOk(message);
    // focus after saving: the panel's heading, so a screen reader hears where it is
    requestAnimationFrame(() => heading.current?.focus());
  };

  const askSave = async () => {
    setBusy(true);
    try {
      const result = await post<AccessPreview>(`/access/${kind}/${id}/preview`, { shares: toInput(draft) });
      setPreview({ kind: 'shares', result });
    } catch (e) {
      notifyError(e, t('shares.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const askScope = async (restricted: boolean) => {
    setBusy(true);
    try {
      const result = await post<AccessPreview>(`/access/${kind}/${id}/preview`, { restricted });
      setPreview({ kind: 'scope', result, restricted });
    } catch (e) {
      notifyError(e, t('shares.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      if (preview.kind === 'shares') done(await put<ResourceAccessView>(`/access/${kind}/${id}/shares`, { shares: toInput(draft) }), t('shares.saved'));
      else done(await put<ResourceAccessView>(`/access/${kind}/${id}/scope`, { restricted: preview.restricted }), t('shares.scopeSaved'));
      setPreview(null);
    } catch (e) {
      notifyError(e, t('shares.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const held = v.held;
  const mayAction = (a: ShareAction) => held === 'all' || held.actions.includes(a);
  const oneLevel = v.levels.length === 1;
  // an identity's share means nothing without "use": a new one carries it
  const newActions: ShareAction[] = oneLevel ? v.actions.filter(mayAction) : [];
  // an identity is closed by default whatever its scope (ADR 0009): instance roles give nothing on it
  const scopeText =
    v.kind === 'platform_identity'
      ? t('shares.scope.identity')
      : v.scope === 'teams'
        ? t('shares.scope.teams', { teams: v.owningTeams.map((x) => x.name).join(', ') })
        : t(`shares.scope.${v.scope}`);

  return (
    <Paper withBorder p="md" mb="md" data-testid="shares-panel">
      <Stack gap="sm">
        <Group gap={6} wrap="nowrap">
          <IconShare size={18} aria-hidden />
          <Title order={3} size="h5" ref={heading} tabIndex={-1}>
            {t('shares.title')}
          </Title>
        </Group>
        <Text size="sm" data-testid="shares-scope">
          {scopeText}
        </Text>
        {v.kind !== 'platform_identity' && v.scope === 'instance' && onOwningTeams && (
          // the owner field does not scope an item (a team as owner looked like one): who may, gets the way to the teams
          <Group gap="xs" wrap="wrap" data-testid="shares-scope-teams">
            <Text size="sm" c="dimmed">
              {t('shares.scopeToTeams')}
            </Text>
            <Button size="compact-sm" variant="light" onClick={onOwningTeams}>
              {t('shares.setOwningTeams')}
            </Button>
          </Group>
        )}
        {v.canRestrict && v.scope !== 'teams' && (
          <Switch
            label={t('shares.restricted')}
            description={t('shares.restrictedHint')}
            checked={v.restricted}
            disabled={busy}
            onChange={(e) => void askScope(e.currentTarget.checked)}
          />
        )}

        {v.implied.length > 0 && (
          <Stack gap={4} data-testid="shares-implied">
            {v.implied.map((x) => (
              <Group key={`${x.as}:${x.subject}`} gap="xs" wrap="wrap">
                <Text size="sm">{subjectName(x.subject)}</Text>
                <Badge variant="light" color="gray">
                  {t('shares.implied', { level: t(`owning.level.${x.level}`), as: t(`shares.as.${x.as}`) })}
                </Badge>
                {x.outside && (
                  <Badge variant="outline" color="orange">
                    {/* without owning teams there is nothing to be outside of: naming them opened a Restricted item */}
                    {v.owningTeams.length ? t('shares.outside') : t('shares.outsideRestricted')}
                  </Badge>
                )}
              </Group>
            ))}
            {/* the owner field gives these shares – it does not scope the item (owning teams do) */}
            <Text size="sm" c="dimmed" data-testid="shares-implied-hint">
              {v.implied.every((x) => x.as === 'responsible') ? t('shares.impliedHintResponsible') : t('shares.impliedHint')}
            </Text>
          </Stack>
        )}

        {v.shares === null ? (
          <Text size="sm" c="dimmed">
            {t('shares.notYours')}
          </Text>
        ) : (
          <>
            {draft.length === 0 && (
              <Text size="sm" c="dimmed" data-testid="shares-empty">
                {t('shares.empty')}
              </Text>
            )}
            {draft.map((s) => (
              <ShareRow
                key={s.subject}
                share={s}
                name={subjectName(s.subject)}
                view={v}
                levelData={levelData}
                phone={phone}
                focus={added === s.subject}
                onFocused={focused}
                onUpdate={update}
                onRemove={remove}
              />
            ))}
            {v.hidden > 0 && (
              <Text size="sm" c="dimmed" data-testid="shares-hidden">
                {t('shares.hidden', { count: v.hidden })}
              </Text>
            )}
            {v.canManage && (
              <>
                <AddShare
                  restricted={v.restricted}
                  taken={draft.map((s) => s.subject)}
                  levels={levelData}
                  onAdd={(subject, level) => {
                    setDraft((d) => [...d, { subject, level, actions: newActions, until: '', known: true, custom: null }]);
                    setAdded(subject);
                  }}
                />
                <Group gap="xs">
                  <Button onClick={() => void askSave()} disabled={!dirty} loading={busy && !preview}>
                    {t('shares.save')}
                  </Button>
                  <Button variant="default" onClick={() => setDraft(toDraft(v))} disabled={!dirty}>
                    {t('reset')}
                  </Button>
                </Group>
              </>
            )}
          </>
        )}
      </Stack>
      {preview && <PreviewModal preview={preview} busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void apply()} subjectName={subjectName} />}
    </Paper>
  );
}

/** One share of the list (memoised: with a hundred shares, a change re-renders its own row only). */
const ShareRow = memo(function ShareRow({
  share: s,
  name,
  view: v,
  levelData,
  phone,
  focus,
  onFocused,
  onUpdate,
  onRemove,
}: {
  share: Draft;
  name: string;
  view: ResourceAccessView;
  levelData: { value: string; label: string; disabled: boolean }[];
  /** A phone: the row as a card – name and removal on top, the level and end date side by side, the rights below */
  phone: boolean;
  /** Just added: the level field (or its first field) takes the focus */
  focus: boolean;
  onFocused: () => void;
  onUpdate: (subject: string, change: Partial<Draft>) => void;
  onRemove: (subject: string) => void;
}) {
  const { t } = useTranslation(['access', 'common']);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focus) return;
    first.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  const held = v.held;
  const mayAction = (a: ShareAction) => held === 'all' || held.actions.includes(a);
  const rightName = (r: string) => t(`common:permissions.${r}`, { defaultValue: r });
  const oneLevel = v.levels.length === 1;
  const maxDay = v.maxEnd.slice(0, 10);
  const update = (change: Partial<Draft>) => onUpdate(s.subject, change);
  const who = (
    <Stack gap={0} style={{ flex: '1 1 160px', minWidth: 0 }}>
      <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
        {name}
      </Text>
      {!s.known && (
        <Text size="xs" c="orange">
          {t('shares.unknown')}
        </Text>
      )}
      {s.custom && (
        <Text size="xs" c="dimmed" data-testid="share-custom">
          {t('shares.custom', { rights: s.custom.map(rightName).join(', ') })}
        </Text>
      )}
    </Stack>
  );
  const level = !oneLevel && (
    <Select
      ref={first}
      label={t('shares.level')}
      data={levelData}
      // a Custom share has no level of its own: the field says so until one is chosen
      value={s.custom ? null : s.level}
      placeholder={s.custom ? t('shares.customShort') : undefined}
      onChange={(l) => l && update({ level: l as ShareLevel })}
      allowDeselect={false}
      w={phone ? undefined : 140}
      aria-label={t('shares.levelFor', { name })}
    />
  );
  const rights = v.actions.map((a, i) => (
    <Checkbox
      key={a}
      // the first field of an identity's share (it has one level): the focus after adding it
      ref={oneLevel && i === 0 ? first : undefined}
      // a label starts with a capital (the right's name is lower case for running text: "may: view, run")
      label={capFirst(t(`common:permissions.${a}`, { defaultValue: a }))}
      checked={s.actions.includes(a)}
      disabled={!mayAction(a)}
      onChange={(e) => update({ actions: e.currentTarget.checked ? [...s.actions, a] : s.actions.filter((x) => x !== a) })}
    />
  ));
  const until = (
    <TextInput
      type="date"
      label={t('shares.until')}
      aria-label={t('shares.untilFor', { name })}
      value={s.until}
      max={maxDay}
      onChange={(e) => update({ until: e.currentTarget.value })}
      w={phone ? undefined : 170}
    />
  );
  const remove = (
    <ActionIcon variant="subtle" color="red" size="lg" aria-label={t('shares.remove', { name })} onClick={() => onRemove(s.subject)}>
      <IconTrash size={16} />
    </ActionIcon>
  );
  const badge = (
    <Badge variant="light">
      {(s.custom ? [t('shares.customShort')] : [t(`owning.level.${s.level}`), ...s.actions.map(rightName)]).join(', ')}
      {s.until ? ` · ${t('shares.untilShort', { date: fmtDayOnly(s.until) })}` : ''}
    </Badge>
  );
  if (phone)
    return (
      <Paper withBorder p="xs" data-testid="share-row">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          {who}
          {v.canManage && remove}
        </Group>
        {v.canManage ? (
          <Stack gap="xs" mt="xs">
            <SimpleGrid cols={level ? 2 : 1} spacing="xs">
              {level}
              {until}
            </SimpleGrid>
            {rights.length > 0 && (
              <Group gap="md" wrap="wrap">
                {rights}
              </Group>
            )}
          </Stack>
        ) : (
          <Group mt={4}>{badge}</Group>
        )}
      </Paper>
    );
  return (
    <Paper withBorder p="xs" data-testid="share-row">
      <Group gap="sm" wrap="wrap" align="flex-end">
        {who}
        {v.canManage ? (
          <>
            {level}
            {rights}
            {until}
            {remove}
          </>
        ) : (
          badge
        )}
      </Group>
    </Paper>
  );
});

/** Adds a user, a team or – on a Restricted item – everyone with a role (decision 7). */
function AddShare({
  restricted,
  taken,
  levels,
  onAdd,
}: {
  restricted: boolean;
  taken: string[];
  levels: { value: string; label: string; disabled: boolean }[];
  onAdd: (subject: string, level: ShareLevel) => void;
}) {
  const { t } = useTranslation(['access', 'common']);
  const subjects = useSubjects();
  const [subject, setSubject] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const first = (levels.find((l) => !l.disabled)?.value ?? 'view') as ShareLevel;
  const [level, setLevel] = useState<ShareLevel>(first);
  const list = useMemo(
    () =>
      (subjects.data ?? []).filter(
        (s) => (restricted || s.kind !== 'role') && !taken.includes(s.value) && s.value !== 'role:admin' && s.value !== 'role:status',
      ),
    [subjects.data, restricted, taken],
  );
  // without the list (who may not list users and teams): user:<name> or team:<name> typed
  const free = subjects.isSuccess && !(subjects.data ?? []).length;
  const value = free ? typed.trim().toLowerCase() : subject;
  const valid = !!value && /^(user|team|role):.+/.test(value) && !taken.includes(value);
  const groups = (['user', 'team', 'role'] as const)
    .map((k) => ({
      group: t(`common:subjects.groups.${k}`),
      items: list.filter((s) => s.kind === k).map((s) => ({ value: s.value, label: subjectOptionLabel(s) })),
    }))
    .filter((g) => g.items.length);
  return (
    <Group gap="sm" align="flex-end" wrap="wrap">
      {free ? (
        <TextInput
          label={t('shares.add')}
          placeholder={t('addPlaceholder')}
          value={typed}
          onChange={(e) => setTyped(e.currentTarget.value)}
          style={{ flex: '1 1 220px' }}
        />
      ) : (
        <Select
          label={t('shares.add')}
          data={groups}
          value={subject}
          onChange={setSubject}
          searchable
          clearable
          nothingFoundMessage={t('common:subjects.nothingFound')}
          style={{ flex: '1 1 220px' }}
          data-testid="share-subject"
        />
      )}
      {levels.length > 1 && (
        <Select
          label={t('shares.level')}
          data={levels}
          value={level}
          onChange={(l) => l && setLevel(l as ShareLevel)}
          allowDeselect={false}
          w={140}
          aria-label={t('shares.newLevel')}
        />
      )}
      <Button
        variant="light"
        disabled={!valid}
        onClick={() => {
          if (!value) return;
          onAdd(value, level);
          setSubject(null);
          setTyped('');
          setLevel(first);
        }}
      >
        {t('shares.addButton')}
      </Button>
    </Group>
  );
}

/** Who gains and who loses what before the change is saved (a gain asks for the step-up next). */
function PreviewModal({
  preview,
  busy,
  onCancel,
  onConfirm,
  subjectName,
}: {
  preview: { kind: 'shares' | 'scope'; result: AccessPreview };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  subjectName: (s: string) => string;
}) {
  const { t } = useTranslation(['access', 'common']);
  // levels first (View, Edit, Manage), then the action rights and the rest, as the tab lists them
  const ORDER: readonly string[] = [...SHARE_LEVELS, ...SHARE_ACTION_RIGHTS, 'extended', 'shortened', 'roleDefaults'];
  const rights = (r: string[]) =>
    [...r]
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .map((x) =>
        (SHARE_LEVELS as readonly string[]).includes(x)
          ? t(`owning.level.${x as ShareLevel}`)
          : ['extended', 'shortened', 'roleDefaults'].includes(x)
            ? t(`shares.change.${x as 'extended'}`)
            : x.startsWith('custom:')
              ? t('shares.customRight', { right: t(`common:permissions.${x.slice(7)}`, { defaultValue: x.slice(7) }) })
              : t(`common:permissions.${x}`, { defaultValue: x }),
      )
      .join(', ');
  const who = (s: string) => (s === 'scope' ? t('shares.everyoneByRole') : subjectName(s));
  const { gains, losses } = preview.result;
  return (
    <Modal opened onClose={onCancel} title={t('shares.previewTitle')} size="lg">
      <Stack gap="sm" data-testid="shares-preview">
        {!gains.length && !losses.length && <Text size="sm">{t('shares.nothingChanges')}</Text>}
        {gains.length > 0 && (
          <>
            <Text size="sm" fw={600}>
              {t('shares.gains')}
            </Text>
            <List size="sm" spacing={2}>
              {gains.map((g) => (
                <List.Item key={g.subject}>{t('shares.gainLine', { who: who(g.subject), rights: rights(g.rights) })}</List.Item>
              ))}
            </List>
            <Text size="xs" c="dimmed">
              {t('shares.stepUpHint')}
            </Text>
          </>
        )}
        {losses.length > 0 && (
          <>
            <Text size="sm" fw={600}>
              {t('shares.losses')}
            </Text>
            <List size="sm" spacing={2}>
              {losses.map((g) => (
                <List.Item key={g.subject}>{t('shares.lossLine', { who: who(g.subject), rights: rights(g.rights) })}</List.Item>
              ))}
            </List>
          </>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onCancel}>
            {t('common:cancel')}
          </Button>
          <Button onClick={onConfirm} loading={busy} color={losses.length && !gains.length ? 'red' : undefined}>
            {t('shares.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
