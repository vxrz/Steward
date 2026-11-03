import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Group, Modal, Select, Stack, Switch, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconCalendarPlus, IconCheck, IconPencil, IconPlayerPlay, IconPlugConnected, IconSearch } from '@tabler/icons-react';
import type { Platform, PlatformPreset, ProcessDetail, ProcessTemplate } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { DescriptionText, descriptionPlain } from './DescriptionText';
import { RunDialog } from './RunDialog';

/** Fields a newer server may add to a template (tolerated, used when present). */
type TemplateInfo = ProcessTemplate & {
  recommendedSchedule?: string | { cron?: string; label?: string; description?: string } | null;
};

/** The platform kinds a template needs: its connections that expect a kind (generic slots accept any platform). */
export function requiredKinds(tpl: ProcessTemplate): string[] {
  const kinds = (tpl.definition.connections ?? []).map((c) => c.kind).filter((k): k is string => !!k && k !== 'generic');
  return [...new Set(kinds)];
}

const scheduleText = (s: TemplateInfo['recommendedSchedule']): string | null =>
  !s ? null : typeof s === 'string' ? s : (s.label ?? s.description ?? s.cron ?? null);

const steps = (tpl: ProcessTemplate) => (tpl.definition.nodes ?? []).filter((n) => n.type !== 'start' && n.type !== 'note').length;

/** "any platform": templates without a required kind */
const ANY = '';

/**
 * "Start from a template": search, a filter by platform kind, "matches your platforms", grouped by the kind a
 * template needs, with what each needs ("needs: Insights Hub platform") – and after "Use", the next steps.
 */
