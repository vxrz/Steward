import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Code,
  Divider,
  FileButton,
  Group,
  Modal,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconShieldLock, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type {
  ApplicationSummary,
  CertificateInfo,
  Credential,
  CredentialLink,
  CredentialOwner,
  CredentialReminderOverride,
  CredentialRole,
  CredentialType,
  CredentialUrl,
  GatusEndpointState,
  MonitorSummary,
  Platform,
  ProcessSummary,
  ServiceSummary,
  Subject,
} from '@sm/shared';
import { api, get, getOptional, notifyError, post } from '../../api';
import { useMe } from '../../auth';
import { fmtDay } from '../../format';
import { useFieldErrors } from '../common';
import { CREDENTIAL_TYPE_IDS } from '../../pages/Credentials';

const CERT_MAX = 256 * 1024;
const LINK_KINDS = ['process', 'monitor', 'platform', 'service', 'application'] as const;

interface Draft {
  name: string;
  type: CredentialType;
  platformId: string | null;
  platformText: string;
  environment: string;
  description: string;
  usedBy: { text: string; links: CredentialLink[]; urls: CredentialUrl[] };
  roles: CredentialRole[];
  rolesComment: string;
  owners: CredentialOwner[];
  ownerSubjects: string[];
  location: { text: string; url: string };
  issuedAt: string | null;
  expiresAt: string | null;
  rotationIntervalDays: number | null;
  lastRotatedAt: string | null;
  reviewIntervalDays: number | null;
  lastReviewedAt: string | null;
  gatus: { platformId: string; endpointKey: string } | null;
  reminders: CredentialReminderOverride | null;
  notes: string;
  tags: string[];
  version?: number;
}

/** Plain e-mail addresses per entry (server: MAX_CREDENTIAL_OWNER_EMAILS). */
const MAX_OWNER_EMAILS = 10;

const fromEntry = (c: Credential | null): Draft =>
  c
    ? {
        name: c.name,
        type: c.type,
        platformId: c.platformId,
        platformText: c.platformText,
        environment: c.environment,
        description: c.description,
        usedBy: { text: c.usedBy.text, links: c.usedBy.links.map(({ kind, id }) => ({ kind, id })), urls: c.usedBy.urls },
        roles: c.roles,
        rolesComment: '',
        owners: c.owners,
        ownerSubjects: c.ownerSubjects,
        location: { text: c.location.text, url: c.location.url ?? '' },
        issuedAt: c.issuedAt,
        expiresAt: c.expiresAt,
        rotationIntervalDays: c.rotationIntervalDays,
        lastRotatedAt: c.lastRotatedAt,
        reviewIntervalDays: c.reviewIntervalDays,
        lastReviewedAt: c.lastReviewedAt,
        gatus: c.gatus,
        reminders: c.reminders,
        notes: c.notes,
        tags: c.tags,
        version: c.version,
      }
    : {
        name: '',
        type: 'apiClient',
        platformId: null,
        platformText: '',
        environment: '',
        description: '',
        usedBy: { text: '', links: [], urls: [] },
        roles: [],
        rolesComment: '',
        owners: [],
        ownerSubjects: [],
        location: { text: '', url: '' },
        issuedAt: null,
        expiresAt: null,
        rotationIntervalDays: null,
        lastRotatedAt: null,
        reviewIntervalDays: 365,
        lastReviewedAt: null,
        gatus: null,
        reminders: null,
        notes: '',
        tags: [],
      };

/** A date input over an ISO value: unchanged values keep their time, a picked day is sent as YYYY-MM-DD. */
function DateField({
  label,
  value,
  onChange,
  description,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  description?: string;
}) {
  return (
    <TextInput
      type="date"
      label={label}
      description={description}
      value={value ? value.slice(0, 10) : ''}
      onChange={(e) => onChange(e.currentTarget.value || null)}
    />
  );
}

