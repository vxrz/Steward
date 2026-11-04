import { useState } from 'react';
import { Badge, Button, Group, Modal, NumberInput, Select, Stack, Table, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconCloudDownload } from '@tabler/icons-react';
import { ENTRA_KIND, type EntraRegisterImport, type Platform } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { platformKeys } from '../../queryKeys';
import { Hint } from '../common';
import { fmtDay } from '../../format';

const ACTION_COLOR: Record<EntraRegisterImport['items'][number]['action'], string> = {
  create: 'green',
  update: 'blue',
  unchanged: 'gray',
  notAllowed: 'orange',
};

/**
 * "Import from Entra ID" (v0.5.0): the secrets and certificates of an Entra ID tenant's app registrations as entries of
 * the register, with their end date as the expiry – a preview first, then the import. Shown to people who may add
 * entries when a Microsoft Graph platform they may use exists.
 */
export function EntraImportButton({ onImported }: { onImported: () => void }) {
  const { t } = useTranslation(['credentials', 'common']);
  const platforms = useQuery({
    queryKey: platformKeys.ofKind(ENTRA_KIND),
    queryFn: async () => (await get<Platform[]>('/platforms')).filter((p) => p.kind === ENTRA_KIND && p.permissions.includes('use')),
  });
  const [open, setOpen] = useState(false);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [withinDays, setWithinDays] = useState<number | ''>(90);
  const [preview, setPreview] = useState<EntraRegisterImport | null>(null);
  const [busy, setBusy] = useState(false);
  const list = platforms.data ?? [];
  if (!list.length) return null;
  const chosen = platformId ?? (list.length === 1 ? list[0]!.id : null);
  const run = async (dryRun: boolean) => {
    if (!chosen) return;
    setBusy(true);
    try {
      const r = await post<EntraRegisterImport>('/credentials/import/entra', { platformId: chosen, withinDays: withinDays === '' ? null : withinDays, dryRun });
      if (dryRun) setPreview(r);
      else {
        notifyOk(t('entraImport.done', { created: r.created, updated: r.updated }));
        setOpen(false);
        setPreview(null);
        onImported();
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="xs" variant="default" leftSection={<IconCloudDownload size={14} />} onClick={() => setOpen(true)} data-testid="entra-import">
        {t('entraImport.button')}
      </Button>
      {open && (
        <Modal opened onClose={() => setOpen(false)} title={t('entraImport.title')} size="lg">
          <Stack gap="sm">
            <Text size="sm">{t('entraImport.intro')}</Text>
            <Group grow align="flex-start" wrap="wrap">
              <Select
                label={t('entraImport.platform')}
                required
                allowDeselect={false}
                data={list.map((p) => ({ value: p.id, label: p.name }))}
                value={chosen}
                onChange={(v) => {
                  setPlatformId(v);
                  setPreview(null);
                }}
              />
              <NumberInput
                label={t('entraImport.withinDays')}
                description={t('entraImport.withinDaysHint')}
                min={0}
                max={3650}
                value={withinDays}
                onChange={(v) => {
                  setWithinDays(v === '' ? '' : Number(v));
                  setPreview(null);
                }}
              />
            </Group>
            {preview && (
              <Stack gap={4} data-testid="entra-import-preview">
                <Text size="sm">
                  {t('entraImport.summary', { read: preview.read, created: preview.created, updated: preview.updated, unchanged: preview.unchanged })}
                </Text>
                {preview.items.length > 0 && (
                  <Table.ScrollContainer minWidth={480}>
                    <Table striped fz="xs">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('entraImport.app')}</Table.Th>
                          <Table.Th>{t('entraImport.credential')}</Table.Th>
                          <Table.Th>{t('entraImport.ends')}</Table.Th>
                          <Table.Th>{t('entraImport.action')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {preview.items.map((x) => (
                          <Table.Tr key={x.keyId}>
                            <Table.Td>{x.appName}</Table.Td>
                            <Table.Td>
                              {t(`entraImport.types.${x.type}`)}
                              {x.name ? ` “${x.name}”` : ''}
                            </Table.Td>
                            <Table.Td>{x.endDateTime ? fmtDay(x.endDateTime) : '–'}</Table.Td>
                            <Table.Td>
                              <Badge size="xs" variant="light" color={ACTION_COLOR[x.action]}>
                                {t(`entraImport.actions.${x.action}`)}
                              </Badge>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                )}
              </Stack>
            )}
            <Hint>{t('entraImport.hint')}</Hint>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>
                {t('common:cancel')}
              </Button>
              <Button variant="light" onClick={() => run(true)} loading={busy && !preview} disabled={!chosen} data-testid="entra-import-preview-button">
                {t('entraImport.preview')}
              </Button>
              <Button
                onClick={() => run(false)}
                loading={busy && !!preview}
                disabled={!chosen || !preview || !(preview.created + preview.updated)}
                data-testid="entra-import-submit"
              >
                {t('entraImport.import')}
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </>
  );
}
