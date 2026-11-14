import { useEffect, useState } from 'react';
import { ActionIcon, Anchor, Button, Group, Paper, Select, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, DOCUMENTED_EVIDENCE_KINDS, type DocumentedDecision, type DocumentedDecisionInput, type DocumentedEvidenceKind } from '@sm/shared';
import { ApiError } from '../../apiError';
import { errorText } from '../../i18n/errors';
import { ContactSnapshotPicker, useContactRoleLabel, type ContactSnapshotValue } from '../contacts';
import { fmtDate, fmtDay, localToday } from '../../format';
import { EvidenceRefSelect, isItemEvidence } from './EvidenceRefSelect';

/**
 * A documented decision (0.25.1, ADR 0038): a decision made outside Steward – in a meeting, an e-mail, a GRC tool or a
 * ticket – recorded here: who decided (contacts, frozen when it is saved), on which date, the evidence and a note.
 * Steward records who entered it. Used for access on a consumer registration, the outcome of a port access review, an
 * endorsement and the approval of a semantic model version.
 */

export interface DecisionDraft {
  decidedBy: ContactSnapshotValue[];
  decidedOn: string;
  /** label: what an item named by id (record, ticket, document) is shown as */
  evidence: { kind: DocumentedEvidenceKind; value: string; label?: string }[];
  note: string;
}

/** The problems of a draft per field (translated). */
export interface DecisionErrors {
  decidedBy?: string;
  decidedOn?: string;
  evidence?: string;
}

/** The role a decider gets when none was given (the server needs one); not shown. */
const NO_ROLE = 'decider';

const today = () => localToday();

export const emptyDecision = (decidedBy: ContactSnapshotValue[] = []): DecisionDraft => ({ decidedBy, decidedOn: today(), evidence: [], note: '' });

/** A stored decision as a draft (its contacts as they were frozen; an erased one cannot be named again). */
export const draftOf = (d: DocumentedDecision | null | undefined): DecisionDraft =>
  d
    ? {
        decidedBy: d.decidedBy.filter((x) => x.contactId).map((x) => ({ contactId: x.contactId!, role: x.role, name: x.name })),
        decidedOn: d.decidedOn,
        evidence: d.evidence.filter((e) => e.value).map((e) => ({ kind: e.kind, value: e.value, ...(e.label ? { label: e.label } : {}) })),
        note: d.note,
      }
    : emptyDecision();

/** What the server takes (documentedDecisionInput). */
export const toDecisionInput = (d: DecisionDraft): DocumentedDecisionInput => ({
  decidedBy: d.decidedBy.map((x) => ({ contactId: x.contactId, role: x.role.trim() || NO_ROLE })),
  decidedOn: d.decidedOn,
  evidence: d.evidence.filter((e) => e.value.trim()).map((e) => ({ kind: e.kind, value: e.value.trim() })),
  note: d.note.trim(),
});

const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s.trim());

