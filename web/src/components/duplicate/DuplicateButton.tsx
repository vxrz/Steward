import { useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Anchor, Button, Checkbox, Group, Menu, Modal, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconCopy } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CopiedFrom, DuplicateKind, DuplicateOption, DuplicateResult, DuplicateSuggestion } from '@sm/shared';
import i18n from '../../i18n';
import { ApiError, get, notifyError, notifyOk, post } from '../../api';
import { errorText } from '../../i18n/errors';
import { fmtDate } from '../../format';
import { QueryState } from '../common';
import { SecretsModal } from '../monitors/dialogs';

/**
 * Duplicate (0.4.0): the same action on every page that has it – a button on detail pages, a menu item in list rows.
 * The dialog asks for the copy's name (and key), the parts to copy along (applications, services) and – only for who
 * may manage the original – whether its access settings are copied; then it opens the copy (its editor for editors).
 * The rules (no secrets, the copy is the creator's, starts disabled …) are the server's (server/src/duplicate).
 */

/** The API path of each kind's duplicate endpoint. */
const ENDPOINT: Record<DuplicateKind, (id: string) => string> = {
  monitor: (id) => `/monitors/${id}/duplicate`,
  process: (id) => `/processes/${id}/duplicate`,
  dashboard: (id) => `/dashboards/${id}/duplicate`,
  credential: (id) => `/credentials/${id}/duplicate`,
  application: (id) => `/applications/${id}/duplicate`,
  service: (id) => `/services/${id}/duplicate`,
  schedule: (id) => `/schedules/${id}/duplicate`,
  'report-schedule': (id) => `/report-schedules/${id}/duplicate`,
  'maintenance-window': (id) => `/maintenance-windows/${id}/duplicate`,
  'access-check': (id) => `/compliance/access-checks/${id}/duplicate`,
  'status-page': (id) => `/status-pages/${id}/duplicate`,
  system: (id) => `/systems/${id}/duplicate`,
  asset: (id) => `/plant/assets/${encodeURIComponent(id)}/duplicate`,
  'device-profile': (id) => `/plant/profiles/${encodeURIComponent(id)}/duplicate`,
  'kpi-definition': (id) => `/plant/kpis/${encodeURIComponent(id)}/duplicate`,
};

/** The list queries a copy shows up in. */
const LIST_KEYS: Record<DuplicateKind, string[]> = {
  monitor: ['monitors'],
  process: ['processes'],
  dashboard: ['dashboards'],
  credential: ['credentials'],
  application: ['applications'],
  service: ['services'],
  schedule: ['schedules'],
  'report-schedule': ['report-schedules'],
  'maintenance-window': ['maintenance-windows'],
  'access-check': ['access-checks'],
  'status-page': ['status-pages'],
  system: ['systems'],
  asset: ['plant'],
  'device-profile': ['plant'],
  'kpi-definition': ['plant'],
};

/** Errors shown at a field of the dialog. */
const FIELD_OF: Record<string, 'name' | 'key'> = {
  DUPLICATE_NAME_TAKEN: 'name',
  APPLICATION_EXISTS: 'name',
  SERVICE_EXISTS: 'name',
  SYSTEM_EXISTS: 'name',
  DUPLICATE_KEY_TAKEN: 'key',
  PLANT_ID_TAKEN: 'key',
  MONITOR_KEY_INVALID: 'key',
  MONITOR_KEY_RESERVED: 'key',
};

interface DialogProps {
  kind: DuplicateKind;
  id: string;
  onClose: () => void;
  /** Instead of opening the copy (e.g. a list that shows it in place) */
  onDone?: (r: DuplicateResult) => void;
}

