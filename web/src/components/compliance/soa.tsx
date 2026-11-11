import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Drawer,
  Group,
  MultiSelect,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  RESPONSIBILITY_AREAS,
  SOA_LIMITS,
  SOA_PARTIES,
  SOA_STATUSES,
  type ResponsibilityArea,
  type ServiceSummary,
  type Soa,
  type SoaEntry,
  type SoaList,
  type SoaParty,
  type SoaStatus,
  type SoaVersionDetail,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { QueryState, subjectLabel, useFieldErrors } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { SupplierPicker } from '../suppliers/SupplierPicker';
import { capFirst, fmtDate, fmtRelative } from '../../format';
import { FormModal, FormModalCancel } from '../FormModal';
import { TableScroll } from '../TableScroll';

/**
 * The parts of the statement of applicability (ADR 0029 part 2): badges, the row form (a drawer), the settings, a new
 * statement and the decision on a version.
 */

const STATUS_COLOR: Record<SoaStatus, string> = { implemented: 'teal', partly: 'yellow', planned: 'blue', notStarted: 'gray' };

export function SoaStatusBadge({ status, size = 'sm' }: { status: SoaStatus | null; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('soa');
  if (!status) return <Text size="sm">–</Text>;
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size={size}>
      {t(`statuses.${status}`)}
    </Badge>
  );
}

