import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Checkbox, Group, Menu, Paper, Select, Stack, Text, Textarea, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconDots, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_ELEMENT_KIND_DEFS,
  DATA_MEMBER_ROLES,
  DATA_PRODUCT_LIMITS as L,
  type DataElement,
  type DataMemberRole,
  type DataProduct,
  type DataProductMember,
} from '@sm/shared';
import { del, notifyError, notifyOk, post, put } from '../../api';
import { confirmDanger } from '../../components/confirm';
import { DataTable, ListFooter } from '../../components/DataTable';
import { FormModal } from '../../components/FormModal';
import { QueryState } from '../../components/common';
import { ElementPicker, type PickedElement } from '../../components/dataproducts/ElementPicker';
import { ElementForm } from '../../components/dataproducts/CatalogueForms';
import { FormButtons, useBusy } from '../../components/dataproducts/form';
import { fmtDay } from '../../format';
import { HealthBadge } from './views';
import { pagesOf, qs, useInvalidateDataProducts, useMembers, useProductHealth } from './api';
import { ElementName, PlatformName, RoleBadge, Section, useKindLabel, useSortedEnvironments } from './parts';
import { useCanCreate } from './rights';

const enc = encodeURIComponent;

/**
 * The elements of a product (ADR 0036 part 6): members with their role, layer, environment and health, paged by the
 * server. An element the reader may not see otherwise is shown as the product's content (decision 15) without a link.
 * Adding needs edit on the product and sight of the element; removing it never touches other products.
 */
