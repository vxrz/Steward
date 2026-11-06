import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  FileButton,
  Group,
  Loader,
  Modal,
  NumberInput,
  SimpleGrid,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconArrowRight, IconPlugConnected, IconRefresh, IconSearch, IconUpload } from '@tabler/icons-react';
import {
  DB_DIALECT_INFO,
  DB_TLS_MODES,
  impliedAuthType,
  type AuthType,
  type DatabaseSettings,
  type DbTlsMode,
  type Platform,
  type PlatformPreset,
} from '@sm/shared';
import { get, notifyError, post, put } from '../../api';
import { Hint, KeyValueEditor } from '../common';
import { EnvironmentInput } from '../catalogue/environments';
import { fmtNumber } from '../../format';
import { authLabel, presetDescription, presetSecretHelp, presetSecretLabel } from './presetText';
import { GetStartedPanel, TestHints } from './onboarding';

/** Groups of the connector list (kinds not named here: "Other"). */
type GroupKey = 'industrial' | 'monitoring' | 'cloud' | 'databases' | 'development' | 'ai' | 'messaging' | 'custom' | 'other';
const GROUPS: { key: GroupKey; kinds: string[] }[] = [
  { key: 'industrial', kinds: ['insights-hub', 'industrial-edge-management', 'mqtt'] },
  { key: 'monitoring', kinds: ['gatus', 'checkmk', 'prometheus', 'zabbix'] },
  { key: 'cloud', kinds: ['aws', 'kubernetes', 'snowflake', 'kafka', 'confluent-cloud', 'microsoft-graph'] },
  { key: 'databases', kinds: ['database', 'datacontract'] },
  { key: 'development', kinds: ['github', 'gitlab', 'forgejo', 'dependency-track', 'endoflife-date'] },
  { key: 'ai', kinds: ['llm-gateway'] },
  { key: 'messaging', kinds: ['teams'] },
];
const groupOf = (p: PlatformPreset): GroupKey => (p.custom ? 'custom' : (GROUPS.find((g) => g.kinds.includes(p.kind))?.key ?? 'other'));
const ORDER: GroupKey[] = [...GROUPS.map((g) => g.key), 'custom', 'other'];

interface TestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
  checks?: { name: string; ok: boolean; message: string }[];
}

/**
 * Adding a platform (v0.4.0): 1 choose a connector, 2 address and credentials (only the connector's fields, with the
 * sign-in inferred from the credentials filled in), 3 a live connection test with the diagnosis and the usual fixes,
 * 4 what's next. "Skip the wizard" opens the quick form.
 */
