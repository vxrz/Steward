import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconFileUpload, IconKey, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  COST_LIMITS,
  COST_PUSH_LIMITS,
  costPushPath,
  type CostImport,
  type CostImportMode,
  type CostImportPreview,
  type CostPushToken,
  type CostPushTokenCreated,
  type CostSourceSettings,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { EmptyState, Hint, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { fmtBytes, fmtDate, fmtDay, fmtRelative } from '../../format';
import { CopyBlock, origin } from '../monitors/dialogs';
import { costKeys } from '../../queryKeys';
import { fmtMoney } from './common';

/**
 * The source of a platform's costs (#226): how a connector reads them (once a day; AI gateways hourly), the FOCUS file
 * import with its preview, the imports so far and the push tokens for CI. Who may manage the platform changes them;
 * whoever may see its costs sees the settings and the imports.
 */
export function PlatformCostSource({ platformId }: { platformId: string }) {
  const q = useQuery({
    queryKey: costKeys.source(platformId),
    queryFn: () => get<CostSourceSettings>(`/costs/platform/${encodeURIComponent(platformId)}/source`),
  });
  const s = q.data;
  return (
    <Stack gap="lg">
      <QueryState query={q} />
      {s && <ConnectorCard s={s} />}
      {s && <ImportCard s={s} />}
      {s?.canManage && <PushTokensCard platformId={platformId} />}
    </Stack>
  );
}

function ConnectorCard({ s }: { s: CostSourceSettings }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(s.enabled);
  const [tagKey, setTagKey] = useState(s.tagKey);
  const [price, setPrice] = useState(s.creditPrice ?? '');
  const [priceCurrency, setPriceCurrency] = useState(s.creditCurrency ?? 'USD');
  const [currency, setCurrency] = useState(s.currency ?? '');
  const [busy, setBusy] = useState<'save' | 'read' | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: costKeys.all });
  const save = async () => {
    setBusy('save');
    try {
      await put(`/costs/platform/${encodeURIComponent(s.platformId)}/source`, {
        enabled,
        tagKey: tagKey.trim() || 'application',
        creditPrice: price.trim() || null,
        creditCurrency: price.trim() ? priceCurrency.trim().toUpperCase() : null,
        currency: currency.trim() ? currency.trim().toUpperCase() : null,
      });
      await reload();
      notifyOk(t('source.saved'));
    } catch (e) {
      notifyError(e, t('source.notSaved'));
    } finally {
      setBusy(null);
    }
  };
  const readNow = async () => {
    setBusy('read');
    try {
      const r = await post<{ error: string | null; lines: number }>(`/costs/platform/${encodeURIComponent(s.platformId)}/read`, {});
      await reload();
      if (r.error) notifyError(new Error(r.error), t('source.readFailed'));
      else notifyOk(t('source.readDone'));
    } catch (e) {
      notifyError(e, t('source.readFailed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Paper withBorder p="md" data-testid="cost-connector">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="sm">
        <div style={{ flex: 1, minWidth: 220 }}>
          <Title order={2} size="h4">
            {t(`source.title.${s.source}`)}
          </Title>
          <Hint>{t(`source.how.${s.source}`)}</Hint>
        </div>
        {s.canManage && s.source !== 'focus' && (
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={readNow} loading={busy === 'read'} data-testid="cost-read-now">
            {t('source.readNow')}
          </Button>
        )}
      </Group>
      <Stack gap="xs" mb="sm">
        <Text size="sm">
          {s.lastReadAt ? t('source.lastRead', { when: fmtDate(s.lastReadAt) }) : t('source.neverRead')}
          {s.lastReadNote ? ` – ${s.lastReadNote}` : ''}
        </Text>
        {s.lastReadError && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="cost-read-error">
            {s.lastReadError}
          </Alert>
        )}
      </Stack>
      <Stack gap="sm">
        {s.source !== 'focus' && (
          <Switch
            label={t('source.enabled')}
            description={t(`source.enabledHint.${s.source}`)}
            checked={enabled}
            disabled={!s.canManage}
            onChange={(e) => setEnabled(e.currentTarget.checked)}
            data-testid="cost-enabled"
          />
        )}
        {(s.source === 'aws' || s.source === 'focus') && (
          <TextInput
            label={t('source.tagKey')}
            description={t('source.tagKeyHint')}
            maw={320}
            disabled={!s.canManage}
            value={tagKey}
            onChange={(e) => setTagKey(e.currentTarget.value)}
          />
        )}
        {s.source === 'snowflake' && (
          <Group align="flex-end" wrap="wrap">
            <TextInput
              label={t('source.creditPrice')}
              description={t('source.creditPriceHint')}
              inputMode="decimal"
              w={220}
              disabled={!s.canManage}
              value={price}
              onChange={(e) => setPrice(e.currentTarget.value)}
            />
            <TextInput
              label={t('source.currency')}
              maxLength={3}
              w={110}
              disabled={!s.canManage}
              value={priceCurrency}
              onChange={(e) => setPriceCurrency(e.currentTarget.value.toUpperCase())}
            />
          </Group>
        )}
        {s.source === 'ai' && (
          <TextInput
            label={t('source.currency')}
            description={t('source.aiCurrencyHint')}
            maxLength={3}
            w={220}
            disabled={!s.canManage}
            value={currency}
            onChange={(e) => setCurrency(e.currentTarget.value.toUpperCase())}
          />
        )}
        {s.canManage && (
          <Group>
            <Button size="xs" onClick={save} loading={busy === 'save'} data-testid="cost-source-save">
              {t('common:save')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function ImportCard({ s }: { s: CostSourceSettings }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const imports = useQuery({
    queryKey: costKeys.imports(s.platformId),
    queryFn: () => get<CostImport[]>(`/costs/platform/${encodeURIComponent(s.platformId)}/imports`),
  });
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<CostImportPreview | null>(null);
  const [mode, setMode] = useState<CostImportMode>('replace');
  const [busy, setBusy] = useState(false);
  const base = `/costs/platform/${encodeURIComponent(s.platformId)}/imports`;
  const choose = async (f: File | null) => {
    if (!f) return;
    if (f.size > COST_LIMITS.importBytes) {
      notifyError(new Error(t('import.tooLarge', { max: fmtBytes(COST_LIMITS.importBytes) })));
      return;
    }
    setBusy(true);
    try {
      const text = await f.text();
      setFile({ name: f.name, text });
      setPreview(await post<CostImportPreview>(`${base}/preview`, { csv: text, fileName: f.name }));
    } catch (e) {
      setFile(null);
      setPreview(null);
      notifyError(e, t('import.notRead'));
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await post<{ inserted: number; replaced: number; corrections: unknown[] }>(base, { csv: file.text, fileName: file.name, mode });
      notifyOk(t('import.done', { lines: r.inserted, replaced: r.replaced }));
      setFile(null);
      setPreview(null);
      await qc.invalidateQueries({ queryKey: costKeys.all });
    } catch (e) {
      notifyError(e, t('import.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder p="md" data-testid="cost-import">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="sm">
        <div style={{ flex: 1, minWidth: 220 }}>
          <Title order={2} size="h4">
            {t('import.title')}
          </Title>
          <Hint>{t('import.help', { max: fmtBytes(COST_LIMITS.importBytes) })}</Hint>
        </div>
        {s.canManage && (
          <FileButton accept=".csv,text/csv" onChange={(f) => void choose(f)}>
            {(props) => (
              <Button {...props} size="xs" leftSection={<IconFileUpload size={14} />} loading={busy && !preview} data-testid="cost-import-choose">
                {t('import.choose')}
              </Button>
            )}
          </FileButton>
        )}
      </Group>
      {preview && file && (
        <Paper withBorder p="sm" mb="md" data-testid="cost-import-preview">
          <Stack gap="xs">
            <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
              {t('import.previewOf', { name: file.name, rows: preview.rows, lines: preview.lines })}
            </Text>
            <Text size="sm">
              {t('import.period', { from: preview.periodStart ? fmtDay(preview.periodStart) : '–', to: preview.periodEnd ? fmtDay(preview.periodEnd) : '–' })}
            </Text>
            <Group gap="xs" wrap="wrap">
              {preview.totals.map((x) => (
                <Badge key={x.currency} variant="light" size="lg" className="viz-num">
                  {fmtMoney(x.effective, x.currency)}
                </Badge>
              ))}
            </Group>
            <Text size="xs" c="dimmed">
              {t('import.mapping', { assigned: preview.assigned, unassigned: preview.unassigned, providers: preview.providers.join(', ') || '–' })}
            </Text>
            {preview.columns.ignored > 0 && (
              <Text size="xs" c="dimmed">
                {t('import.ignored', { count: preview.columns.ignored })}
              </Text>
            )}
            {preview.warnings.map((w, i) => (
              <Text key={i} size="xs" c="orange.8">
                {w}
              </Text>
            ))}
            {preview.duplicateOf && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="cost-import-duplicate">
                {t('import.duplicate', { when: fmtDate(preview.duplicateOf.importedAt) })}
              </Alert>
            )}
            <SegmentedControl
              size="xs"
              aria-label={t('import.mode')}
              value={mode}
              onChange={(v) => setMode(v === 'add' ? 'add' : 'replace')}
              data={[
                { value: 'replace', label: t('import.modes.replace') },
                { value: 'add', label: t('import.modes.add') },
              ]}
            />
            <Text size="xs" c="dimmed">
              {mode === 'replace' ? t('import.replaceHint', { count: preview.replacesLines }) : t('import.addHint')}
            </Text>
            <Group justify="flex-end" gap="xs">
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  setFile(null);
                  setPreview(null);
                }}
              >
                {t('common:cancel')}
              </Button>
              <Button size="xs" onClick={run} loading={busy} disabled={!!preview.duplicateOf || preview.lines === 0} data-testid="cost-import-run">
                {t('import.run')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      <QueryState query={imports} rows={1} />
      {imports.data && !imports.data.length && (
        <EmptyState compact icon={IconFileUpload} title={t('import.none')}>
          {t('import.noneHint')}
        </EmptyState>
      )}
      {imports.data && imports.data.length > 0 && (
        <Table.ScrollContainer minWidth={520}>
          <Table fz="sm" data-testid="cost-imports" aria-label={t('import.list')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('import.file')}</Table.Th>
                <Table.Th>{t('import.periodCol')}</Table.Th>
                <Table.Th>{t('import.linesCol')}</Table.Th>
                <Table.Th>{t('import.by')}</Table.Th>
                <Table.Th>{t('import.when')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {imports.data.map((x) => (
                <Table.Tr key={x.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {x.fileName || t('import.noName')}
                    <Text size="xs" c="dimmed" className="mono" title={x.sha256}>
                      {x.sha256.slice(0, 12)}…
                    </Text>
                  </Table.Td>
                  <Table.Td>{x.periodStart && x.periodEnd ? `${fmtDay(x.periodStart)} – ${fmtDay(x.periodEnd)}` : '–'}</Table.Td>
                  <Table.Td>{t('import.linesOf', { lines: x.lines, rows: x.rows })}</Table.Td>
                  <Table.Td>
                    {x.actor}
                    {x.via === 'push' && (
                      <Badge ml={6} size="xs" variant="light">
                        {t('import.viaPush')}
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{fmtRelative(x.importedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Paper>
  );
}

function PushTokensCard({ platformId }: { platformId: string }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const base = `/costs/platform/${encodeURIComponent(platformId)}/push-tokens`;
  const q = useQuery({ queryKey: costKeys.pushTokens(platformId), queryFn: () => get<CostPushToken[]>(base) });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<CostPushTokenCreated | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: costKeys.pushTokens(platformId) });
  const rotate = async (x: CostPushToken) => {
    if (!(await confirmDanger({ action: 'rotate', message: t('push.rotateConfirm', { name: x.name }) }))) return;
    try {
      setShown(await post<CostPushTokenCreated>(`${base}/${x.id}/rotate`));
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const revoke = async (x: CostPushToken) => {
    if (!(await confirmDanger({ action: 'revoke', message: t('push.revokeConfirm', { name: x.name }) }))) return;
    try {
      await del(`${base}/${x.id}`);
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = q.data ?? [];
  return (
    <Paper withBorder p="md" data-testid="cost-push-tokens">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="sm">
        <div style={{ flex: 1, minWidth: 220 }}>
          <Title order={2} size="h4">
            {t('push.title')}
          </Title>
          <Hint>{t('push.help')}</Hint>
        </div>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="cost-push-new">
          {t('push.new')}
        </Button>
      </Group>
      <QueryState query={q} rows={1} />
      {q.data && !list.length && (
        <EmptyState compact icon={IconKey} title={t('push.empty')}>
          {t('push.emptyHint')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <Table.ScrollContainer minWidth={520}>
          <Table fz="sm" aria-label={t('push.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('push.name')}</Table.Th>
                <Table.Th>{t('push.token')}</Table.Th>
                <Table.Th>{t('push.lastUsed')}</Table.Th>
                <Table.Th>{t('push.expires')}</Table.Th>
                <Table.Th>
                  <VisuallyHidden>{t('push.actions')}</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((x) => (
                <Table.Tr key={x.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    {x.name}
                    {x.creatorInactive && (
                      <Text size="xs" c="orange.8">
                        {t('push.creatorInactive')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td className="mono">{x.prefix}…</Table.Td>
                  <Table.Td>{x.lastUsedAt ? fmtRelative(x.lastUsedAt) : t('push.neverUsed')}</Table.Td>
                  <Table.Td>{x.expired ? t('push.expired') : x.expiresAt ? fmtDay(x.expiresAt) : t('push.never')}</Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <Tooltip label={t('push.rotate')}>
                        <ActionIcon variant="subtle" onClick={() => void rotate(x)} aria-label={t('push.rotateNamed', { name: x.name })}>
                          <IconRefresh size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('push.revoke')}>
                        <ActionIcon variant="subtle" color="red" onClick={() => void revoke(x)} aria-label={t('push.revokeNamed', { name: x.name })}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {creating && (
        <CreateTokenModal
          base={base}
          onClose={() => setCreating(false)}
          onCreated={async (x) => {
            setCreating(false);
            setShown(x);
            await reload();
          }}
        />
      )}
      {shown && <SecretModal platformId={platformId} token={shown} onClose={() => setShown(null)} />}
    </Paper>
  );
}

function CreateTokenModal({ base, onClose, onCreated }: { base: string; onClose: () => void; onCreated: (x: CostPushTokenCreated) => void | Promise<void> }) {
  const { t } = useTranslation(['costs', 'common']);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | undefined>(365);
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const submit = async () => {
    setTried(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreated(await post<CostPushTokenCreated>(base, { name: name.trim(), ...(days ? { expiresInDays: days } : {}), allowedCidrs: cidrs }));
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('push.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('push.name')}
            description={t('push.nameHint')}
            required
            maxLength={COST_PUSH_LIMITS.nameChars}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={tried && !name.trim() ? t('common:validation.required') : undefined}
            data-autofocus
          />
          <NumberInput
            label={t('push.expiresIn')}
            min={1}
            max={COST_PUSH_LIMITS.expiresInDays}
            value={days ?? ''}
            onChange={(v) => setDays(typeof v === 'number' ? v : undefined)}
          />
          <TagsInput label={t('push.addresses')} description={t('push.addressesHint')} value={cidrs} onChange={setCidrs} maxTags={COST_PUSH_LIMITS.cidrs} />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="cost-push-create">
              {t('push.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function SecretModal({ platformId, token, onClose }: { platformId: string; token: CostPushTokenCreated; onClose: () => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const url = `${origin()}${costPushPath(platformId)}`;
  const cmd = `curl -sS -f -X POST '${url}?fileName=focus.csv' \\\n  -H "Authorization: Bearer $STEWARD_COST_TOKEN" \\\n  -H 'Content-Type: text/csv' \\\n  --data-binary @focus.csv`;
  return (
    <Modal opened onClose={onClose} size="lg" title={t('push.secretTitle', { name: token.name })}>
      <Stack gap="sm" data-testid="cost-push-secret">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('push.secretOnce')}
        </Alert>
        <CopyBlock label={t('push.token')} text={token.token} />
        <CopyBlock label={t('push.command')} text={cmd} />
        <Group justify="flex-end">
          <Button onClick={onClose} data-testid="cost-push-done">
            {t('push.done')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
