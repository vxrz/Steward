import { useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconPlus, IconSearch, IconServer2 } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SubjectsInput } from '../components/SubjectsInput';
import { SYSTEM_KINDS, SYSTEM_LIMITS, type Platform, type SystemDetail, type SystemKind, type SystemSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { EmptyState, PageHeader, QueryState, useCreateParam, useFieldErrors } from '../components/common';
import { useMe } from '../auth';
import { fmtRelative } from '../format';
import { EnvironmentBadge, useEnvironmentList } from '../components/catalogue/environments';
import { StackFields, stackBody, stackRowsOf, type StackRow } from '../components/catalogue/ComponentsPanel';

/** Systems (#129): servers, VMs, clusters, appliances and cloud services that applications run on. */
export function SystemsPage() {
  const { t } = useTranslation(['applications', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [env, setEnv] = useState<string | null>(null);
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems') });
  const envList = useEnvironmentList();
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  useCreateParam(canCreate, () => setCreating(true));
  const needle = q.trim().toLowerCase();
  const list = (systems.data ?? []).filter(
    (s) =>
      (!needle || [s.name, s.vendor, s.note].some((x) => x.toLowerCase().includes(needle))) &&
      (!kind || s.kind === kind) &&
      (!env || s.environments.includes(env)),
  );
  return (
    <>
      <PageHeader
        title={t('systems.title')}
        description={t('systems.description')}
        actions={
          canCreate && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
              {t('systems.new')}
            </Button>
          )
        }
      />
      <Group gap="sm" mb="md" align="flex-end" wrap="wrap">
        <TextInput
          size="xs"
          label={t('search')}
          placeholder={t('systems.searchPlaceholder')}
          leftSection={<IconSearch size={14} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={{ base: '100%', sm: 240 }}
        />
        <Select
          size="xs"
          label={t('systems.kind')}
          data={SYSTEM_KINDS.map((k) => ({ value: k, label: t(`systems.kinds.${k}`) }))}
          value={kind}
          onChange={setKind}
          clearable
          w={180}
        />
        <Select
          size="xs"
          label={t('environments.label')}
          data={[...new Set([...envList.map((e) => e.name), ...(systems.data ?? []).flatMap((s) => s.environments).filter(Boolean)])]}
          value={env}
          onChange={setEnv}
          clearable
          w={180}
        />
      </Group>
      <QueryState query={systems} />
      {systems.isSuccess && systems.data.length === 0 && (
        <EmptyState
          icon={IconServer2}
          title={t('systems.emptyTitle')}
          action={
            canCreate && (
              <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
                {t('systems.new')}
              </Button>
            )
          }
        >
          {t('systems.emptyText')}
        </EmptyState>
      )}
      {systems.isSuccess && systems.data.length > 0 && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('systems.noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm" aria-label={t('systems.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('name')}</Table.Th>
                <Table.Th>{t('systems.kind')}</Table.Th>
                <Table.Th>{t('environments.title')}</Table.Th>
                <Table.Th>{t('systems.applicationsColumn')}</Table.Th>
                <Table.Th>{t('systems.eolColumn')}</Table.Th>
                <Table.Th>{t('updated')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((s) => (
                <Table.Tr key={s.id} className="clickable" onClick={() => navigate(`/systems/${s.id}`)}>
                  <Table.Td>
                    <Anchor component={Link} to={`/systems/${s.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Anchor>
                    {s.vendor && (
                      <Text size="xs" c="dimmed">
                        {s.vendor}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="default">
                      {t(`systems.kinds.${s.kind}`)}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {s.environments.map((e) => (
                        <EnvironmentBadge key={e} value={e} />
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td>{s.applicationCount}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {s.eol > 0 && (
                        <Badge size="sm" color="red" variant="light">
                          {t('systems.eolCount', { count: s.eol })}
                        </Badge>
                      )}
                      {s.ending > 0 && (
                        <Badge size="sm" color="orange" variant="light">
                          {t('systems.endingCount', { count: s.ending })}
                        </Badge>
                      )}
                      {!s.eol && !s.ending && '–'}
                    </Group>
                  </Table.Td>
                  <Table.Td className="nowrap">{fmtRelative(s.updatedAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && (
        <SystemFormModal
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            void qc.invalidateQueries({ queryKey: ['systems'] });
            navigate(`/systems/${s.id}`);
          }}
        />
      )}
    </>
  );
}

/** Create or change a system: what it is, who owns it, the platform it is, its tech stack. */
export function SystemFormModal({ system, onClose, onSaved }: { system?: SystemDetail; onClose: () => void; onSaved: (s: SystemDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const [name, setName] = useState(system?.name ?? '');
  const [kind, setKind] = useState<SystemKind>(system?.kind ?? 'server');
  const [vendor, setVendor] = useState(system?.vendor ?? '');
  const [cmdbUrl, setCmdbUrl] = useState(system?.cmdbUrl ?? '');
  const [owners, setOwners] = useState<string[]>(system?.owners ?? []);
  const [note, setNote] = useState(system?.note ?? '');
  // a platform the reader may not see stays as it is (null here means "keep" only when hidden)
  const [platformId, setPlatformId] = useState<string | null>(system?.platform?.id ?? null);
  const [stack, setStack] = useState<StackRow[]>(stackRowsOf(system?.stack ?? []));
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    cmdbUrl: !!cmdbUrl.trim() && !/^https?:\/\/\S+$/i.test(cmdbUrl.trim()) && t('common:validation.invalid'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      kind,
      vendor: vendor.trim(),
      cmdbUrl: cmdbUrl.trim(),
      owners: owners.map((o) => (/^(user|team):/i.test(o) ? o : `user:${o}`)),
      note,
      platformId: system?.platformHidden && platformId === null ? undefined : platformId,
      stack: stackBody(stack),
    };
    try {
      onSaved(system ? await put<SystemDetail>(`/systems/${system.id}`, body) : await post<SystemDetail>('/systems', body));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="lg" title={system ? t('systems.editTitle', { name: system.name }) : t('systems.new')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <TextInput
              label={t('name')}
              required
              maxLength={SYSTEM_LIMITS.name}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
            />
            <Select
              label={t('systems.kind')}
              data={SYSTEM_KINDS.map((k) => ({ value: k, label: t(`systems.kinds.${k}`) }))}
              value={kind}
              allowDeselect={false}
              onChange={(k) => k && setKind(k as SystemKind)}
            />
          </Group>
          <Group grow align="flex-start">
            <TextInput
              label={t('systems.vendor')}
              description={t('systems.vendorHint')}
              maxLength={SYSTEM_LIMITS.vendor}
              value={vendor}
              onChange={(e) => setVendor(e.currentTarget.value)}
            />
            <TextInput
              label={t('systems.cmdbUrl')}
              placeholder="https://"
              value={cmdbUrl}
              onChange={(e) => setCmdbUrl(e.currentTarget.value)}
              error={v.error('cmdbUrl')}
            />
          </Group>
          <SubjectsInput label={t('owners')} description={t('systems.ownersHelp')} value={owners} onChange={setOwners} max={20} />
          <Select
            label={t('systems.platform')}
            description={system?.platformHidden ? t('systems.platformHiddenHint') : t('systems.platformHint')}
            placeholder={system?.platformHidden ? t('systems.platformHidden') : t('systems.noPlatform')}
            data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.environment ? `${p.name} (${p.environment})` : p.name }))}
            value={platformId}
            onChange={setPlatformId}
            clearable
            searchable
          />
          <Textarea
            label={t('systems.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SYSTEM_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <StackFields stack={stack} onChange={setStack} />
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
