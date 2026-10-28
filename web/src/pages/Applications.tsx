import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconApps, IconPlus, IconScale, IconSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CIA_DIMENSIONS, SERVICE_CRITICALITIES, type ApplicationDetail, type ApplicationSummary, type ServiceSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { EmptyState, FilterPanel, PageHeader, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { CriticalityBadge } from './Services';
import { RatingBadges, levelText, useCiaScale } from '../components/catalogue/cia';
import { useRoleLabel } from '../components/catalogue/ServiceApplications';
import { EndOfLifeButton } from '../components/catalogue/lifecycle';

const NOT_RATED = '__none';

/** The applications of the service catalogue: search, filters by service, criticality and protection need. */
export function ApplicationsPage() {
  const { t } = useTranslation(['applications', 'services', 'common']);
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [service, setService] = useState<string | null>(null);
  const [criticality, setCriticality] = useState<string | null>(null);
  const [protection, setProtection] = useState<string | null>(null);
  const apps = useQuery({ queryKey: ['applications', archived], queryFn: () => get<ApplicationSummary[]>(`/applications${archived ? '?archived=1' : ''}`) });
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const scale = useCiaScale().data;
  const roleLabel = useRoleLabel();
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;

  // the levels of all dimensions, once each (a scale per dimension can have different levels)
  const levelOptions = useMemo(() => {
    if (!scale) return [];
    const seen = new Map<string, string>();
    for (const d of CIA_DIMENSIONS) for (const l of scale.levels[d]) if (!seen.has(l.key)) seen.set(l.key, levelText(t, scale, l).label);
    return [...[...seen].map(([value, label]) => ({ value, label })), { value: NOT_RATED, label: t('filters.notRated') }];
  }, [scale, t]);

  const needle = q.trim().toLowerCase();
  const list = (apps.data ?? []).filter((a) => {
    if (needle && ![a.name, a.vendor, ...a.tags].some((x) => x.toLowerCase().includes(needle))) return false;
    if (service && !a.services.some((s) => s.id === service)) return false;
    if (criticality && a.criticality !== criticality) return false;
    if (protection === NOT_RATED) return CIA_DIMENSIONS.every((d) => !a.rating[d]);
    if (protection && !CIA_DIMENSIONS.some((d) => a.rating[d]?.level === protection && !a.rating[d]?.needsRerating)) return false;
    return true;
  });
  const active = [service, criticality, protection].filter(Boolean).length;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <Button size="xs" variant="default" component={Link} to="/applications/cia-scale" leftSection={<IconScale size={14} />}>
              {t('scale.link')}
            </Button>
            <EndOfLifeButton />
            {canCreate && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
                {t('new')}
              </Button>
            )}
          </>
        }
      />
      <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
        <TextInput
          label={t('search')}
          placeholder={t('searchPlaceholder')}
          leftSection={<IconSearch size={14} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={{ base: '100%', sm: 240 }}
          size="xs"
        />
        <FilterPanel active={active}>
          <Group gap="sm" align="flex-end" wrap="wrap">
            <Select
              size="xs"
              label={t('filters.service')}
              data={(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
              value={service}
              onChange={setService}
              clearable
              searchable
              w={200}
            />
            <Select
              size="xs"
              label={t('filters.criticality')}
              data={SERVICE_CRITICALITIES.map((c) => ({ value: c, label: t(`services:criticalities.${c}`) }))}
              value={criticality}
              onChange={setCriticality}
              clearable
              w={160}
            />
            <Select
              size="xs"
              label={t('filters.protection')}
              description={t('filters.protectionHint')}
              data={levelOptions}
              value={protection}
              onChange={setProtection}
              clearable
              w={200}
            />
          </Group>
        </FilterPanel>
      </Group>
      <Switch size="sm" mb="md" label={t('showArchived')} checked={archived} onChange={(e) => setArchived(e.currentTarget.checked)} />
      <QueryState query={apps} />
      {apps.isSuccess && (apps.data ?? []).length === 0 && (
        <EmptyState
          icon={IconApps}
          title={archived ? t('emptyState.titleArchived') : t('emptyState.title')}
          action={
            canCreate &&
            !archived && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('emptyState.action')}
              </Button>
            )
          }
        >
          {archived ? undefined : canCreate ? t('emptyState.textCreate') : t('emptyState.text')}
        </EmptyState>
      )}
      {apps.isSuccess && (apps.data ?? []).length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('noMatch')}
        </Text>
      )}
      {list.length > 0 &&
        (narrow ? (
          <Stack gap="xs" role="list" aria-label={t('title')}>
            {list.map((a) => (
              <Paper key={a.id} withBorder p="sm" role="listitem">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Anchor component={Link} to={`/applications/${a.id}`} fw={600} size="sm">
                      {a.name}
                    </Anchor>
                    <RatingBadges rating={a.rating} />
                    <Text size="xs" c="dimmed">
                      {a.services.map((s) => s.name).join(', ') || a.vendor || '–'}
                    </Text>
                  </Stack>
                  <CriticalityBadge value={a.criticality} />
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : (
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" aria-label={t('title')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('name')}</Table.Th>
                  <Table.Th>{t('cia.title')}</Table.Th>
                  <Table.Th>{t('criticality')}</Table.Th>
                  <Table.Th>{t('servicesColumn')}</Table.Th>
                  <Table.Th>{t('integrationsColumn')}</Table.Th>
                  <Table.Th>{t('updated')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((a) => (
                  <Table.Tr key={a.id} className="clickable" onClick={() => navigate(`/applications/${a.id}`)} data-inactive={a.archived || undefined}>
                    <Table.Td>
                      <Anchor component={Link} to={`/applications/${a.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                        {a.name}
                      </Anchor>
                      {a.archived && (
                        <Badge ml={6} size="xs" variant="outline" color="gray">
                          {t('archived')}
                        </Badge>
                      )}
                      {(a.vendor || a.version) && (
                        <Text size="xs" c="dimmed">
                          {[a.vendor, a.version].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <RatingBadges rating={a.rating} />
                    </Table.Td>
                    <Table.Td>{a.criticality ? <CriticalityBadge value={a.criticality} /> : '–'}</Table.Td>
                    <Table.Td>
                      {a.services.length === 0
                        ? '–'
                        : a.services.map((s) => (
                            <Text key={s.id} size="xs">
                              <Anchor component={Link} to={`/services/${s.id}`} size="xs" onClick={(e) => e.stopPropagation()}>
                                {s.name}
                              </Anchor>{' '}
                              ({roleLabel(s.role, s.roleText)})
                            </Text>
                          ))}
                    </Table.Td>
                    <Table.Td>{a.integrationCount}</Table.Td>
                    <Table.Td className="nowrap" title={fmtDate(a.updatedAt)}>
                      {fmtRelative(a.updatedAt)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        ))}
      {creating && <ApplicationFormModal onClose={() => setCreating(false)} onSaved={(a) => navigate(`/applications/${a.id}`)} />}
    </>
  );
}

/** Create or edit an application. */
export function ApplicationFormModal({ app, onClose, onSaved }: { app?: ApplicationDetail; onClose: () => void; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'services', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(app?.name ?? '');
  const [description, setDescription] = useState(app?.description ?? '');
  const [vendor, setVendor] = useState(app?.vendor ?? '');
  const [version, setVersion] = useState(app?.version ?? '');
  const [url, setUrl] = useState(app?.url ?? '');
  const [criticality, setCriticality] = useState<string | null>(app?.criticality ?? null);
  const [owners, setOwners] = useState<string[]>(app?.owners ?? []);
  const [cmdbSystem, setCmdbSystem] = useState(app?.cmdb?.system ?? '');
  const [cmdbId, setCmdbId] = useState(app?.cmdb?.id ?? '');
  const [cmdbUrl, setCmdbUrl] = useState(app?.cmdb?.url ?? '');
  const [tags, setTags] = useState<string[]>(app?.tags ?? []);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        vendor: vendor.trim(),
        version: version.trim(),
        url: url.trim(),
        criticality,
        owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
        cmdb: cmdbSystem.trim() || cmdbId.trim() || cmdbUrl.trim() ? { system: cmdbSystem.trim(), id: cmdbId.trim(), url: cmdbUrl.trim() } : null,
        tags,
      };
      const a = app ? await put<ApplicationDetail>(`/applications/${app.id}`, body) : await post<ApplicationDetail>('/applications', body);
      void qc.invalidateQueries({ queryKey: ['applications'] });
      qc.setQueryData(['application', a.id], a);
      onSaved(a);
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={app ? t('editTitle', { name: app.name }) : t('newTitle')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
            maxLength={160}
            data-autofocus
            error={v.error('name')}
          />
          <Group grow align="flex-start" wrap="wrap">
            <TextInput label={t('vendor')} value={vendor} onChange={(e) => setVendor(e.currentTarget.value)} maxLength={120} miw={160} />
            <TextInput label={t('version')} value={version} onChange={(e) => setVersion(e.currentTarget.value)} maxLength={60} miw={120} />
          </Group>
          <TextInput label={t('url')} placeholder="https://" value={url} onChange={(e) => setUrl(e.currentTarget.value)} maxLength={2000} />
          <Textarea
            label={t('descriptionLabel')}
            description={t('descriptionHelp')}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            autosize
            minRows={3}
            maxRows={12}
          />
          <Select
            label={t('criticality')}
            placeholder={t('services:criticalities.none')}
            data={SERVICE_CRITICALITIES.map((c) => ({ value: c, label: t(`services:criticalities.${c}`) }))}
            value={criticality}
            onChange={setCriticality}
            clearable
          />
          <TagsInput label={t('owners')} description={t('ownersHelp')} value={owners} onChange={setOwners} maxTags={20} />
          <Text fw={600} size="sm">
            {t('cmdb')}
          </Text>
          <Group grow align="flex-start" wrap="wrap">
            <TextInput
              size="xs"
              label={t('cmdbSystem')}
              placeholder="ServiceNow"
              value={cmdbSystem}
              onChange={(e) => setCmdbSystem(e.currentTarget.value)}
              maxLength={80}
              miw={140}
            />
            <TextInput size="xs" label={t('cmdbId')} value={cmdbId} onChange={(e) => setCmdbId(e.currentTarget.value)} maxLength={120} miw={140} />
          </Group>
          <TextInput
            size="xs"
            label={t('cmdbUrl')}
            placeholder="https://"
            value={cmdbUrl}
            onChange={(e) => setCmdbUrl(e.currentTarget.value)}
            maxLength={2000}
          />
          <TagsInput label={t('tags')} value={tags} onChange={setTags} maxTags={30} />
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
