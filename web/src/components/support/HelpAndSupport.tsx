import { useMemo, useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconArrowDown,
  IconArrowUp,
  IconBrandSlack,
  IconBrandTeams,
  IconEdit,
  IconExternalLink,
  IconInfoCircle,
  IconLifebuoy,
  IconMail,
  IconMessageCircle,
  IconPhone,
  IconPlus,
  IconTicket,
  IconTrash,
  IconWorldWww,
  type Icon,
} from '@tabler/icons-react';
import {
  SUPPORT_LIMITS as SL,
  SUPPORT_PURPOSES,
  SUPPORT_TOOLS,
  effectiveSupport,
  isSupportAddress,
  isSupportUrl,
  levelName,
  type ItemSupport,
  type ItemSupportInput,
  type ServiceSummary,
  type SupportChannel,
  type SupportItemKind,
  type SupportLevel,
  type SupportLevelRef,
  type SupportPurpose,
  type SupportTool,
} from '@sm/shared';
import { ApiError, get, put } from '../../api';
import { errorText } from '../../i18n/errors';
import { FormModal } from '../FormModal';
import { FormButtons, useBusy } from '../dataproducts/form';

/**
 * Help and support of a data product, service or application (0.26.0, ADR 0039, docs/SUPPORT.md): its channels first
 * (purpose, tool, the address as a link, hours, note), then the support level with what it promises, then – for data
 * products – the guides as external links. A product supported by a service shows that service's channels and level,
 * marked as such, where it names none of its own (only for readers who may see the service: the server leaves it out
 * otherwise).
 */

export const TOOL_ICONS: Record<SupportTool, Icon> = {
  ticket: IconTicket,
  email: IconMail,
  teams: IconBrandTeams,
  slack: IconBrandSlack,
  web: IconWorldWww,
  phone: IconPhone,
  other: IconMessageCircle,
};

/** The support level catalogue (every signed-in reader). */
export function useSupportLevels(enabled = true) {
  return useQuery({ queryKey: ['support-levels'], queryFn: () => get<SupportLevel[]>('/support/levels'), enabled, staleTime: 60_000 });
}

/** An external link that says it opens a new tab (web addresses; mailto: and tel: open where they open). */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const { t } = useTranslation('support');
  const web = /^https?:/i.test(href);
  return (
    <Anchor href={href} size="sm" {...(web ? { target: '_blank', rel: 'noopener noreferrer' } : {})} style={{ overflowWrap: 'anywhere' }}>
      {children}
      {web && (
        <>
          {' '}
          <IconExternalLink size={12} aria-hidden style={{ verticalAlign: 'middle' }} />
          <VisuallyHidden>{t('guides.opensNewTab')}</VisuallyHidden>
        </>
      )}
    </Anchor>
  );
}

/** One channel as a card: tool icon, purpose, name, the address as a link, hours, note. */
function ChannelCard({ c }: { c: SupportChannel }) {
  const { t } = useTranslation('support');
  const I = TOOL_ICONS[c.tool] ?? IconMessageCircle;
  return (
    <Paper withBorder p="xs" component="li" style={{ listStyle: 'none' }} data-testid="support-channel">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Tooltip label={t(`tools.${c.tool}`)}>
          <span style={{ display: 'inline-flex', paddingTop: 2 }}>
            <I size={20} aria-hidden />
          </span>
        </Tooltip>
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="wrap">
            <Badge variant="light" size="sm" tt="none">
              {t(`purposes.${c.purpose}`)}
            </Badge>
            <VisuallyHidden>{t(`tools.${c.tool}`)}</VisuallyHidden>
            {c.name && (
              <Text size="sm" fw={600}>
                {c.name}
              </Text>
            )}
          </Group>
          {c.address && <ExternalLink href={c.address}>{c.address.replace(/^(mailto|tel):/i, '')}</ExternalLink>}
          {c.hours && (
            <Text size="xs" c="dimmed">
              {t('level.hours')}: {c.hours}
            </Text>
          )}
          {c.note && <Text size="xs">{c.note}</Text>}
        </Stack>
      </Group>
    </Paper>
  );
}