export function ApplicableBadge({ applicable, size = 'sm' }: { applicable: boolean | null; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('soa');
  return (
    <Badge color={applicable === null ? 'orange' : applicable ? 'teal' : 'gray'} variant={applicable === null ? 'outline' : 'light'} size={size}>
      {t(applicable === null ? 'applicable.undecided' : applicable ? 'applicable.yes' : 'applicable.no')}
    </Badge>
  );
}

/** "Supplier: Hostwell", "Central IT or group: Group IT", "Our team". */
export function usePartyLabel() {
  const { t } = useTranslation('soa');
  return (e: Pick<SoaEntry, 'party' | 'supplier' | 'supplierHidden' | 'centralName'>): string => {
    if (!e.party) return '–';
    const name = e.party === 'supplier' ? (e.supplier?.name ?? (e.supplierHidden ? t('notVisible') : '')) : e.party === 'central' ? e.centralName : '';
    return name ? t('partyWithName', { party: t(`parties.${e.party}`), name }) : t(`parties.${e.party}`);
  };
}

/** The suggestion of the matrix, in words: "supplier: 7 services · our team: 2". */
export function useSuggestionText() {
  const { t } = useTranslation('soa');
  return (e: SoaEntry): string => {
    const s = e.suggestion;
    if (!s) return '';
    const parts = (['supplier', 'team', 'central', 'shared', 'notApplicable'] as const)
      .filter((p) => s.counts[p] > 0)
      .map((p) => t('suggestion.count', { party: t(`matrixParties.${p}`), count: s.counts[p] }));
    if (s.undecided) parts.push(t('suggestion.undecided', { count: s.undecided }));
    return parts.join(' · ');
  };
}

const httpUrl = (v: string) => v.trim() === '' || /^https?:\/\/\S+$/i.test(v.trim());

/**
 * One row in a drawer: the control, its decision, the suggestion of the matrix with "Take suggestion", the evidence
 * Steward holds and the open findings. Designers and administrators change every field; the row's owner its status,
 * how it is met and the review.
 */
export function SoaEntryDrawer({ soa, entry, onClose, onSaved }: { soa: Soa; entry: SoaEntry; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['soa', 'common']);
  const partyLabel = usePartyLabel();
  const suggestionText = useSuggestionText();
  const full = entry.canEdit;
  const own = entry.canEditOwn;
  const [applicable, setApplicable] = useState<'yes' | 'no' | 'undecided'>(entry.applicable === null ? 'undecided' : entry.applicable ? 'yes' : 'no');
  const [justification, setJustification] = useState(entry.justification);
  const [status, setStatus] = useState<SoaStatus | null>(entry.status);
  const [howMet, setHowMet] = useState(entry.howMet);
  const [party, setParty] = useState<SoaParty | null>(entry.party);
  const [supplierId, setSupplierId] = useState<string | null>(entry.supplier?.id ?? null);
  const [supplierTouched, setSupplierTouched] = useState(false);
  const [centralName, setCentralName] = useState(entry.centralName);
  const [owner, setOwner] = useState<string[]>(entry.owner ? [entry.owner] : []);
  const [reviewed, setReviewed] = useState(false);
  const [grcRef, setGrcRef] = useState(entry.grcRef);
  const [grcUrl, setGrcUrl] = useState(entry.grcUrl);
  const [links, setLinks] = useState(entry.evidenceLinks);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    grcUrl: !httpUrl(grcUrl) && t('common:validation.url'),
    links: links.some((l) => !l.title.trim() || !/^https?:\/\/\S+$/i.test(l.url.trim())) && t('entry.linksInvalid'),
  });
  const applies = applicable === 'yes';
  const takeSuggestion = () => {
    const s = entry.suggestion;
    if (!s?.party) return;
    setParty(s.party);
    if (s.party === 'supplier' && s.supplier) {
      setSupplierId(s.supplier.id);
      setSupplierTouched(true);
    }
    if (s.party === 'central' && s.centralName) setCentralName(s.centralName);
  };
  const save = async () => {
    if (!v.validate()) return;
    const body: Record<string, unknown> = {};
    const nextApplicable = applicable === 'undecided' ? null : applies;
    if (full) {
      if (nextApplicable !== entry.applicable) body.applicable = nextApplicable;
      if (justification !== entry.justification) body.justification = justification;
      if (party !== entry.party) body.party = party;
      if (party === 'supplier' && supplierTouched) body.supplierId = supplierId;
      if (party === 'central' && centralName !== entry.centralName) body.centralName = centralName;
      const nextOwner = owner[0] ?? null;
      if (nextOwner !== entry.owner) body.owner = nextOwner;
      if (grcRef !== entry.grcRef) body.grcRef = grcRef;
      if (grcUrl !== entry.grcUrl) body.grcUrl = grcUrl.trim();
      if (JSON.stringify(links) !== JSON.stringify(entry.evidenceLinks)) body.evidenceLinks = links.map((l) => ({ title: l.title.trim(), url: l.url.trim() }));
    }
    if (status !== entry.status && (nextApplicable !== false || !full)) body.status = status;
    if (howMet !== entry.howMet) body.howMet = howMet;
    if (reviewed) body.reviewed = true;
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await put(`/compliance/soa/${encodeURIComponent(soa.catalogueKey)}/entries/${entry.controlId}`, body);
      notifyOk(t('entry.saved', { ref: entry.ref }));
      onSaved();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const differs = !!entry.suggestion?.party && entry.suggestion.party !== party;
  return (
    <Drawer opened onClose={onClose} position="right" size="lg" title={`${entry.ref} ${capFirst(entry.title)}`} data-testid="soa-entry-drawer">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          {entry.description && (
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
              {entry.description}
            </Text>
          )}
          {!full && own && (
            <Alert color="blue" variant="light">
              {t('entry.ownerHint')}
            </Alert>
          )}
          <div>
            <Text size="sm" fw={500} mb={4} id="soa-applicable-label">
              {t('fields.applicable')}
            </Text>
            <SegmentedControl
              aria-labelledby="soa-applicable-label"
              disabled={!full}
              value={applicable}
              onChange={(x) => setApplicable(x as typeof applicable)}
              data={[
                { value: 'yes', label: t('applicable.yes') },
                { value: 'no', label: t('applicable.no') },
                { value: 'undecided', label: t('applicable.undecided') },
              ]}
              data-testid="soa-applicable"
            />
          </div>
          <Textarea
            label={t('fields.justification')}
            description={t('hints.justification')}
            autosize
            minRows={2}
            maxRows={8}
            maxLength={SOA_LIMITS.justification}
            value={justification}
            onChange={(e) => setJustification(e.currentTarget.value)}
            disabled={!full}
            data-testid="soa-justification"
          />
          {applicable !== 'no' && (
            <Select
              label={t('fields.status')}
              data={SOA_STATUSES.map((x) => ({ value: x, label: t(`statuses.${x}`) }))}
              value={status}
              onChange={(x) => setStatus(x as SoaStatus | null)}
              clearable
              disabled={!own}
              data-testid="soa-status"
            />
          )}
          <Textarea
            label={t('fields.howMet')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={SOA_LIMITS.howMet}
            value={howMet}
            onChange={(e) => setHowMet(e.currentTarget.value)}
            disabled={!own}
          />
          <Paper withBorder p="xs">
            <Stack gap={6}>
              <Select
                label={t('fields.party')}
                data={SOA_PARTIES.map((x) => ({ value: x, label: t(`parties.${x}`) }))}
                value={party}
                onChange={(x) => setParty(x as SoaParty | null)}
                clearable
                disabled={!full}
                data-testid="soa-party"
              />
              {party === 'supplier' && full && (
                <SupplierPicker
                  value={supplierId}
                  onChange={(id) => {
                    setSupplierId(id);
                    setSupplierTouched(true);
                  }}
                  initial={entry.supplier}
                />
              )}
              {party === 'supplier' && !full && <Text size="sm">{partyLabel(entry)}</Text>}
              {party === 'central' && (
                <TextInput
                  label={t('fields.centralName')}
                  maxLength={SOA_LIMITS.centralName}
                  value={centralName}
                  onChange={(e) => setCentralName(e.currentTarget.value)}
                  disabled={!full}
                />
              )}
              {entry.suggestion ? (
                <Group justify="space-between" gap="xs" wrap="wrap" data-testid="soa-suggestion">
                  <Text size="xs" c="dimmed">
                    {t('suggestion.label')}: {suggestionText(entry)}
                    {entry.suggestion.party && ` → ${partyLabel({ ...entry.suggestion, supplierHidden: false })}`}
                  </Text>
                  {full && differs && (
                    <Button size="compact-xs" variant="light" onClick={takeSuggestion} data-testid="soa-take-suggestion">
                      {t('suggestion.take')}
                    </Button>
                  )}
                </Group>
              ) : (
                <Text size="xs" c="dimmed">
                  {t('suggestion.none')}
                </Text>
              )}
            </Stack>
          </Paper>
          <SubjectsInput label={t('fields.owner')} description={t('hints.owner')} value={owner} onChange={(x) => full && setOwner(x.slice(-1))} max={1} />
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              label={t('fields.grcRef')}
              maxLength={SOA_LIMITS.grcRef}
              value={grcRef}
              onChange={(e) => setGrcRef(e.currentTarget.value)}
              disabled={!full}
              miw={180}
            />
            <TextInput
              label={t('fields.grcUrl')}
              type="url"
              maxLength={SOA_LIMITS.url}
              value={grcUrl}
              onChange={(e) => setGrcUrl(e.currentTarget.value)}
              error={v.error('grcUrl')}
              disabled={!full}
              miw={180}
            />
          </Group>
          <div>
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={500}>
                {t('fields.evidenceLinks')}
              </Text>
              {full && links.length < SOA_LIMITS.evidenceLinks && (
                <Button size="compact-xs" variant="subtle" leftSection={<IconPlus size={12} />} onClick={() => setLinks([...links, { title: '', url: '' }])}>
                  {t('entry.addLink')}
                </Button>
              )}
            </Group>
            {links.length === 0 && (
              <Text size="xs" c="dimmed">
                {t('entry.noLinks')}
              </Text>
            )}
            <Stack gap={4}>
              {links.map((l, i) => (
                <Group key={i} gap="xs" wrap="nowrap" align="flex-end">
                  <TextInput
                    size="xs"
                    aria-label={t('entry.linkTitle', { n: i + 1 })}
                    placeholder={t('entry.linkTitlePlaceholder')}
                    value={l.title}
                    maxLength={SOA_LIMITS.linkTitle}
                    onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, title: e.currentTarget.value } : x)))}
                    disabled={!full}
                    style={{ flex: 1 }}
                  />
                  <TextInput
                    size="xs"
                    type="url"
                    aria-label={t('entry.linkUrl', { n: i + 1 })}
                    placeholder="https://"
                    value={l.url}
                    maxLength={SOA_LIMITS.url}
                    onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.currentTarget.value } : x)))}
                    disabled={!full}
                    style={{ flex: 2 }}
                  />
                  {full && (
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('entry.removeLink', { n: i + 1 })}
                      onClick={() => setLinks(links.filter((_, j) => j !== i))}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  )}
                </Group>
              ))}
            </Stack>
            {v.error('links') && (
              <Text size="xs" c="red" mt={4}>
                {v.error('links')}
              </Text>
            )}
          </div>
          <EvidenceBlock entry={entry} catalogueKey={soa.catalogueKey} />
          <Text size="xs" c="dimmed">
            {entry.reviewedAt ? t('entry.reviewed', { user: entry.reviewedBy ?? '', date: fmtDate(entry.reviewedAt) }) : t('entry.neverReviewed')}
            {entry.updatedAt && (
              <>
                <br />
                {t('entry.updated', { user: entry.updatedBy ?? '', when: fmtRelative(entry.updatedAt) })}
              </>
            )}
          </Text>
          {own && (
            <Checkbox label={t('entry.markReviewed')} checked={reviewed} onChange={(e) => setReviewed(e.currentTarget.checked)} data-testid="soa-reviewed" />
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {own ? t('common:cancel') : t('common:close')}
            </Button>
            {own && (
              <Button type="submit" loading={busy} data-testid="soa-entry-save">
                {t('common:save')}
              </Button>
            )}
          </Group>
        </Stack>
      </form>
    </Drawer>
  );
}

