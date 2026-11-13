import { useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconAlertTriangle, IconKey, IconPencil, IconPlus, IconRefresh, IconRoute, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_LINEAGE_LIMITS as LL,
  type DataLineageSource,
  type DataLineageToken,
  type DataLineageTokenCreated,
  type DataLineageImport,
  type Team,
} from '@sm/shared';
import { del, getOptional, notifyError, notifyOk, post } from '../../../api';
import { BASE_PATH } from '../../../basePath';
import { DetailState, EmptyState, Hint, QueryState } from '../../../components/common';
import { DataTable } from '../../../components/DataTable';
import { DetailPage } from '../../../components/page/DetailPage';
import { TableScroll } from '../../../components/TableScroll';
import { confirmDanger } from '../../../components/confirm';
import { CopyBlock } from '../../../components/monitors/dialogs';
import { codeText } from '../../../i18n/errors';
import { fmtDate, fmtNumber, fmtRelative } from '../../../format';
import { useInvalidateDataProducts } from '../api';
import { Fact, Section } from '../parts';
import { useCanManageModule } from '../rights';
import { lineageKeys, useLineageSource, useLineageSources, useLineageTokens } from './api';
import { LineageSourceForm } from './LineageSourceForm';
import { ProposalInbox } from './ProposalInbox';

const enc = encodeURIComponent;
const to = (s: { id: string }) => `/data-products/lineage/${enc(s.id)}`;
const MB = 1024 * 1024;

/** The address a tool pushes to (absolute: the instance's origin and base path). */
const pushUrl = (s: DataLineageSource) => `${window.location.origin}${BASE_PATH}${s.pushPath}`;

function LastEvent({ s }: { s: DataLineageSource }) {
  const { t } = useTranslation('dataLineage');
  return (
    <Stack gap={2}>
      <Text size="sm" title={s.stats.lastEventAt ? fmtDate(s.stats.lastEventAt) : undefined}>
        {s.stats.lastEventAt ? fmtRelative(s.stats.lastEventAt) : t('never')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('counts', { received: fmtNumber(s.stats.received), refused: fmtNumber(s.stats.refused) })}
      </Text>
    </Stack>
  );
}

function OpenBadge({ s }: { s: DataLineageSource }) {
  const { t } = useTranslation('dataLineage');
  return (
    <Badge size="sm" variant={s.proposals.open ? 'filled' : 'outline'} color={s.proposals.open ? 'blue' : 'gray'} tt="none" data-testid="lineage-open-count">
      {t('openCount', { count: s.proposals.open })}
    </Badge>
  );
}

/**
 * _Lineage from tools_ on the Discovery page (0.24.0): the lineage sources (OpenLineage, dbt) with their last push and
 * open proposals, and the inbox of proposed steps of every source the reader sees – Snowflake discovery sources in
 * account usage mode among them.
 */
