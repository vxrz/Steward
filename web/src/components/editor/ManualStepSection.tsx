import { ActionIcon, Box, Button, Divider, Group, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { MANUAL_FIELD_TYPES, MANUAL_LIMITS, type ManualFieldDef, type ManualUse, type ManualVerificationConfig, type NodeOf } from '@sm/shared';
import { SubjectsField } from './fields';

type Node = NodeOf<'userTask'>;

/** Settings of a manual step (user task mode "manual"): checklist, fields, evidence, verification, after-the-fact entries. */
export function ManualStepSection({ node, onChange }: { node: Node; onChange: (patch: Partial<Node>) => void }) {
  const { t } = useTranslation('editor');
  const checklist = node.checklist ?? [];
  const fields = node.fields ?? [];
  const verification = node.verification ?? {};
  const setVerification = (patch: Partial<ManualVerificationConfig>) => {
    const next: ManualVerificationConfig = { ...verification, ...patch };
    for (const k of Object.keys(next) as (keyof ManualVerificationConfig)[]) if (next[k] === undefined) delete next[k];
    onChange({ verification: Object.keys(next).length ? next : undefined });
  };
  const useOptions = (['off', 'optional', 'required'] as const).map((u) => ({ value: u, label: t(`manual.use.${u}`) }));

  const move = <T,>(list: T[], i: number, d: number): T[] => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    return next;
  };
  const setField = (i: number, patch: Partial<ManualFieldDef>) => onChange({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const newFieldId = () => {
    let n = fields.length + 1;
    while (fields.some((f) => f.id === `field${n}`)) n++;
    return `field${n}`;
  };

  return (
    <Paper withBorder p="sm">
      <Stack gap="sm">
        <Text size="sm" fw={600}>
          {t('manual.title')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('manual.intro')}
        </Text>

        <Divider label={t('manual.checklist')} labelPosition="left" />
        {checklist.map((item, i) => (
          <Group key={i} gap={4} wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              aria-label={t('manual.checklistItem', { n: i + 1 })}
              value={item}
              maxLength={MANUAL_LIMITS.checklistItemChars}
              onChange={(e) => onChange({ checklist: checklist.map((c, j) => (j === i ? e.currentTarget.value : c)) })}
            />
            <ActionIcon variant="subtle" disabled={i === 0} aria-label={t('manual.moveUp')} onClick={() => onChange({ checklist: move(checklist, i, -1) })}>
              <IconArrowUp size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              disabled={i === checklist.length - 1}
              aria-label={t('manual.moveDown')}
              onClick={() => onChange({ checklist: move(checklist, i, 1) })}
            >
              <IconArrowDown size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('manual.removeItem', { n: i + 1 })}
              onClick={() => {
                const next = checklist.filter((_, j) => j !== i);
                onChange({ checklist: next.length ? next : undefined });
              }}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        ))}
        <Group justify="space-between" wrap="wrap">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            disabled={checklist.length >= MANUAL_LIMITS.checklistItems}
            onClick={() => onChange({ checklist: [...checklist, t('manual.newItem')] })}
          >
            {t('manual.addItem')}
          </Button>
          <Switch
            size="xs"
            label={t('manual.allRequired')}
            checked={!!node.checklistAllRequired}
            onChange={(e) => onChange({ checklistAllRequired: e.currentTarget.checked || undefined })}
          />
        </Group>

        <Divider label={t('manual.fields')} labelPosition="left" />
        {fields.map((f, i) => (
          <Paper key={i} withBorder p="xs">
            <Stack gap={6}>
              <Group gap="xs" wrap="wrap" align="flex-end">
                <TextInput
                  size="xs"
                  label={t('manual.fieldLabel')}
                  value={f.label}
                  style={{ flex: 2, minWidth: 140 }}
                  onChange={(e) => setField(i, { label: e.currentTarget.value })}
                />
                <TextInput
                  size="xs"
                  label={t('manual.fieldId')}
                  classNames={{ input: 'mono' }}
                  value={f.id}
                  style={{ flex: 1, minWidth: 100 }}
                  onChange={(e) => setField(i, { id: e.currentTarget.value })}
                />
                <Select
                  size="xs"
                  label={t('manual.fieldType')}
                  allowDeselect={false}
                  data={MANUAL_FIELD_TYPES.map((x) => ({ value: x, label: t(`manual.type.${x}`) }))}
                  value={f.type}
                  style={{ flex: 1, minWidth: 120 }}
                  onChange={(v) => v && setField(i, { type: v as ManualFieldDef['type'] })}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('manual.removeField', { name: f.label || f.id })}
                  onClick={() => onChange({ fields: fields.filter((_, j) => j !== i).length ? fields.filter((_, j) => j !== i) : undefined })}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
              <TextInput
                size="xs"
                label={t('manual.fieldHint')}
                value={f.hint ?? ''}
                onChange={(e) => setField(i, { hint: e.currentTarget.value || undefined })}
              />
              <SegmentedControl
                size="xs"
                aria-label={t('manual.fieldUse', { name: f.label || f.id })}
                data={useOptions}
                value={f.use ?? 'optional'}
                onChange={(v) => setField(i, { use: v === 'optional' ? undefined : (v as ManualUse) })}
              />
            </Stack>
          </Paper>
        ))}
        <Group>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPlus size={14} />}
            disabled={fields.length >= MANUAL_LIMITS.fields}
            onClick={() => onChange({ fields: [...fields, { id: newFieldId(), type: 'text', label: t('manual.newField') }] })}
          >
            {t('manual.addField')}
          </Button>
        </Group>

        <Divider label={t('manual.evidence')} labelPosition="left" />
        <Box>
          <Text size="xs" c="dimmed" mb={4}>
            {t('manual.evidenceHint')}
          </Text>
          <SegmentedControl
            size="xs"
            aria-label={t('manual.evidence')}
            data={useOptions}
            value={node.evidence ?? 'optional'}
            onChange={(v) => onChange({ evidence: v === 'optional' ? undefined : (v as ManualUse) })}
          />
        </Box>

        <Divider label={t('manual.verification')} labelPosition="left" />
        <Switch
          label={t('manual.verificationRequired')}
          description={t('manual.verificationHint')}
          checked={!!verification.required}
          onChange={(e) => setVerification({ required: e.currentTarget.checked || undefined })}
        />
        <SubjectsField
          label={t('manual.verifiers')}
          description={t('manual.verifiersHint')}
          value={verification.verifiers}
          onChange={(v) => setVerification({ verifiers: (v as string[] | undefined) ?? undefined })}
        />
        <Switch
          label={t('manual.notRunStarter')}
          checked={!!verification.notRunStarter}
          onChange={(e) => setVerification({ notRunStarter: e.currentTarget.checked || undefined })}
        />
        <Select
          label={t('manual.onReject')}
          allowDeselect={false}
          data={[
            { value: 'return', label: t('manual.onRejectReturn') },
            { value: 'fail', label: t('manual.onRejectFail') },
          ]}
          value={verification.onReject ?? 'return'}
          onChange={(v) => setVerification({ onReject: v === 'fail' ? 'fail' : undefined })}
        />

        <Divider label={t('manual.late')} labelPosition="left" />
        <NumberInput
          label={t('manual.backdateDays')}
          description={t('manual.backdateHint', { max: MANUAL_LIMITS.backdateDays })}
          min={0}
          max={MANUAL_LIMITS.backdateDays}
          clampBehavior="strict"
          value={node.backdateDays ?? 0}
          onChange={(v) => onChange({ backdateDays: Number(v) > 0 ? Math.min(MANUAL_LIMITS.backdateDays, Math.floor(Number(v))) : undefined })}
        />
      </Stack>
    </Paper>
  );
}