/** What Steward holds for the control: coverage of the last twelve months, the mapped items, open findings. */
function EvidenceBlock({ entry, catalogueKey }: { entry: SoaEntry; catalogueKey: string }) {
  const { t } = useTranslation('soa');
  const e = entry.evidence;
  return (
    <Paper withBorder p="xs" data-testid="soa-evidence">
      <Text size="sm" fw={500} mb={4}>
        {t('evidence.title')}
      </Text>
      <Group gap={6} mb={4}>
        <CoverageBadge status={e.status} />
        {entry.noEvidence && (
          <Badge color="red" variant="light" size="sm">
            {t('evidence.none')}
          </Badge>
        )}
        <Text size="xs" c="dimmed">
          {t('evidence.counts', { items: e.items, mapped: e.mapped })}
          {e.hidden > 0 && ` · ${t('evidence.hidden', { count: e.hidden })}`}
        </Text>
      </Group>
      {e.tags.length > 0 && (
        <Stack gap={0}>
          {e.tags.map((x, i) =>
            x.visible && x.path ? (
              <Anchor key={i} component={Link} to={x.path} size="xs">
                {x.label}
              </Anchor>
            ) : (
              <Text key={i} size="xs" c="dimmed">
                {x.visible ? x.label : t('notVisible')}
              </Text>
            ),
          )}
        </Stack>
      )}
      <Group gap={6} mt={6}>
        <Anchor
          component={Link}
          to={`/compliance/controls?catalogue=${encodeURIComponent(catalogueKey)}&control=${encodeURIComponent(entry.controlId)}`}
          size="xs"
        >
          {t('evidence.openControl')}
        </Anchor>
        {entry.findings.total > 0 && (
          <Anchor component={Link} to={`/compliance/corrective-actions?controlId=${encodeURIComponent(entry.controlId)}`} size="xs" data-testid="soa-findings">
            {t('evidence.findings', { open: entry.findings.open, total: entry.findings.total })}
          </Anchor>
        )}
      </Group>
    </Paper>
  );
}

