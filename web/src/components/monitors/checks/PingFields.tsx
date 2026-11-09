import { Group, NumberInput, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { num, type CheckFieldsProps } from './common';

/** ICMP echo, with a TCP connect as the fallback. */
export function PingFields({ c, set, disabled, err }: CheckFieldsProps<'ping'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <TextInput
        error={err('host')}
        data-field="host"
        label={t('form.hostOrIp')}
        required
        disabled={disabled}
        value={c.host}
        onChange={(e) => set({ host: e.currentTarget.value })}
      />
      <Group grow align="flex-start">
        <NumberInput
          error={err('fallbackPort')}
          data-field="fallbackPort"
          label={t('form.fallbackPort')}
          description={t('form.fallbackPortHint')}
          min={1}
          max={65535}
          disabled={disabled}
          value={c.fallbackPort ?? ''}
          onChange={(v) => set({ fallbackPort: num(v) })}
        />
        <NumberInput
          error={err('degradedRttMs')}
          data-field="degradedRttMs"
          label={t('form.degradedAbove')}
          min={1}
          disabled={disabled}
          value={c.degradedRttMs ?? ''}
          onChange={(v) => set({ degradedRttMs: num(v) })}
        />
      </Group>
    </>
  );
}