export function LineageSection() {
  const { t } = useTranslation(['dataLineage', 'common']);
  const navigate = useNavigate();
  const q = useLineageSources();
  const canManage = useCanManageModule();
  const invalidate = useInvalidateDataProducts();
  const [creating, setCreating] = useState(false);
  const rows = q.data ?? [];
  return (
    <Stack gap="md" mt="lg" data-testid="lineage-section">
      <Section
        title={t('section.title')}
        testId="lineage-sources"
        actions={
          canManage && (
            <Button size="xs" leftSection={<IconRoute size={14} />} onClick={() => setCreating(true)} data-testid="lineage-source-new">
              {t('section.new')}
            </Button>
          )
        }
      >
        <Hint>{t('section.description')}</Hint>
        <QueryState query={q} rows={2} />
        {q.isSuccess && !rows.length && (
          <EmptyState compact icon={IconRoute} title={t('section.emptyTitle')}>
            {t('section.emptyText')} {!canManage && t('section.whoCanAct')}
          </EmptyState>
        )}
        {rows.length > 0 && (
          <DataTable
            testId="lineage-source-table"
            ariaLabel={t('section.title')}
            rows={rows}
            rowKey={(s) => s.id}
            rowHref={to}
            card={(s) => (
              <Paper withBorder p="sm" component="article" aria-labelledby={`lineage-${s.id}`}>
                <Stack gap={6}>
                  <Group justify="space-between" wrap="nowrap">
                    <Anchor id={`lineage-${s.id}`} component={Link} to={to(s)} fw={600}>
                      {s.name}
                    </Anchor>
                    <OpenBadge s={s} />
                  </Group>
                  <Text size="xs" c="dimmed">
                    {[t(`kinds.${s.kind}`), s.platformName, !s.enabled && t('paused')].filter(Boolean).join(' · ')}
                  </Text>
                  <LastEvent s={s} />
                </Stack>
              </Paper>
            )}
            columns={[
              {
                key: 'name',
                header: t('columns.name'),
                sortValue: (s) => s.name,
                cell: (s) => (
                  <Stack gap={0}>
                    <Anchor component={Link} to={to(s)} size="sm" fw={500} onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Anchor>
                    {!s.enabled && (
                      <Text size="xs" c="dimmed">
                        {t('paused')}
                      </Text>
                    )}
                  </Stack>
                ),
              },
              {
                key: 'kind',
                header: t('columns.kind'),
                sortValue: (s) => s.kind,
                cell: (s) => [t(`kinds.${s.kind}`), s.platformName].filter(Boolean).join(' · '),
              },
              { key: 'last', header: t('columns.lastEvent'), sortValue: (s) => s.stats.lastEventAt ?? '', cell: (s) => <LastEvent s={s} /> },
              { key: 'open', header: t('columns.open'), sortValue: (s) => s.proposals.open, cell: (s) => <OpenBadge s={s} /> },
            ]}
          />
        )}
      </Section>
      <Section title={t('proposals.title')} testId="lineage-inbox">
        <Hint>{t('proposals.help')}</Hint>
        <ProposalInbox sources={rows.map((s) => ({ id: s.id, name: s.name }))} />
      </Section>
      {creating && (
        <LineageSourceForm
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            invalidate();
            setCreating(false);
            navigate(to(s));
          }}
        />
      )}
    </Stack>
  );
}

// ---------- push tokens ----------

function configText(s: DataLineageSource, token: string): { label: string; text: string }[] {
  const url = pushUrl(s);
  if (s.kind === 'dbt')
    return [
      {
        label: 'configDbt',
        text: ['manifest', 'run-results']
          .map(
            (f) =>
              `curl -sS -f -X POST '${url}/dbt/${f}' \\\n  -H "Authorization: Bearer ${token}" \\\n  -H 'Content-Type: application/json' \\\n  --data-binary @target/${f === 'manifest' ? 'manifest' : 'run_results'}.json`,
          )
          .join('\n'),
      },
    ];
  return [{ label: 'configOpenlineage', text: `OPENLINEAGE_URL=${url}/\nOPENLINEAGE_ENDPOINT=api/v1/lineage\nOPENLINEAGE_API_KEY=${token}` }];
}