const toBase64 = async (f: File): Promise<string> => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export function CredentialEditor({ initial, onClose, onSaved }: { initial: Credential | null; onClose: () => void; onSaved: (c: Credential) => void }) {
  const { t } = useTranslation(['credentials', 'common']);
  const [d, setD] = useState<Draft>(() => fromEntry(initial));
  const [cert, setCert] = useState<{ contentBase64: string; info: CertificateInfo } | null>(null);
  const [removeCert, setRemoveCert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { hasRole } = useMe();
  // owners who are not editors by role may not change who gets the reminders by e-mail (the server refuses it)
  const ownersLocked = !!initial && !hasRole('admin') && !hasRole('designer') && !hasRole('operator');
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const applications = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []), retry: false });
  const gatusEndpoints = useQuery({
    queryKey: ['gatus-endpoints', d.gatus?.platformId],
    queryFn: () => getOptional<GatusEndpointState[]>(`/gatus/sources/${d.gatus!.platformId}/endpoints`, []),
    enabled: !!d.gatus?.platformId,
  });
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const isCert = d.type === 'certificate' || d.type === 'agentCertificate';
  // an uploaded certificate sets the expiry unless a date was entered by hand
  const certDecides = !!cert && d.expiresAt === (initial?.expiresAt ?? null);
  const options = (kind: string) =>
    kind === 'process'
      ? (processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))
      : kind === 'monitor'
        ? (monitors.data ?? []).map((m) => ({ value: m.id, label: m.name }))
        : kind === 'service'
          ? (services.data ?? []).map((x) => ({ value: x.id, label: x.name }))
          : kind === 'application'
            ? (applications.data ?? []).map((x) => ({ value: x.id, label: x.name }))
            : (platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }));

  const upload = async (f: File | null) => {
    if (!f) return;
    setError(null);
    if (f.size > CERT_MAX) return setError(t('editor.certTooLarge'));
    try {
      const contentBase64 = await toBase64(f);
      const info = await post<CertificateInfo>('/credentials/certificate/parse', { contentBase64 });
      setCert({ contentBase64, info });
      setRemoveCert(false);
    } catch (e) {
      notifyError(e, t('editor.certNotRead'));
    }
  };

  const v = useFieldErrors<string>({
    name: !d.name.trim() && t('common:validation.required'),
    ...Object.fromEntries(d.owners.map((o, i) => [`owner${i}`, !o.email.trim() && t('common:validation.required')])),
    ...Object.fromEntries(d.usedBy.links.map((l, i) => [`link${i}`, !l.id && t('common:validation.required')])),
    ...Object.fromEntries(d.usedBy.urls.map((x, i) => [`url${i}`, !/^https?:\/\/\S+$/i.test(x.url.trim()) && t('editor.urlInvalid')])),
    ...Object.fromEntries(d.roles.map((r, i) => [`role${i}`, !r.role.trim() && t('common:validation.required')])),
  });
  const rolesChanged = JSON.stringify(d.roles) !== JSON.stringify(initial?.roles ?? []);
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        ...d,
        location: { text: d.location.text, url: d.location.url.trim() || null },
        platformText: d.platformId ? '' : d.platformText,
        usedBy: { ...d.usedBy, urls: d.usedBy.urls.map((x) => ({ label: x.label.trim(), url: x.url.trim() })) },
        ...(cert ? { certificate: { contentBase64: cert.contentBase64 } } : removeCert ? { certificate: null } : {}),
        // the certificate decides the expiry unless one is entered with it
        ...(certDecides ? { expiresAt: null } : {}),
      };
      const saved = initial ? await api<Credential>('PUT', `/credentials/${initial.id}`, body) : await post<Credential>('/credentials', body);
      onSaved(saved);
    } catch (e) {
      notifyError(e, t('editor.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  const gatusPlatforms = (platforms.data ?? []).filter((p) => p.kind === 'gatus');
  const reminderDays = d.reminders?.daysBefore?.join(', ') ?? '';

  return (
    <Modal opened onClose={onClose} title={initial ? t('editor.editTitle') : t('editor.newTitle')} size="xl">
      <Stack>
        <Alert icon={<IconShieldLock size={18} />} color="yellow" variant="light">
          {t('noSecretsHint')}
        </Alert>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('fields.name')} required value={d.name} onChange={(e) => set({ name: e.currentTarget.value })} error={v.error('name')} />
          <Select
            label={t('fields.type')}
            required
            allowDeselect={false}
            data={CREDENTIAL_TYPE_IDS.map((x) => ({ value: x, label: t(`types.${x}`) }))}
            value={d.type}
            onChange={(v) => set({ type: (v as CredentialType) ?? 'other' })}
          />
          <Select
            label={t('fields.platform')}
            description={t('editor.platformHint')}
            searchable
            clearable
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            value={d.platformId}
            onChange={(v) => set({ platformId: v })}
          />
          {!d.platformId ? (
            <TextInput
              label={t('fields.platformText')}
              placeholder={t('editor.platformTextPlaceholder')}
              value={d.platformText}
              onChange={(e) => set({ platformText: e.currentTarget.value })}
            />
          ) : (
            <div />
          )}
          <TextInput
            label={t('fields.environment')}
            placeholder={t('editor.environmentPlaceholder')}
            value={d.environment}
            onChange={(e) => set({ environment: e.currentTarget.value })}
          />
          <TagsInput label={t('fields.tags')} value={d.tags} onChange={(v) => set({ tags: v })} />
        </SimpleGrid>
        <Textarea label={t('fields.description')} autosize minRows={2} value={d.description} onChange={(e) => set({ description: e.currentTarget.value })} />

        <Divider label={t('editor.whereKept')} labelPosition="left" />
        <Textarea
          label={t('fields.location')}
          description={t('editor.locationHint')}
          placeholder={t('editor.locationPlaceholder')}
          autosize
          minRows={2}
          value={d.location.text}
          onChange={(e) => set({ location: { ...d.location, text: e.currentTarget.value } })}
        />
        <TextInput
          label={t('fields.locationUrl')}
          description={t('editor.locationUrlHint')}
          classNames={{ input: 'mono' }}
          value={d.location.url}
          onChange={(e) => set({ location: { ...d.location, url: e.currentTarget.value } })}
        />

        <Divider label={t('editor.ownersSection')} labelPosition="left" />
        <Stack gap="xs">
          {d.owners.map((o, i) => (
            <Group key={i} gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                style={{ flex: 2 }}
                type="email"
                label={i === 0 ? t('fields.ownerEmail') : undefined}
                aria-label={t('fields.ownerEmail')}
                disabled={ownersLocked}
                value={o.email}
                onChange={(e) => set({ owners: d.owners.map((x, j) => (j === i ? { ...x, email: e.currentTarget.value } : x)) })}
                error={v.error(`owner${i}`)}
              />
              <Autocomplete
                style={{ flex: 1.4 }}
                label={i === 0 ? t('fields.ownerRole') : undefined}
                aria-label={t('fields.ownerRole')}
                data={[t('editor.roleBusiness'), t('editor.roleIt'), t('editor.roleVendor')]}
                value={o.role}
                onChange={(v) => set({ owners: d.owners.map((x, j) => (j === i ? { ...x, role: v } : x)) })}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                mb={4}
                disabled={ownersLocked}
                onClick={() => set({ owners: d.owners.filter((_, j) => j !== i) })}
                aria-label={t('editor.removeOwner')}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              disabled={ownersLocked || d.owners.length >= MAX_OWNER_EMAILS}
              onClick={() => set({ owners: [...d.owners, { email: '', role: '' }] })}
            >
              {t('editor.addOwner')}
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            {ownersLocked ? t('editor.ownerEmailsLocked') : t('editor.ownerEmailsHint')}
          </Text>
          <MultiSelect
            label={t('fields.ownerSubjects')}
            description={t('editor.ownerSubjectsHint')}
            searchable
            data={(subjects.data ?? []).filter((s) => s.kind !== 'role').map((s) => ({ value: s.value, label: s.label }))}
            value={d.ownerSubjects}
            onChange={(v) => set({ ownerSubjects: v })}
          />
        </Stack>

        <Divider label={t('fields.usedBy')} labelPosition="left" />
        <TextInput label={t('editor.usedByText')} value={d.usedBy.text} onChange={(e) => set({ usedBy: { ...d.usedBy, text: e.currentTarget.value } })} />
        <Stack gap="xs">
          {d.usedBy.links.map((l, i) => (
            <Group key={i} gap="xs" align="flex-end" wrap="nowrap">
              <Select
                style={{ flex: 1 }}
                aria-label={t('editor.linkKind')}
                allowDeselect={false}
                data={LINK_KINDS.map((k) => ({ value: k, label: t(`linkKinds.${k}`) }))}
                value={l.kind}
                onChange={(v) => set({ usedBy: { ...d.usedBy, links: d.usedBy.links.map((x, j) => (j === i ? { kind: v ?? 'process', id: '' } : x)) } })}
              />
              <Select
                style={{ flex: 2 }}
                aria-label={t('editor.linkTarget')}
                searchable
                data={options(l.kind)}
                value={l.id || null}
                onChange={(id) => set({ usedBy: { ...d.usedBy, links: d.usedBy.links.map((x, j) => (j === i ? { ...x, id: id ?? '' } : x)) } })}
                error={v.error(`link${i}`)}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                mb={4}
                onClick={() => set({ usedBy: { ...d.usedBy, links: d.usedBy.links.filter((_, j) => j !== i) } })}
                aria-label={t('editor.removeLink')}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => set({ usedBy: { ...d.usedBy, links: [...d.usedBy.links, { kind: 'process', id: '' }] } })}
            >
              {t('editor.addLink')}
            </Button>
          </Group>
        </Stack>

        <Stack gap="xs" data-testid="credential-urls">
          {d.usedBy.urls.map((x, i) => (
            <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
              <TextInput
                style={{ flex: 1 }}
                aria-label={t('editor.urlLabel')}
                placeholder={t('editor.urlLabel')}
                value={x.label}
                onChange={(e) => set({ usedBy: { ...d.usedBy, urls: d.usedBy.urls.map((y, j) => (j === i ? { ...y, label: e.currentTarget.value } : y)) } })}
              />
              <TextInput
                style={{ flex: 2 }}
                aria-label={t('editor.url')}
                placeholder="https://"
                value={x.url}
                error={v.error(`url${i}`)}
                onChange={(e) => set({ usedBy: { ...d.usedBy, urls: d.usedBy.urls.map((y, j) => (j === i ? { ...y, url: e.currentTarget.value } : y)) } })}
              />
              <ActionIcon
                variant="subtle"
                color="red"
                mt={4}
                onClick={() => set({ usedBy: { ...d.usedBy, urls: d.usedBy.urls.filter((_, j) => j !== i) } })}
                aria-label={t('editor.removeUrl')}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => set({ usedBy: { ...d.usedBy, urls: [...d.usedBy.urls, { label: '', url: '' }] } })}
            >
              {t('editor.addUrl')}
            </Button>
          </Group>
        </Stack>

        <Divider label={t('fields.roles')} labelPosition="left" />
        <Text size="xs" c="dimmed">
          {t('editor.rolesHint')}
        </Text>
        <Stack gap="xs" data-testid="credential-roles-editor">
          {d.roles.map((r, i) => {
            const patch = (p: Partial<CredentialRole>) => set({ roles: d.roles.map((x, j) => (j === i ? { ...x, ...p } : x)) });
            return (
              <Paper key={i} withBorder p="xs">
                <Group gap="xs" align="flex-start" wrap="nowrap">
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" style={{ flex: 1 }}>
                    <TextInput
                      size="xs"
                      label={t('roles.role')}
                      required
                      classNames={{ input: 'mono' }}
                      value={r.role}
                      error={v.error(`role${i}`)}
                      onChange={(e) => patch({ role: e.currentTarget.value })}
                    />
                    <TextInput size="xs" label={t('roles.scope')} value={r.scope} onChange={(e) => patch({ scope: e.currentTarget.value })} />
                    <TextInput
                      size="xs"
                      type="date"
                      label={t('roles.grantedAt')}
                      value={r.grantedAt ? r.grantedAt.slice(0, 10) : ''}
                      onChange={(e) => patch({ grantedAt: e.currentTarget.value || null })}
                    />
                    <TextInput size="xs" label={t('roles.note')} value={r.note} onChange={(e) => patch({ note: e.currentTarget.value })} />
                  </SimpleGrid>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    mt={22}
                    onClick={() => set({ roles: d.roles.filter((_, j) => j !== i) })}
                    aria-label={t('editor.removeRole', { role: r.role || '' })}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Paper>
            );
          })}
          <Group>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => set({ roles: [...d.roles, { role: '', scope: '', grantedAt: null, note: '' }] })}
            >
              {t('editor.addRole')}
            </Button>
          </Group>
          {rolesChanged && initial && (
            <TextInput
              label={t('editor.rolesComment')}
              description={t('editor.rolesCommentHint')}
              value={d.rolesComment}
              onChange={(e) => set({ rolesComment: e.currentTarget.value })}
            />
          )}
        </Stack>

        <Divider label={t('editor.datesSection')} labelPosition="left" />
        {isCert && (
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={500}>
                  {t('editor.certificate')}
                </Text>
                <FileButton onChange={upload} accept=".pem,.crt,.cer,.der,application/x-x509-ca-cert,application/pkix-cert">
                  {(props) => (
                    <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                      {t('editor.uploadCert')}
                    </Button>
                  )}
                </FileButton>
              </Group>
              <Text size="xs" c="dimmed">
                {t('editor.certHint')}
              </Text>
              {cert && (
                <Stack gap={2} data-testid="certificate-preview">
                  <Text size="sm">{cert.info.subject}</Text>
                  <Text size="xs" c="dimmed">
                    {t('editor.certValid', { from: fmtDay(cert.info.notBefore), to: fmtDay(cert.info.chainNotAfter) })}
                  </Text>
                  <Code style={{ overflowWrap: 'anywhere' }}>{cert.info.fingerprint256}</Code>
                </Stack>
              )}
              {!cert && initial?.certificate && !removeCert && (
                <Group gap="xs">
                  <Text size="sm">{initial.certificate.subject}</Text>
                  <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconX size={12} />} onClick={() => setRemoveCert(true)}>
                    {t('editor.removeCert')}
                  </Button>
                </Group>
              )}
            </Stack>
          </Paper>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <DateField label={t('fields.issuedAt')} value={d.issuedAt} onChange={(v) => set({ issuedAt: v })} />
          <DateField
            label={t('fields.expiresAt')}
            description={certDecides ? t('editor.expiryFromCert') : undefined}
            value={certDecides ? cert!.info.chainNotAfter : d.expiresAt}
            onChange={(v) => set({ expiresAt: v })}
          />
          <NumberInput
            label={t('fields.rotationInterval')}
            description={t('editor.daysOptional')}
            min={1}
            max={3650}
            value={d.rotationIntervalDays ?? ''}
            onChange={(v) => set({ rotationIntervalDays: typeof v === 'number' ? v : null })}
          />
          <DateField label={t('fields.lastRotated')} value={d.lastRotatedAt} onChange={(v) => set({ lastRotatedAt: v })} />
          <NumberInput
            label={t('fields.reviewInterval')}
            description={t('editor.daysOptional')}
            min={1}
            max={3650}
            value={d.reviewIntervalDays ?? ''}
            onChange={(v) => set({ reviewIntervalDays: typeof v === 'number' ? v : null })}
          />
          <DateField label={t('fields.lastReviewed')} value={d.lastReviewedAt} onChange={(v) => set({ lastReviewedAt: v })} />
        </SimpleGrid>
        {gatusPlatforms.length > 0 && (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('fields.gatusSync')}
              description={t('editor.gatusHint')}
              clearable
              data={gatusPlatforms.map((p) => ({ value: p.id, label: p.name }))}
              value={d.gatus?.platformId ?? null}
              onChange={(v) => set({ gatus: v ? { platformId: v, endpointKey: d.gatus?.endpointKey ?? '' } : null })}
            />
            {d.gatus && (
              <Select
                label={t('editor.gatusEndpoint')}
                searchable
                data={(gatusEndpoints.data ?? []).map((e) => ({ value: e.key, label: `${e.group ? `${e.group}/` : ''}${e.name || e.key}` }))}
                value={d.gatus.endpointKey || null}
                onChange={(v) => set({ gatus: { platformId: d.gatus!.platformId, endpointKey: v ?? '' } })}
                nothingFoundMessage={t('editor.gatusNoEndpoints')}
              />
            )}
          </SimpleGrid>
        )}

        <Divider label={t('editor.remindersSection')} labelPosition="left" />
        <Switch
          label={t('editor.ownReminders')}
          checked={!!d.reminders}
          onChange={(e) => set({ reminders: e.currentTarget.checked ? { daysBefore: [30, 14, 7, 1], overdueEveryDays: 7 } : null })}
        />
        {d.reminders && (
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <TextInput
              label={t('editor.remindDays')}
              description={t('editor.remindDaysHint')}
              defaultValue={reminderDays}
              onBlur={(e) =>
                set({
                  reminders: {
                    ...d.reminders,
                    daysBefore: e.currentTarget.value
                      .split(/[,\s]+/)
                      .map((x) => Number(x))
                      .filter((x) => Number.isInteger(x) && x >= 0 && x <= 365),
                  },
                })
              }
            />
            <NumberInput
              label={t('editor.overdueEvery')}
              min={0}
              max={365}
              value={d.reminders.overdueEveryDays ?? 7}
              onChange={(v) => set({ reminders: { ...d.reminders, overdueEveryDays: typeof v === 'number' ? v : 0 } })}
            />
            <Switch
              mt="lg"
              label={t('editor.noReminders')}
              checked={!!d.reminders.disabled}
              onChange={(e) => set({ reminders: { ...d.reminders, disabled: e.currentTarget.checked } })}
            />
          </SimpleGrid>
        )}

        <Textarea
          label={t('fields.notes')}
          description={t('noSecretsShort')}
          autosize
          minRows={2}
          value={d.notes}
          onChange={(e) => set({ notes: e.currentTarget.value })}
        />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
