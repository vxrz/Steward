import { useState } from 'react';
import { Badge, Button, Group, Modal, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ADVISORY_LIMITS,
  ADVISORY_REMEDIATIONS,
  type AdvisoryAssetMatch,
  type AdvisoryMatchReason,
  type AdvisoryRemediationStatus,
  type AdvisorySeverity,
  type AdvisoryStatus,
  type AdvisoryZoneRef,
  type MaintenanceList,
  type PlantChangeSetList,
} from '@sm/shared';
import { get, notifyError, put } from '../../../api';
import { fmtDate, fmtNumber, localToday } from '../../../format';

/** Security advisories (0.14, docs/ADVISORIES.md): what the list, the advisory page and the asset page share. */

export const SEVERITY_COLOR: Record<AdvisorySeverity, string> = {
  critical: 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'blue',
  none: 'gray',
  unknown: 'gray',
};
const STATUS_COLOR: Record<AdvisoryStatus, string> = { open: 'red', mitigated: 'green', not_applicable: 'gray', unaffected: 'gray' };
const REMEDIATION_COLOR: Record<AdvisoryRemediationStatus, string> = {
  open: 'red',
  planned: 'blue',
  mitigated: 'green',
  accepted: 'yellow',
  not_affected: 'gray',
};

export function SeverityBadge({ severity, cvss, size = 'sm' }: { severity: AdvisorySeverity; cvss?: number | null; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('plantAdvisories');
  return (
    <Badge
      size={size}
      color={SEVERITY_COLOR[severity]}
      variant={severity === 'critical' || severity === 'high' ? 'filled' : 'light'}
      data-testid="advisory-severity"
    >
      {t(`severity.${severity}`)}
      {cvss !== null && cvss !== undefined ? ` ${fmtNumber(cvss, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}` : ''}
    </Badge>
  );
}

export function AdvisoryStatusBadge({ status }: { status: AdvisoryStatus }) {
  const { t } = useTranslation('plantAdvisories');
  return (
    <Badge size="sm" variant="light" color={STATUS_COLOR[status]} data-testid="advisory-status">
      {t(`status.${status}`)}
    </Badge>
  );
}

export function RemediationBadge({ m }: { m: Pick<AdvisoryAssetMatch, 'remediation'> }) {
  const { t } = useTranslation('plantAdvisories');
  const r = m.remediation;
  return (
    <Badge size="sm" variant="light" color={r.expired ? 'red' : REMEDIATION_COLOR[r.status]} data-testid="remediation-status">
      {r.expired ? t('remediation.expired') : t(`remediation.${r.status}`)}
    </Badge>
  );
}

export function zoneText(t: (k: 'detail.zoneSl' | 'detail.zoneSlOpen', o: Record<string, unknown>) => string, z: AdvisoryZoneRef): string {
  return z.slTarget === null ? t('detail.zoneSlOpen', { zone: z.name }) : t('detail.zoneSl', { zone: z.name, sl: z.slTarget });
}

/** Why an asset matches, in the reader's language: vendor · model · firmware (· via profile). */
export function ReasonLine({ r }: { r: AdvisoryMatchReason }) {
  const { t } = useTranslation('plantAdvisories');
  const parts = [
    t(`reason.vendor.${r.vendor.how}`, { value: r.vendor.advisory, asset: r.vendor.asset }),
    t(`reason.model.${r.model.how}`, { value: r.model.advisory, asset: r.model.asset }),
    t(`reason.version.${r.version.how}`, { value: r.version.advisory, asset: r.version.asset }),
    ...(r.via === 'profile' && r.profileId ? [t('reason.viaProfile', { profile: r.profileId })] : []),
    ...(r.status === 'under_investigation' ? [t('reason.underInvestigation')] : []),
  ];
  return (
    <Text size="xs" style={{ overflowWrap: 'anywhere' }} title={r.text} data-testid="match-reason">
      {parts.join(' · ')}
    </Text>
  );
}

/** Confirm or dismiss a possible match (a reason is needed to dismiss). */
export function DecisionModal({
  advisoryId,
  match,
  decision,
  onClose,
  onSaved,
}: {
  advisoryId: string;
  match: AdvisoryAssetMatch;
  decision: 'confirmed' | 'dismissed';
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/plant/advisories/${encodeURIComponent(advisoryId)}/assets/${encodeURIComponent(match.assetId)}/decision`, {
        decision,
        reason: reason.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t(decision === 'confirmed' ? 'match.confirmTitle' : 'match.dismissTitle', { asset: match.assetName })}>
      <Stack>
        <Textarea
          label={decision === 'dismissed' ? t('match.reasonDismiss') : t('match.reason')}
          required={decision === 'dismissed'}
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          maxLength={ADVISORY_LIMITS.reasonChars}
          autosize
          minRows={2}
          data-autofocus
          data-testid="decision-reason"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={decision === 'dismissed' && !reason.trim()} data-testid="decision-save">
            {t(decision === 'confirmed' ? 'match.confirm' : 'match.dismiss')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The remediation of one affected asset: status, reason, until (accepted), a maintenance window or change set (planned). */
export function RemediationModal({
  advisoryId,
  match,
  onClose,
  onSaved,
}: {
  advisoryId: string;
  match: AdvisoryAssetMatch;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['plantAdvisories', 'common']);
  const r = match.remediation;
  const [status, setStatus] = useState<AdvisoryRemediationStatus>(r.status);
  const [reason, setReason] = useState(r.reason);
  const [until, setUntil] = useState(r.until ?? '');
  const [windowId, setWindowId] = useState<string | null>(r.windowId);
  const [changeSetId, setChangeSetId] = useState<string | null>(r.changeSetId);
  const [note, setNote] = useState(r.note);
  const [busy, setBusy] = useState(false);
  const windows = useQuery({
    queryKey: ['maintenance', 'advisory-choice'],
    queryFn: () => get<MaintenanceList>('/maintenance-windows'),
    enabled: status === 'planned',
    retry: false,
  });
  const changeSets = useQuery({
    queryKey: ['plant', 'change-sets', 'advisory-choice'],
    queryFn: () => get<PlantChangeSetList>('/plant/change-sets?box=mine'),
    enabled: status === 'planned',
    retry: false,
  });
  const needsReason = status === 'accepted' || status === 'not_affected';
  const save = async () => {
    setBusy(true);
    try {
      await put(`/plant/advisories/${encodeURIComponent(advisoryId)}/assets/${encodeURIComponent(match.assetId)}/remediation`, {
        status,
        reason: reason.trim(),
        until: status === 'accepted' ? until || null : null,
        windowId: status === 'planned' ? windowId : null,
        changeSetId: status === 'planned' ? changeSetId : null,
        note: note.trim(),
      });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('fix.title', { asset: match.assetName })}>
      <Stack>
        {match.fixes.length > 0 && (
          <Text size="sm" data-testid="suggested-fix">
            {t('fix.suggested', { versions: match.fixes.map((f) => f.version).join(', ') })}
          </Text>
        )}
        <Select
          label={t('fix.status')}
          value={status}
          onChange={(v) => v && setStatus(v as AdvisoryRemediationStatus)}
          data={ADVISORY_REMEDIATIONS.map((s) => ({ value: s, label: t(`remediation.${s}`) }))}
          allowDeselect={false}
          data-testid="remediation-select"
        />
        {status === 'planned' && (
          <>
            <Select
              label={t('fix.window')}
              clearable
              searchable
              value={windowId}
              onChange={setWindowId}
              placeholder={t('fix.windowNone')}
              data={(windows.data?.windows ?? []).map((w) => ({ value: w.id, label: `${w.title} (${fmtDate(w.startsAt)})` }))}
            />
            <Select
              label={t('fix.changeSet')}
              clearable
              searchable
              value={changeSetId}
              onChange={setChangeSetId}
              placeholder={t('fix.changeSetNone')}
              data={(changeSets.data?.items ?? []).map((c) => ({ value: c.id, label: c.title }))}
            />
          </>
        )}
        {(needsReason || status === 'planned' || status === 'mitigated') && (
          <Textarea
            label={t('fix.reason')}
            required={needsReason}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            maxLength={ADVISORY_LIMITS.reasonChars}
            autosize
            minRows={2}
            data-testid="remediation-reason"
          />
        )}
        {status === 'accepted' && (
          <TextInput
            type="date"
            label={t('fix.until')}
            required
            value={until}
            min={localToday()}
            onChange={(e) => setUntil(e.currentTarget.value)}
            data-testid="remediation-until"
          />
        )}
        <Textarea
          label={t('fix.note')}
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
          maxLength={ADVISORY_LIMITS.reasonChars}
          autosize
          minRows={1}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={(needsReason && !reason.trim()) || (status === 'accepted' && !until)} data-testid="remediation-save">
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
