import type { ReactNode } from 'react';
import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import i18n from '../i18n';

/** The kinds of confirmation; each has a dialog title and a button label in `common:confirm`. */
export type ConfirmAction = 'delete' | 'archive' | 'remove' | 'revoke' | 'rotate' | 'reset' | 'lockVault' | 'discard' | 'cleanup' | 'confirm';

export interface ConfirmOptions {
  /** Picks the title and the confirm button's label. */
  action: ConfirmAction;
  /** What happens: the question and its consequences (one or two sentences). */
  message: ReactNode;
  /** Overrides the default title of the action. */
  title?: ReactNode;
  /** Overrides the default button label of the action. */
  confirmLabel?: string;
  /** Red confirm button (default). `false` for a confirmation that is not destructive. */
  danger?: boolean;
}

/**
 * A themed confirmation dialog instead of the browser's `confirm()`. Resolves `true` when the person
 * confirms, `false` when they cancel, press Escape or close the dialog. Focus starts on _Cancel_, so
 * Enter never confirms a destructive action by accident.
 */
export function confirmDialog({ action, message, title, confirmLabel, danger = true }: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    modals.openConfirmModal({
      title: title ?? i18n.t(`common:confirm.${action}.title`),
      centered: true,
      size: 'md',
      children: (
        <Text size="sm" data-testid="confirm-dialog-message">
          {message}
        </Text>
      ),
      labels: { confirm: confirmLabel ?? i18n.t(`common:confirm.${action}.button`), cancel: i18n.t('common:cancel') },
      confirmProps: { color: danger ? 'red' : undefined, 'data-testid': 'confirm-dialog-confirm' },
      cancelProps: { 'data-autofocus': 'true' },
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
      onClose: () => finish(false),
    });
  });
}

/** A destructive confirmation (red button): delete, archive, revoke, rotate a secret … */
export const confirmDanger = (o: Omit<ConfirmOptions, 'danger'>) => confirmDialog({ ...o, danger: true });
