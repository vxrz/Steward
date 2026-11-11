import { useMemo, useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Paper, Select, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconApps, IconPlus, IconScale } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SubjectsInput } from '../components/SubjectsInput';
import { CIA_DIMENSIONS, SERVICE_CRITICALITIES, tagLabel, tagsMatch, type ApplicationDetail, type ApplicationSummary, type ServiceSummary } from '@sm/shared';
import { TagBadges, TagFilterChip, TagInput, useTagFilter } from '../components/tags';
import { get, notifyError, post, put } from '../api';
import { EmptyState, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtDate, fmtRelative } from '../format';
import { CRITICALITY_RANK, CriticalityBadge } from './Services';
import { RatingBadges, levelText, useCiaScale } from '../components/catalogue/cia';
import { useRoleLabel } from '../components/catalogue/ServiceApplications';
import { EndOfLifeButton } from '../components/catalogue/lifecycle';
import { VersionWatchButton } from '../components/catalogue/versions';
import { ListPage } from '../components/page/ListPage';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { IfModule } from '../components/modules/ModuleOff';
import { RestrictedEmpty, useHiddenByPermissions } from '../components/modules/RestrictedEmpty';
import { SupplierPicker, useSupplierChoice } from '../components/suppliers/SupplierPicker';

const NOT_RATED = '__none';

/** The applications of the service catalogue: search, filters by service, criticality and protection need. */
export function ApplicationsPage() {
  const { t } = useTranslation(['applications', 'services', 'common']);
  const navigate = useNavigate();
  // the filters live in the address (?q=, ?service=, ?criticality=, ?protection=, ?archived=1, ?tag=), so a filtered list can be shared
  const { params, set } = useListParams();
  const q = params.get('q') ?? '';
  const service = params.get('service');
  const criticality = params.get('criticality');
  const protection = params.get('protection');
  const archived = params.get('archived') === '1';
  const [creating, setCreating] = useState(false);
  const apps = useQuery({ queryKey: ['applications', archived], queryFn: () => get<ApplicationSummary[]>(`/applications${archived ? '?archived=1' : ''}`) });
  // entries the person may not see (U3): "nothing you may see" instead of "nothing yet"
  const hidden = useHiddenByPermissions('applications');
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const scale = useCiaScale().data;
  const roleLabel = useRoleLabel();
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));

  // the levels of all dimensions, once each (a scale per dimension can have different levels)
  const levelOptions = useMemo(() => {
    if (!scale) return [];
    const seen = new Map<string, string>();
    for (const d of CIA_DIMENSIONS) for (const l of scale.levels[d]) if (!seen.has(l.key)) seen.set(l.key, levelText(t, scale, l).label);
    return [...[...seen].map(([value, label]) => ({ value, label })), { value: NOT_RATED, label: t('filters.notRated') }];
  }, [scale, t]);

  const [tag, setTag] = useTagFilter();
  const needle = q.trim().toLowerCase();
  const all = apps.data ?? [];
  const list = all.filter((a) => {
    if (needle && ![a.name, a.vendor, a.supplier?.name ?? '', ...a.tags.map(tagLabel)].some((x) => x.toLowerCase().includes(needle))) return false;
    if (!tagsMatch(a.tags, tag)) return false;
    if (service && !a.services.some((s) => s.id === service)) return false;
    if (criticality && a.criticality !== criticality) return false;
    if (protection === NOT_RATED) return CIA_DIMENSIONS.every((d) => !a.rating[d]);
    if (protection && !CIA_DIMENSIONS.some((d) => a.rating[d]?.level === protection && !a.rating[d]?.needsRerating)) return false;
    return true;
  });
  const active = [service, criticality, protection, archived].filter(Boolean).length;
  const columns: DataColumn<ApplicationSummary>[] = [
    {
      key: 'name',
      header: t('name'),
      sortValue: (a) => a.name,
      cell: (a) => (
        <>
          {/* inline-block with a 24 px line: a target of at least 24 × 24 px (WCAG 2.2, 2.5.8) */}
          <Anchor component={Link} to={`/applications/${a.id}`} fw={500} size="sm" display="inline-block" lh="24px" onClick={(e) => e.stopPropagation()}>
            {a.name}
          </Anchor>
          {a.archived && (
            <Badge ml={6} size="xs" variant="outline" color="gray">
              {t('archived')}
            </Badge>
          )}
          {(a.supplier || a.vendor || a.version) && (
            <Text size="xs" c="dimmed">
              {[a.supplier?.name ?? a.vendor, a.version].filter(Boolean).join(' · ')}
            </Text>
          )}
          <TagBadges tags={a.tags} onTag={setTag} />
        </>
      ),
    },
    { key: 'cia', header: t('cia.title'), cell: (a) => <RatingBadges rating={a.rating} /> },
    {
      key: 'criticality',
      header: t('criticality'),
      sortValue: (a) => (a.criticality ? CRITICALITY_RANK[a.criticality] : null),
      cell: (a) => (a.criticality ? <CriticalityBadge value={a.criticality} /> : '–'),
    },
    {
      key: 'services',
      header: t('servicesColumn'),
      sortValue: (a) => a.services.map((s) => s.name).join(', '),
      cell: (a) =>
        a.services.length === 0
          ? '–'
          : a.services.map((s) => (
              <Text key={s.id} size="xs">
                <Anchor component={Link} to={`/services/${s.id}`} size="xs" onClick={(e) => e.stopPropagation()}>
                  {s.name}
                </Anchor>{' '}
                ({roleLabel(s.role, s.roleText)})
              </Text>
            )),
    },
    { key: 'integrations', header: t('integrationsColumn'), sortValue: (a) => a.integrationCount, cell: (a) => a.integrationCount },
    {
      key: 'updated',
      header: t('updated'),
      sortValue: (a) => a.updatedAt,
      nowrap: true,
      tdProps: (a) => ({ title: fmtDate(a.updatedAt) }),
      cell: (a) => fmtRelative(a.updatedAt),
    },
  ];

  return (
    <ListPage
      view="applications"
      title={t('title')}
      description={t('description')}
      actions={
        <>
          <Button size="xs" variant="default" component={Link} to="/applications/cia-scale" leftSection={<IconScale size={14} />}>
            {t('scale.link')}
          </Button>
          <IfModule module="versionWatch">
            <EndOfLifeButton />
            <VersionWatchButton />
          </IfModule>
          {canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('new')}
            </Button>
          )}
        </>
      }
      search={{ value: q, onChange: (v) => set('q', v), placeholder: t('searchPlaceholder'), label: t('search') }}
      activeFilters={active}
      filters={
        <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="application-filters">
          <Select
            size="xs"
            label={t('filters.service')}
            data={(services.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            value={service}
            onChange={(v) => set('service', v)}
            clearable
            searchable
            w={{ base: '100%', xs: 200 }}
          />
          <Select
            size="xs"
            label={t('filters.criticality')}
            data={SERVICE_CRITICALITIES.map((c) => ({ value: c, label: t(`services:criticalities.${c}`) }))}
            value={criticality}
            onChange={(v) => set('criticality', v)}
            clearable
            w={{ base: '100%', xs: 160 }}
          />
          <Select
            size="xs"
            label={t('filters.protection')}
            description={t('filters.protectionHint')}
            data={levelOptions}
            value={protection}
            onChange={(v) => set('protection', v)}
            clearable
            w={{ base: '100%', xs: 200 }}
          />
          <Switch size="sm" mb={4} label={t('showArchived')} checked={archived} onChange={(e) => set('archived', e.currentTarget.checked ? '1' : null)} />
          <TagFilterChip tag={tag} onChange={setTag} />
        </Group>
      }
    >
      <QueryState query={apps} />
      {apps.isSuccess && all.length === 0 && hidden && !archived && <RestrictedEmpty />}
      {apps.isSuccess && all.length === 0 && !(hidden && !archived) && (
        <EmptyState
          icon={IconApps}
          title={archived ? t('emptyState.titleArchived') : t('emptyState.title')}
          whoCanAct={t('common:whoCanAct.applications')}
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
      {apps.isSuccess && all.length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(a) => a.id}
          ariaLabel={t('title')}
          rowHref={(a) => `/applications/${a.id}`}
          rowProps={(a) => ({ 'data-inactive': a.archived || undefined })}
          testId="application-list"
          rememberSort="applications"
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={list.length} total={all.length} />}
          card={(a) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  {/* inline-block with a 24 px line: a target of at least 24 × 24 px (WCAG 2.2, 2.5.8) */}
                  <Anchor component={Link} to={`/applications/${a.id}`} fw={600} size="sm" display="inline-block" lh="24px">
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
          )}
        />
      )}
      {creating && <ApplicationFormModal onClose={() => setCreating(false)} onSaved={(a) => navigate(`/applications/${a.id}`)} />}
    </ListPage>
  );
}

