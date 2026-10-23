import { useState } from 'react';
import { Alert, Button, Card, Checkbox, Code, Group, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconKey } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { get, notifyError, notifyOk, post } from '../../api';

interface VaultInfo {
  format?: 1 | 2;
  kdf?: { N: number; r: number; p: number };
  keyId?: string;
  fingerprint?: string;
  updatedAt?: string;
  passphraseMinLength: number;
}

/** Change of the master passphrase (administrators). The data key can be rotated at the same time. */
export function VaultPassphraseCard() {
  const { t } = useTranslation('settings');
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['vault-info'], queryFn: () => get<VaultInfo>('/vault/info') });
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [rotate, setRotate] = useState(true);
  const [busy, setBusy] = useState(false);
  const min = info.data?.passphraseMinLength ?? 12;
  const problem = next && next.length < min ? t('vault.tooShort', { count: min }) : repeat && next !== repeat ? t('vault.differ') : null;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ rotated: boolean; reencrypted: number }>('/vault/passphrase', { current, next, rotateDataKey: rotate });
      notifyOk(r.rotated ? t('vault.changedRotated', { count: r.reencrypted }) : t('vault.changed'));
      setCurrent('');
      setNext('');
      setRepeat('');
      void qc.invalidateQueries({ queryKey: ['vault-info'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconKey size={18} />
        <Title order={5}>{t('vault.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('vault.hint')}
      </Text>
      {info.data?.kdf && (
        <Text size="xs" c="dimmed" mb="sm">
          {t('vault.status', { n: Math.log2(info.data.kdf.N), date: info.data.updatedAt?.slice(0, 10) ?? '–' })}{' '}
          {info.data.fingerprint && (
            <>
              {t('vault.signingKey')} <Code>{info.data.fingerprint}</Code>
            </>
          )}
        </Text>
      )}
      <Stack gap="xs" maw={420}>
        <PasswordInput label={t('vault.current')} value={current} onChange={(e) => setCurrent(e.currentTarget.value)} autoComplete="current-password" />
        <PasswordInput
          label={t('vault.next')}
          description={t('vault.nextHint', { count: min })}
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
        />
        <PasswordInput label={t('vault.repeat')} value={repeat} onChange={(e) => setRepeat(e.currentTarget.value)} autoComplete="new-password" />
        <Checkbox label={t('vault.rotate')} description={t('vault.rotateHint')} checked={rotate} onChange={(e) => setRotate(e.currentTarget.checked)} />
        {problem && (
          <Alert color="orange" variant="light" p="xs">
            {problem}
          </Alert>
        )}
        <Group>
          <Button loading={busy} disabled={!current || !next || next !== repeat || next.length < min} onClick={submit}>
            {t('vault.submit')}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('vault.backupHint')}
        </Text>
      </Stack>
    </Card>
  );
}
