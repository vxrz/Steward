import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Divider,
  Group,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  BRAND,
  DB_DIALECTS,
  DB_DIALECT_INFO,
  DB_LIMITS,
  DB_TLS_MODES,
  databaseSettingsSchema,
  type DatabaseSettings,
  type DbDialect,
  type DbTlsMode,
  type Platform,
} from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { platformKeys } from '../../queryKeys';
import { fmtNumber } from '../../format';

/**
 * Platform → Database (0.7.0, docs/DATABASES.md): the connection of a database platform – DBMS, host, port, database,
 * TLS and the limits every statement runs within. Saved with the platform's "manage" right; part of its sealed
 * connection settings. User name and password are credentials (Credentials tab).
 */

type Draft = Omit<DatabaseSettings, 'limits' | 'tls'> & {
  tls: { mode: DbTlsMode; ca?: string; serverName?: string; contractServiceUnverified?: boolean };
  limits: { timeoutSeconds?: number; maxRows?: number; maxMb?: number };
};

const empty = (): Draft => ({ dialect: 'postgresql', host: '', database: '', tls: { mode: 'verify' }, limits: {}, auth: 'password' });

const fromPlatform = (p: Platform): Draft => {
  const s = p.config.database;
  return s ? { ...s, tls: { ...s.tls }, limits: { ...s.limits } } : empty();
};