export function AddPlatformWizard({
  opened,
  onClose,
  onSkip,
  onDone,
  importConnector,
}: {
  opened: boolean;
  onClose: () => void;
  /** The quick form for experts */
  onSkip: () => void;
  onDone: (id: string) => void;
  importConnector: (f: File) => Promise<string | null>;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const presets = useQuery({ queryKey: ['platform-presets'], queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened });
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<PlatformPreset | null>(null);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [authChoice, setAuthChoice] = useState<AuthType | null>(null);
  /** Database platforms (0.7.0): the connection, filled in here and saved as config.database */
  const [dbConn, setDbConn] = useState<DatabaseSettings | null>(null);
  const [created, setCreated] = useState<Platform | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    if (opened) return;
    setStep(0);
    setSearch('');
    setPreset(null);
    setName('');
    setEnvironment('');
    setSecrets({});
    setAuthChoice(null);
    setCreated(null);
    setTest(null);
  }, [opened]);

  const choose = (p: PlatformPreset) => {
    setPreset(p);
    setBaseUrl(p.baseUrl);
    setVariables({ ...p.config.variables });
    setDbConn(p.config.database ? { ...p.config.database, host: '', tls: { ...p.config.database.tls } } : null);
    setSecrets({});
    setAuthChoice(null);
    setStep(1);
  };
  const authFields = preset?.secretFields.filter((f) => f.auth) ?? [];
  const authType: AuthType = authChoice ?? impliedAuthType(preset?.config.auth?.type, preset?.secretFields ?? [], secrets);
  const authOptions = [...new Set<AuthType>([preset?.config.auth?.type ?? 'none', ...authFields.map((f) => f.auth!)])];

  const runTest = async (id: string) => {
    setTest(null);
    try {
      setTest(await post<TestResult>(`/platforms/${id}/test`));
    } catch (e) {
      notifyError(e, t('detail.testFailed'));
    }
    qc.invalidateQueries({ queryKey: ['platform', id, 'health'] });
    qc.invalidateQueries({ queryKey: ['platforms'] });
  };

  /** Creates the platform (or saves the changed settings of the one created before), then tests it. */
  const saveAndTest = async () => {
    if (!preset) return;
    setBusy(true);
    try {
      const vars = Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
      const config = { ...preset.config, auth: { ...preset.config.auth, type: authType }, variables: vars, ...(dbConn ? { database: dbConn } : {}) };
      let p: Platform;
      if (!created) {
        p = await post<Platform>('/platforms', {
          name,
          kind: preset.kind,
          environment,
          description: presetDescription(preset),
          baseUrl,
          config,
          secrets: filled,
          typeKind: preset.custom ? preset.kind : undefined,
        });
      } else {
        p = await put<Platform>(`/platforms/${created.id}`, { name, environment, baseUrl, config: { ...created.config, ...config } });
        // the database connection changes only through its own route
        if (dbConn) p = await put<Platform>(`/platforms/${created.id}/database`, dbConn);
        if (Object.keys(filled).length) await put(`/platforms/${created.id}/secrets`, filled);
      }
      setCreated(p);
      await qc.invalidateQueries({ queryKey: ['platforms'] });
      setStep(2);
      await runTest(p.id);
    } catch (e) {
      notifyError(e, t('addModal.notCreated'));
    } finally {
      setBusy(false);
    }
  };

  const needle = search.trim().toLowerCase();
  const list = (presets.data ?? []).filter((p) => !needle || [p.label, p.kind, presetDescription(p)].some((x) => x.toLowerCase().includes(needle)));
  const groups = ORDER.map((g) => ({ key: g, items: list.filter((p) => groupOf(p) === g) })).filter((g) => g.items.length);
  const finish = () => {
    if (created) onDone(created.id);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={created ? finish : onClose} title={t('wizard.title')} size="xl">
      <Stepper active={step} size="xs" mb="md" allowNextStepsSelect={false} onStepClick={(s) => (s < step && (s > 0 || !created) ? setStep(s) : undefined)}>
        <Stepper.Step label={t('wizard.steps.connector')} />
        <Stepper.Step label={t('wizard.steps.settings')} />
        <Stepper.Step label={t('wizard.steps.test')} />
        <Stepper.Step label={t('wizard.steps.next')} />
      </Stepper>

      {step === 0 && (
        <Stack gap="xs" data-testid="wizard-connectors">
          <Group justify="space-between" align="flex-end" wrap="wrap">
            <TextInput
              data-autofocus
              label={t('wizard.search')}
              placeholder={t('wizard.searchPlaceholder')}
              leftSection={<IconSearch size={14} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={{ base: '100%', xs: 300 }}
            />
            <Button size="xs" variant="subtle" onClick={onSkip} data-testid="wizard-skip">
              {t('wizard.skip')}
            </Button>
          </Group>
          {presets.isLoading && <Loader />}
          {presets.isSuccess && !list.length && (
            <Text size="sm" c="dimmed">
              {t('wizard.noMatch')}
            </Text>
          )}
          {groups.map((g) => (
            <Stack key={g.key} gap={6} component="section" aria-label={t(`wizard.groups.${g.key}`)}>
              <Title order={6} c="dimmed" tt="uppercase" fz="xs" mt={4}>
                {t(`wizard.groups.${g.key}`)}
              </Title>
              {g.items.map((p) => (
                <UnstyledButton key={`${p.kind}-${p.label}`} onClick={() => choose(p)} data-testid="wizard-connector">
                  <Paper withBorder p="sm">
                    <Group gap="xs">
                      <Text fw={600}>{p.label}</Text>
                      <Badge size="xs" variant="light">
                        {p.kind}
                      </Badge>
                      {p.custom && (
                        <Badge size="xs" variant="filled" color="grape">
                          {t('addModal.custom')}
                        </Badge>
                      )}
                    </Group>
                    <Text size="sm" c="dimmed" mt={4} lineClamp={2}>
                      {presetDescription(p)}
                    </Text>
                  </Paper>
                </UnstyledButton>
              ))}
            </Stack>
          ))}
          <Group justify="space-between" wrap="wrap">
            <Hint>{t('addModal.hint')}</Hint>
            <FileButton
              accept=".json,application/json"
              onChange={(f) =>
                f &&
                importConnector(f).then(async (kind) => {
                  if (!kind) return;
                  const found = ((await presets.refetch()).data ?? []).find((x) => x.custom && x.kind === kind);
                  if (found) choose(found);
                })
              }
            >
              {(props) => (
                <Button {...props} size="xs" variant="subtle" leftSection={<IconUpload size={14} />}>
                  {t('types.import')}
                </Button>
              )}
            </FileButton>
          </Group>
        </Stack>
      )}

      {step === 1 && preset && (
        <Stack data-testid="wizard-settings">
          <Text size="sm" c="dimmed">
            {presetDescription(preset)}
          </Text>
          <TextInput label={t('form.name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder={t('form.namePlaceholder')} />
          <EnvironmentInput label={t('form.environment')} value={environment} onChange={setEnvironment} />
          {(preset.baseUrl !== '' || baseUrl !== '') && (
            <TextInput
              label={t('form.baseUrl')}
              classNames={{ input: 'mono' }}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
              description={t('form.baseUrlHint', { example: '{{ vars.region }}' })}
            />
          )}
          {dbConn && (
            <Stack gap="xs" data-testid="wizard-database">
              <Divider label={t('wizard.databaseConnection', { dbms: DB_DIALECT_INFO[dbConn.dialect].label })} labelPosition="left" />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput
                  label={t('database.host')}
                  description={t('database.hostHint')}
                  required
                  classNames={{ input: 'mono' }}
                  placeholder="db.example.internal"
                  value={dbConn.host}
                  onChange={(e) => setDbConn({ ...dbConn, host: e.currentTarget.value.trim() })}
                  data-testid="wizard-db-host"
                />
                <NumberInput
                  label={t('database.port')}
                  placeholder={String(DB_DIALECT_INFO[dbConn.dialect].port)}
                  min={1}
                  max={65535}
                  value={dbConn.port ?? ''}
                  onChange={(v) => setDbConn({ ...dbConn, port: typeof v === 'number' ? v : undefined })}
                />
                <TextInput
                  label={t('database.database')}
                  description={t(`database.databaseHint.${dbConn.dialect}`)}
                  required
                  classNames={{ input: 'mono' }}
                  value={dbConn.database}
                  onChange={(e) => setDbConn({ ...dbConn, database: e.currentTarget.value })}
                  data-testid="wizard-db-name"
                />
                <Select
                  label={t('database.tlsMode')}
                  data={DB_TLS_MODES.map((m) => ({ value: m, label: t(`database.tlsModes.${m}`) }))}
                  value={dbConn.tls.mode}
                  allowDeselect={false}
                  onChange={(v) => v && setDbConn({ ...dbConn, tls: { ...dbConn.tls, mode: v as DbTlsMode } })}
                />
              </SimpleGrid>
              <Hint>{t('wizard.databaseHint')}</Hint>
            </Stack>
          )}
          {Object.keys(preset.config.variables ?? {}).length > 0 && (
            <div>
              <Text size="sm" fw={500} mb={4}>
                {t('form.variables')}
              </Text>
              <KeyValueEditor value={variables} onChange={(v) => setVariables(v ?? {})} />
            </div>
          )}
          {preset.secretFields.length > 0 && (
            <>
              <Divider label={t('form.credentials')} labelPosition="left" />
              {created && (
                <Text size="xs" c="dimmed">
                  {t('wizard.secretsKept')}
                </Text>
              )}
              {preset.secretFields.map((f) => (
                <PasswordInput
                  key={f.key}
                  label={presetSecretLabel(preset, f)}
                  description={presetSecretHelp(preset, f) ?? t('form.storedAs', { key: f.key })}
                  value={secrets[f.key] ?? ''}
                  onChange={(e) => setSecrets({ ...secrets, [f.key]: e.currentTarget.value })}
                />
              ))}
              {authFields.length > 0 && (
                <Select
                  label={t('form.authType')}
                  description={t('form.authTypeHint')}
                  data={authOptions.map((a) => ({ value: a, label: authLabel(a) }))}
                  value={authType}
                  allowDeselect={false}
                  onChange={(v) => v && setAuthChoice(v as AuthType)}
                  data-testid="add-platform-auth"
                />
              )}
              <Hint>{t('form.credentialsHint')}</Hint>
            </>
          )}
          <Group justify="space-between">
            <Group gap="xs">
              {!created && (
                <Button variant="subtle" onClick={() => setStep(0)}>
                  {t('common:back')}
                </Button>
              )}
              {!created && (
                <Button variant="subtle" onClick={onSkip}>
                  {t('wizard.skip')}
                </Button>
              )}
            </Group>
            <Button
              onClick={saveAndTest}
              loading={busy}
              disabled={!name.trim() || (!!dbConn && (!dbConn.host || !dbConn.database.trim()))}
              leftSection={<IconPlugConnected size={16} />}
              data-testid="wizard-create"
            >
              {created ? t('wizard.saveAndTest') : t('wizard.createAndTest')}
            </Button>
          </Group>
        </Stack>
      )}

      {step === 2 && created && (
        <Stack data-testid="wizard-test">
          {!test ? (
            <Group gap="xs">
              <Loader size="sm" />
              <Text size="sm">{t('wizard.testing', { name: created.name })}</Text>
            </Group>
          ) : (
            <Alert color={test.ok ? 'green' : 'red'} title={test.ok ? t('detail.testOk') : t('detail.testNotOk')} data-testid="wizard-test-result">
              <Text size="sm">
                {test.status ? `HTTP ${test.status} · ${fmtNumber(test.durationMs)} ms · ` : ''}
                {test.message}
              </Text>
              {!!test.checks?.length && (
                <Stack gap={2} mt={4}>
                  {test.checks.map((c) => (
                    <Text key={c.name} size="xs" c={c.ok ? undefined : 'orange.8'}>
                      {c.ok ? '✓' : '✗'} {c.name}: {c.message}
                    </Text>
                  ))}
                </Stack>
              )}
              <TestHints result={test} />
            </Alert>
          )}
          <Group justify="space-between" wrap="wrap">
            <Group gap="xs">
              <Button variant="default" onClick={() => setStep(1)} disabled={!test}>
                {t('wizard.changeSettings')}
              </Button>
              <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={() => runTest(created.id)} disabled={!test}>
                {t('wizard.testAgain')}
              </Button>
            </Group>
            <Button
              onClick={() => setStep(3)}
              disabled={!test}
              variant={test?.ok ? 'filled' : 'light'}
              rightSection={<IconArrowRight size={14} />}
              data-testid="wizard-continue"
            >
              {test?.ok ? t('wizard.continue') : t('wizard.continueAnyway')}
            </Button>
          </Group>
        </Stack>
      )}

      {step === 3 && created && (
        <Stack data-testid="wizard-next">
          <Title order={5}>{t('wizard.nextTitle', { name: created.name })}</Title>
          <GetStartedPanel platform={created} onNavigate={() => onClose()} />
          <Group justify="flex-end">
            <Anchor size="sm" onClick={finish} component="button" type="button">
              {t('wizard.openPlatform')}
            </Anchor>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