export function TemplateGallery({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('processes');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => get<TemplateInfo[]>('/templates'), enabled: opened });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms'), enabled: opened });
  const presets = useQuery({ queryKey: ['platform-presets'], queryFn: () => get<PlatformPreset[]>('/platform-presets'), enabled: opened, retry: false });
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<ProcessDetail | null>(null);
  const [dryRun, setDryRun] = useState(false);

  const have = useMemo(() => new Set((platforms.data ?? []).map((p) => p.kind)), [platforms.data]);
  // the connector's name without its variant ("Siemens Insights Hub (service credentials)" → "Siemens Insights Hub")
  const label = (k: string) => (k === ANY ? t('templates.anyPlatform') : (presets.data?.find((p) => p.kind === k)?.label.replace(/\s*\([^)]*\)\s*$/, '') ?? k));
  const all = templates.data ?? [];
  const kinds = [...new Set(all.flatMap((x) => (requiredKinds(x).length ? requiredKinds(x) : [ANY])))];
  const q = search.trim().toLowerCase();
  const list = all.filter((x) => {
    const need = requiredKinds(x);
    if (kind !== null && !(kind === ANY ? !need.length : need.includes(kind))) return false;
    if (mine && !need.every((k) => have.has(k))) return false;
    if (!q) return true;
    return [x.name, descriptionPlain(x.description), ...x.tags, ...need.map(label)].some((s) => s.toLowerCase().includes(q));
  });
  // grouped by the first kind a template needs; templates for any platform last
  const groups = [...new Set(list.map((x) => requiredKinds(x)[0] ?? ANY))].sort((a, b) => (a === ANY ? 1 : b === ANY ? -1 : label(a).localeCompare(label(b))));

  const close = () => {
    setCreated(null);
    onClose();
  };
  const use = async (tpl: ProcessTemplate) => {
    setBusy(tpl.id);
    try {
      const p = await post<ProcessDetail>('/processes', { templateId: tpl.id });
      qc.invalidateQueries({ queryKey: ['processes'] });
      setCreated(p);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Modal opened={opened && !dryRun} onClose={close} title={t('templates.title')} size="xl">
        {created ? (
          // the next steps after "Use template"
          <Stack data-testid="template-next-steps">
            <Alert color="green" icon={<IconCheck size={18} />} title={t('templates.created', { name: created.name })}>
              {t('templates.nextText')}
            </Alert>
            {requiredKinds({ definition: created.definition } as ProcessTemplate)
              .filter((k) => !have.has(k))
              .map((k) => (
                <Alert key={k} color="orange" icon={<IconPlugConnected size={18} />}>
                  {t('templates.missingPlatform', { kind: label(k) })}
                </Alert>
              ))}
            <Group>
              <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => setDryRun(true)}>
                {t('templates.dryRun')}
              </Button>
              <Button
                variant="default"
                leftSection={<IconCalendarPlus size={16} />}
                onClick={() => {
                  close();
                  navigate(`/schedules?new=1&processId=${encodeURIComponent(created.id)}`);
                }}
              >
                {t('templates.schedule')}
              </Button>
              <Button
                variant="default"
                leftSection={<IconPencil size={16} />}
                onClick={() => {
                  close();
                  navigate(`/processes/${created.id}`);
                }}
              >
                {t('templates.openEditor')}
              </Button>
            </Group>
            <Button variant="subtle" size="xs" w="fit-content" onClick={() => setCreated(null)}>
              {t('templates.backToList')}
            </Button>
          </Stack>
        ) : (
          <Stack>
            <Group gap="xs" align="flex-end" wrap="wrap">
              <TextInput
                data-autofocus
                label={t('templates.search')}
                placeholder={t('templates.searchPlaceholder')}
                leftSection={<IconSearch size={14} />}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                w={{ base: '100%', xs: 260 }}
              />
              <Select
                label={t('templates.platform')}
                placeholder={t('templates.allPlatforms')}
                clearable
                data={kinds
                  .sort((a, b) => (a === ANY ? 1 : b === ANY ? -1 : label(a).localeCompare(label(b))))
                  .map((k) => ({ value: k === ANY ? '-' : k, label: label(k) }))}
                value={kind === null ? null : kind === ANY ? '-' : kind}
                onChange={(v) => setKind(v === null ? null : v === '-' ? ANY : v)}
                w={{ base: '100%', xs: 240 }}
              />
              <Switch label={t('templates.mine')} checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} mb={6} />
            </Group>
            <Text size="xs" c="dimmed" aria-live="polite">
              {t('templates.shown', { count: list.length, total: all.length })}
            </Text>
            {templates.isSuccess && !list.length && (
              <Text size="sm" c="dimmed">
                {t('templates.noMatch')}
              </Text>
            )}
            {groups.map((g) => (
              <Stack key={g || 'any'} gap="xs" component="section" aria-label={label(g)}>
                <Title order={6} c="dimmed" tt="uppercase" fz="xs">
                  {label(g)} · {list.filter((x) => (requiredKinds(x)[0] ?? ANY) === g).length}
                </Title>
                {list
                  .filter((x) => (requiredKinds(x)[0] ?? ANY) === g)
                  .map((tpl) => {
                    const sched = scheduleText(tpl.recommendedSchedule);
                    return (
                      <Card key={tpl.id} withBorder padding="sm" data-testid="template-card">
                        <Group justify="space-between" wrap="nowrap" align="flex-start">
                          <div style={{ minWidth: 0 }}>
                            <Text fw={600}>{tpl.name}</Text>
                            <DescriptionText text={tpl.description} size="sm" c="dimmed" lineClamp={3} />
                            <Group gap={4} mt={6}>
                              {requiredKinds(tpl).map((k) => (
                                <Tooltip key={k} label={have.has(k) ? t('templates.haveKind') : t('templates.missingKind')}>
                                  <Badge
                                    size="xs"
                                    variant={have.has(k) ? 'light' : 'outline'}
                                    color={have.has(k) ? 'blue' : 'orange'}
                                    leftSection={have.has(k) ? <IconCheck size={10} /> : <IconPlugConnected size={10} />}
                                    data-testid="template-needs"
                                    tt="none"
                                  >
                                    {t('templates.needs', { kind: label(k) })}
                                  </Badge>
                                </Tooltip>
                              ))}
                              <Badge size="xs" variant="outline">
                                {t('templates.steps', { count: steps(tpl) })}
                              </Badge>
                              {sched && (
                                <Badge size="xs" variant="light" color="teal" leftSection={<IconCalendarPlus size={10} />}>
                                  {t('templates.recommended', { schedule: sched })}
                                </Badge>
                              )}
                              {tpl.tags.map((tag) => (
                                <Badge key={tag} size="xs" variant="light" color="gray">
                                  {tag}
                                </Badge>
                              ))}
                            </Group>
                          </div>
                          <Button
                            size="xs"
                            style={{ flexShrink: 0 }}
                            aria-label={t('templates.useNamed', { name: tpl.name })}
                            loading={busy === tpl.id}
                            onClick={() => use(tpl)}
                          >
                            {t('templates.use')}
                          </Button>
                        </Group>
                      </Card>
                    );
                  })}
              </Stack>
            ))}
          </Stack>
        )}
      </Modal>
      {/* a dry run of the new process; the run page opens when it starts */}
      <RunDialog
        processId={dryRun ? (created?.id ?? null) : null}
        opened={dryRun}
        onClose={() => {
          setDryRun(false);
          setCreated(null);
          onClose();
        }}
      />
    </>
  );
}
