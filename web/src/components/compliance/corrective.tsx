import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, MultiSelect, SegmentedControl, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  CA_LIMITS,
  CA_MANUAL_SOURCES,
  CA_SEVERITIES,
  type CaAction,
  type CaFinding,
  type CaFindingList,
  type CaSeverity,
  type CaStatus,
  type CaSuggestion,
  type Control,
  type ServiceSummary,
  type Subject,
  type SupplierRef,
} from '@sm/shared';
import { get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { TONE, useFieldErrors } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { fmtDay } from '../../format';
import { correctiveKeys } from '../../queryKeys';
import { SupplierPicker, useSupplierChoice } from '../suppliers/SupplierPicker';

/** Shared pieces of the register of corrective actions (ADR 0029): badges, the forms and the panel on Controls. */

const STATUS_TONE: Record<CaStatus, string> = {
  open: TONE.person,
  inProgress: TONE.active,
  implemented: TONE.soon,
  closed: TONE.ok,
  cancelled: TONE.neutral,
};
const SEVERITY_TONE: Record<CaSeverity, string> = { major: TONE.bad, minor: TONE.attention, observation: TONE.neutral };

export function CaStatusBadge({ status, size = 'sm' }: { status: CaStatus; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('corrective');
  return (
    <Badge color={STATUS_TONE[status]} variant="light" size={size} style={{ minWidth: 'max-content' }} data-testid="ca-status">
      {t(`statuses.${status}`)}
    </Badge>
  );
}

export function CaSeverityBadge({ severity, size = 'sm' }: { severity: CaSeverity; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('corrective');
  return (
    <Badge color={SEVERITY_TONE[severity]} variant="outline" size={size} style={{ minWidth: 'max-content' }}>
      {t(`severities.${severity}`)}
    </Badge>
  );
}

/** A calendar date YYYY-MM-DD in the browser's format (as a local day, not midnight UTC). */
export function calDay(s: string | null | undefined): string {
  if (!s) return '–';
  const [y, m, d] = s.split('-').map(Number);
  return fmtDay(new Date(y!, m! - 1, d!));
}

const DAY = 86_400_000;
const inDays = (n: number) => {
  const d = new Date(Date.now() + n * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The translated title of a suggestion (its details), the stored English title otherwise. The server fills in the names
 * of what it came from only where the reader may see them (`hidden` otherwise): then, and with `neutral` – the title a
 * confirmed finding starts with, read by everyone who reads the register – the title names nothing.
 */
export function useSuggestionTitle(): (s: CaSuggestion, opts?: { neutral?: boolean }) => string {
  const { t } = useTranslation('corrective');
  return (s, opts = {}) => {
    const d = s.details;
    const which = opts.neutral || d.hidden ? 'neutralTitles' : 'titles';
    switch (d.kind) {
      case 'dutyMissed':
      case 'dutyFailed':
        return t(`suggestions.${which}.${d.kind}`, { ...d, level: t(`suggestions.levels.${d.level === 'recommended' ? 'recommended' : 'mandatory'}`) });
      case 'incident':
      case 'personReview':
      case 'reconciliation':
      case 'supplierCertificate':
      case 'supplierReviewMissed':
      case 'supplierReviewFailed':
        return t(`suggestions.${which}.${d.kind}`, d);
      default:
        return s.title;
    }
  };
}

// ---------- pickers ----------

function useServices() {
  return useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
}

function useControls() {
  return useQuery({ queryKey: ['compliance', 'controls', 'all'], queryFn: () => get<Control[]>('/compliance/controls'), staleTime: 60_000 });
}

function useUsers() {
  return useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []), retry: false, staleTime: 60_000 });
}

// ---------- the finding form: record, change, confirm a suggestion ----------

export function FindingForm({
  finding,
  suggestion,
  preset,
  onClose,
  onSaved,
}: {
  finding?: CaFinding;
  suggestion?: CaSuggestion;
  /** A new finding from a supplier's page: the supplier and the source supplier review */
  preset?: { supplier: { id: string; name: string; status: SupplierRef['status'] } };
  onClose: () => void;
  onSaved: (f: CaFinding) => void;
}) {
  const { t } = useTranslation(['corrective', 'common']);
  const suggestionTitle = useSuggestionTitle();
  const services = useServices();
  const controls = useControls();
  const users = useUsers();
  // a confirmed finding starts with the neutral title: everyone who reads the register reads it, and the names of its
  // source are shown through its link, with each reader's rights
  const [title, setTitle] = useState(finding?.title ?? (suggestion ? suggestionTitle(suggestion, { neutral: true }).slice(0, CA_LIMITS.title) : ''));
  const [description, setDescription] = useState(finding?.description ?? '');
  const [source, setSource] = useState<string>(preset ? 'supplierReview' : 'internalAudit');
  const [sourceLabel, setSourceLabel] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [severity, setSeverity] = useState<CaSeverity>(finding?.severity ?? suggestion?.severity ?? 'minor');
  const [serviceId, setServiceId] = useState<string | null>(finding?.serviceId ?? suggestion?.serviceId ?? null);
  // the supplier: sent only when the person changed it, so a supplier they may not see is never cleared by saving
  const initialSupplier = finding?.supplierId
    ? finding.supplierName
      ? { id: finding.supplierId, name: finding.supplierName, status: 'active' as const }
      : null
    : suggestion?.supplierId && suggestion.supplierName
      ? { id: suggestion.supplierId, name: suggestion.supplierName, status: 'active' as const }
      : (preset?.supplier ?? null);
  const supplier = useSupplierChoice(initialSupplier);
  const [controlIds, setControlIds] = useState<string[]>(finding?.controls.map((c) => c.id) ?? suggestion?.controls.map((c) => c.id) ?? []);
  const [owner, setOwner] = useState<string | null>(finding?.owner ?? null);
  const [dueDate, setDueDate] = useState(finding?.dueDate ?? (finding ? '' : inDays(30)));
  const [cause, setCause] = useState(finding?.cause ?? '');
  const [grcRef, setGrcRef] = useState(finding?.grcRef ?? '');
  const [grcUrl, setGrcUrl] = useState(finding?.grcUrl ?? '');
  const [busy, setBusy] = useState(false);
  const url = (v: string) => v.trim() !== '' && !/^https?:\/\/\S+$/i.test(v.trim()) && t('common:validation.url');
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    dueDate: dueDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && t('common:validation.required'),
    sourceUrl: url(sourceUrl),
    grcUrl: url(grcUrl),
  });
  const serviceData = useMemo(
    () => [...(services.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ value: s.id, label: s.name })),
    [services.data],
  );
  const controlData = useMemo(() => {
    const known = new Set((controls.data ?? []).map((c) => c.id));
    return [
      ...(controls.data ?? []).map((c) => ({ value: c.id, label: `${c.catalogueKey} ${c.ref} – ${c.title}` })),
      // controls of the finding the list does not hold (yet): keep them visible
      ...[...(finding?.controls ?? []), ...(suggestion?.controls ?? [])]
        .filter((c) => !known.has(c.id))
        .map((c) => ({ value: c.id, label: `${c.catalogueKey} ${c.ref} – ${c.title}` })),
    ];
  }, [controls.data, finding, suggestion]);
  const userData = useMemo(() => {
    const list = (users.data ?? [])
      .filter((s) => s.kind === 'user')
      .map((s) => ({ value: s.value.replace(/^user:/, ''), label: s.value.replace(/^user:/, '') }));
    if (owner && !list.some((x) => x.value === owner)) list.push({ value: owner, label: owner });
    return list;
  }, [users.data, owner]);
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      title: title.trim(),
      description,
      severity,
      serviceId,
      ...(supplier.body !== undefined ? { supplierId: supplier.body } : !finding && !suggestion && preset ? { supplierId: preset.supplier.id } : {}),
      controlIds,
      owner,
      dueDate: dueDate || null,
      cause,
      grcRef: grcRef.trim(),
      grcUrl: grcUrl.trim(),
    };
    try {
      const f = finding
        ? await put<CaFinding>(`/compliance/corrective-actions/${finding.id}`, body)
        : suggestion
          ? await post<CaFinding>(`/compliance/corrective-suggestions/${suggestion.id}/confirm`, body)
          : await post<CaFinding>('/compliance/corrective-actions', { ...body, source, sourceLabel: sourceLabel.trim(), sourceUrl: sourceUrl.trim() });
      notifyOk(finding ? t('form.saved') : suggestion ? t('form.confirmed', { number: f.number }) : t('form.created', { number: f.number }));
      onSaved(f);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      size="lg"
      title={finding ? t('form.editTitle', { number: finding.number }) : suggestion ? t('form.confirmTitle') : t('form.newTitle')}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="ca-finding-form">
          {suggestion && (
            <Text size="sm" c="dimmed">
              {t('form.confirmIntro')} {t('form.confirmNeutral')}
            </Text>
          )}
          <TextInput
            label={t('fields.title')}
            required
            maxLength={CA_LIMITS.title}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={v.error('title')}
            data-autofocus
          />
          {!finding && !suggestion && (
            <>
              <Select
                label={t('fields.source')}
                allowDeselect={false}
                data={CA_MANUAL_SOURCES.map((x) => ({ value: x, label: t(`sources.${x}`) }))}
                value={source}
                onChange={(x) => setSource(x ?? 'internalAudit')}
              />
              <Group grow align="flex-start" wrap="wrap">
                <TextInput
                  label={t('fields.sourceLabel')}
                  description={t('hints.sourceLabel')}
                  maxLength={CA_LIMITS.sourceLabel}
                  value={sourceLabel}
                  onChange={(e) => setSourceLabel(e.currentTarget.value)}
                  miw={220}
                />
                <TextInput
                  label={t('fields.sourceUrl')}
                  type="url"
                  maxLength={CA_LIMITS.url}
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.currentTarget.value)}
                  error={v.error('sourceUrl')}
                  miw={220}
                />
              </Group>
            </>
          )}
          <Textarea
            label={t('fields.description')}
            autosize
            minRows={3}
            maxRows={10}
            maxLength={CA_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Group grow align="flex-start" wrap="wrap">
            <Select
              label={t('fields.severity')}
              allowDeselect={false}
              data={CA_SEVERITIES.map((x) => ({ value: x, label: t(`severities.${x}`) }))}
              value={severity}
              onChange={(x) => setSeverity((x as CaSeverity) ?? 'minor')}
              miw={200}
            />
            <TextInput
              type="date"
              label={t('fields.dueDate')}
              value={dueDate}
              onChange={(e) => setDueDate(e.currentTarget.value)}
              error={v.error('dueDate')}
              miw={160}
            />
          </Group>
          <Group grow align="flex-start" wrap="wrap">
            <Select
              label={t('fields.service')}
              description={t('hints.service')}
              placeholder={t('form.noService')}
              data={serviceData}
              value={serviceId}
              onChange={setServiceId}
              searchable
              clearable
              miw={200}
            />
            <Select
              label={t('fields.owner')}
              description={t('hints.owner')}
              placeholder={t('form.noOwner')}
              data={userData}
              value={owner}
              onChange={setOwner}
              searchable
              clearable
              miw={200}
            />
          </Group>
          {finding?.supplierId && !finding.supplierName ? (
            <TextInput label={t('fields.supplier')} value={t('notVisible')} readOnly />
          ) : (
            <SupplierPicker
              value={supplier.value}
              onChange={supplier.set}
              initial={initialSupplier}
              label={t('fields.supplier')}
              description={t('hints.supplier')}
              testId="ca-supplier"
            />
          )}
          <MultiSelect
            label={t('fields.controls')}
            description={t('hints.controls')}
            placeholder={controlIds.length ? undefined : t('form.controlsPlaceholder')}
            data={controlData}
            value={controlIds}
            onChange={setControlIds}
            searchable
            clearable
            limit={50}
            maxValues={CA_LIMITS.controls}
          />
          <Textarea
            label={t('fields.cause')}
            description={t('hints.cause')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={CA_LIMITS.cause}
            value={cause}
            onChange={(e) => setCause(e.currentTarget.value)}
          />
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              label={t('fields.grcRef')}
              description={t('hints.grcRef')}
              maxLength={CA_LIMITS.grcRef}
              value={grcRef}
              onChange={(e) => setGrcRef(e.currentTarget.value)}
              miw={200}
            />
            <TextInput
              label={t('fields.grcUrl')}
              type="url"
              maxLength={CA_LIMITS.url}
              value={grcUrl}
              onChange={(e) => setGrcUrl(e.currentTarget.value)}
              error={v.error('grcUrl')}
              miw={200}
            />
          </Group>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {suggestion ? t('suggestions.confirm') : t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------- actions ----------

export function ActionForm({
  finding,
  action,
  onClose,
  onSaved,
}: {
  finding: CaFinding;
  action?: CaAction;
  onClose: () => void;
  onSaved: (f: CaFinding) => void;
}) {
  const { t } = useTranslation(['corrective', 'common']);
  const [title, setTitle] = useState(action?.title ?? '');
  const [owners, setOwners] = useState<string[]>(action?.owners ?? []);
  const [dueDate, setDueDate] = useState(action?.dueDate ?? inDays(14));
  const [note, setNote] = useState(action?.note ?? '');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    owners: !owners.length && t('common:validation.required'),
    dueDate: !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && t('common:validation.required'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = { title: title.trim(), owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)), dueDate, note };
    try {
      onSaved(
        action
          ? await put<CaFinding>(`/compliance/corrective-actions/${finding.id}/actions/${action.id}`, body)
          : await post<CaFinding>(`/compliance/corrective-actions/${finding.id}/actions`, body),
      );
      notifyOk(t('actions.saved'));
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={action ? t('actions.edit') : t('actions.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="ca-action-form">
          <TextInput
            label={t('actions.fieldTitle')}
            required
            maxLength={CA_LIMITS.title}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            error={v.error('title')}
            data-autofocus
          />
          <SubjectsInput
            label={t('actions.owners')}
            description={t('actions.ownersHint')}
            value={owners}
            onChange={setOwners}
            max={CA_LIMITS.owners}
            error={v.error('owners') || undefined}
          />
          <TextInput
            type="date"
            label={t('actions.dueDate')}
            required
            value={dueDate}
            onChange={(e) => setDueDate(e.currentTarget.value)}
            error={v.error('dueDate')}
          />
          <Textarea
            label={t('actions.note')}
            autosize
            minRows={2}
            maxRows={5}
            maxLength={CA_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------- the effectiveness check ----------

export function EffectivenessModal({ finding, onClose, onSaved }: { finding: CaFinding; onClose: () => void; onSaved: (f: CaFinding) => void }) {
  const { t } = useTranslation(['corrective', 'common']);
  const [method, setMethod] = useState('');
  const [result, setResult] = useState<'effective' | 'notEffective'>('effective');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ method: !method.trim() && t('common:validation.required') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      onSaved(await post<CaFinding>(`/compliance/corrective-actions/${finding.id}/effectiveness`, { method: method.trim(), result, note }));
      notifyOk(t('effectiveness.done'));
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('effectiveness.title', { number: finding.number })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="ca-effectiveness-form">
          <Text size="sm" c="dimmed">
            {t('effectiveness.intro')}
          </Text>
          <Textarea
            label={t('effectiveness.method')}
            description={t('effectiveness.methodHint')}
            required
            autosize
            minRows={2}
            maxLength={CA_LIMITS.method}
            value={method}
            onChange={(e) => setMethod(e.currentTarget.value)}
            error={v.error('method')}
            data-autofocus
          />
          <div>
            <Text size="sm" fw={500} mb={4} id="ca-eff-result">
              {t('effectiveness.result')}
            </Text>
            <SegmentedControl
              aria-labelledby="ca-eff-result"
              fullWidth
              data={[
                { value: 'effective', label: t('effectiveness.effective') },
                { value: 'notEffective', label: t('effectiveness.notEffective') },
              ]}
              value={result}
              onChange={(x) => setResult(x === 'notEffective' ? 'notEffective' : 'effective')}
            />
          </div>
          <Textarea
            label={t('effectiveness.note')}
            autosize
            minRows={2}
            maxLength={CA_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('effectiveness.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** A reason, then a request: cancelling a finding, dismissing a suggestion. */
export function ReasonModal({
  title,
  label,
  hint,
  submit,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  hint?: string;
  submit: string;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ reason: !reason.trim() && t('validation.required') });
  return (
    <Modal opened onClose={onClose} title={title}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.validate()) return;
          setBusy(true);
          onSubmit(reason.trim()).catch((err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm" data-testid="ca-reason-form">
          <Textarea
            label={label}
            description={hint}
            required
            autosize
            minRows={2}
            maxLength={CA_LIMITS.reason}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            error={v.error('reason')}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" color="red" loading={busy}>
              {submit}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------- the panel on Controls ----------

/** The open findings that name a control (the control's panel on Controls, ADR 0029). */
export function ControlFindings({ controlId }: { controlId: string }) {
  const { t } = useTranslation('corrective');
  const q = useQuery({
    queryKey: correctiveKeys.ofControl(controlId),
    queryFn: () => get<CaFindingList>(`/compliance/corrective-actions?state=open&controlId=${encodeURIComponent(controlId)}`),
  });
  const items = q.data?.items ?? [];
  return (
    <div data-testid="control-findings">
      <Text fw={600} mb={4}>
        {t('controlPanel.title')}
      </Text>
      {q.isError && <Alert color="gray">{t('controlPanel.none')}</Alert>}
      {q.isSuccess && items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('controlPanel.none')}
        </Text>
      )}
      <Stack gap={4}>
        {items.map((f) => (
          <Group key={f.id} gap={6} wrap="nowrap">
            <Anchor component={Link} to={`/compliance/corrective-actions/${f.id}`} size="sm" className="mono">
              {f.number}
            </Anchor>
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {f.title}
            </Text>
            <CaSeverityBadge severity={f.severity} size="xs" />
            <CaStatusBadge status={f.status} size="xs" />
          </Group>
        ))}
      </Stack>
    </div>
  );
}

/** The open findings about a supplier, on its page (ADR 0029), and recording one from there (source supplier review). */
export function SupplierFindings({ supplier }: { supplier: { id: string; name: string; status: SupplierRef['status'] } }) {
  const { t } = useTranslation('corrective');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [recording, setRecording] = useState(false);
  const q = useQuery({
    queryKey: correctiveKeys.ofSupplier(supplier.id),
    queryFn: () => getOptional<CaFindingList | null>(`/compliance/corrective-actions?state=open&supplierId=${encodeURIComponent(supplier.id)}`, null),
  });
  // the register is not there for this person (the Compliance module is off): nothing to show
  if (q.isSuccess && !q.data) return null;
  const items = q.data?.items ?? [];
  return (
    <Stack gap="xs" data-testid="supplier-findings">
      <Group justify="space-between" gap="xs">
        <Text fw={600}>{t('supplierPanel.title')}</Text>
        {q.data?.canCreate && supplier.status !== 'archived' && (
          <Button size="xs" variant="light" onClick={() => setRecording(true)}>
            {t('supplierPanel.record')}
          </Button>
        )}
      </Group>
      {q.isSuccess && items.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('supplierPanel.none')}
        </Text>
      )}
      <Stack gap={4}>
        {items.map((f) => (
          <Group key={f.id} gap={6} wrap="wrap">
            <Anchor component={Link} to={`/compliance/corrective-actions/${f.id}`} size="sm" className="mono">
              {f.number}
            </Anchor>
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {f.title}
            </Text>
            <CaSeverityBadge severity={f.severity} size="xs" />
            <CaStatusBadge status={f.status} size="xs" />
            {f.overdue && (
              <Badge color={TONE.bad} variant="light" size="xs">
                {t('overdue')}
              </Badge>
            )}
          </Group>
        ))}
      </Stack>
      {q.isSuccess && (
        <Anchor component={Link} to={`/compliance/corrective-actions?supplierId=${encodeURIComponent(supplier.id)}`} size="xs">
          {t('supplierPanel.all')}
        </Anchor>
      )}
      {recording && (
        <FindingForm
          preset={{ supplier }}
          onClose={() => setRecording(false)}
          onSaved={(f) => {
            setRecording(false);
            void qc.invalidateQueries({ queryKey: correctiveKeys.all });
            navigate(`/compliance/corrective-actions/${f.id}`);
          }}
        />
      )}
    </Stack>
  );
}