function TokenCreate({ source, onClose, onCreated }: { source: DataLineageSource; onClose: () => void; onCreated: (x: DataLineageTokenCreated) => void }) {
  const { t } = useTranslation(['dataLineage', 'common']);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | undefined>(365);
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [rate, setRate] = useState<number>(LL.rateLimitPerMinute.default);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const submit = async () => {
    setTried(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      onCreated(
        await post<DataLineageTokenCreated>(`/data-products/lineage-sources/${enc(source.id)}/tokens`, {
          name: name.trim(),
          ...(days ? { expiresInDays: days } : {}),
          allowedCidrs: cidrs,
          rateLimitPerMinute: rate,
        }),
      );
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('tokens.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm" data-testid="lineage-token-form">
          <TextInput
            label={t('tokens.name')}
            description={t('tokens.nameHint')}
            required
            maxLength={LL.tokenName}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={tried && !name.trim() ? t('common:validation.required') : undefined}
            data-autofocus
            data-testid="lineage-token-name"
          />
          <NumberInput
            label={t('tokens.expiresIn')}
            description={t('tokens.expiresInHint', { max: LL.expiresInDays })}
            min={1}
            max={LL.expiresInDays}
            value={days ?? ''}
            onChange={(v) => setDays(typeof v === 'number' ? v : undefined)}
          />
          <TagsInput
            label={t('tokens.addresses')}
            description={t('tokens.addressesHint')}
            placeholder="10.20.0.0/16"
            value={cidrs}
            onChange={setCidrs}
            maxTags={LL.cidrs}
          />
          <NumberInput
            label={t('tokens.rate')}
            min={1}
            max={LL.rateLimitPerMinute.max}
            value={rate}
            onChange={(v) => setRate(typeof v === 'number' ? v : LL.rateLimitPerMinute.default)}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="lineage-token-create">
              {t('tokens.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function Tokens({ source }: { source: DataLineageSource }) {
  const { t } = useTranslation(['dataLineage', 'common']);
  const qc = useQueryClient();
  const phone = useMediaQuery('(max-width: 48em)');
  const q = useLineageTokens(source.id, true);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<DataLineageTokenCreated | null>(null);
  const base = `/data-products/lineage-sources/${enc(source.id)}/tokens`;
  const reload = () => qc.invalidateQueries({ queryKey: lineageKeys.tokens(source.id) });
  const rotate = async (x: DataLineageToken) => {
    if (!(await confirmDanger({ action: 'rotate', message: t('tokens.rotateConfirm', { name: x.name }) }))) return;
    try {
      setShown(await post<DataLineageTokenCreated>(`${base}/${enc(x.id)}/rotate`));
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const revoke = async (x: DataLineageToken) => {
    if (!(await confirmDanger({ action: 'revoke', message: t('tokens.revokeConfirm', { name: x.name }) }))) return;
    try {
      await del(`${base}/${enc(x.id)}`);
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = q.data ?? [];
  const expiry = (x: DataLineageToken) =>
    x.expired ? (
      <Badge size="sm" color="red" variant="light" tt="none">
        {t('tokens.expired')}
      </Badge>
    ) : x.expiresAt ? (
      fmtDate(x.expiresAt)
    ) : (
      t('tokens.never')
    );
  const stopped = (x: DataLineageToken) =>
    x.creatorInactive ? (
      <Group gap={4} wrap="nowrap" align="flex-start">
        <IconAlertTriangle size={14} aria-hidden style={{ flex: 'none', marginTop: 2, color: 'var(--mantine-color-orange-text)' }} />
        <Text size="xs" c="orange">
          {t('tokens.creatorInactive')}
        </Text>
      </Group>
    ) : null;
  const used = (x: DataLineageToken) => (x.lastUsedAt ? `${fmtRelative(x.lastUsedAt)}${x.lastUsedIp ? ` · ${x.lastUsedIp}` : ''}` : t('tokens.neverUsed'));
  const actions = (x: DataLineageToken) => (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={t('tokens.rotate')}>
        <ActionIcon variant="subtle" onClick={() => void rotate(x)} aria-label={t('tokens.rotateNamed', { name: x.name })}>
          <IconRefresh size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('tokens.revoke')}>
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={() => void revoke(x)}
          aria-label={t('tokens.revokeNamed', { name: x.name })}
          data-testid="lineage-token-revoke"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
  return (
    <Section
      title={t('tokens.title')}
      testId="lineage-tokens"
      actions={
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="lineage-token-new">
          {t('tokens.new')}
        </Button>
      }
    >
      <Hint>{t('tokens.help')}</Hint>
      <QueryState query={q} rows={1} />
      {q.data && !list.length && (
        <EmptyState compact icon={IconKey} title={t('tokens.empty')}>
          {t('tokens.emptyHint')}
        </EmptyState>
      )}
      {list.length > 0 && phone && (
        <Stack gap="xs">
          {list.map((x) => (
            <Paper key={x.id} withBorder p="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={2} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={500} style={{ wordBreak: 'break-word' }}>
                    {x.name}
                  </Text>
                  {stopped(x)}
                  <Text size="xs" c="dimmed" className="mono">
                    {x.prefix}…
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('tokens.lastUsed')}: {used(x)}
                  </Text>
                  <Text size="xs" c="dimmed" component="div">
                    {t('tokens.expires')}: {expiry(x)}
                  </Text>
                </Stack>
                {actions(x)}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {list.length > 0 && !phone && (
        <TableScroll>
          <Table fz="sm" aria-label={t('tokens.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('tokens.name')}</Table.Th>
                <Table.Th scope="col">{t('tokens.token')}</Table.Th>
                <Table.Th scope="col">{t('tokens.addresses')}</Table.Th>
                <Table.Th scope="col">{t('tokens.lastUsed')}</Table.Th>
                <Table.Th scope="col">{t('tokens.expires')}</Table.Th>
                <Table.Th scope="col">
                  <VisuallyHidden>{t('tokens.actions')}</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((x) => (
                <Table.Tr key={x.id} data-testid="lineage-token">
                  <Table.Td>
                    {x.name}
                    {stopped(x)}
                  </Table.Td>
                  <Table.Td className="mono">{x.prefix}…</Table.Td>
                  <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                    {x.allowedCidrs.join(', ') || t('tokens.anyAddress')}
                  </Table.Td>
                  <Table.Td>{used(x)}</Table.Td>
                  <Table.Td>{expiry(x)}</Table.Td>
                  <Table.Td>{actions(x)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      {creating && (
        <TokenCreate
          source={source}
          onClose={() => setCreating(false)}
          onCreated={(x) => {
            setCreating(false);
            setShown(x);
            void reload();
          }}
        />
      )}
      {shown && (
        // shown once: a stray click beside the dialog must not lose it (as the other secrets' dialogs)
        <Modal opened onClose={() => setShown(null)} size="lg" title={t('tokens.secretTitle', { name: shown.name })} closeOnClickOutside={false}>
          <Stack gap="sm" data-testid="lineage-token-secret">
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
              {t('tokens.secretOnce')}
            </Alert>
            <CopyBlock label={t('tokens.token')} text={shown.token} />
            <Text size="sm" c="dimmed">
              {t('tokens.secretHelp')}
            </Text>
            {configText(source, shown.token).map((c) => (
              <CopyBlock key={c.label} label={t(`tokens.${c.label as 'configDbt'}`)} text={c.text} />
            ))}
            <Group justify="flex-end">
              <Button onClick={() => setShown(null)} data-testid="lineage-token-done">
                {t('tokens.done')}
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Section>
  );
}

// ---------- dbt files ----------

function DbtUpload({ source }: { source: DataLineageSource }) {
  const { t } = useTranslation(['dataLineage', 'common']);
  const invalidate = useInvalidateDataProducts();
  const [busy, setBusy] = useState<'manifest' | 'runResults' | null>(null);
  const resets = { manifest: useRef<() => void>(null), runResults: useRef<() => void>(null) };
  const upload = async (file: 'manifest' | 'runResults', f: File | null) => {
    if (!f) return;
    const max = file === 'manifest' ? LL.manifestBytes : LL.runResultsBytes;
    if (f.size > max) {
      notifyError(new Error(t('dbt.tooLarge', { name: f.name, mb: max / MB })), t('dbt.notUploaded'));
      return;
    }
    setBusy(file);
    try {
      let body: unknown;
      try {
        body = JSON.parse(await f.text()) as unknown;
      } catch {
        throw new Error(t('dbt.notJson', { name: f.name }));
      }
      const path = file === 'manifest' ? 'manifest' : 'run-results';
      await post<DataLineageImport>(`/data-products/lineage-sources/${enc(source.id)}/dbt/${path}`, body);
      notifyOk(t('dbt.uploaded', { file: t(`dbt.files.${file}`) }));
      invalidate();
    } catch (e) {
      notifyError(e, t('dbt.notUploaded'));
    } finally {
      setBusy(null);
      resets[file].current?.();
    }
  };
  const last = source.lastImport;
  return (
    <Section title={t('dbt.title')} testId="lineage-dbt">
      <Hint>{t('dbt.help')}</Hint>
      <Group gap="xs" mt="xs" wrap="wrap">
        {(['manifest', 'runResults'] as const).map((file) => (
          <FileButton key={file} resetRef={resets[file]} accept="application/json,.json" onChange={(f) => void upload(file, f)}>
            {(props) => (
              <Button {...props} size="xs" variant="default" leftSection={<IconUpload size={14} />} loading={busy === file} data-testid={`lineage-dbt-${file}`}>
                {t(`dbt.${file}`)}
              </Button>
            )}
          </FileButton>
        ))}
      </Group>
      {last && (
        <Stack gap={2} mt="sm" data-testid="lineage-last-import">
          <Text size="xs" c="dimmed">
            {t('dbt.lastImport')}
          </Text>
          <Text size="sm">{t('dbt.lastImportLine', { file: t(`dbt.files.${last.file}`), when: fmtRelative(last.at), by: last.by })}</Text>
          <Text size="xs" c="dimmed">
            {Object.entries(last.counts)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${fmtNumber(v)} ${t(`dbt.countKeys.${k as 'nodes'}`, { defaultValue: k })}`)
              .join(' · ')}
          </Text>
        </Stack>
      )}
    </Section>
  );
}

// ---------- the page of a source ----------

/** A lineage source: its settings, push address and tokens, dbt uploads, and its proposals with each job's last run. */
export function LineageSourcePage() {
  const { t } = useTranslation(['dataLineage', 'dataProducts', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const q = useLineageSource(id);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => getOptional<Team[]>('/teams', []) });
  const [editing, setEditing] = useState(false);
  const s = q.data;
  const back = { to: '/data-products/discovery', label: t('dataProducts:discovery.title') };
  if (!s) return <DetailState query={q} back={back} />;
  const canManage = s.permissions.includes('manage');
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('page.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/data-products/lineage-sources/${enc(s.id)}`);
      notifyOk(t('page.deleted'));
      invalidate();
      navigate('/data-products/discovery');
    } catch (e) {
      notifyError(e);
    }
  };
  const lastError = s.stats.lastErrorCode
    ? (codeText(s.stats.lastErrorCode, undefined, s.stats.lastError ?? undefined) ?? s.stats.lastError)
    : s.stats.lastError;
  return (
    <DetailPage
      back={back}
      title={s.name}
      status={
        <Badge variant="light" color={s.enabled ? 'blue' : 'gray'} tt="none">
          {s.enabled ? t(`kinds.${s.kind}`) : t('paused')}
        </Badge>
      }
      description={t(`kindHints.${s.kind}`)}
      actions={
        canManage && (
          <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="lineage-source-edit">
            {t('common:edit')}
          </Button>
        )
      }
      menu={{
        items: canManage ? [{ label: t('page.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'lineage-source-delete' }] : [],
      }}
    >
      <Stack gap="md">
        {lastError && s.stats.lastErrorAt && (
          <Alert color="orange" variant="light" data-testid="lineage-last-error">
            {t('page.lastError', { when: fmtRelative(s.stats.lastErrorAt), error: lastError })}
          </Alert>
        )}
        <Section title={t('page.settings')}>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm">
            <Fact label={t('page.kind')}>{t(`kinds.${s.kind}`)}</Fact>
            {s.kind === 'dbt' && (
              <Fact label={t('page.platform')}>
                {s.platformId && s.platformName ? (
                  <Anchor component={Link} to={`/platforms/${enc(s.platformId)}`} size="sm">
                    {s.platformName}
                  </Anchor>
                ) : (
                  '–'
                )}
              </Fact>
            )}
            <Fact label={t('page.received')}>
              <LastEvent s={s} />
            </Fact>
            <Fact label={t('page.aliases')}>
              {s.namespaceAliases.length ? (
                <Stack gap={0}>
                  {s.namespaceAliases.map((a) => (
                    <Text key={a.from} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {a.from} → {a.to}
                    </Text>
                  ))}
                </Stack>
              ) : (
                t('page.noAliases')
              )}
            </Fact>
            <Fact label={t('page.teams')}>
              {s.teamIds.length ? s.teamIds.map((id) => (teams.data ?? []).find((x) => x.id === id)?.name ?? id).join(', ') : t('page.everyone')}
            </Fact>
            <Fact label={t('page.createdBy')}>
              {s.createdBy} · {fmtDate(s.createdAt)}
            </Fact>
          </SimpleGrid>
          {canManage && (
            <Stack gap={4} mt="md">
              <CopyBlock label={t('page.pushAddress')} text={pushUrl(s)} />
              <Text size="xs" c="dimmed">
                {s.kind === 'dbt' ? t('page.pushHintDbt') : t('page.pushHintOpenlineage')}
              </Text>
            </Stack>
          )}
        </Section>
        {canManage && <Tokens source={s} />}
        {canManage && s.kind === 'dbt' && <DbtUpload source={s} />}
        <Paper withBorder p="md" data-testid="lineage-source-proposals">
          <Title order={2} size="h5" mb="xs">
            {t('proposals.title')}
          </Title>
          <Hint>{t('proposals.help')}</Hint>
          <ProposalInbox sourceId={s.id} />
        </Paper>
      </Stack>
      {editing && (
        <LineageSourceForm
          source={s}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            qc.setQueryData(lineageKeys.source(s.id), x);
            invalidate();
            setEditing(false);
          }}
        />
      )}
    </DetailPage>
  );
}
