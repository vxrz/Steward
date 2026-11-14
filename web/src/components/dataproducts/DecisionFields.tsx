import { ActionIcon, Anchor, Button, Group, Paper, Select, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, DOCUMENTED_EVIDENCE_KINDS, type DocumentedDecision, type DocumentedDecisionInput, type DocumentedEvidenceKind } from '@sm/shared';
import { ContactSnapshotPicker, useContactRoleLabel, type ContactSnapshotValue } from '../contacts';
import { fmtDate, fmtDay, localToday } from '../../format';

/**
 * A documented decision (0.25.1, ADR 0038): a decision made outside Steward – in a meeting, an e-mail, a GRC tool or a
 * ticket – recorded here: who decided (contacts, frozen when it is saved), on which date, the evidence and a note.
 * Steward records who entered it. Used for access on a consumer registration, the outcome of a port access review, an
 * endorsement and the approval of a semantic model version.
 */

export interface DecisionDraft {
  decidedBy: ContactSnapshotValue[];
  decidedOn: string;
  evidence: { kind: DocumentedEvidenceKind; value: string }[];
  note: string;
}

const today = () => localToday();

export const emptyDecision = (decidedBy: ContactSnapshotValue[] = []): DecisionDraft => ({ decidedBy, decidedOn: today(), evidence: [], note: '' });

/** A stored decision as a draft (its contacts as they were frozen; an erased one cannot be named again). */
export const draftOf = (d: DocumentedDecision | null | undefined): DecisionDraft =>
  d
    ? {
        decidedBy: d.decidedBy.filter((x) => x.contactId).map((x) => ({ contactId: x.contactId!, role: x.role, name: x.name })),
        decidedOn: d.decidedOn,
        evidence: d.evidence.filter((e) => e.value).map((e) => ({ kind: e.kind, value: e.value })),
        note: d.note,
      }
    : emptyDecision();

/** What the server takes (documentedDecisionInput). */
export const toDecisionInput = (d: DecisionDraft): DocumentedDecisionInput => ({
  decidedBy: d.decidedBy.map((x) => ({ contactId: x.contactId, role: x.role.trim() || 'decider' })),
  decidedOn: d.decidedOn,
  evidence: d.evidence.filter((e) => e.value.trim()).map((e) => ({ kind: e.kind, value: e.value.trim() })),
  note: d.note.trim(),
});

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/** The problems of a draft, as field errors (translated); empty: fine. */
export function useDecisionErrors(d: DecisionDraft): { decidedBy?: string; decidedOn?: string; evidence?: string } {
  const { t } = useTranslation('dataProductGovernance');
  return {
    ...(d.decidedBy.length ? {} : { decidedBy: t('documented.decidedByRequired') }),
    ...(!/^\d{4}-\d{2}-\d{2}$/.test(d.decidedOn)
      ? { decidedOn: t('documented.dateRequired') }
      : d.decidedOn > today()
        ? { decidedOn: t('documented.dateFuture') }
        : {}),
    ...(d.evidence.some((e) => e.kind === 'url' && e.value.trim() && !isUrl(e.value)) ? { evidence: t('documented.urlInvalid') } : {}),
  };
}

