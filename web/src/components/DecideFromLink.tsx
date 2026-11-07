import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Approvals from Microsoft Teams, stage 1 (ADR 0013): a card's Approve / Reject button opens the item with
 * `?decide=approve|reject`. The dialog opens with that choice; nothing is decided until the person confirms here, in
 * their signed-in session with the usual checks (step-up, four-eyes). A link alone never decides.
 */

export type DecideVerb = 'approve' | 'reject';

/** The choice a link asks for (`?decide=`), and a way to drop it from the address once handled. */
export function useDecideParam(): { verb: DecideVerb | null; task: string | null; clear: () => void } {
  const [params, setParams] = useSearchParams();
  const v = params.get('decide');
  const verb = v === 'approve' || v === 'reject' ? v : null;
  const clear = () =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.delete('decide');
        next.delete('task');
        return next;
      },
      { replace: true },
    );
  return { verb, task: params.get('task'), clear };
}

/** The confirmation dialog with the choice from the link pre-selected. */
export function DecideFromLinkModal({
  verb,
  title,
  onConfirm,
  onClose,
  commentMax = 4000,
}: {
  verb: DecideVerb;
  title: string;
  onConfirm: (approve: boolean, comment: string) => Promise<boolean>;
  onClose: () => void;
  commentMax?: number;
}) {
  const { t } = useTranslation(['tasks', 'common']);
  const [choice, setChoice] = useState<DecideVerb>(verb);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      if (await onConfirm(choice === 'approve', comment.trim())) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t(choice === 'approve' ? 'fromLink.titleApprove' : 'fromLink.titleReject', { title })} size="md">
      <Stack gap="sm" data-testid="decide-from-link">
        <Text size="sm">{t('fromLink.intro')}</Text>
        <Textarea label={t('panel.comment')} autosize minRows={2} maxLength={commentMax} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Button variant="subtle" color="gray" onClick={() => setChoice(choice === 'approve' ? 'reject' : 'approve')}>
            {t(choice === 'approve' ? 'fromLink.switchToReject' : 'fromLink.switchToApprove')}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            {choice === 'approve' ? (
              <Button color="green" leftSection={<IconCheck size={16} />} loading={busy} onClick={() => void confirm()}>
                {t('panel.approve')}
              </Button>
            ) : (
              <Button color="red" leftSection={<IconX size={16} />} loading={busy} onClick={() => void confirm()}>
                {t('panel.reject')}
              </Button>
            )}
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Shown instead of the dialog when the item can no longer be decided (decided, cancelled, expired, or not by this person). */
export function DecideNotPossible({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['tasks', 'common']);
  return (
    <Alert color="gray" variant="light" withCloseButton onClose={onClose} closeButtonLabel={t('common:close')} data-testid="decide-not-possible">
      {t('fromLink.notPossible')}
    </Alert>
  );
}
