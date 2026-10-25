import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Collapse,
  CopyButton,
  FileInput,
  Group,
  List,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronDown, IconChevronRight, IconFileExport, IconFileImport, IconHistory } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type {
  ImportedHistoryEntry,
  ImportResult,
  InstanceImport,
  MigrationPlan,
  MigrationPlanTeam,
  MigrationPlanUser,
  TeamDecision,
  UserAction,
  UserDecision,
} from '@sm/shared';
import { MIGRATION_FINGERPRINT_MIN_CHARS, normalizeFingerprint } from '@sm/shared';
import { ApiError, api, apiUrl, del, get, notifyError, notifyOk, post } from '../api';
import { PageHeader, QueryState } from '../components/common';
import { useMe } from '../auth';
import { fmtBytes, fmtDate, fmtNumber } from '../format';

const MIN_TRANSFER = 12;

/** Settings → Migration: move this instance to another one (export), or bring one in (import with an identity mapping). */
export function MigrationPage() {
  const { t } = useTranslation('settings');
  const { isAdmin } = useMe();
  if (!isAdmin) return <PageHeader back="settings" title={t('migration.title')} description={t('migration.adminsOnly')} />;
  return (
    <>
      <PageHeader back="settings" title={t('migration.title')} description={t('migration.intro')} />
      <Stack maw={960}>
        <ExportCard />
        <ImportCard />
        <ImportsList />
      </Stack>
    </>
  );
}

interface ExportResult {
  downloadId: string;
  filename: string;
  sha256: string;
  size: number;
  fingerprint: string;
  tables: number;
  rows: number;
  files: number;
  auditEntries: number;
  undecryptable: number;
}

