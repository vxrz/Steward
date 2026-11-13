import { useState } from 'react';
import { Badge, Button, Group, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconRosetteDiscountCheck, IconRosette } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataProduct } from '@sm/shared';
import { del, put } from '../../../api';
import { confirmDanger } from '../../../components/confirm';
import { useFieldErrors } from '../../../components/common';
import { FormModal } from '../../../components/FormModal';
import { useSubjectLabel } from '../../../components/SubjectsInput';
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
 * The endorsement of a product (ADR 0036 part 17): who endorsed it and until when, whether it needs a review, and –
 * for the owners of its domain – _Endorse_, _Endorse again_ and _Revoke_. Maturity 5 counts a valid one on top of 4.
 */
export function EndorsementSection({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const q = useEndorsement(p.id);
  const invalidate = useInvalidateGovernance();
  const subject = useSubjectLabel();
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
                {t('endorsement.line', { user: e.endorsedBy, date: fmtDay(e.endorsedAt), review: fmtDay(e.reviewDate) })}
              </Text>
            </Group>
            {e.review && (
              <Text size="sm" c={e.valid ? 'orange' : 'red'} data-testid="endorsement-review">
                {t(`endorsement.reviews.${e.review}`, { date: fmtDay(e.reviewDate) })}
              </Text>
            )}
            {e.note && (
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
          {v.endorsers.length ? t('endorsement.endorsers', { list: v.endorsers.map(subject).join(', ') }) : t('endorsement.managers')}
          {v.whyNot === 'ownProduct' && ` ${t('endorsement.ownProduct')}`}
        </Text>
      </Stack>
      {editing && (
        <EndorseForm
          p={p}
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

function EndorseForm({ p, onClose, onSaved }: { p: DataProduct; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const [reviewDate, setReviewDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, run] = useBusy();
  const v = useFieldErrors({ reviewDate: !!reviewDate && !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate) && t('common:validation.invalid') });
  const save = () =>
    run(async () => {
      await put(`/data-products/${enc(p.id)}/endorsement`, { reviewDate: reviewDate || null, note: note.trim() });
      onSaved();
    });
  return (
    <FormModal onClose={onClose} title={t('endorsement.formTitle', { name: p.name })}>
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
          <TextInput
            label={t('endorsement.reviewDate')}
            description={t('endorsement.reviewDateHelp')}
            placeholder="2027-11-30"
            value={reviewDate}
            onChange={(e) => setReviewDate(e.currentTarget.value)}
            error={v.error('reviewDate')}
            data-testid="endorse-review-date"
          />
          <Textarea
            label={t('endorsement.note')}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            autosize
            minRows={2}
            data-testid="endorse-note"
          />
          <FormButtons busy={busy} submit={t('endorsement.endorse')} testId="endorse-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