export function DatabaseTab({ platform, readOnly }: { platform: Platform; readOnly: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => fromPlatform(platform));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setD(fromPlatform(platform)), [platform]);

  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const setTls = (patch: Partial<Draft['tls']>) => setD((x) => ({ ...x, tls: { ...x.tls, ...patch } }));
  const setLimit = (k: keyof Draft['limits'], v: string | number) =>
    setD((x) => ({ ...x, limits: { ...x.limits, [k]: typeof v === 'number' ? v : undefined } }));
  const info = DB_DIALECT_INFO[d.dialect];

  const save = async () => {
    const body = {
      ...d,
      port: d.port || undefined,
      tls: {
        mode: d.tls.mode,
        ca: d.tls.ca?.trim() ? d.tls.ca : undefined,
        serverName: d.tls.serverName?.trim() || undefined,
        contractServiceUnverified: d.tls.contractServiceUnverified || undefined,
      },
      poolSize: d.poolSize || undefined,
    };
    const parsed = databaseSettingsSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])));
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await put(`/platforms/${platform.id}/database`, parsed.data);
      await Promise.all([qc.invalidateQueries({ queryKey: platformKeys.detail(platform.id) }), qc.invalidateQueries({ queryKey: platformKeys.all })]);
      notifyOk(t('database.saved'));
    } catch (e) {
      notifyError(e, t('database.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} data-testid="database-tab">
      <Stack maw={960}>
        <Text size="sm">{t('database.intro')}</Text>
        {!platform.config.database && (
          <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
            {readOnly ? t('database.notSetReadOnly') : t('database.notSet')}
          </Alert>
        )}
        <Paper withBorder p="md">
          <Title order={5} mb="sm">
            {t('database.connection')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('database.dialect')}
              data={DB_DIALECTS.map((x) => ({ value: x, label: DB_DIALECT_INFO[x].label }))}
              value={d.dialect}
              allowDeselect={false}
              onChange={(v) => v && set({ dialect: v as DbDialect })}
              data-testid="database-dialect"
            />
            <TextInput
              label={t('database.database')}
              description={t(`database.databaseHint.${d.dialect}`)}
              required
              classNames={{ input: 'mono' }}
              value={d.database}
              error={errors.database}
              onChange={(e) => set({ database: e.currentTarget.value })}
              data-testid="database-name"
            />
            <TextInput
              label={t('database.host')}
              description={t('database.hostHint')}
              required
              classNames={{ input: 'mono' }}
              value={d.host}
              error={errors.host}
              onChange={(e) => set({ host: e.currentTarget.value })}
              data-testid="database-host"
            />
            <NumberInput
              label={t('database.port')}
              description={t('database.portHint', { port: info.port })}
              placeholder={String(info.port)}
              min={1}
              max={65535}
              value={d.port ?? ''}
              error={errors.port}
              onChange={(v) => set({ port: typeof v === 'number' ? v : undefined })}
            />
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="sm">
            {t('database.credentialsHint')}
          </Text>
        </Paper>

        <Paper withBorder p="md">
          <Title order={5} mb="sm">
            {t('database.tls')}
          </Title>
          <Stack>
            <Select
              label={t('database.tlsMode')}
              description={t(`database.tlsModeHints.${d.tls.mode}`)}
              data={DB_TLS_MODES.map((m) => ({ value: m, label: t(`database.tlsModes.${m}`) }))}
              value={d.tls.mode}
              allowDeselect={false}
              onChange={(v) => v && setTls({ mode: v as DbTlsMode })}
              data-testid="database-tls"
            />
            {d.tls.mode !== 'verify' && (
              <Alert color={d.tls.mode === 'off' ? 'red' : 'orange'} variant="light" p="xs">
                <Text size="xs">{t(`database.tlsWarning.${d.tls.mode}`)}</Text>
              </Alert>
            )}
            {d.tls.mode === 'verify' && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Textarea
                  label={t('database.ca')}
                  description={t('database.caHint')}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  autosize
                  minRows={2}
                  maxRows={8}
                  classNames={{ input: 'mono' }}
                  value={d.tls.ca ?? ''}
                  error={errors['tls.ca']}
                  onChange={(e) => setTls({ ca: e.currentTarget.value })}
                />
                <TextInput
                  label={t('database.serverName')}
                  description={t('database.serverNameHint')}
                  classNames={{ input: 'mono' }}
                  value={d.tls.serverName ?? ''}
                  error={errors['tls.serverName']}
                  onChange={(e) => setTls({ serverName: e.currentTarget.value })}
                />
              </SimpleGrid>
            )}
            {d.tls.mode !== 'off' && d.dialect !== 'sqlserver' && (
              <Checkbox
                label={t('database.contractServiceUnverified')}
                description={t('database.contractServiceUnverifiedHint')}
                checked={!!d.tls.contractServiceUnverified}
                onChange={(e) => setTls({ contractServiceUnverified: e.currentTarget.checked })}
                data-testid="database-contract-unverified"
              />
            )}
          </Stack>
        </Paper>

        <Paper withBorder p="md">
          <Title order={5}>{t('database.limits')}</Title>
          <Text size="xs" c="dimmed" mb="sm">
            {t('database.limitsHint')}
          </Text>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
            <NumberInput
              label={t('database.timeout')}
              placeholder={String(DB_LIMITS.timeoutSeconds.default)}
              description={t('database.atMost', { max: DB_LIMITS.timeoutSeconds.max })}
              min={1}
              max={DB_LIMITS.timeoutSeconds.max}
              value={d.limits.timeoutSeconds ?? ''}
              onChange={(v) => setLimit('timeoutSeconds', v)}
            />
            <NumberInput
              label={t('database.maxRows')}
              placeholder={String(DB_LIMITS.maxRows.default)}
              description={t('database.atMost', { max: fmtNumber(DB_LIMITS.maxRows.max) })}
              min={1}
              max={DB_LIMITS.maxRows.max}
              thousandSeparator=" "
              value={d.limits.maxRows ?? ''}
              onChange={(v) => setLimit('maxRows', v)}
            />
            <NumberInput
              label={t('database.maxMb')}
              placeholder={String(DB_LIMITS.maxMb.default)}
              description={t('database.atMost', { max: DB_LIMITS.maxMb.max })}
              min={1}
              max={DB_LIMITS.maxMb.max}
              value={d.limits.maxMb ?? ''}
              onChange={(v) => setLimit('maxMb', v)}
            />
            <NumberInput
              label={t('database.poolSize')}
              placeholder={String(DB_LIMITS.poolSize.default)}
              description={t('database.atMost', { max: DB_LIMITS.poolSize.max })}
              min={1}
              max={DB_LIMITS.poolSize.max}
              value={d.poolSize ?? ''}
              onChange={(v) => set({ poolSize: typeof v === 'number' ? v : undefined })}
            />
          </SimpleGrid>
        </Paper>

        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />} title={t('database.readOnlyTitle')}>
          <Text size="sm">{t(`database.readOnly.${d.dialect}`)}</Text>
          <Anchor size="sm" href={`${BRAND.repoUrl}/blob/HEAD/docs/DATABASES.md`} target="_blank" rel="noopener" mt={4} display="inline-block">
            {t('database.docsLink')}
          </Anchor>
        </Alert>

        {!readOnly && (
          <>
            <Divider />
            <Group justify="flex-end">
              <Button leftSection={<IconDeviceFloppy size={16} />} onClick={save} loading={busy} data-testid="database-save">
                {t('database.save')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </fieldset>
  );
}