export function DecisionFields({
  value,
  onChange,
  errors,
  legend,
  help,
  defaultRole,
  roles,
  testId = 'decision',
}: {
  value: DecisionDraft;
  onChange: (d: DecisionDraft) => void;
  /** Shown once the person tried to save */
  errors: { decidedBy?: string; decidedOn?: string; evidence?: string };
  legend: string;
  help?: string;
  defaultRole?: string;
  roles?: readonly string[];
  testId?: string;
}) {
  const { t } = useTranslation('dataProductGovernance');
  const set = (patch: Partial<DecisionDraft>) => onChange({ ...value, ...patch });
  return (
    <Paper withBorder p="sm" component="fieldset" data-testid={testId} style={{ margin: 0 }}>
      <Text component="legend" size="sm" fw={600} px={4}>
        {legend}
      </Text>
      <Stack gap="xs">
        {help && (
          <Text size="xs" c="dimmed">
            {help}
          </Text>
        )}
        <ContactSnapshotPicker
          label={t('documented.decidedBy')}
          description={t('documented.decidedByHelp', { max: CONTACT_LIMITS.decidedBy })}
          value={value.decidedBy}
          onChange={(decidedBy) => set({ decidedBy })}
          defaultRole={defaultRole}
          roles={roles}
          error={errors.decidedBy}
          testId={`${testId}-by`}
        />
        <TextInput
          type="date"
          label={t('documented.decidedOn')}
          value={value.decidedOn}
          max={today()}
          onChange={(e) => set({ decidedOn: e.currentTarget.value })}
          error={errors.decidedOn}
          required
          w={{ base: '100%', xs: 220 }}
          data-testid={`${testId}-on`}
        />
        <Stack gap={4}>
          <Text size="sm" fw={500} id={`${testId}-evidence-label`}>
            {t('documented.evidence')}
          </Text>
          {value.evidence.map((e, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <Select
                aria-label={t('documented.evidenceKind')}
                data={DOCUMENTED_EVIDENCE_KINDS.map((k) => ({ value: k, label: t(`documented.evidenceKinds.${k}`) }))}
                value={e.kind}
                allowDeselect={false}
                onChange={(k) => set({ evidence: value.evidence.map((x, j) => (j === i ? { ...x, kind: k as DocumentedEvidenceKind } : x)) })}
                w={150}
              />
              <TextInput
                aria-label={t(`documented.evidenceValue.${e.kind}`)}
                placeholder={t(`documented.evidenceValue.${e.kind}`)}
                value={e.value}
                onChange={(ev) => {
                  const v = ev.currentTarget.value;
                  set({ evidence: value.evidence.map((x, j) => (j === i ? { ...x, value: v } : x)) });
                }}
                style={{ flex: 1 }}
                error={e.kind === 'url' && e.value.trim() && !isUrl(e.value) ? errors.evidence : undefined}
              />
              <Tooltip label={t('documented.evidenceRemove')}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size={36}
                  aria-label={t('documented.evidenceRemove')}
                  onClick={() => set({ evidence: value.evidence.filter((_, j) => j !== i) })}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
          {value.evidence.length < 10 && (
            <Group>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlus size={14} />}
                onClick={() => set({ evidence: [...value.evidence, { kind: 'url', value: '' }] })}
                data-testid={`${testId}-evidence-add`}
              >
                {t('documented.evidenceAdd')}
              </Button>
            </Group>
          )}
        </Stack>
        <Textarea
          label={t('documented.note')}
          value={value.note}
          onChange={(e) => set({ note: e.currentTarget.value })}
          autosize
          minRows={2}
          maxLength={2000}
        />
      </Stack>
    </Paper>
  );
}

/** A recorded decision, read only: who decided when, the evidence, who recorded it. */
export function DecisionLine({ d, testId = 'decision-line' }: { d: DocumentedDecision; testId?: string }) {
  const { t } = useTranslation('dataProductGovernance');
  const roleLabel = useContactRoleLabel();
  return (
    <Stack gap={2} data-testid={testId}>
      <Text size="sm">
        {t('documented.line', {
          names: d.decidedBy.map((x) => `${x.name} (${roleLabel(x.role)})`).join(', '),
          date: fmtDay(d.decidedOn),
        })}
      </Text>
      {d.evidence.map((e, i) => (
        <Text key={i} size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {t(`documented.evidenceKinds.${e.kind}`)}:{' '}
          {e.kind === 'url' ? (
            <Anchor href={e.value} target="_blank" rel="noopener noreferrer" size="xs">
              {e.value}
            </Anchor>
          ) : e.kind === 'text' ? (
            e.value
          ) : e.label ? (
            <Anchor component={Link} to={e.kind === 'ticket' ? `/tickets/${encodeURIComponent(e.value)}` : `/records/${encodeURIComponent(e.value)}`} size="xs">
              {e.label}
            </Anchor>
          ) : (
            t('documented.evidenceHidden')
          )}
        </Text>
      ))}
      {d.note && (
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
          {d.note}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t('documented.recorded', { user: d.recordedBy, date: fmtDate(d.recordedAt) })}
      </Text>
    </Stack>
  );
}