export function CoverageBadge({ status }: { status: SoaEntry['evidence']['status'] }) {
  const { t } = useTranslation('soa');
  const color = status === 'covered' ? 'teal' : status === 'gap' ? 'red' : status === 'notVisible' ? 'yellow' : 'gray';
  return (
    <Badge color={color} variant="light" size="sm">
      {t(`coverage.${status}`)}
    </Badge>
  );
}

function useServices() {
  return useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
}

/** A new statement: one per catalogue (designers, administrators). */
export function NewSoaModal({
  catalogues,
  fourEyesOff,
  onClose,
  onCreated,
}: {
  catalogues: SoaList['catalogues'];
  /** The person may create a statement without a second person (administrators, unless the policy requires one) */
  fourEyesOff: boolean;
  onClose: () => void;
  onCreated: (s: Soa) => void;
}) {
  const { t } = useTranslation(['soa', 'common']);
  const services = useServices();
  const [catalogueId, setCatalogueId] = useState<string | null>(catalogues.find((c) => c.key === 'ISO27001')?.id ?? catalogues[0]?.id ?? null);
  const [scopeName, setScopeName] = useState('');
  const [scope, setScope] = useState<string[]>([]);
  const [fourEyes, setFourEyes] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!catalogueId) return;
    setBusy(true);
    try {
      const s = await post<Soa>('/compliance/soa', { catalogueId, scopeName: scopeName.trim(), scopeServiceIds: scope, fourEyes });
      notifyOk(t('new.created', { catalogue: s.catalogueName }));
      onCreated(s);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={t('new.title')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="soa-new-form">
          <Text size="sm" c="dimmed">
            {t('new.intro')}
          </Text>
          <Select
            label={t('fields.catalogue')}
            required
            allowDeselect={false}
            data={catalogues.map((c) => ({ value: c.id, label: t('new.catalogueOption', { name: c.name, count: c.controls }) }))}
            value={catalogueId}
            onChange={setCatalogueId}
            data-autofocus
            data-testid="soa-new-catalogue"
          />
          <ScopeFields services={services.data ?? []} scopeName={scopeName} setScopeName={setScopeName} scope={scope} setScope={setScope} />
          <FourEyesSwitch checked={fourEyes} onChange={setFourEyes} mayTurnOff={fourEyesOff} />
          <Group justify="flex-end" gap="xs">
            <FormModalCancel />
            <Button type="submit" loading={busy} disabled={!catalogueId} data-testid="soa-new-submit">
              {t('new.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/**
 * "A second person approves": everyone with the form switches it on; switching it off loosens the control point
 * soa.approve – administrators only, after confirming it is them, and never while the policy requires it. A version
 * waiting keeps the rule it was submitted with.
 */
function FourEyesSwitch({
  checked,
  onChange,
  mayTurnOff,
  policy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  mayTurnOff: boolean;
  policy?: boolean;
}) {
  const { t } = useTranslation('soa');
  return (
    <Stack gap={4}>
      <Switch
        label={t('fields.fourEyes')}
        description={t('hints.fourEyes')}
        checked={checked}
        disabled={checked && !mayTurnOff}
        onChange={(e) => onChange(e.currentTarget.checked)}
        data-testid="soa-four-eyes"
      />
      {policy ? (
        <Text size="xs" c="dimmed">
          {t('settings.fourEyesPolicy')}
        </Text>
      ) : (
        checked &&
        !mayTurnOff && (
          <Text size="xs" c="dimmed">
            {t('settings.fourEyesAdmins')}
          </Text>
        )
      )}
    </Stack>
  );
}

function ScopeFields(p: {
  services: ServiceSummary[];
  scopeName: string;
  setScopeName: (v: string) => void;
  scope: string[];
  setScope: (v: string[]) => void;
}) {
  const { t } = useTranslation('soa');
  const data = useMemo(() => [...p.services].sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ value: s.id, label: s.name })), [p.services]);
  return (
    <>
      <TextInput
        label={t('fields.scopeName')}
        description={t('hints.scopeName')}
        maxLength={SOA_LIMITS.scopeName}
        value={p.scopeName}
        onChange={(e) => p.setScopeName(e.currentTarget.value)}
      />
      <MultiSelect
        label={t('fields.scopeServices')}
        description={t('hints.scopeServices')}
        placeholder={p.scope.length ? undefined : t('allServices')}
        data={[...data, ...p.scope.filter((id) => !data.some((d) => d.value === id)).map((id) => ({ value: id, label: id }))]}
        value={p.scope}
        onChange={p.setScope}
        searchable
        clearable
        maxValues={SOA_LIMITS.scopeServices}
      />
    </>
  );
}

/** Scope, the second person and – administrators – the controls per area. */
export function SoaSettingsModal({ soa, onClose, onSaved }: { soa: Soa; onClose: () => void; onSaved: (s: Soa) => void }) {
  const { t } = useTranslation(['soa', 'common']);
  const services = useServices();
  const [scopeName, setScopeName] = useState(soa.scopeName);
  const [scope, setScope] = useState(soa.scopeServiceIds);
  const [fourEyes, setFourEyes] = useState(soa.fourEyes);
  const [areas, setAreas] = useState<Record<ResponsibilityArea, string[]>>(soa.areaControls);
  const [busy, setBusy] = useState(false);
  const controls = useMemo(() => soa.entries.map((e) => ({ value: e.controlId, label: `${e.ref} ${capFirst(e.title)}` })), [soa.entries]);
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { scopeName: scopeName.trim(), scopeServiceIds: scope, fourEyes };
      if (soa.permissions.areaControls && JSON.stringify(areas) !== JSON.stringify(soa.areaControls)) body.areaControls = areas;
      const s = await put<Soa>(`/compliance/soa/${encodeURIComponent(soa.catalogueKey)}/settings`, body);
      notifyOk(t('settings.saved'));
      onSaved(s);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={t('settings.title')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <ScopeFields services={services.data ?? []} scopeName={scopeName} setScopeName={setScopeName} scope={scope} setScope={setScope} />
          <FourEyesSwitch
            checked={fourEyes}
            onChange={setFourEyes}
            mayTurnOff={soa.permissions.fourEyesOff || !soa.fourEyes}
            policy={soa.permissions.fourEyesRequiredByPolicy}
          />
          <Text size="sm" fw={500}>
            {t('settings.areaControls')}
          </Text>
          <Text size="xs" c="dimmed">
            {soa.areaControlsDefault ? t('settings.areaDefault') : t('settings.areaOwn')} {!soa.permissions.areaControls && t('settings.areaAdmins')}
          </Text>
          {RESPONSIBILITY_AREAS.map((a) => (
            <MultiSelect
              key={a}
              size="xs"
              label={t(`areas.${a}`)}
              data={controls}
              value={areas[a]}
              onChange={(v) => setAreas({ ...areas, [a]: v })}
              searchable
              clearable
              maxValues={SOA_LIMITS.areaControls}
              disabled={!soa.permissions.areaControls}
            />
          ))}
          <Group justify="flex-end" gap="xs">
            <FormModalCancel />
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/** Approve or return the waiting version (the server asks for a fresh confirmation first). */
export function SoaDecisionModal({ soa, approve, onClose, onSaved }: { soa: Soa; approve: boolean; onClose: () => void; onSaved: (s: Soa) => void }) {
  const { t } = useTranslation(['soa', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const w = soa.waiting!;
  const v = soa.versions.find((x) => x.number === w.number);
  const err = useFieldErrors({ comment: !approve && !comment.trim() && t('common:validation.required') });
  const save = async () => {
    if (!err.validate()) return;
    setBusy(true);
    try {
      const s = await post<Soa>(`/compliance/soa/${encodeURIComponent(soa.catalogueKey)}/versions/${w.number}/decision`, { approve, comment: comment.trim() });
      notifyOk(approve ? t('decision.approved', { number: w.number }) : t('decision.returned', { number: w.number }));
      onSaved(s);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={approve ? t('decision.approveTitle', { number: w.number }) : t('decision.returnTitle', { number: w.number })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="soa-decision-form">
          <Text size="sm">{t('decision.submitted', { user: subjectLabel(`user:${w.submittedBy}`), date: fmtDate(w.submittedAt) })}</Text>
          {v && (
            <Text size="sm" c="dimmed">
              {t('decision.counts', { applicable: v.counts.applicable, notApplicable: v.counts.notApplicable, implemented: v.counts.implemented })}
            </Text>
          )}
          {v && (
            <Tooltip label={v.contentSha256}>
              <Text size="xs" c="dimmed" className="mono">
                SHA-256 {v.contentSha256.slice(0, 16)}…
              </Text>
            </Tooltip>
          )}
          <Textarea
            label={t('decision.comment')}
            description={approve ? t('decision.commentOptional') : t('decision.commentRequired')}
            required={!approve}
            autosize
            minRows={2}
            maxLength={SOA_LIMITS.comment}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            error={err.error('comment')}
            data-autofocus
          />
          <Group justify="flex-end" gap="xs">
            <FormModalCancel />
            <Button type="submit" color={approve ? undefined : 'orange'} loading={busy} data-testid="soa-decision-submit">
              {approve ? t('decision.approve') : t('decision.return')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/** One version as it was frozen: what an approver approves and what the signed file holds (soa.json). */
export function SoaVersionModal({ catalogueKey, number, onClose }: { catalogueKey: string; number: number; onClose: () => void }) {
  const { t } = useTranslation(['soa', 'common']);
  const q = useQuery({
    queryKey: ['soa', 'version', catalogueKey, number],
    queryFn: () => get<SoaVersionDetail>(`/compliance/soa/${encodeURIComponent(catalogueKey)}/versions/${number}`),
  });
  const v = q.data;
  return (
    <FormModal onClose={onClose} title={t('versionView.title', { number })} size="xl">
      {!v ? (
        <QueryState query={q} />
      ) : (
        <Stack gap="xs" data-testid="soa-version-view">
          <Text size="sm" c="dimmed">
            {t('versionView.intro', { user: v.submittedBy, date: fmtDate(v.submittedAt) })}
          </Text>
          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
            SHA-256 {v.contentSha256}
          </Text>
          {(v.content.scope.servicesHidden || v.content.entries.some((e) => e.supplierHidden)) && (
            <Text size="xs" c="dimmed">
              {t('versionView.hidden')}
            </Text>
          )}
          <TableScroll>
            <Table fz="xs" aria-label={t('versionView.title', { number })}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('table.control')}</Table.Th>
                  <Table.Th>{t('table.applies')}</Table.Th>
                  <Table.Th>{t('fields.justification')}</Table.Th>
                  <Table.Th>{t('table.status')}</Table.Th>
                  <Table.Th>{t('table.party')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {v.content.entries.map((e) => (
                  <Table.Tr key={e.ref}>
                    <Table.Td>
                      {e.ref} {capFirst(e.title)}
                    </Table.Td>
                    <Table.Td>{t(e.applicable === null ? 'applicable.undecided' : e.applicable ? 'applicable.yes' : 'applicable.no')}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.justification || '–'}</Table.Td>
                    <Table.Td>{e.status ? t(`statuses.${e.status}`) : '–'}</Table.Td>
                    <Table.Td>
                      {e.party ? [t(`parties.${e.party}`), e.supplier ?? (e.supplierHidden ? t('notVisible') : e.centralName)].filter(Boolean).join(': ') : '–'}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        </Stack>
      )}
    </FormModal>
  );
}
