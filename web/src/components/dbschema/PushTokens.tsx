import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Paper,
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
import { IconAlertTriangle, IconKey, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DB_SCHEMA_PUSH_LIMITS, type DbSchemaPushToken, type DbSchemaPushTokenCreated } from '@sm/shared';
import { del, get, notifyError, post } from '../../api';
import { EmptyState, Hint, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { fmtDate, fmtRelative } from '../../format';
import { dbSchemaKeys } from '../../queryKeys';
import { CopyBlock } from '../monitors/dialogs';
import { ciCommands } from './dialogs';
import type { SchemaSubject } from './SchemaView';

/**
 * Push tokens of the tbls import from CI (#222): bound to this platform or system, they can do nothing but push its
 * schema.json. Who may manage the target creates, rotates and revokes them; a secret is shown once.
 */
export function PushTokensPanel({ subject }: { subject: SchemaSubject }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const phone = useMediaQuery('(max-width: 48em)');
  const key = dbSchemaKeys.pushTokens(subject.kind, subject.id);
  const base = `/db-schemas/${subject.kind}/${subject.id}/push-tokens`;
  const q = useQuery({ queryKey: key, queryFn: () => get<DbSchemaPushToken[]>(base) });
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<DbSchemaPushTokenCreated | null>(null);
  const reload = () => qc.invalidateQueries({ queryKey: key });
  const rotate = async (x: DbSchemaPushToken) => {
    if (!(await confirmDanger({ action: 'rotate', message: t('schema.push.rotateConfirm', { name: x.name }) }))) return;
    try {
      setShown(await post<DbSchemaPushTokenCreated>(`${base}/${x.id}/rotate`));
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const revoke = async (x: DbSchemaPushToken) => {
    if (!(await confirmDanger({ action: 'revoke', message: t('schema.push.revokeConfirm', { name: x.name }) }))) return;
    try {
      await del(`${base}/${x.id}`);
      await reload();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = q.data ?? [];
  const expiry = (x: DbSchemaPushToken) =>
    x.expired ? (
      <Badge size="sm" color="red" variant="light">
        {t('schema.push.expired')}
      </Badge>
    ) : x.expiresAt ? (
      fmtDate(x.expiresAt)
    ) : (
      t('schema.push.never')
    );
  const used = (x: DbSchemaPushToken) =>
    x.lastUsedAt ? `${fmtRelative(x.lastUsedAt)}${x.lastUsedIp ? ` · ${x.lastUsedIp}` : ''}` : t('schema.push.neverUsed');
  const actions = (x: DbSchemaPushToken) => (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={t('schema.push.rotate')}>
        <ActionIcon variant="subtle" onClick={() => void rotate(x)} aria-label={t('schema.push.rotateNamed', { name: x.name })} data-testid="push-token-rotate">
          <IconRefresh size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={t('schema.push.revoke')}>
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={() => void revoke(x)}
          aria-label={t('schema.push.revokeNamed', { name: x.name })}
          data-testid="push-token-revoke"
        >
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
  return (
    <Paper withBorder p="md" data-testid="push-tokens">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm" mb="sm">
        <div style={{ flex: 1, minWidth: 220 }}>
          <Title order={5}>{t('schema.push.title')}</Title>
          <Hint>{t('schema.push.help')}</Hint>
        </div>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="push-token-new">
          {t('schema.push.new')}
        </Button>
      </Group>
      <QueryState query={q} rows={1} />
      {q.data && !list.length && (
        <EmptyState compact icon={IconKey} title={t('schema.push.empty')}>
          {t('schema.push.emptyHint')}
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
                  <Text size="xs" c="dimmed" className="mono">
                    {x.prefix}…
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('schema.push.lastUsed')}: {used(x)}
                  </Text>
                  <Text size="xs" c="dimmed" component="div">
                    {t('schema.push.expires')}: {expiry(x)}
                  </Text>
                  {x.allowedCidrs.length > 0 && (
                    <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
                      {x.allowedCidrs.join(', ')}
                    </Text>
                  )}
                </Stack>
                {actions(x)}
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      {list.length > 0 && !phone && (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('schema.push.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('schema.push.name')}</Table.Th>
                <Table.Th>{t('schema.push.token')}</Table.Th>
                <Table.Th>{t('schema.push.addresses')}</Table.Th>
                <Table.Th>{t('schema.push.lastUsed')}</Table.Th>
                <Table.Th>{t('schema.push.expires')}</Table.Th>
                <Table.Th>
                  <VisuallyHidden>{t('schema.push.actions')}</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((x) => (
                <Table.Tr key={x.id}>
                  <Table.Td>{x.name}</Table.Td>
                  <Table.Td className="mono">{x.prefix}…</Table.Td>
                  <Table.Td className="mono" style={{ wordBreak: 'break-all' }}>
                    {x.allowedCidrs.join(', ') || t('schema.push.anyAddress')}
                  </Table.Td>
                  <Table.Td>{used(x)}</Table.Td>
                  <Table.Td>{expiry(x)}</Table.Td>
                  <Table.Td>{actions(x)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && (
        <CreateModal
          base={base}
          onClose={() => setCreating(false)}
          onCreated={async (x) => {
            setCreating(false);
            setShown(x);
            await reload();
          }}
        />
      )}
      {shown && <SecretModal subject={subject} token={shown} onClose={() => setShown(null)} />}
    </Paper>
  );
}

function CreateModal({ base, onClose, onCreated }: { base: string; onClose: () => void; onCreated: (x: DbSchemaPushTokenCreated) => void | Promise<void> }) {
  const { t } = useTranslation(['platforms', 'common']);
  const [name, setName] = useState('');
  const [days, setDays] = useState<number | undefined>(365);
  const [cidrs, setCidrs] = useState<string[]>([]);
  const [rate, setRate] = useState<number>(DB_SCHEMA_PUSH_LIMITS.rateLimitPerMinute.default);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const submit = async () => {
    setShown(true);
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onCreated(
        await post<DbSchemaPushTokenCreated>(base, {
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
    <Modal opened onClose={onClose} title={t('schema.push.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm" data-testid="push-token-form">
          <TextInput
            label={t('schema.push.name')}
            description={t('schema.push.nameHint')}
            required
            maxLength={DB_SCHEMA_PUSH_LIMITS.nameChars}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={shown && !name.trim() ? t('common:validation.required') : undefined}
            data-autofocus
          />
          <NumberInput
            label={t('schema.push.expiresIn')}
            description={t('schema.push.expiresInHint', { max: DB_SCHEMA_PUSH_LIMITS.expiresInDays })}
            min={1}
            max={DB_SCHEMA_PUSH_LIMITS.expiresInDays}
            value={days ?? ''}
            onChange={(v) => setDays(typeof v === 'number' ? v : undefined)}
          />
          <TagsInput
            label={t('schema.push.addresses')}
            description={t('schema.push.addressesHint')}
            placeholder="10.20.0.0/16"
            value={cidrs}
            onChange={setCidrs}
            maxTags={DB_SCHEMA_PUSH_LIMITS.cidrs}
          />
          <NumberInput
            label={t('schema.push.rate')}
            min={1}
            max={DB_SCHEMA_PUSH_LIMITS.rateLimitPerMinute.max}
            value={rate}
            onChange={(v) => setRate(typeof v === 'number' ? v : DB_SCHEMA_PUSH_LIMITS.rateLimitPerMinute.default)}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="push-token-create">
              {t('schema.push.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The secret, this once, with the commands of a CI job. */
function SecretModal({ subject, token, onClose }: { subject: SchemaSubject; token: DbSchemaPushTokenCreated; onClose: () => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const cmds = ciCommands(subject);
  return (
    <Modal opened onClose={onClose} size="lg" title={t('schema.push.secretTitle', { name: token.name })}>
      <Stack gap="sm" data-testid="push-token-secret">
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('schema.push.secretOnce')}
        </Alert>
        <CopyBlock label={t('schema.push.token')} text={token.token} />
        <Text size="sm" c="dimmed">
          {t('schema.push.secretHelp')}
        </Text>
        <CopyBlock label={t('schema.ciPlain')} text={cmds.plain} />
        <CopyBlock label={t('schema.ciLint')} text={cmds.lint} />
        <Group justify="flex-end">
          <Button onClick={onClose} data-testid="push-token-done">
            {t('schema.push.done')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