function ExportCard() {
  const { t } = useTranslation(['settings', 'common']);
  const [passphrase, setPassphrase] = useState('');
  const [transfer, setTransfer] = useState('');
  const [transfer2, setTransfer2] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  const problem =
    transfer && transfer.length < MIN_TRANSFER
      ? t('migration.export.tooShort', { count: MIN_TRANSFER })
      : transfer2 && transfer !== transfer2
        ? t('migration.export.differ')
        : null;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<ExportResult>('/migration/export', { passphrase, transferPassphrase: transfer });
      setResult(r);
      setPassphrase('');
      notifyOk(t('migration.export.done'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconFileExport size={18} aria-hidden />
        <Title order={5}>{t('migration.export.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('migration.export.intro')}
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <PasswordInput
            label={t('migration.export.passphrase')}
            description={t('migration.export.passphraseHint')}
            required
            value={passphrase}
            onChange={(e) => setPassphrase(e.currentTarget.value)}
            autoComplete="off"
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <PasswordInput
              label={t('migration.export.transfer')}
              description={t('migration.export.transferHint', { count: MIN_TRANSFER })}
              required
              value={transfer}
              onChange={(e) => setTransfer(e.currentTarget.value)}
              autoComplete="new-password"
            />
            <PasswordInput
              label={t('migration.export.transferRepeat')}
              required
              value={transfer2}
              onChange={(e) => setTransfer2(e.currentTarget.value)}
              autoComplete="new-password"
              error={problem}
            />
          </SimpleGrid>
          <Group>
            <Button type="submit" loading={busy} disabled={!passphrase || transfer.length < MIN_TRANSFER || transfer !== transfer2}>
              {t('migration.export.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
      {result && (
        <Alert color="green" variant="light" mt="md" title={t('migration.export.readyTitle')} data-testid="export-result">
          <Stack gap="xs">
            <Text size="sm">
              {t('migration.export.ready', {
                rows: fmtNumber(result.rows),
                tables: fmtNumber(result.tables),
                files: fmtNumber(result.files),
                entries: fmtNumber(result.auditEntries),
                size: fmtBytes(result.size),
              })}
            </Text>
            <Text size="sm">
              {t('migration.fingerprint')}: <Code>{result.fingerprint}</Code>
            </Text>
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              SHA-256: <Code>{result.sha256}</Code>
            </Text>
            {result.undecryptable > 0 && (
              <Text size="sm" c="orange">
                {t('migration.export.undecryptable', { count: result.undecryptable })}
              </Text>
            )}
            <Group>
              <Button
                component="a"
                href={apiUrl(`/migration/exports/${encodeURIComponent(result.downloadId)}/download`)}
                download={result.filename}
                variant="light"
              >
                {t('migration.export.download', { name: result.filename })}
              </Button>
            </Group>
            <Text size="sm" c="dimmed">
              {t('migration.export.once')}
            </Text>
          </Stack>
        </Alert>
      )}
    </Card>
  );
}

// ---------- import ----------

type Decisions = { users: Record<string, UserDecision>; teams: Record<string, TeamDecision> };

const initialDecisions = (p: MigrationPlan): Decisions => ({
  users: Object.fromEntries(p.users.map((u) => [u.username, u.suggestion])),
  teams: Object.fromEntries(p.teams.map((tm) => [tm.name, tm.suggestion])),
});

function ImportCard() {
  const { t } = useTranslation(['settings', 'common']);
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [transfer, setTransfer] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [decisions, setDecisions] = useState<Decisions | null>(null);
  const [fingerprint, setFingerprint] = useState('');
  const fingerprintOk = /^[0-9a-f]*$/.test(normalizeFingerprint(fingerprint)) && normalizeFingerprint(fingerprint).length >= MIGRATION_FINGERPRINT_MIN_CHARS;
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);

  const check = async () => {
    if (!file) return;
    setBusy(true);
    setProblems([]);
    try {
      const form = new FormData();
      form.append('transferPassphrase', transfer);
      form.append('file', file);
      const p = await api<MigrationPlan>('POST', '/migration/imports/upload', form);
      setPlan(p);
      setDecisions(initialDecisions(p));
      setFingerprint('');
      setResult(null);
      setTransfer('');
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (plan?.id) await del(`/migration/imports/staged/${encodeURIComponent(plan.id)}`).catch(() => undefined);
    setPlan(null);
    setDecisions(null);
    setProblems([]);
  };
  const apply = async () => {
    if (!plan?.id || !decisions) return;
    setBusy(true);
    setProblems([]);
    try {
      const r = await post<ImportResult>(`/migration/imports/staged/${encodeURIComponent(plan.id)}/apply`, {
        mapping: decisions,
        confirmFingerprint: fingerprint,
      });
      setResult(r);
      setPlan(null);
      setDecisions(null);
      setFile(null);
      notifyOk(t('migration.import.done'));
      void qc.invalidateQueries();
    } catch (e) {
      const list = e instanceof ApiError ? (e.params as { problems?: unknown } | undefined)?.problems : undefined;
      if (Array.isArray(list)) setProblems(list.map(String));
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder>
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconFileImport size={18} aria-hidden />
        <Title order={5}>{t('migration.import.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('migration.import.intro')}
      </Text>
      {result && <ImportDone result={result} />}
      {!plan ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <Stack gap="sm">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <FileInput
                label={t('migration.import.file')}
                placeholder={t('migration.import.filePlaceholder')}
                accept=".smig,application/octet-stream"
                value={file}
                onChange={setFile}
                clearable
                required
              />
              <PasswordInput
                label={t('migration.export.transfer')}
                required
                value={transfer}
                onChange={(e) => setTransfer(e.currentTarget.value)}
                autoComplete="off"
              />
            </SimpleGrid>
            <Group>
              <Button type="submit" loading={busy} disabled={!file || !transfer}>
                {t('migration.import.check')}
              </Button>
            </Group>
          </Stack>
        </form>
      ) : (
        <Stack gap="md">
          <PlanSummary plan={plan} />
          {decisions && plan.blocking.length === 0 && (
            <>
              <MappingEditor plan={plan} decisions={decisions} onChange={setDecisions} />
              <Paper withBorder p="sm">
                <Stack gap="xs">
                  <TextInput
                    label={t('migration.import.fingerprintLabel')}
                    description={t('migration.import.fingerprintHint', { min: MIGRATION_FINGERPRINT_MIN_CHARS })}
                    placeholder="1a2b:3c4d:5e6f:7a8b:…"
                    value={fingerprint}
                    onChange={(e) => setFingerprint(e.currentTarget.value)}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={100}
                    classNames={{ input: 'mono' }}
                    data-testid="source-fingerprint"
                  />
                </Stack>
              </Paper>
            </>
          )}
          {problems.length > 0 && (
            <Alert color="red" variant="light" title={t('migration.import.problems')}>
              <List size="sm">
                {problems.map((p) => (
                  <List.Item key={p}>{p}</List.Item>
                ))}
              </List>
            </Alert>
          )}
          <Group>
            {plan.blocking.length === 0 && (
              <Button onClick={() => void apply()} loading={busy} disabled={!fingerprintOk}>
                {t('migration.import.submit')}
              </Button>
            )}
            <Button variant="default" onClick={() => void discard()} disabled={busy}>
              {t('migration.import.discard')}
            </Button>
          </Group>
        </Stack>
      )}
    </Card>
  );
}

function PlanSummary({ plan }: { plan: MigrationPlan }) {
  const { t } = useTranslation('settings');
  const [more, setMore] = useState(false);
  const rows = plan.counts.reduce((s, c) => s + c.rows, 0);
  return (
    <Stack gap="xs" data-testid="migration-plan">
      <Title order={6}>{t('migration.plan.title')}</Title>
      {plan.blocking.map((b) => (
        <Alert key={b} color="red" variant="light">
          {b}
        </Alert>
      ))}
      <Text size="sm">
        {t('migration.plan.source', {
          version: plan.source.version,
          at: fmtDate(plan.source.exportedAt),
          by: plan.source.exportedBy,
          db: plan.source.database === 'postgres' ? 'PostgreSQL' : 'SQLite',
        })}
      </Text>
      <Text size="sm">
        {t('migration.plan.content', {
          rows: fmtNumber(rows),
          tables: fmtNumber(plan.counts.length),
          files: fmtNumber(plan.files.count),
          size: fmtBytes(plan.files.bytes),
        })}
        {plan.schema.migrationsToApply > 0 ? ` ${t('migration.plan.migrations', { count: plan.schema.migrationsToApply })}` : ''}
      </Text>
      <Group gap="xs">
        <Badge color={plan.history.ok ? 'green' : 'red'} variant="light">
          {plan.history.ok ? t('migration.plan.historyOk') : t('migration.plan.historyBad')}
        </Badge>
        <Text size="sm">{plan.history.message}</Text>
      </Group>
      {plan.paused.length > 0 && (
        <Text size="sm">{t('migration.plan.paused', { list: plan.paused.map((p) => `${fmtNumber(p.count)} ${p.label}`).join(', ') })}</Text>
      )}
      {plan.warnings.map((w) => (
        <Alert key={w} color="orange" variant="light" p="xs">
          {w}
        </Alert>
      ))}
      <UnstyledButton onClick={() => setMore((v) => !v)} aria-expanded={more}>
        <Group gap={4} wrap="nowrap">
          {more ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text size="sm" c="dimmed">
            {t('migration.plan.details')}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse in={more}>
        <Stack gap="xs">
          <Text size="sm">
            {t('migration.plan.notApplied')}: {plan.settings.notApplied.join(', ') || '–'}
          </Text>
          <List size="sm">
            {plan.notMoved.map((n) => (
              <List.Item key={n.what}>
                <Code>{n.what}</Code> – {n.why}
              </List.Item>
            ))}
          </List>
        </Stack>
      </Collapse>
    </Stack>
  );
}

const USER_ACTIONS: UserAction[] = ['map', 'create-sso', 'create-local', 'archive'];

const low = (s: string) => s.trim().toLowerCase();
const before = (s: string) => low(s).split('@')[0]!;
/** Same rule as the server (migration/import.ts guessedMatch): a match by e-mail or local part needs a confirmation. */
function guessedMatch(u: { username: string; email: string | null }, t: { username: string; email: string | null }): boolean {
  if (low(t.username) === low(u.username)) return false;
  return (
    (!!u.email && !!t.email && low(t.email) === low(u.email)) ||
    before(t.username) === before(u.username) ||
    (!!t.email && before(t.email) === before(u.username))
  );
}

function MappingEditor({ plan, decisions, onChange }: { plan: MigrationPlan; decisions: Decisions; onChange: (d: Decisions) => void }) {
  const { t } = useTranslation('settings');
  const setUser = (name: string, d: UserDecision) => onChange({ ...decisions, users: { ...decisions.users, [name]: d } });
  const setTeam = (name: string, d: TeamDecision) => onChange({ ...decisions, teams: { ...decisions.teams, [name]: d } });
  return (
    <Stack gap="sm">
      <Title order={6}>{t('migration.mapping.users')}</Title>
      <Text size="sm" c="dimmed">
        {t('migration.mapping.usersHint')}
      </Text>
      {plan.users.map((u) => (
        <UserRow key={u.username} user={u} plan={plan} decision={decisions.users[u.username]!} onChange={(d) => setUser(u.username, d)} />
      ))}
      {plan.teams.length > 0 && (
        <>
          <Title order={6}>{t('migration.mapping.teams')}</Title>
          {plan.teams.map((tm) => (
            <TeamRow key={tm.name} team={tm} plan={plan} decision={decisions.teams[tm.name]!} onChange={(d) => setTeam(tm.name, d)} />
          ))}
        </>
      )}
    </Stack>
  );
}

function UserRow({
  user,
  plan,
  decision,
  onChange,
}: {
  user: MigrationPlanUser;
  plan: MigrationPlan;
  decision: UserDecision;
  onChange: (d: UserDecision) => void;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const mappedTo = decision.action === 'map' ? plan.targetUsers.find((x) => x.username === decision.to) : undefined;
  const targetAdmin = !!mappedTo?.roles.includes('admin');
  // a match by e-mail address or by the name before "@" is a guess (the server asks for the same confirmation)
  const guessed = !!mappedTo && guessedMatch(user, mappedTo);
  const needsConfirm = user.roles.includes('admin') || targetAdmin || guessed;
  const change = (action: UserAction) => {
    const keep = decision.confirm;
    if (action === 'map') onChange({ action, to: plan.targetUsers.find((x) => x.active)?.username ?? '', confirm: keep });
    else if (action === 'create-sso')
      onChange({
        action,
        username: (user.email ?? user.username).toLowerCase(),
        ...(plan.providers.length === 1 ? { provider: plan.providers[0]!.id } : {}),
        confirm: keep,
      });
    else onChange({ action, confirm: keep });
  };
  const target =
    decision.action === 'map'
      ? decision.to
      : decision.action === 'create-sso'
        ? decision.username
        : ('username' in decision && decision.username) || user.username;
  return (
    <Paper withBorder p="sm" data-testid={`map-user-${user.username}`}>
      <Stack gap="xs">
        <Group gap="xs" wrap="wrap">
          <Text fw={600} size="sm">
            {user.username}
          </Text>
          <Text size="sm" c="dimmed">
            {user.displayName}
          </Text>
          <Badge variant="light" size="sm">
            {user.kind === 'sso' ? `SSO${user.provider ? ` · ${user.provider}` : ''}` : t('migration.mapping.local')}
          </Badge>
          {user.roles.map((r) => (
            <Badge key={r} variant="outline" size="sm" color={r === 'admin' ? 'red' : 'gray'}>
              {t(`common:roles.${r}` as 'common:roles.admin', { defaultValue: r })}
            </Badge>
          ))}
          {!user.active && (
            <Badge size="sm" color="gray">
              {t('migration.mapping.inactive')}
            </Badge>
          )}
        </Group>
        {user.clash && !(decision.action === 'map' && decision.to.toLowerCase() === user.clash.username.toLowerCase()) && (
          <Text size="sm" c="orange">
            {t('migration.mapping.clash', { name: user.clash.username })}
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={t('migration.mapping.becomes')}
            data={USER_ACTIONS.map((a) => ({
              value: a,
              label: t(`migration.mapping.action.${a}`),
              disabled: a === 'create-local' && plan.passwordLogin === 'none',
            }))}
            value={decision.action}
            onChange={(v) => v && change(v as UserAction)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          {decision.action === 'map' ? (
            <Select
              label={t('migration.mapping.account')}
              data={plan.targetUsers
                .filter((x) => x.active)
                .map((x) => ({ value: x.username, label: `${x.displayName} (${x.username})${x.sso ? ' · SSO' : ''}` }))}
              value={decision.to || null}
              onChange={(v) => onChange({ ...decision, to: v ?? '' })}
              searchable
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
          ) : (
            <TextInput
              label={t('migration.mapping.username')}
              description={decision.action === 'create-sso' ? t('migration.mapping.ssoHint') : undefined}
              value={decision.action === 'create-sso' ? decision.username : (decision.username ?? '')}
              placeholder={user.username}
              onChange={(e) =>
                onChange(
                  decision.action === 'create-sso'
                    ? { ...decision, username: e.currentTarget.value }
                    : { ...decision, username: e.currentTarget.value || undefined },
                )
              }
            />
          )}
        </SimpleGrid>
        {decision.action === 'create-sso' && plan.providers.length > 1 && (
          <Select
            label={t('migration.mapping.provider')}
            description={t('migration.mapping.providerHint')}
            data={plan.providers.map((p) => ({ value: p.id, label: p.displayName }))}
            value={decision.provider ?? null}
            onChange={(v) => onChange({ ...decision, provider: v ?? undefined })}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
        )}
        <Text size="sm" data-testid={`map-preview-${user.username}`}>
          {t('migration.mapping.preview', {
            kind: user.kind === 'sso' ? 'SSO' : t('migration.mapping.local'),
            source: user.username,
            target: target || '–',
            what: t(`migration.mapping.result.${decision.action}`),
          })}
        </Text>
        {needsConfirm && (
          <Checkbox
            checked={decision.confirm === true}
            onChange={(e) => onChange({ ...decision, confirm: e.currentTarget.checked })}
            label={
              user.roles.includes('admin')
                ? t('migration.mapping.confirmSourceAdmin')
                : targetAdmin
                  ? t('migration.mapping.confirmTargetAdmin')
                  : t('migration.mapping.confirmGuess')
            }
          />
        )}
      </Stack>
    </Paper>
  );
}

function TeamRow({
  team,
  plan,
  decision,
  onChange,
}: {
  team: MigrationPlanTeam;
  plan: MigrationPlan;
  decision: TeamDecision;
  onChange: (d: TeamDecision) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <Paper withBorder p="sm" data-testid={`map-team-${team.name}`}>
      <Stack gap="xs">
        <Group gap="xs">
          <Text fw={600} size="sm">
            {team.name}
          </Text>
          <Text size="sm" c="dimmed">
            {t('migration.mapping.members', { count: team.members.length })}
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label={t('migration.mapping.becomes')}
            data={(['map', 'create', 'drop'] as const).map((a) => ({
              value: a,
              label: t(`migration.mapping.teamAction.${a}`),
              disabled: a === 'map' && !plan.targetTeams.length,
            }))}
            value={decision.action}
            onChange={(v) =>
              v && onChange(v === 'map' ? { action: 'map', to: plan.targetTeams[0] ?? '' } : v === 'create' ? { action: 'create' } : { action: 'drop' })
            }
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          {decision.action === 'map' && (
            <Select
              label={t('migration.mapping.team')}
              data={plan.targetTeams}
              value={decision.to || null}
              onChange={(v) => onChange({ action: 'map', to: v ?? '' })}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
          )}
          {decision.action === 'create' && (
            <TextInput
              label={t('migration.mapping.teamName')}
              value={decision.name ?? ''}
              placeholder={team.name}
              onChange={(e) => onChange({ action: 'create', name: e.currentTarget.value || undefined })}
            />
          )}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}

function ImportDone({ result }: { result: ImportResult }) {
  const { t } = useTranslation(['settings', 'common']);
  const rows = Object.values(result.counts).reduce((s, n) => s + n, 0);
  return (
    <Alert color="green" variant="light" mb="md" title={t('migration.import.doneTitle')} data-testid="import-result">
      <Stack gap="xs">
        <Text size="sm">
          {t('migration.import.doneText', { rows: fmtNumber(rows), files: fmtNumber(result.files), entries: fmtNumber(result.historyEntries) })}
        </Text>
        {result.paused.length > 0 && (
          <Text size="sm">{t('migration.plan.paused', { list: result.paused.map((p) => `${fmtNumber(p.count)} ${p.label}`).join(', ') })}</Text>
        )}
        {result.temporaryPasswords.length > 0 && (
          <>
            <Text size="sm">{t('migration.import.temporaryPasswords')}</Text>
            {result.temporaryPasswords.map((p) => (
              <Group key={p.username} gap="xs">
                <Text size="sm">{p.username}:</Text>
                <Code>{p.password}</Code>
                <CopyButton value={p.password}>
                  {({ copied, copy }) => (
                    <Button size="compact-xs" variant="subtle" onClick={copy}>
                      {copied ? t('common:copied') : t('common:copy')}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            ))}
          </>
        )}
      </Stack>
    </Alert>
  );
}

// ---------- imports into this instance ----------

function ImportsList() {
  const { t } = useTranslation('settings');
  const q = useQuery({ queryKey: ['migration-imports'], queryFn: () => get<InstanceImport[]>('/migration/imports') });
  return (
    <Card withBorder>
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconHistory size={18} aria-hidden />
        <Title order={5}>{t('migration.imports.title')}</Title>
      </Group>
      <QueryState query={q} />
      {q.data && !q.data.length && (
        <Text size="sm" c="dimmed">
          {t('migration.imports.none')}
        </Text>
      )}
      {q.data && q.data.length > 0 && (
        <Stack gap="md">
          {q.data.map((imp) => (
            <ImportItem key={imp.id} imp={imp} />
          ))}
        </Stack>
      )}
    </Card>
  );
}

interface ImportDetail extends InstanceImport {
  verification: { ok: boolean; entries: number; history: { ok: boolean; message: string }; record: { ok: boolean; message: string } };
}

function ImportItem({ imp }: { imp: InstanceImport }) {
  const { t } = useTranslation('settings');
  const [showHistory, setShowHistory] = useState(false);
  const detail = useQuery({ queryKey: ['migration-import', imp.id], queryFn: () => get<ImportDetail>(`/migration/imports/${encodeURIComponent(imp.id)}`) });
  const v = detail.data?.verification;
  return (
    <Paper withBorder p="sm" data-testid={`import-${imp.id}`}>
      <Stack gap="xs">
        <Text size="sm">
          {t('migration.imports.summary', {
            at: fmtDate(imp.importedAt),
            by: imp.importedBy,
            version: imp.source.version,
            exportedAt: fmtDate(imp.source.exportedAt),
          })}
        </Text>
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {t('migration.fingerprint')}: <Code>{imp.source.fingerprint}</Code> · SHA-256: <Code>{imp.packageSha256}</Code>
        </Text>
        {v && (
          <Group gap="xs">
            <Badge color={v.ok ? 'green' : 'red'} variant="light" data-testid="import-verification">
              {v.ok ? t('migration.imports.verified') : t('migration.imports.notVerified')}
            </Badge>
            <Text size="sm">
              {v.history.message}. {v.record.message}.
            </Text>
          </Group>
        )}
        <Table striped withTableBorder fz="sm" aria-label={t('migration.imports.mapping')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('migration.imports.source')}</Table.Th>
              <Table.Th>{t('migration.imports.now')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {imp.mapping.map((m) => (
              <Table.Tr key={`${m.kind}:${m.source}`}>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>
                  {m.kind === 'team' ? t('migration.imports.team', { name: m.source }) : `${m.sourceKind}: ${m.source}`}
                </Table.Td>
                <Table.Td style={{ overflowWrap: 'anywhere' }}>
                  {m.target
                    ? `${m.target} (${m.kind === 'team' ? t(`migration.mapping.teamAction.${m.action as 'map'}`) : t(`migration.mapping.result.${m.action as 'map'}`)})`
                    : t('migration.mapping.teamAction.drop')}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group>
          <Anchor component="button" type="button" size="sm" onClick={() => setShowHistory((x) => !x)} aria-expanded={showHistory}>
            {showHistory ? t('migration.imports.hideHistory') : t('migration.imports.showHistory', { count: imp.historyEntries })}
          </Anchor>
        </Group>
        {showHistory && <ImportedHistory importId={imp.id} />}
      </Stack>
    </Paper>
  );
}

function ImportedHistory({ importId }: { importId: string }) {
  const { t } = useTranslation('settings');
  const [q, setQ] = useState('');
  const history = useQuery({
    queryKey: ['migration-history', importId, q],
    queryFn: () => get<ImportedHistoryEntry[]>(`/migration/imports/${encodeURIComponent(importId)}/history?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  return (
    <Stack gap="xs">
      <TextInput label={t('migration.imports.search')} value={q} onChange={(e) => setQ(e.currentTarget.value)} maw={360} />
      <QueryState query={history} />
      {history.data && !history.data.length && (
        <Text size="sm" c="dimmed">
          {t('migration.imports.noEntries')}
        </Text>
      )}
      {history.data && history.data.length > 0 && (
        <Stack gap={4} data-testid="imported-history">
          {history.data.map((e) => (
            <Text key={e.seq} size="sm" style={{ overflowWrap: 'anywhere' }}>
              #{e.seq} · {fmtDate(e.ts)} · <b>{e.actorNow ? t('migration.imports.actorNow', { actor: e.actor, now: e.actorNow }) : e.actor}</b> · {e.action} –{' '}
              {e.summary}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
