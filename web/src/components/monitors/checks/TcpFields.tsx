import { Group, NumberInput, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { num, type CheckFieldsProps } from './common';

/** A TCP connection to host:port. */
export function TcpFields({ c, set, disabled, err }: CheckFieldsProps<'tcp'>) {
  const { t } = useTranslation('monitors');
  return (
    <Group grow align="flex-start">
      <TextInput
        error={err('host')}
        data-field="host"
        label={t('form.host')}
        required
        disabled={disabled}
        value={c.host}
        onChange={(e) => set({ host: e.currentTarget.value })}
      />
      <NumberInput
        error={err('port')}
        data-field="port"
        label={t('form.port')}
        required
        min={1}
        max={65535}
        disabled={disabled}
        value={c.port}
        onChange={(v) => set({ port: num(v) ?? 0 })}
      />
      <NumberInput
        error={err('degradedMs')}
        data-field="degradedMs"
        label={t('form.degradedAbove')}
        min={1}
        disabled={disabled}
        value={c.degradedMs ?? ''}
        onChange={(v) => set({ degradedMs: num(v) })}
      />
    </Group>
  );
}
