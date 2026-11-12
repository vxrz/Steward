import { Button, Group, Stack, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import i18n from '../../i18n';
import { ApiError } from '../../api';

/** What happens to a platform's stored credentials when its address changes (docs/PLATFORMS.md#changing-the-address). */
export type CredentialChoice = 'keep' | 'clear';

/**
 * Asks what to do with the stored credentials: administrators choose between sending them to the new address and
 * removing them, everyone else confirms that they are removed. null: cancelled (nothing is saved).
 */
function askCredentials(name: string, admin: boolean): Promise<CredentialChoice | null> {
  type Key =
    | 'destinationKeepTitle'
    | 'destinationKeepText'
    | 'destinationKeep'
    | 'destinationClear'
    | 'destinationClearTitle'
    | 'destinationClearText'
    | 'destinationSave';
  const t = (key: Key) => i18n.t(`platforms:settings.${key}`, { name });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: CredentialChoice | null) => {
      if (settled) return;
      settled = true;
      modals.close(id);
      resolve(v);
    };
    const id = modals.open({
      title: t(admin ? 'destinationKeepTitle' : 'destinationClearTitle'),
      centered: true,
      size: 'md',
      onClose: () => finish(null),
      children: (
        <Stack>
          <Text size="sm" data-testid="destination-dialog-message">
            {t(admin ? 'destinationKeepText' : 'destinationClearText')}
          </Text>
          <Group justify="flex-end" wrap="wrap">
            <Button variant="default" data-autofocus onClick={() => finish(null)}>
              {i18n.t('common:cancel')}
            </Button>
            <Button color="red" variant={admin ? 'light' : 'filled'} data-testid="destination-clear" onClick={() => finish('clear')}>
              {t(admin ? 'destinationClear' : 'destinationSave')}
            </Button>
            {admin && (
              <Button color="red" data-testid="destination-keep" onClick={() => finish('keep')}>
                {t('destinationKeep')}
              </Button>
            )}
          </Group>
        </Stack>
      ),
    });
  });
}

/**
 * Sends a change of a platform; when it would send the stored credentials to a new address (409
 * PLATFORM_DESTINATION_CREDENTIALS), asks what to do with them and sends it again with the answer. null: cancelled.
 */
export async function withCredentialChoice<T>(send: (credentials?: CredentialChoice) => Promise<T>): Promise<T | null> {
  try {
    return await send();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'PLATFORM_DESTINATION_CREDENTIALS') throw e;
    const choice = await askCredentials(String(e.params?.name ?? ''), e.params?.admin === true);
    return choice ? send(choice) : null;
  }
}