export function ProductElementsTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const kindLabel = useKindLabel();
  const canEdit = p.permissions.includes('edit');
  const canCreate = useCanCreate();
  const invalidate = useInvalidateDataProducts();
  const [role, setRole] = useState<DataMemberRole | ''>('');
  const envs = useSortedEnvironments(p.environments);
  const [environment, setEnvironment] = useState('');
  const members = useMembers(p.id, qs({ role, environment }));
  const health = useProductHealth(p.id);
  const healthOf = useMemo(() => new Map((health.data ?? []).flatMap((h) => h.elements.map((e) => [e.elementId, e.status] as const))), [health.data]);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const rows = pagesOf(members.data);
  const total = members.data?.pages[0]?.total ?? 0;
  const setMember = async (m: DataProductMember, patch: { role?: DataMemberRole; includeDescendants?: boolean }) => {
    try {
      await put(`/data-products/${enc(p.id)}/members/${enc(m.elementId)}`, patch);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (m: DataProductMember) => {
    if (!(await confirmDanger({ action: 'remove', message: t('members.removeConfirm', { name: m.element.qualifiedName }) }))) return;
    try {
      await del(`/data-products/${enc(p.id)}/members/${enc(m.elementId)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const actions = (m: DataProductMember) =>
    canEdit && (
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" aria-label={t('members.actionsFor', { name: m.element.qualifiedName })} data-testid="member-actions">
            <IconDots size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('members.role')}</Menu.Label>
          {DATA_MEMBER_ROLES.filter((r) => r !== m.role).map((r) => (
            <Menu.Item key={r} onClick={() => void setMember(m, { role: r })}>
              {t('members.makeRole', { role: t(`roles.${r}`) })}
            </Menu.Item>
          ))}
          {DATA_ELEMENT_KIND_DEFS[m.element.kind].container && (
            <Menu.Item onClick={() => void setMember(m, { includeDescendants: !m.includeDescendants })}>
              {m.includeDescendants ? t('members.withoutDescendants') : t('members.withDescendants')}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove(m)}>
            {t('members.remove')}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  const missing = (m: DataProductMember) =>
    m.element.missingSince && (
      <Tooltip label={t('elements.missingSince', { date: fmtDay(m.element.missingSince) })}>
        <Badge size="xs" color="orange" variant="light" tt="none" leftSection={<IconAlertTriangle size={10} aria-hidden />}>
          {t('elements.missing')}
        </Badge>
      </Tooltip>
    );
  return (
    <Stack gap="md">
      <Section
        title={t('members.title')}
        testId="product-members"
        actions={
          canEdit && (
            <>
              {canCreate && (
                <Button size="xs" variant="default" onClick={() => setCreating(true)} data-testid="element-new-for-product">
                  {t('members.newElement')}
                </Button>
              )}
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="member-add">
                {t('members.add')}
              </Button>
            </>
          )
        }
      >
        <Group gap="sm" mb="sm" align="flex-end" wrap="wrap">
          <Select
            size="xs"
            label={t('members.role')}
            data={DATA_MEMBER_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            value={role || null}
            onChange={(r) => setRole((r as DataMemberRole) ?? '')}
            clearable
            w={{ base: '100%', xs: 160 }}
          />
          {envs.length > 1 && (
            <Select
              size="xs"
              label={t('environment.label')}
              data={envs}
              value={environment || null}
              onChange={(e) => setEnvironment(e ?? '')}
              clearable
              placeholder={t('environment.all')}
              w={{ base: '100%', xs: 160 }}
            />
          )}
          <Text size="sm" c="dimmed" role="status">
            {t('members.counts', { input: p.memberCounts.input, internal: p.memberCounts.internal, output: p.memberCounts.output })}
          </Text>
        </Group>
        <QueryState query={members} />
        {members.isSuccess && rows.length === 0 && (
          <Text size="sm" c="dimmed">
            {role || environment ? t('members.noMatch') : t('members.none')}
          </Text>
        )}
        {rows.length > 0 && (
          <DataTable
            testId="member-table"
            ariaLabel={t('members.title')}
            rows={rows}
            rowKey={(m) => m.elementId}
            card={(m) => (
              <Paper withBorder p="sm" data-testid="member-card">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <ElementName e={m.element} />
                    <Text size="xs" c="dimmed">
                      {[kindLabel(m.element.kind), m.element.environment, m.element.layer].filter(Boolean).join(' · ')}
                    </Text>
                    <Group gap={4}>
                      <RoleBadge role={m.role} size="xs" />
                      {healthOf.get(m.elementId) && <HealthBadge status={healthOf.get(m.elementId)!} size="xs" />}
                      {missing(m)}
                    </Group>
                  </Stack>
                  {actions(m)}
                </Group>
              </Paper>
            )}
            columns={[
              {
                key: 'name',
                header: t('elements.name'),
                sortValue: (m) => m.element.qualifiedName,
                cell: (m) => (
                  <Stack gap={2}>
                    <ElementName e={m.element} />
                    {m.includeDescendants && (
                      <Text size="xs" c="dimmed">
                        {t('members.descendantsIncluded')}
                      </Text>
                    )}
                    {m.note && (
                      <Text size="xs" c="dimmed">
                        {m.note}
                      </Text>
                    )}
                  </Stack>
                ),
              },
              { key: 'kind', header: t('elements.kind'), sortValue: (m) => kindLabel(m.element.kind), cell: (m) => kindLabel(m.element.kind) },
              { key: 'platform', header: t('elements.platform'), cell: (m) => <PlatformName name={m.element.platformName} hidden={m.element.platformHidden} /> },
              { key: 'environment', header: t('elements.environment'), sortValue: (m) => m.element.environment, nowrap: true, cell: (m) => m.element.environment || '–' },
              { key: 'layer', header: t('elements.layer'), sortValue: (m) => m.element.layer, nowrap: true, cell: (m) => m.element.layer || '–' },
              { key: 'role', header: t('members.role'), sortValue: (m) => m.role, nowrap: true, cell: (m) => <RoleBadge role={m.role} size="xs" /> },
              {
                key: 'health',
                header: t('products.health'),
                nowrap: true,
                cell: (m) => (
                  <Group gap={4} wrap="nowrap">
                    {healthOf.get(m.elementId) ? <HealthBadge status={healthOf.get(m.elementId)!} size="xs" /> : m.role === 'input' ? '–' : <HealthBadge status="noData" size="xs" />}
                    {missing(m)}
                  </Group>
                ),
              },
              { key: 'actions', header: '', cell: (m) => actions(m) },
            ]}
            footer={<ListFooter shown={rows.length} total={total} hasMore={!!members.hasNextPage} onLoadMore={() => void members.fetchNextPage()} loading={members.isFetchingNextPage} />}
          />
        )}
      </Section>
      {adding && <AddMembers p={p} onClose={() => setAdding(false)} onDone={() => {
            invalidate();
            setAdding(false);
          }} />}
      {creating && (
        <ElementForm
          onClose={() => setCreating(false)}
          onSaved={(e: DataElement) => {
            setCreating(false);
            void post(`/data-products/${enc(p.id)}/members`, { elementIds: [e.id], role: 'internal' })
              .then(() => {
                invalidate();
                notifyOk(t('members.createdAndAdded', { name: e.qualifiedName }));
              })
              .catch((err) => notifyError(err));
          }}
        />
      )}
    </Stack>
  );
}

/**
 * Elements added to a product: picked from the catalogue by a search the server runs, with their role, whether a
 * project or bundle counts with everything below it, and a note. At most 500 at a time.
 */
function AddMembers({ p, onClose, onDone }: { p: DataProduct; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const [picked, setPicked] = useState<PickedElement[]>([]);
  const [role, setRole] = useState<DataMemberRole>('internal');
  const [descendants, setDescendants] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, run] = useBusy();
  const save = () =>
    run(async () => {
      if (!picked.length) return setError(t('members.pickOne'));
      const r = await post<{ added: number; changed: number }>(`/data-products/${enc(p.id)}/members`, {
        elementIds: picked.map((e) => e.id),
        role,
        includeDescendants: descendants,
        note,
      });
      notifyOk(t('members.added', { count: r.added, changed: r.changed }));
      onDone();
    }, t('members.notAdded'));
  return (
    <FormModal onClose={onClose} size="lg" title={t('members.addTitle', { name: p.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <ElementPicker
            label={t('members.elements')}
            description={t('members.elementsHint')}
            value={picked}
            onChange={(v) => {
              setPicked(v);
              setError(undefined);
            }}
            max={L.membersPerRequest}
            error={error}
            testId="member-picker"
          />
          <Select
            label={t('members.role')}
            description={t('members.roleHint')}
            data={DATA_MEMBER_ROLES.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
            value={role}
            onChange={(r) => r && setRole(r as DataMemberRole)}
            allowDeselect={false}
            data-testid="member-role"
          />
          <Checkbox label={t('members.withDescendants')} description={t('members.descendantsHint')} checked={descendants} onChange={(e) => setDescendants(e.currentTarget.checked)} />
          <Textarea label={t('members.note')} autosize minRows={1} maxLength={L.text} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
          <FormButtons busy={busy} submit={t('members.addButton', { count: picked.length })} testId="member-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
