import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Anchor, Button, Group, Loader, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import { IconExternalLink, IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { StepUpAction, StepUpInfo, StepUpSsoStart, StepUpStatus } from '@sm/shared';
import { get, post, setStepUpHandler } from '../../api';
import { codeText, errorText } from '../../i18n/errors';
import { appPath } from '../../basePath';

interface Ask {
  info: StepUpInfo;
  /** Every request waiting for this confirmation: the dialog names their actions */
  waiting: { action?: StepUpAction; resolve: (confirmed: boolean) => void }[];
}

/**
 * The step-up dialog (docs/SECURITY-HARDENING.md#step-up-re-authentication), mounted once for the whole app: when a
 * sensitive action answers STEP_UP_REQUIRED, api.ts asks here. Password sessions enter the password; single sign-on
 * sessions sign in again at their provider in a popup (or this window when popups are blocked). Once confirmed, the
 * action is sent again automatically (once).
 */
export function StepUpDialog() {
  const { t } = useTranslation(['auth', 'common']);
  const [ask, setAsk] = useState<Ask | null>(null);
  useEffect(() => {
    // a request that asks while the dialog is open joins it (one confirmation, every action listed)
    setStepUpHandler(
      (info) =>
        new Promise<boolean>((resolve) =>
          setAsk((a) => (a ? { ...a, waiting: [...a.waiting, { action: info.action, resolve }] } : { info, waiting: [{ action: info.action, resolve }] })),
        ),
    );
    return () => setStepUpHandler(undefined);
  }, []);
  const finish = (confirmed: boolean) => {
    for (const w of ask?.waiting ?? []) w.resolve(confirmed);
    setAsk(null);
  };
  if (!ask) return null;
  const { info } = ask;
  const actions = [...new Set(ask.waiting.map((w) => w.action).filter((a): a is StepUpAction => !!a))];
  return (
    <Modal
      opened
      onClose={() => finish(false)}
      zIndex={1000}
      centered
      title={
        <Group gap="xs" wrap="nowrap">
          <IconShieldLock size={18} aria-hidden />
          <Text fw={600}>{t('stepUp.title')}</Text>
        </Group>
      }
      closeButtonProps={{ 'aria-label': t('common:close') }}
      data-testid="step-up-dialog"
    >
      <Stack gap="sm">
        <Text size="sm">{t('stepUp.why', { count: info.windowMinutes })}</Text>
        <div data-testid="step-up-actions">
          <Text size="sm" fw={600}>
            {t('stepUp.confirmFor')}
          </Text>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {(actions.length ? actions : (['other'] as const)).map((a) => (
              <li key={a}>
                <Text size="sm">{t(`stepUp.actions.${a}`)}</Text>
              </li>
            ))}
          </ul>
        </div>
        {info.method === 'password' && <PasswordConfirm onDone={() => finish(true)} onCancel={() => finish(false)} />}
        {info.method === 'sso' && <SsoConfirm info={info} actions={actions} onDone={() => finish(true)} onCancel={() => finish(false)} />}
        {(info.method === 'none' || info.method === 'emergency') && (
          <>
            <Alert color="orange" variant="light">
              {t('stepUp.none')}
            </Alert>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => finish(false)}>
                {t('stepUp.cancel')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}

function PasswordConfirm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation('auth');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/step-up', { password });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <Stack gap="sm">
        <PasswordInput
          label={t('stepUp.password')}
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          error={error}
          autoComplete="current-password"
          data-autofocus
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            {t('stepUp.cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={!password}>
            {t('stepUp.confirm')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

const POLL_MS = 1500;

function SsoConfirm({ info, actions, onDone, onCancel }: { info: StepUpInfo; actions: StepUpAction[]; onDone: () => void; onCancel: () => void }) {
  const { t } = useTranslation('auth');
  const provider = info.provider?.displayName ?? '';
  const [started, setStarted] = useState<{ url: string; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;

  // wait for the confirmation: the popup's page redeems it for this session (the popup cannot reach this window)
  useEffect(() => {
    if (!started) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await get<StepUpStatus>('/auth/step-up');
        if (stop) return;
        if (s.until && s.confirmedWith) return done.current();
        if (s.failure && Date.parse(s.failure.at) >= started.at - 1000) {
          setError(codeText(s.failure.code, undefined, s.failure.message) ?? s.failure.message);
          setStarted(null);
          return;
        }
      } catch {
        /* try again */
      }
      if (!stop) timer = window.setTimeout(tick, POLL_MS);
    };
    let timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [started]);

  const start = async () => {
    setBusy(true);
    setError(null);
    // opened right away (a popup opened after an await is blocked), pointed at the provider once the URL is known
    const popup = window.open('', 'sm-step-up', 'popup,width=520,height=700');
    try {
      const s = await post<StepUpSsoStart>('/auth/step-up/sso', { popup: !!popup, returnTo: appPath(), actions });
      if (popup) {
        popup.opener = null; // the provider's page gets no reference back to Steward
        popup.location.href = s.authorizationUrl;
        setStarted({ url: s.authorizationUrl, at: Date.now() });
      } else {
        // popups blocked: this window goes to the provider and comes back here, confirmed – the action is then done again by hand
        window.location.assign(s.authorizationUrl);
      }
    } catch (e) {
      popup?.close();
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm">{info.mfa ? t('stepUp.ssoHintMfa', { provider }) : t('stepUp.ssoHint', { provider })}</Text>
      {error && (
        <Alert color="red" variant="light" role="alert">
          {error}
        </Alert>
      )}
      {started && (
        <Group gap="xs" role="status">
          <Loader size="xs" />
          <Text size="sm">{t('stepUp.waiting', { provider })}</Text>
          <Anchor href={started.url} target="_blank" rel="noopener noreferrer" size="sm">
            <Group gap={4} component="span">
              {t('stepUp.openAgain')} <IconExternalLink size={12} aria-hidden />
            </Group>
          </Anchor>
        </Group>
      )}
      <Group justify="flex-end">
        <Button variant="default" onClick={onCancel}>
          {t('stepUp.cancel')}
        </Button>
        <Button onClick={start} loading={busy} disabled={!!started} data-autofocus>
          {t('stepUp.confirmWith', { provider })}
        </Button>
      </Group>
    </Stack>
  );
}