function DuplicateDialog({ kind, id, onClose, onDone }: DialogProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const lang = i18n.language.startsWith('de') ? 'de' : 'en';
  const suggestion = useQuery({
    queryKey: ['duplicate-suggestion', kind, id, lang],
    queryFn: () => get<DuplicateSuggestion>(`/duplicates/${kind}/${encodeURIComponent(id)}?lang=${lang}`),
    gcTime: 0,
  });
  const [name, setName] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [options, setOptions] = useState<Set<DuplicateOption> | null>(null);
  const [copyAccess, setCopyAccess] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'key'; text: string } | null>(null);
  const [secrets, setSecrets] = useState<DuplicateResult | null>(null);
  const s = suggestion.data;
  const chosen = options ?? new Set((s?.options ?? []).map((o) => o.option));

  const open = (r: DuplicateResult) => {
    for (const k of LIST_KEYS[kind]) qc.invalidateQueries({ queryKey: [k] });
    const skipped = r.skipped.map((x) => t(`duplicate.skipped.${x.what}` as 'duplicate.skipped.links', { count: x.count })).join(' ');
    notifyOk(skipped || t('duplicate.done'), t('duplicate.doneTitle', { name: r.name }));
    onClose();
    if (onDone) onDone(r);
    else navigate(r.editPath ?? r.path);
  };
  const submit = async () => {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<DuplicateResult>(ENDPOINT[kind](id), {
        name: (name ?? s.name).trim(),
        ...(s.key !== null ? { key: (key ?? s.key).trim() } : {}),
        ...(s.options.length ? { options: [...chosen] } : {}),
        ...(copyAccess ? { copyAccess: true } : {}),
      });
      // new heartbeat secrets are shown once, before the copy opens
      if (r.secrets?.length) setSecrets(r);
      else open(r);
    } catch (e) {
      // a taken name or key is shown at its field
      const field = e instanceof ApiError ? FIELD_OF[e.code ?? ''] : undefined;
      if (field) setError({ field: field === 'key' && s.key === null ? 'name' : field, text: errorText(e) });
      else notifyError(e, t('duplicate.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (secrets) return <SecretsModal result={{ secrets: secrets.secrets ?? [] }} onClose={() => open(secrets)} />;
  return (
    <Modal opened onClose={onClose} title={t('duplicate.title')} data-testid="duplicate-dialog">
      <QueryState query={suggestion} rows={3} />
      {s && (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('duplicate.intro', { name: s.sourceName })}
          </Text>
          <TextInput
            label={t('duplicate.name')}
            value={name ?? s.name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={error?.field === 'name' ? error.text : undefined}
            data-autofocus
            required
          />
          {s.key !== null && (
            <TextInput
              label={t('duplicate.key')}
              description={t('duplicate.keyHint')}
              value={key ?? s.key}
              onChange={(e) => setKey(e.currentTarget.value.toLowerCase())}
              classNames={{ input: 'mono' }}
              error={error?.field === 'key' ? error.text : undefined}
              required
            />
          )}
          {s.options.length > 0 && (
            <Stack gap={6} role="group" aria-label={t('duplicate.optionsLabel')}>
              <Text size="sm" fw={500}>
                {t('duplicate.optionsLabel')}
              </Text>
              {s.options.map((o) => (
                <Checkbox
                  key={o.option}
                  label={t(`duplicate.options.${o.option}`, { count: o.count })}
                  checked={chosen.has(o.option)}
                  disabled={o.count === 0}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.currentTarget.checked) next.add(o.option);
                    else next.delete(o.option);
                    setOptions(next);
                  }}
                />
              ))}
              {kind === 'application' && (
                <Text size="xs" c="dimmed">
                  {t('duplicate.noPlatforms')}
                </Text>
              )}
            </Stack>
          )}
          {kind === 'system' && (
            <Text size="xs" c="dimmed">
              {t('duplicate.systemNote')}
            </Text>
          )}
          {s.canCopyAccess && (
            <Checkbox
              label={t(kind === 'application' || kind === 'service' || kind === 'system' ? 'duplicate.copyOwners' : 'duplicate.copyAccess')}
              description={t('duplicate.copyAccessHint')}
              checked={copyAccess}
              onChange={(e) => setCopyAccess(e.currentTarget.checked)}
            />
          )}
          {s.accessApplies && !s.canCopyAccess && (
            <Text size="xs" c="dimmed">
              {t('duplicate.accessNotCopied')}
            </Text>
          )}
          <Alert color="blue" variant="light" p="xs">
            <Text size="xs">
              {t('duplicate.rules')} {s.startsDisabled ? t('duplicate.startsDisabled') : ''}
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button leftSection={<IconCopy size={14} />} loading={busy} onClick={() => void submit()} disabled={!(name ?? s.name).trim()}>
              {t('duplicate.submit')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/** For menus (list rows, a page's "more" menu): `open(kind, id)` from a Menu.Item, `dialog` rendered outside the menu. */
export function useDuplicate(onDone?: (r: DuplicateResult) => void): { open: (kind: DuplicateKind, id: string) => void; dialog: ReactNode } {
  const [target, setTarget] = useState<{ kind: DuplicateKind; id: string } | null>(null);
  return {
    open: (kind, id) => setTarget({ kind, id }),
    dialog: target ? <DuplicateDialog kind={target.kind} id={target.id} onClose={() => setTarget(null)} onDone={onDone} /> : null,
  };
}

/** The menu entry ("Duplicate …"); `onClick` opens the dialog (useDuplicate). */
export function DuplicateMenuItem({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('common');
  return (
    <Menu.Item leftSection={<IconCopy size={14} />} onClick={onClick} data-testid="duplicate-action">
      {t('duplicate.action')}
    </Menu.Item>
  );
}

/** The row action of a list without a menu (schedules, maintenance windows …); `onClick` opens the dialog (useDuplicate). */
export function DuplicateActionIcon({ onClick, name }: { onClick: () => void; name: string }) {
  const { t } = useTranslation('common');
  return (
    <Tooltip label={t('duplicate.action')}>
      <ActionIcon variant="subtle" onClick={onClick} aria-label={t('duplicate.actionNamed', { name })} data-testid="duplicate-action">
        <IconCopy size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

/** The Duplicate button of a detail page, with its dialog. */
export function DuplicateButton({
  kind,
  id,
  onDone,
  size = 'xs',
  variant = 'default',
}: {
  kind: DuplicateKind;
  id: string;
  onDone?: (r: DuplicateResult) => void;
  size?: string;
  variant?: string;
}) {
  const { t } = useTranslation('common');
  const d = useDuplicate(onDone);
  return (
    <>
      <Button size={size} variant={variant} leftSection={<IconCopy size={14} />} onClick={() => d.open(kind, id)} data-testid="duplicate-action">
        {t('duplicate.action')}
      </Button>
      {d.dialog}
    </>
  );
}

/** "Copied from …" on the copy's page: the original's name for who may see it, otherwise only that it was copied. */
export function CopiedFromNote({ kind, id, pathOf }: { kind: DuplicateKind; id: string; pathOf?: (sourceId: string) => string }) {
  const { t } = useTranslation('common');
  const q = useQuery({
    queryKey: ['copied-from', kind, id],
    queryFn: () => get<{ copiedFrom: CopiedFrom | null }>(`/duplicates/${kind}/${encodeURIComponent(id)}/source`),
    staleTime: 60_000,
    retry: false,
  });
  const c = q.data?.copiedFrom;
  if (!c) return null;
  return (
    <Text size="xs" c="dimmed" data-testid="copied-from">
      {c.hidden || !c.sourceId ? (
        t('duplicate.copiedFromHidden', { date: fmtDate(c.at), by: c.by })
      ) : (
        <>
          {t('duplicate.copiedFrom')}{' '}
          {pathOf ? (
            <Anchor component={Link} to={pathOf(c.sourceId)} size="xs">
              {c.sourceName}
            </Anchor>
          ) : (
            c.sourceName
          )}{' '}
          {t('duplicate.copiedAt', { date: fmtDate(c.at), by: c.by })}
        </>
      )}
    </Text>
  );
}