/** Create or edit an application. */
export function ApplicationFormModal({ app, onClose, onSaved }: { app?: ApplicationDetail; onClose: () => void; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'services', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(app?.name ?? '');
  const [description, setDescription] = useState(app?.description ?? '');
  const [vendor, setVendor] = useState(app?.vendor ?? '');
  const supplier = useSupplierChoice(app?.supplier);
  const [version, setVersion] = useState(app?.version ?? '');
  const [url, setUrl] = useState(app?.url ?? '');
  const [criticality, setCriticality] = useState<string | null>(app?.criticality ?? null);
  const [owners, setOwners] = useState<string[]>(app?.owners ?? []);
  const [cmdbSystem, setCmdbSystem] = useState(app?.cmdb?.system ?? '');
  const [cmdbId, setCmdbId] = useState(app?.cmdb?.id ?? '');
  const [cmdbUrl, setCmdbUrl] = useState(app?.cmdb?.url ?? '');
  const [tags, setTags] = useState<string[]>(app?.tags ?? []);
  const known = useQuery({ queryKey: ['applications', false], queryFn: () => get<ApplicationSummary[]>('/applications') });
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
        supplierId: supplier.body,
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
            <SupplierPicker value={supplier.value} onChange={supplier.set} initial={app?.supplier} testId="application-supplier">
              <TextInput label={t('vendor')} value={vendor} onChange={(e) => setVendor(e.currentTarget.value)} maxLength={120} miw={160} />
            </SupplierPicker>
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
          <SubjectsInput label={t('owners')} description={t('ownersHelp')} value={owners} onChange={setOwners} max={20} />
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
          <TagInput label={t('tags')} value={tags} onChange={setTags} max={30} lower suggestions={(known.data ?? []).flatMap((a) => a.tags)} />
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
