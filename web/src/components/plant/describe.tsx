import { useState } from 'react';
import { Badge, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { IconArrowBackUp, IconPencil } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_LIMITS } from '@sm/shared';
import { notifyError } from '../../api';
import { FormButtons } from './forms';

/**
 * Descriptions in the plant registry (0.12.0): plain text, optional. On a derived device profile a description may be
 * inherited – it says from which profile – or changed here, and then reset to the inherited one.
 */

/** A dialog that edits one description (plain text, at most PLANT_LIMITS.description characters). */
export function DescriptionModal({
  title,
  value,
  help,
  max = PLANT_LIMITS.description,
  onClose,
  onSave,
}: {
  title: string;
  value: string;
  help?: string;
  /** The length limit (device profiles keep their longer one) */
  max?: number;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const { t } = useTranslation(['plantModel', 'common']);
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened onClose={onClose} title={title}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSave(text.trim()).then(onClose, (err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm">
          <Textarea
            label={t('describe.label')}
            description={help}
            data-autofocus
            autosize
            minRows={3}
            maxRows={10}
            maxLength={max}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * A description as it is in effect, with where it comes from on a derived profile: inherited from a base (named), or
 * changed here (with "back to the inherited one"). `editable` offers to write or change it.
 */
export function DescribedText({
  text,
  inheritedFrom,
  changedHere,
  editable,
  size = 'sm',
  onEdit,
  onReset,
  testId,
}: {
  text: string;
  /** The profile it is inherited from (null: its own) */
  inheritedFrom: string | null;
  /** Changed on this profile although the item is inherited: it can go back to the inherited one */
  changedHere: boolean;
  editable: boolean;
  size?: 'xs' | 'sm';
  onEdit?: () => void;
  onReset?: () => void;
  testId?: string;
}) {
  const { t } = useTranslation('plantModel');
  if (!text && !editable) return null;
  return (
    <Stack gap={2} data-testid={testId}>
      {text && (
        <Text size={size} c={size === 'xs' ? 'dimmed' : undefined} style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
          {text}
        </Text>
      )}
      {(inheritedFrom || changedHere || editable) && (
        <Group gap={6} wrap="wrap">
          {text && inheritedFrom && (
            <Badge size="xs" variant="default" tt="none" data-testid="description-inherited">
              {t('describe.inherited', { from: inheritedFrom })}
            </Badge>
          )}
          {changedHere && (
            <Badge size="xs" variant="light" color="blue" tt="none" data-testid="description-changed">
              {t('describe.changedHere')}
            </Badge>
          )}
          {editable && onEdit && (
            <Button size="compact-xs" variant="subtle" leftSection={<IconPencil size={12} />} onClick={onEdit}>
              {!text ? t('describe.add') : inheritedFrom ? t('describe.override') : t('describe.edit')}
            </Button>
          )}
          {editable && changedHere && onReset && (
            <Button size="compact-xs" variant="subtle" leftSection={<IconArrowBackUp size={12} />} onClick={onReset}>
              {t('describe.reset')}
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}
