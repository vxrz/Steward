import { useEffect, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Anchor, Button, Card, Group, List, Loader, Modal, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconHistory, IconId, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { plantIdPattern, type PlantIdAlias, type PlantIdKind, type PlantReferenceCount, type PlantRenamePreview, type PlantRenameResult } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../../api';
import { confirmDanger } from '../confirm';
import type { DetailMenuItem } from '../page/DetailPage';
import { fmtDate } from '../../format';
import { plantKeys } from '../../queryKeys';

/**
 * Changing the ids of plant entries in the web app (0.11.0, docs/PLANT.md#changing-ids): the "Change id" dialog with
 * live checking and what refers to the entry, the redirect from an old id in the address to the entry's id, the list of
 * old ids in the plant settings, and the texts of counts and problems shared with the bulk changes and the import.
 */

export interface EntryRef {
  kind: PlantIdKind;
  scope?: string;
  id: string;
  name: string;
}

/** "3 assets, 2 links": counts of a preview as text. */
export function useCountsText(): (counts: PlantReferenceCount[]) => string {
  const { t } = useTranslation('plantIds');
  return (counts) => counts.map((c) => t(`what.${c.what as 'other'}`, { count: c.count, defaultValue: t('what.other', { count: c.count }) })).join(', ');
}

/** A problem of the server (code and message) in the reader's language; unknown codes show the server's text. */
export function useProblemText(): (p: { code: string; message: string }, kind?: PlantIdKind) => string {
  const { t } = useTranslation('plantIds');
  return (p, kind) => {
    const code = p.code === 'PLANT_ID_FORMAT' && (kind === 'interface' || kind === 'data_point') ? 'PLANT_ID_FORMAT_NAME' : p.code;
    return t(`problems.${code as 'other'}`, { defaultValue: t('problems.other', { message: p.message }), message: p.message });
  };
}

/** The "Change id" dialog: the new id, checked while it is typed, what follows, and that old links keep working. */
export function ChangeIdModal({ entry, onClose, onRenamed }: { entry: EntryRef; onClose: () => void; onRenamed?: (r: PlantRenameResult) => void }) {
  const { t } = useTranslation(['plantIds', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const countsText = useCountsText();
  const problemText = useProblemText();
  const [value, setValue] = useState(entry.id);
  const [debounced] = useDebouncedValue(value.trim(), 300);
  const [busy, setBusy] = useState(false);
  const body = { kind: entry.kind, scope: entry.scope ?? '', id: entry.id, newId: debounced };
  const formatOk = plantIdPattern(entry.kind).test(value.trim());
  const changed = debounced !== entry.id && !!debounced;
  const preview = useQuery({
    queryKey: ['plant', 'rename-preview', entry.kind, entry.scope ?? '', entry.id, debounced],
    queryFn: () => post<PlantRenamePreview>('/plant/ids/rename/preview', body),
    enabled: changed && plantIdPattern(entry.kind).test(debounced),
    retry: false,
  });
  const p = preview.data && preview.data.newId === debounced ? preview.data : null;
  const typing = value.trim() !== debounced || preview.isFetching;
  const error =
    !formatOk && value.trim() ? problemText({ code: 'PLANT_ID_FORMAT', message: '' }, entry.kind) : p?.problem ? problemText(p.problem, entry.kind) : null;
  const ok = !!p && !p.problem && !typing && formatOk && changed;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post<PlantRenameResult>('/plant/ids/rename', body);
      notifyOk(t('changeId.done', { id: r.newId }));
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      onClose();
      if (onRenamed) onRenamed(r);
      else if (r.path) navigate(r.path, { replace: true });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('changeId.title', { name: entry.name })} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm" data-testid="change-id-dialog">
          <Text size="sm">
            {t('changeId.current')}:{' '}
            <Text span className="mono" size="sm">
              {entry.id}
            </Text>
          </Text>
          <TextInput
            label={t('changeId.newId')}
            description={entry.kind === 'interface' || entry.kind === 'data_point' ? t('changeId.helpName') : t('changeId.help')}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            error={error}
            rightSection={changed && typing && formatOk ? <Loader size="xs" aria-label={t('changeId.checking')} /> : undefined}
            data-autofocus
            required
            data-testid="change-id-input"
            classNames={{ input: 'mono' }}
          />
          {ok && p && (
            <Stack gap={6} data-testid="change-id-preview" aria-live="polite">
              <Title order={3} fz="sm">
                {t('changeId.refers')}
              </Title>
              {p.references.length ? (
                <List size="sm" spacing={2}>
                  {p.references.map((r) => (
                    <List.Item key={r.what}>{countsText([r])}</List.Item>
                  ))}
                </List>
              ) : (
                <Text size="sm" c="dimmed">
                  {t('changeId.nothing')}
                </Text>
              )}
              <Alert color="blue" variant="light" icon={<IconHistory size={16} />} p="xs">
                <Text size="sm">{t('changeId.aliasNote', { ids: p.aliases.join(', ') })}</Text>
              </Alert>
            </Stack>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={!ok} loading={busy} data-testid="change-id-confirm">
              {t('changeId.confirm')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** "Change id" in a detail page's menu (for whoever may change the entry) and its dialog. */
export function useChangeId(entry: EntryRef | null, canManage: boolean): { item: DetailMenuItem | null; modal: ReactNode } {
  const { t } = useTranslation('plantIds');
  const [open, setOpen] = useState(false);
  if (!entry || !canManage) return { item: null, modal: null };
  return {
    item: { label: t('changeId.menu'), icon: IconId, onClick: () => setOpen(true), testId: 'change-id' },
    modal: open ? <ChangeIdModal entry={entry} onClose={() => setOpen(false)} /> : null,
  };
}

/**
 * An address with an old id (a bookmark, an old link): once the entry is loaded under its id, the address is replaced
 * with the entry's id. Pairs of [the id in the address, the entry's id].
 */
export function useAliasRedirect(pairs: [string | undefined, string | undefined][]): void {
  const navigate = useNavigate();
  const location = useLocation();
  const key = JSON.stringify(pairs);
  useEffect(() => {
    let path = location.pathname;
    for (const [inUrl, actual] of pairs) {
      if (!inUrl || !actual || inUrl === actual) continue;
      path = path.replace(`/${encodeURIComponent(inUrl)}`, `/${encodeURIComponent(actual)}`);
    }
    if (path !== location.pathname) navigate(`${path}${location.search}${location.hash}`, { replace: true });
    // pairs is compared by its text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, location.pathname]);
}

/** Settings → Modules → Plant registry: the old ids that still lead to entries, each removable (administrators). */
export function PlantAliasesCard() {
  const { t } = useTranslation(['plantIds', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plant', 'aliases'], queryFn: () => get<PlantIdAlias[]>('/plant/aliases') });
  const list = q.data ?? [];
  const remove = async (a: PlantIdAlias) => {
    if (!(await confirmDanger({ action: 'remove', message: t('aliases.removeConfirm', { id: a.oldId, target: a.newId }) }))) return;
    try {
      await del(`/plant/aliases/${encodeURIComponent(a.kind)}/${encodeURIComponent(a.oldId)}${a.scope ? `?scope=${encodeURIComponent(a.scope)}` : ''}`);
      notifyOk(t('aliases.removed', { id: a.oldId }));
      void qc.invalidateQueries({ queryKey: ['plant', 'aliases'] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder data-testid="plant-aliases">
      <Title order={5} mb={4}>
        {t('aliases.title')}
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        {t('aliases.help')}
      </Text>
      {q.isError && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />}>
          {(q.error as Error).message}
        </Alert>
      )}
      {q.isSuccess && !list.length && (
        <Text size="sm" c="dimmed">
          {t('aliases.empty')}
        </Text>
      )}
      {list.length > 0 && (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={t('aliases.title')}>
          <Table fz="sm" aria-label={t('aliases.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('aliases.kind')}</Table.Th>
                <Table.Th>{t('aliases.old')}</Table.Th>
                <Table.Th>{t('aliases.new')}</Table.Th>
                <Table.Th>{t('aliases.when')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((a) => (
                <Table.Tr key={`${a.kind}|${a.scope}|${a.oldId}`}>
                  <Table.Td>{t(`kinds.${a.kind}`)}</Table.Td>
                  <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {a.scope ? `${a.scope} / ` : ''}
                    {a.oldId}
                  </Table.Td>
                  <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                    {a.path ? (
                      <Anchor component={Link} to={a.path} size="sm">
                        {a.newId}
                      </Anchor>
                    ) : (
                      a.newId
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {fmtDate(a.renamedAt)}
                    <Text size="xs" c="dimmed">
                      {a.renamedBy}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" aria-label={t('aliases.remove', { id: a.oldId })} onClick={() => void remove(a)}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