function LevelView({ level }: { level: SupportLevelRef }) {
  const { t, i18n } = useTranslation('support');
  return (
    <Stack gap={4} data-testid="support-level">
      <Text size="sm" fw={600}>
        {levelName(level, i18n.language)}
      </Text>
      <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs" verticalSpacing={4}>
        {level.hours && (
          <Text size="sm">
            <Text span c="dimmed" size="sm">
              {t('level.hours')}:
            </Text>{' '}
            {level.hours}
          </Text>
        )}
        {level.firstResponse && (
          <Text size="sm">
            <Text span c="dimmed" size="sm">
              {t('level.firstResponse')}:
            </Text>{' '}
            {level.firstResponse}
          </Text>
        )}
      </SimpleGrid>
      {level.note && <Text size="sm">{level.note}</Text>}
      {level.slaUrl && <ExternalLink href={level.slaUrl}>{t('level.sla')}</ExternalLink>}
      <Text size="xs" c="dimmed">
        {t('level.promise')}
      </Text>
    </Stack>
  );
}

function FromService({ name, id }: { name: string; id: string }) {
  const { t } = useTranslation('support');
  return (
    <Badge variant="outline" color="gray" size="sm" tt="none" component={Link} to={`/services/${encodeURIComponent(id)}`} style={{ cursor: 'pointer' }}>
      {t('channels.fromService', { name })}
    </Badge>
  );
}

