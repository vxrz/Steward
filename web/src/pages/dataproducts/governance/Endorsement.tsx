import { useState } from 'react';
import { Badge, Button, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconRosetteDiscountCheck, IconRosette } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ContactLink, DataProduct } from '@sm/shared';
import { del, notifyOk, put } from '../../../api';
import { confirmDanger } from '../../../components/confirm';
import { useFieldErrors } from '../../../components/common';
import { FormModal } from '../../../components/FormModal';
import {
  DecisionFields,
  DecisionLine,
  emptyDecision,
  toDecisionInput,
  useDecisionErrors,
  useDecisionServerErrors,
  type DecisionDraft,
} from '../../../components/dataproducts/DecisionFields';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDay } from '../../../format';
import { Section } from '../parts';
import { useEndorsement, useInvalidateGovernance } from './api';

const enc = encodeURIComponent;

/** The endorsement badge of the header: endorsed (valid), or needing a review. */
export function EndorsementBadge({ productId }: { productId: string }) {
  const { t } = useTranslation('dataProductGovernance');
  const q = useEndorsement(productId);
  const e = q.data?.endorsement;
  if (!e) return null;
  return (
    <Badge
      variant={e.valid ? 'filled' : 'outline'}
      color={e.valid ? 'teal' : 'orange'}
      tt="none"
      leftSection={e.valid ? <IconRosetteDiscountCheck size={12} aria-hidden /> : <IconRosette size={12} aria-hidden />}
      data-testid="product-endorsed-badge"
    >
      {e.valid ? t('endorsement.badge') : t('endorsement.badgeReview')}
    </Badge>
  );
}

/**
 * The endorsement of a product (ADR 0036 part 17; 0.25.1, ADR 0038 part 5): who endorsed it elsewhere – contacts,
 * typically the owners of its domain – when and until when, the evidence, whether it needs a review; its IT
 * maintainers record it (_Record endorsement_, _Record again_, _Remove_). Maturity 5 counts a valid one on top of 4.
 */
export function EndorsementSection({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const q = useEndorsement(p.id);
  const invalidate = useInvalidateGovernance();
  const [editing, setEditing] = useState(false);
  const [busy, run] = useBusy();
  const v = q.data;
  if (!v) return null;
  const e = v.endorsement;
  const revoke = async () => {
    if (!(await confirmDanger({ action: 'remove', message: t('endorsement.revokeConfirm', { name: p.name }) }))) return;
    await run(async () => {
      await del(`/data-products/${enc(p.id)}/endorsement`);
      invalidate();
    });
  };
  return (
    <Section
      title={t('endorsement.title')}
      testId="product-endorsement"
      actions={
        v.mayEndorse && (
          <>
            <Button size="xs" variant="default" leftSection={<IconRosetteDiscountCheck size={14} />} onClick={() => setEditing(true)} data-testid="endorse">
              {e ? t('endorsement.again') : t('endorsement.endorse')}
            </Button>
            {e && (
              <Button size="xs" variant="subtle" color="red" loading={busy} onClick={() => void revoke()} data-testid="endorse-revoke">
                {t('endorsement.revoke')}
              </Button>
            )}
          </>
        )
      }
    >
      <Stack gap={4}>
        {e ? (
          <>
            <Group gap="xs">
              <EndorsementBadge productId={p.id} />
              <Text size="sm" data-testid="endorsement-line">
                {t('endorsement.line', { review: fmtDay(e.reviewDate) })}
              </Text>
            </Group>
            {e.decision && <DecisionLine d={e.decision} testId="endorsement-decision" />}
            {e.review && (
              <Text size="sm" c={e.valid ? 'orange' : 'red'} data-testid="endorsement-review">
                {t(`endorsement.reviews.${e.review}`, { date: fmtDay(e.reviewDate) })}
              </Text>
            )}
            {e.note && !e.decision?.note && (
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {e.note}
              </Text>
            )}
          </>
        ) : (
          <Text size="sm" c="dimmed">
            {t('endorsement.none')}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          {v.domainOwners.length ? t('endorsement.endorsers', { list: v.domainOwners.map((l) => l.contact.name).join(', ') }) : t('endorsement.managers')}
        </Text>
      </Stack>
      {editing && (
        <EndorseForm
          p={p}
          suggested={v.domainOwners}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            invalidate();
          }}
        />
      )}
    </Section>
  );
}

function EndorseForm({ p, suggested, onClose, onSaved }: { p: DataProduct; suggested: ContactLink[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const [reviewDate, setReviewDate] = useState('');
  // the domain's owners are offered first: who typically endorses
  const [decision, setDecision] = useState<DecisionDraft>(
    emptyDecision(suggested.filter((l) => l.contact.status === 'active').map((l) => ({ contactId: l.contact.id, name: l.contact.name, role: 'domainOwner' }))),
  );
  const decisionErrors = useDecisionErrors(decision);
  const server = useDecisionServerErrors(decision);
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    reviewDate: !!reviewDate && !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) && t('common:validation.invalid'),
    decision: Object.values(decisionErrors).find(Boolean),
  });
  const save = () =>
    run(async () => {
      try {
        await put(`/data-products/${enc(p.id)}/endorsement`, { reviewDate: reviewDate || null, decision: toDecisionInput(decision) });
      } catch (e) {
        if (server.capture(e)) return;
        throw e;
      }
      notifyOk(t('endorsement.saved'));
      onSaved();
    });
  return (
    <FormModal onClose={onClose} size="lg" title={t('endorsement.formTitle', { name: p.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('endorsement.formHelp')}
          </Text>
          <DecisionFields
            legend={t('endorsement.decision')}
            value={decision}
            onChange={setDecision}
            errors={{ ...(v.error('decision') ? decisionErrors : {}), ...server.errors }}
            defaultRole="domainOwner"
            roles={['domainOwner', 'dataOwner', 'productOwner']}
            testId="endorse-decision"
          />
          <TextInput
            type="date"
            label={t('endorsement.reviewDate')}
            description={t('endorsement.reviewDateHelp')}
            value={reviewDate}
            onChange={(e) => setReviewDate(e.currentTarget.value)}
            error={v.error('reviewDate')}
            data-testid="endorse-review-date"
          />
          <FormButtons busy={busy} submit={t('endorsement.record')} testId="endorse-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