/** The problems of a draft, as field errors (translated); empty: fine. */
export function useDecisionErrors(d: DecisionDraft): DecisionErrors {
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

/**
 * Which field of a documented decision a server error is about: who decided (a contact not found, left, too many),
 * the date, the evidence (DATA_DECISION_INVALID with its context). `decidedBy` names the deciders, so that a left
 * contact elsewhere in the same form (an item's own contacts) is not taken for one of them.
 */
export function decisionFieldOf(e: unknown, decidedBy: readonly { name: string }[]): keyof DecisionErrors | null {
  if (!(e instanceof ApiError)) return null;
  const context = e.params?.context;
  if (e.code === 'DATA_DECISION_INVALID') return context === 'decidedOn' ? 'decidedOn' : context?.toString().startsWith('evidence') ? 'evidence' : null;
  if (e.code === 'CONTACT_DECIDED_BY_LIMIT') return 'decidedBy';
  if ((e.code === 'CONTACT_LEFT' || e.code === 'CONTACT_NOT_FOUND') && (e.code === 'CONTACT_NOT_FOUND' || decidedBy.some((x) => x.name === e.params?.name)))
    return 'decidedBy';
  return null;
}

/**
 * Server errors of a documented decision, shown at their field (and the field focused) instead of as a notice:
 * `capture(e)` is true when it took the error. They go when the draft changes.
 */
export function useDecisionServerErrors(d: DecisionDraft): { errors: DecisionErrors; capture: (e: unknown) => boolean } {
  const [errors, setErrors] = useState<DecisionErrors>({});
  useEffect(() => setErrors({}), [d]);
  const capture = (e: unknown): boolean => {
    const field = decisionFieldOf(e, d.decidedBy);
    if (!field) return false;
    setErrors({ [field]: errorText(e) });
    requestAnimationFrame(() => {
      const box = `[data-decision-field="${field}"]`;
      (document.querySelector<HTMLElement>(`${box} [aria-invalid="true"]`) ?? document.querySelector<HTMLElement>(`${box}[tabindex]`))?.focus();
    });
    return true;
  };
  return { errors, capture };
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
  errors: DecisionErrors;
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
        <div data-decision-field="decidedBy" tabIndex={-1} style={{ outline: 'none' }}>
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
        </div>
        <TextInput
          type="date"
          label={t('documented.decidedOn')}
          value={value.decidedOn}
          max={today()}
          onChange={(e) => set({ decidedOn: e.currentTarget.value })}
          error={errors.decidedOn}
          required
          w={{ base: '100%', xs: 220 }}
          wrapperProps={{ 'data-decision-field': 'decidedOn' }}
          data-testid={`${testId}-on`}
        />
        <Stack gap={4} data-decision-field="evidence" tabIndex={-1} style={{ outline: 'none' }} role="group" aria-labelledby={`${testId}-evidence-label`}>
          <Text size="sm" fw={500} id={`${testId}-evidence-label`}>
            {t('documented.evidence')}
          </Text>
          {value.evidence.map((e, i) => {
            const setRow = (patch: Partial<DecisionDraft['evidence'][number]>) =>
              set({ evidence: value.evidence.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            // an address that is not one, else (the server's answer) the items named
            const badUrl = (x: { kind: string; value: string }) => x.kind === 'url' && !!x.value.trim() && !isUrl(x.value);
            const invalid = !!errors.evidence && (badUrl(e) || (isItemEvidence(e.kind) && !value.evidence.some(badUrl)));
            return (
              <Group key={i} gap="xs" wrap="wrap" align="flex-start">
                <Select
                  aria-label={t('documented.evidenceKind')}
                  data={DOCUMENTED_EVIDENCE_KINDS.map((k) => ({ value: k, label: t(`documented.evidenceKinds.${k}`) }))}
                  value={e.kind}
                  allowDeselect={false}
                  // an id of a document is no ticket and no address: another kind starts empty
                  onChange={(k) =>
                    setRow(
                      isItemEvidence(e.kind) || isItemEvidence(k ?? '')
                        ? { kind: k as DocumentedEvidenceKind, value: '', label: undefined }
                        : { kind: k as DocumentedEvidenceKind },
                    )
                  }
                  w={{ base: '100%', xs: 170 }}
                  data-testid={`${testId}-evidence-kind`}
                />
                <Group gap="xs" wrap="nowrap" align="flex-start" style={{ flex: 1, minWidth: 200 }}>
                  {isItemEvidence(e.kind) ? (
                    <EvidenceRefSelect
                      kind={e.kind}
                      value={e.value}
                      label={e.label}
                      onChange={(id, label) => setRow({ value: id, label })}
                      ariaLabel={t(`documented.evidenceKinds.${e.kind}`)}
                      error={invalid}
                      testId={`${testId}-evidence-ref`}
                    />
                  ) : (
                    <TextInput
                      aria-label={t(`documented.evidenceKinds.${e.kind}`)}
                      placeholder={t(`documented.evidenceValue.${e.kind}`)}
                      value={e.value}
                      maxLength={2000}
                      onChange={(ev) => setRow({ value: ev.currentTarget.value })}
                      style={{ flex: 1, minWidth: 0 }}
                      error={invalid}
                      data-testid={`${testId}-evidence-value`}
                    />
                  )}
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
              </Group>
            );
          })}
          {errors.evidence && (
            <Text size="xs" c="red" role="alert" data-testid={`${testId}-evidence-error`}>
              {errors.evidence}
            </Text>
          )}
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
          maxLength={CONTACT_LIMITS.note}
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
          // a decider recorded without a role is named alone
          names: d.decidedBy.map((x) => (x.role && x.role !== NO_ROLE ? `${x.name} (${roleLabel(x.role)})` : x.name)).join(', '),
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