/** The section on an item's page. */
export function HelpAndSupportSection({
  kind,
  support,
  canEdit,
  onEdit,
}: {
  kind: SupportItemKind;
  support: ItemSupport;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation('support');
  const shown = effectiveSupport(support);
  const svc = support.supportedBy?.service;
  const titleId = `support-title-${kind}`;
  return (
    <Paper withBorder p="md" data-testid="help-and-support" component="section" aria-labelledby={titleId}>
      <Group justify="space-between" mb="sm" gap="xs" wrap="wrap">
        <Group gap={6}>
          <IconLifebuoy size={18} aria-hidden />
          <Title order={2} size="h5" id={titleId}>
            {t('title')}
          </Title>
        </Group>
        {canEdit && (
          <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={onEdit} data-testid="support-edit">
            {t('edit')}
          </Button>
        )}
      </Group>
      <Stack gap="md">
        <Stack gap={6}>
          <Group gap="xs" justify="space-between" wrap="wrap">
            <Title order={3} size="h6">
              {t('channels.title')}
            </Title>
            {shown.channelsFromService && svc && <FromService name={svc.name} id={svc.id} />}
          </Group>
          {shown.channels.length ? (
            <Stack gap={6} component="ul" m={0} p={0}>
              {shown.channels.map((c) => (
                <ChannelCard key={c.id} c={c} />
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {t('channels.none')}
            </Text>
          )}
        </Stack>
        <Stack gap={6}>
          <Group gap="xs" justify="space-between" wrap="wrap">
            <Title order={3} size="h6">
              {t('level.title')}
            </Title>
            {shown.levelFromService && svc && <FromService name={svc.name} id={svc.id} />}
          </Group>
          {shown.level ? (
            <LevelView level={shown.level} />
          ) : (
            <Text size="sm" c="dimmed">
              {t('level.none')}
            </Text>
          )}
        </Stack>
        {kind === 'data_product' && (
          <Stack gap={6}>
            <Title order={3} size="h6">
              {t('guides.title')}
            </Title>
            {support.guides.length ? (
              <Stack gap={4} component="ul" m={0} p={0} style={{ listStyle: 'none' }} data-testid="support-guides">
                {support.guides.map((g) => (
                  <li key={g.id}>
                    <ExternalLink href={g.url}>{g.title}</ExternalLink>
                  </li>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                {t('guides.none')}
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

// ---------- the editor ----------

type ChannelDraft = Omit<SupportChannel, 'id'> & { key: number };
type GuideDraft = { title: string; url: string; key: number };

let nextKey = 1;
const draftOf = (c: Omit<SupportChannel, 'id'>): ChannelDraft => ({
  purpose: c.purpose,
  tool: c.tool,
  name: c.name,
  address: c.address,
  hours: c.hours,
  note: c.note,
  key: nextKey++,
});

/**
 * The fields of the server's refusal: an INVALID_INPUT names them ("channels.1.address: …"), a missing level or service
 * is its field – with the text to show there (null: the general "Check this value").
 */
export function serverFieldErrors(e: unknown): Record<string, string | null> {
  if (!(e instanceof ApiError)) return {};
  if (e.code === 'SUPPORT_LEVEL_NOT_FOUND') return { levelId: errorText(e) };
  if (e.code === 'SERVICE_NOT_FOUND') return { supportedByServiceId: errorText(e) };
  if (e.code !== 'INVALID_INPUT') return {};
  const details = String((e.params as { details?: unknown } | undefined)?.details ?? '');
  const out: Record<string, string | null> = {};
  for (const part of details.split('; ')) {
    const path = part.split(':')[0]?.trim();
    if (path) out[path] = null;
  }
  return out;
}

/** Up, down and remove for one row of a list (targets of 28 px). */
function RowActions({
  i,
  n,
  labels,
  onMove,
  onRemove,
}: {
  i: number;
  n: number;
  labels: { up: string; down: string; remove: string };
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={labels.up}>
        <ActionIcon variant="subtle" size="lg" aria-label={labels.up} disabled={i === 0} onClick={() => onMove(-1)}>
          <IconArrowUp size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={labels.down}>
        <ActionIcon variant="subtle" size="lg" aria-label={labels.down} disabled={i === n - 1} onClick={() => onMove(1)}>
          <IconArrowDown size={16} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label={labels.remove}>
        <ActionIcon variant="subtle" color="red" size="lg" aria-label={labels.remove} onClick={onRemove}>
          <IconTrash size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

const move = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
};

/**
 * Changes the help and support of an item: channels (add, order, remove), the level, and for data products the guides
 * and the service that supports it. Checked before saving; what the server refuses is shown at its field.
 */
export function SupportEditor({
  kind,
  name,
  support,
  onClose,
  onSave,
}: {
  kind: SupportItemKind;
  name: string;
  support: ItemSupport;
  onClose: () => void;
  onSave: (body: ItemSupportInput) => Promise<void>;
}) {
  const { t, i18n } = useTranslation(['support', 'common']);
  const product = kind === 'data_product';
  const levels = useSupportLevels();
  const services = useQuery({ queryKey: ['services'], queryFn: () => get<ServiceSummary[]>('/services'), enabled: product });
  const [channels, setChannels] = useState<ChannelDraft[]>(() => support.channels.map(draftOf));
  const [levelId, setLevelId] = useState<string | null>(support.level?.id ?? null);
  const [guides, setGuides] = useState<GuideDraft[]>(() => support.guides.map((g) => ({ title: g.title, url: g.url, key: nextKey++ })));
  const initialService = support.supportedBy?.service.id ?? null;
  const [serviceId, setServiceId] = useState<string | null>(initialService);
  const [shown, setShown] = useState(false);
  const [server, setServer] = useState<Record<string, string | null>>({});
  const [busy, run] = useBusy();

  const channelError = (c: ChannelDraft, field: 'name' | 'address'): string | undefined => {
    if (field === 'address' && c.address.trim() && !isSupportAddress(c.address)) return t('fields.addressInvalid');
    if (field === 'address' && !c.address.trim() && !c.name.trim()) return t('fields.nameOrAddress');
    return undefined;
  };
  const guideError = (g: GuideDraft, field: 'title' | 'url'): string | undefined => {
    if (field === 'title' && !g.title.trim()) return t('common:validation.required');
    if (field === 'url' && !isSupportUrl(g.url)) return t('fields.urlInvalid');
    return undefined;
  };
  const invalid = channels.some((c) => channelError(c, 'address')) || (product && guides.some((g) => guideError(g, 'title') || guideError(g, 'url')));
  const err = (path: string, local?: string) => (shown && local) || (path in server ? (server[path] ?? t('fields.serverInvalid')) : undefined);

  const levelOptions = useMemo(() => (levels.data ?? []).map((l) => ({ value: l.id, label: levelName(l, i18n.language) })), [levels.data, i18n.language]);
  const chosen = levels.data?.find((l) => l.id === levelId);
  const serviceOptions = useMemo(() => {
    const list = (services.data ?? []).filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name }));
    // the current one, also when archived
    if (initialService && support.supportedBy && !list.some((o) => o.value === initialService))
      list.push({ value: initialService, label: support.supportedBy.service.name });
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [services.data, initialService, support.supportedBy]);

  const setChannel = (i: number, patch: Partial<ChannelDraft>) => {
    setChannels((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setServer({});
  };
  const setGuide = (i: number, patch: Partial<GuideDraft>) => {
    setGuides((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)));
    setServer({});
  };

  const save = () =>
    run(async () => {
      const body: ItemSupportInput = {
        channels: channels.map(({ key: _k, ...c }) => ({
          purpose: c.purpose,
          tool: c.tool,
          name: c.name.trim(),
          address: c.address.trim(),
          hours: c.hours.trim(),
          note: c.note.trim(),
        })),
        levelId,
        ...(product ? { guides: guides.map((g) => ({ title: g.title.trim(), url: g.url.trim() })) } : {}),
        // a service the editor may not see stays as it is unless another one is picked
        ...(product && serviceId !== initialService ? { supportedByServiceId: serviceId } : {}),
      };
      try {
        await onSave(body);
      } catch (e) {
        const fields = serverFieldErrors(e);
        setServer(fields);
        // shown at its field (and focused there); anything else as a notification
        if (!Object.keys(fields).length) throw e;
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      }
    }, t('notSaved'));

  return (
    <FormModal onClose={onClose} size="xl" title={t('editTitle', { name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (invalid) {
            setShown(true);
            requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
            return;
          }
          void save();
        }}
      >
        <Stack gap="md">
          <Stack gap="xs">
            <Title order={3} size="h6">
              {t('channels.title')}
            </Title>
            <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} p="xs" data-testid="support-channel-hint">
              <Text size="sm">{t('channels.hint')}</Text>
            </Alert>
            {channels.map((c, i) => (
              <Paper key={c.key} withBorder p="xs" role="group" aria-label={t('channels.item', { n: i + 1 })} data-testid="support-channel-row">
                <Stack gap="xs">
                  <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Text size="sm" fw={600}>
                      {t('channels.item', { n: i + 1 })}
                    </Text>
                    <RowActions
                      i={i}
                      n={channels.length}
                      labels={{
                        up: t('channels.moveUp', { n: i + 1 }),
                        down: t('channels.moveDown', { n: i + 1 }),
                        remove: t('channels.remove', { n: i + 1 }),
                      }}
                      onMove={(d) => setChannels((cs) => move(cs, i, d))}
                      onRemove={() => setChannels((cs) => cs.filter((_, j) => j !== i))}
                    />
                  </Group>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
                    <Select
                      label={t('fields.purpose')}
                      data={SUPPORT_PURPOSES.map((p) => ({ value: p, label: t(`purposes.${p}`) }))}
                      value={c.purpose}
                      onChange={(v) => v && setChannel(i, { purpose: v as SupportPurpose })}
                      allowDeselect={false}
                      error={err(`channels.${i}.purpose`)}
                    />
                    <Select
                      label={t('fields.tool')}
                      data={SUPPORT_TOOLS.map((x) => ({ value: x, label: t(`tools.${x}`) }))}
                      value={c.tool}
                      onChange={(v) => v && setChannel(i, { tool: v as SupportTool })}
                      allowDeselect={false}
                      error={err(`channels.${i}.tool`)}
                    />
                    <TextInput
                      label={t('fields.name')}
                      placeholder={t('fields.namePlaceholder')}
                      maxLength={SL.name}
                      value={c.name}
                      onChange={(e) => setChannel(i, { name: e.currentTarget.value })}
                      error={err(`channels.${i}.name`)}
                    />
                    <TextInput
                      label={t('fields.address')}
                      description={t('fields.addressHint')}
                      placeholder="https://…"
                      maxLength={SL.address}
                      value={c.address}
                      onChange={(e) => setChannel(i, { address: e.currentTarget.value })}
                      error={err(`channels.${i}.address`, channelError(c, 'address'))}
                      data-testid="support-channel-address"
                    />
                    <TextInput
                      label={t('fields.hours')}
                      placeholder={t('fields.hoursPlaceholder')}
                      maxLength={SL.hours}
                      value={c.hours}
                      onChange={(e) => setChannel(i, { hours: e.currentTarget.value })}
                      error={err(`channels.${i}.hours`)}
                    />
                    <TextInput
                      label={t('fields.note')}
                      description={t('fields.noteHint')}
                      maxLength={SL.note}
                      value={c.note}
                      onChange={(e) => setChannel(i, { note: e.currentTarget.value })}
                      error={err(`channels.${i}.note`)}
                    />
                  </SimpleGrid>
                </Stack>
              </Paper>
            ))}
            {channels.length < SL.channels ? (
              <Group>
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => setChannels((cs) => [...cs, draftOf({ purpose: 'questions', tool: 'email', name: '', address: '', hours: '', note: '' })])}
                  data-testid="support-channel-add"
                >
                  {t('channels.add')}
                </Button>
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                {t('channels.max', { max: SL.channels })}
              </Text>
            )}
          </Stack>

          <Select
            label={t('fields.level')}
            description={t('fields.levelHint')}
            data={levelOptions}
            value={levelId}
            onChange={(v) => {
              setLevelId(v);
              setServer({});
            }}
            clearable
            placeholder={t('fields.noLevel')}
            error={err('levelId')}
            data-testid="support-level-select"
          />
          {chosen && (
            <Paper withBorder p="xs" bg="var(--mantine-color-default-hover)">
              <LevelView level={chosen} />
            </Paper>
          )}

          {product && (
            <>
              <Select
                label={t('fields.service')}
                description={t('fields.serviceHint')}
                data={serviceOptions}
                value={serviceId}
                onChange={(v) => {
                  setServiceId(v);
                  setServer({});
                }}
                searchable
                clearable
                placeholder={t('fields.noService')}
                error={err('supportedByServiceId')}
                data-testid="support-service-select"
              />
              <Stack gap="xs">
                <Title order={3} size="h6">
                  {t('guides.title')}
                </Title>
                <Text size="xs" c="dimmed">
                  {t('guides.hint')}
                </Text>
                {guides.map((g, i) => (
                  <Paper key={g.key} withBorder p="xs" role="group" aria-label={t('guides.item', { n: i + 1 })} data-testid="support-guide-row">
                    <Group align="flex-start" gap="xs" wrap="wrap">
                      <TextInput
                        label={t('fields.guideTitle')}
                        maxLength={SL.title}
                        value={g.title}
                        onChange={(e) => setGuide(i, { title: e.currentTarget.value })}
                        error={err(`guides.${i}.title`, guideError(g, 'title'))}
                        style={{ flex: '1 1 12rem', minWidth: 0 }}
                      />
                      <TextInput
                        label={t('fields.guideUrl')}
                        placeholder="https://…"
                        maxLength={SL.url}
                        value={g.url}
                        onChange={(e) => setGuide(i, { url: e.currentTarget.value })}
                        error={err(`guides.${i}.url`, guideError(g, 'url'))}
                        style={{ flex: '2 1 16rem', minWidth: 0 }}
                      />
                      <div style={{ paddingTop: 24 }}>
                        <RowActions
                          i={i}
                          n={guides.length}
                          labels={{ up: t('guides.moveUp', { n: i + 1 }), down: t('guides.moveDown', { n: i + 1 }), remove: t('guides.remove', { n: i + 1 }) }}
                          onMove={(d) => setGuides((gs) => move(gs, i, d))}
                          onRemove={() => setGuides((gs) => gs.filter((_, j) => j !== i))}
                        />
                      </div>
                    </Group>
                  </Paper>
                ))}
                {guides.length < SL.guides && (
                  <Group>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconPlus size={14} />}
                      onClick={() => setGuides((gs) => [...gs, { title: '', url: '', key: nextKey++ }])}
                      data-testid="support-guide-add"
                    >
                      {t('guides.add')}
                    </Button>
                  </Group>
                )}
              </Stack>
            </>
          )}
          <FormButtons busy={busy} testId="support-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The section with its editor: saves with PUT `<path>/support` and hands the changed item to `onSaved`. */
export function ItemHelpAndSupport<T>({
  kind,
  path,
  name,
  support,
  canEdit,
  onSaved,
}: {
  kind: SupportItemKind;
  /** The item's API path, e.g. /services/svc_… */
  path: string;
  name: string;
  support: ItemSupport;
  canEdit: boolean;
  onSaved: (item: T) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <HelpAndSupportSection kind={kind} support={support} canEdit={canEdit} onEdit={() => setEditing(true)} />
      {editing && (
        <SupportEditor
          kind={kind}
          name={name}
          support={support}
          onClose={() => setEditing(false)}
          onSave={async (body) => {
            onSaved(await put<T>(`${path}/support`, body));
            setEditing(false);
          }}
        />
      )}
    </>
  );
}
