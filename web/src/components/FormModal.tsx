import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Box, Button, Modal, type ButtonProps, type ModalProps } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { confirmDanger } from './confirm';

const GuardedClose = createContext<(() => void) | null>(null);

/**
 * A dialog with a form, mounted while it is open (`{open && <XModal onClose=… />}`):
 * - it gives the focus back to the control that opened it when it closes – Mantine does that only in the exit
 *   transition of a modal that stays mounted (WCAG 2.4.3);
 * - it asks "Discard your changes?" before Esc, the ✕ or _Cancel_ ({@link FormModalCancel}) throws away what was
 *   entered, and a click outside no longer closes it then. Changed means: something was typed, ticked or picked in it
 *   (or `dirty`, when the form knows better). Saving closes it through the caller's own `onClose`, without asking.
 */
export function FormModal({
  dirty,
  onClose,
  children,
  closeOnEscape = true,
  closeOnClickOutside = true,
  ...props
}: Omit<ModalProps, 'opened'> & { dirty?: boolean }) {
  const { t } = useTranslation('common');
  // the control that had the focus when the dialog was opened (the first render runs before the modal takes it)
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  const [touched, setTouched] = useState(false);
  const [asking, setAsking] = useState(false);
  const asked = useRef(false);
  const changed = dirty ?? touched;

  useEffect(
    () => () => {
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    },
    [opener],
  );

  const close = useCallback(() => {
    if (!changed) return onClose();
    if (asked.current) return;
    asked.current = true;
    setAsking(true);
    void confirmDanger({ action: 'discard', title: t('formModal.discardTitle'), message: t('formModal.discardMessage') }).then((ok) => {
      asked.current = false;
      setAsking(false);
      if (ok) onClose();
    });
  }, [changed, onClose, t]);

  const touch = () => {
    if (!touched) setTouched(true);
  };
  // a pick in a select or a combobox (their options sit in a portal, but React events still reach this box)
  const onClick = (e: MouseEvent) => {
    if ((e.target as Element | null)?.closest?.('[role="option"]')) touch();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.target as Element | null)?.getAttribute?.('aria-expanded') === 'true') touch();
  };

  return (
    <Modal opened onClose={close} closeOnEscape={closeOnEscape && !asking} closeOnClickOutside={closeOnClickOutside && !changed} {...props}>
      <GuardedClose.Provider value={close}>
        <Box display="contents" onInput={touch} onChange={touch} onClick={onClick} onKeyDown={onKeyDown}>
          {children}
        </Box>
      </GuardedClose.Provider>
    </Modal>
  );
}

/** Closes the surrounding {@link FormModal} like Esc does: asks first when something was entered. */
export function useFormModalClose(): () => void {
  const close = useContext(GuardedClose);
  if (!close) throw new Error('useFormModalClose outside a FormModal');
  return close;
}

/** The _Cancel_ button of a {@link FormModal}. */
export function FormModalCancel({ children, ...props }: ButtonProps & { children?: ReactNode; 'data-testid'?: string }) {
  const { t } = useTranslation('common');
  const close = useFormModalClose();
  return (
    <Button variant="default" {...props} onClick={close}>
      {children ?? t('cancel')}
    </Button>
  );
}
