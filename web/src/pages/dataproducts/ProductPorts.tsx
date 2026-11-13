import { useMemo, useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Collapse, Group, Paper, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconChevronDown, IconLinkOff, IconPencil, IconPlus, IconTrash, IconUsers } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataConsumer, DataObjectives, DataPort, DataPortDirection, DataProduct } from '@sm/shared';
import { del, notifyError } from '../../api';
import { confirmDanger } from '../../components/confirm';
import { useSubjectLabel } from '../../components/SubjectsInput';
import { BindingForm, ConsumerForm, PortForm } from '../../components/dataproducts/PortForms';
import type { PickedElement } from '../../components/dataproducts/ElementPicker';
import { capFirst, fmtDay } from '../../format';
import { pagesOf, qs, useConsumers, useInvalidateDataProducts, useMembers } from './api';
import { CardTable, EnvironmentSwitch, HiddenCount, LifecycleBadge, RefLink, Section, useEnvironmentParam, useRetentionText } from './parts';
import { ActualConsumers } from './governance/ActualConsumers';
import { RequestAccessButton } from './governance/AccessRequests';

const enc = encodeURIComponent;

/** Objectives in words (freshness in minutes, hours or days; availability in percent). */
export function useObjectivesText(): (o: DataObjectives) => string[] {
  const { t } = useTranslation('dataProducts');
  const retention = useRetentionText();
  const minutesText = (m: number) =>
    m % 1440 === 0
      ? t('objectives.days', { count: m / 1440 })
      : m % 60 === 0
        ? t('objectives.hours', { count: m / 60 })
        : t('objectives.minutes', { count: m });
  return (o) =>
    [
      o.freshnessMinutes ? t('objectives.freshnessText', { value: minutesText(o.freshnessMinutes) }) : '',
      o.availabilityPct !== null && o.availabilityPct !== undefined ? t('objectives.availabilityText', { value: o.availabilityPct }) : '',
      o.completenessPct !== null && o.completenessPct !== undefined ? t('objectives.completenessText', { value: o.completenessPct }) : '',
      o.updateSchedule ? t('objectives.scheduleText', { value: o.updateSchedule }) : '',
      o.retention ? t('objectives.retentionText', { value: retention(o.retention) }) : '',
    ].filter(Boolean);
}

type Editing =
  | { kind: 'port'; direction: DataPortDirection; port?: DataPort }
  | { kind: 'binding'; port: DataPort }
  | { kind: 'consumer'; port: DataPort; consumer?: DataConsumer }
  | null;

/**
 * The ports of a product (ADR 0036 part 7): output ports first, each with its binding in the chosen environment
 * (elements, contract, objectives), consumers and lifecycle; input ports with where their data comes from. An input on
 * a deprecated or retired port is flagged.
 */
export function ProductPortsTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProducts');
  const canEdit = p.permissions.includes('edit');
  const invalidate = useInvalidateDataProducts();
  const envNames = useMemo(() => [...new Set([...p.environments, ...p.ports.flatMap((x) => x.bindings.map((b) => b.environment))])], [p]);
  const [environment, setEnvironment] = useEnvironmentParam(envNames);
  const [editing, setEditing] = useState<Editing>(null);
  // names of the bound elements: the product's members in this environment
  const members = useMembers(p.id, qs({ environment, limit: 100 }));
  const names = useMemo(
    () =>
      new Map<string, PickedElement>(
        pagesOf(members.data).map((m) => [m.elementId, { id: m.elementId, label: m.element.qualifiedName, visible: m.element.visible }]),
      ),
    [members.data],
  );
  const done = () => {
    invalidate();
    setEditing(null);
  };
  const remove = async (port: DataPort) => {
    if (!(await confirmDanger({ action: 'delete', message: t('ports.deleteConfirm', { name: port.name }) }))) return;
    try {
      await del(`/data-products/${enc(p.id)}/ports/${enc(port.id)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const unbind = async (port: DataPort) => {
    if (!(await confirmDanger({ action: 'remove', message: t('bindings.removeConfirm', { name: port.name, environment }) }))) return;
    try {
      await del(`/data-products/${enc(p.id)}/ports/${enc(port.id)}/bindings/${enc(environment)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const group = (direction: DataPortDirection) => {
    const ports = p.ports.filter((x) => x.direction === direction).sort((a, b) => a.position - b.position);
    return (
      <Section
        title={direction === 'output' ? t('ports.outputs') : t('ports.inputs')}
        testId={`ports-${direction}`}
        actions={
          canEdit && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => setEditing({ kind: 'port', direction })}
              data-testid={`port-add-${direction}`}
            >
              {direction === 'output' ? t('ports.addOutput') : t('ports.addInput')}
            </Button>
          )
        }
      >
        {ports.length ? (
          <Stack gap="sm">
            {ports.map((x) => (
              <PortCard
                key={x.id}
                p={p}
                port={x}
                environment={environment}
                names={names}
                canEdit={canEdit}
                onEdit={() => setEditing({ kind: 'port', direction, port: x })}
                onDelete={() => void remove(x)}
                onBind={() => setEditing({ kind: 'binding', port: x })}
                onUnbind={() => void unbind(x)}
                onConsumer={(c) => setEditing({ kind: 'consumer', port: x, consumer: c })}
              />
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {direction === 'output' ? t('ports.noOutputs') : t('ports.noInputs')}
          </Text>
        )}
      </Section>
    );
  };
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t('ports.help')}
        </Text>
        <EnvironmentSwitch names={envNames} value={environment} onChange={setEnvironment} testId="ports-environment" />
      </Group>
      {group('output')}
      {group('input')}
      {editing?.kind === 'port' && (
        <PortForm productId={p.id} port={editing.port} direction={editing.direction} ports={p.ports} onClose={() => setEditing(null)} onSaved={done} />
      )}
      {editing?.kind === 'binding' && environment && (
        <BindingForm productId={p.id} port={editing.port} environment={environment} names={names} onClose={() => setEditing(null)} onSaved={done} />
      )}
      {editing?.kind === 'consumer' && (
        <ConsumerForm productId={p.id} portId={editing.port.id} consumer={editing.consumer} onClose={() => setEditing(null)} onSaved={done} />
      )}
    </Stack>
  );
}

function PortCard({
  p,
  port,
  environment,
  names,
  canEdit,
  onEdit,
  onDelete,
  onBind,
  onUnbind,
  onConsumer,
}: {
  p: DataProduct;
  port: DataPort;
  environment: string;
  names: Map<string, PickedElement>;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onBind: () => void;
  onUnbind: () => void;
  onConsumer: (c?: DataConsumer) => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const objectives = useObjectivesText();
  const binding = port.bindings.find((b) => b.environment === environment);
  const [open, setOpen] = useState(false);
  const objects = [...port.objects.declared, ...port.objects.throughElements.filter((o) => !port.objects.declared.some((d) => d.id && d.id === o.id))];
  const hiddenObjects = objects.filter((o) => o.hidden).length;
  const src = port.source;
  return (
    <Paper withBorder p="sm" component="article" aria-labelledby={`port-${port.id}`} data-testid={`port-${port.name}`}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
          <Group gap="xs" wrap="wrap">
            <Text fw={600} id={`port-${port.id}`} className="mono">
              {port.name}
              {port.version && ` ${port.version}`}
            </Text>
            <Badge size="sm" variant="light" color="gray" tt="none">
              {t(`portTypes.${port.type}`)}
            </Badge>
            <LifecycleBadge lifecycle={port.lifecycle} sunsetDate={port.sunsetDate} />
            {port.consumesDeprecated && (
              <Badge
                size="sm"
                color="red"
                variant="light"
                tt="none"
                leftSection={<IconAlertTriangle size={11} aria-hidden />}
                data-testid="port-consumes-deprecated"
              >
                {t('ports.consumesDeprecated')}
              </Badge>
            )}
          </Group>
          {canEdit && (
            <Group gap={2} wrap="nowrap">
              <Tooltip label={t('ports.edit')}>
                <ActionIcon variant="subtle" color="gray" aria-label={t('ports.editNamed', { name: port.name })} onClick={onEdit}>
                  <IconPencil size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label={t('ports.delete')}>
                <ActionIcon variant="subtle" color="red" aria-label={t('ports.deleteNamed', { name: port.name })} onClick={onDelete}>
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </Group>
          )}
        </Group>
        {port.description && (
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {port.description}
          </Text>
        )}
        {port.type === 'file' && (port.fileFormat || port.partitioning.length > 0) && (
          <Text size="sm" data-testid="port-files">
            {t('ports.files')}:{' '}
            {[
              port.fileFormat ? t('ports.filesFormat', { format: t(`fileFormats.${port.fileFormat}`) }) : '',
              port.partitioning.length ? t('ports.partitionedBy', { keys: port.partitioning.join(', ') }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        {port.lifecycle === 'deprecated' && port.sunsetDate && (
          <Text size="sm" c="orange">
            {capFirst(t('ports.sunset', { date: fmtDay(port.sunsetDate) }))}
          </Text>
        )}
        {src && (
          <Text size="sm" data-testid="port-source">
            {t('ports.from')}{' '}
            {src.kind === 'port' ? (
              <>
                <RefLink r={src.product} base="/data-products" />
                {src.portName && ` · ${src.portName}${src.version ? ` ${src.version}` : ''}`}
                {src.lifecycle &&
                  src.lifecycle !== 'active' &&
                  ` (${t(`lifecycle.${src.lifecycle}`)}${src.sunsetDate ? `, ${t('ports.sunset', { date: fmtDay(src.sunsetDate) })}` : ''})`}
              </>
            ) : src.kind === 'element' ? (
              <Anchor component={Link} to={`/data-elements/${enc(src.elementId)}`} size="sm" className="mono">
                {names.get(src.elementId)?.label ?? t('ports.anElement')}
              </Anchor>
            ) : (
              src.text
            )}
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
          <div>
            <Text size="xs" c="dimmed">
              {port.direction === 'output' ? t('ports.objectsOut') : t('ports.objectsIn')}
            </Text>
            {objects.length ? (
              <Group gap={4}>
                {objects
                  .filter((o) => !o.hidden)
                  .map((o) => (
                    <Badge
                      key={o.id}
                      size="sm"
                      variant={port.objects.declared.some((d) => d.id === o.id) ? 'light' : 'outline'}
                      tt="none"
                      component={Link}
                      to={`/data-objects/${enc(o.id!)}`}
                      style={{ cursor: 'pointer' }}
                    >
                      {o.name}
                    </Badge>
                  ))}
                <HiddenCount count={hiddenObjects} />
              </Group>
            ) : (
              <Text size="sm">–</Text>
            )}
          </div>
          {port.direction === 'output' && (
            <div>
              <Text size="xs" c="dimmed">
                {t('objectives.title')}
              </Text>
              <Text size="sm">{objectives({ ...port.objectives, ...(binding?.objectives ?? {}) }).join(' · ') || '–'}</Text>
            </div>
          )}
        </SimpleGrid>
        <Paper withBorder p="xs" bg="var(--mantine-color-default-hover)" data-testid="port-binding">
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Text size="sm" fw={500}>
              {environment ? t('bindings.in', { environment }) : t('bindings.none')}
            </Text>
            {canEdit && environment && (
              <Group gap="xs">
                <Button size="compact-xs" variant="default" onClick={onBind} data-testid="port-bind">
                  {binding ? t('bindings.change') : t('bindings.bind')}
                </Button>
                {binding && (
                  <Tooltip label={t('bindings.remove')}>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={t('bindings.removeNamed', { name: port.name, environment })}
                      onClick={onUnbind}
                    >
                      <IconLinkOff size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </Group>
            )}
          </Group>
          {binding ? (
            <Stack gap={2} mt={4}>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {t('bindings.elements')}:{' '}
                {binding.elementIds.length
                  ? binding.elementIds.map((id, i) => {
                      const n = names.get(id);
                      return (
                        <span key={id}>
                          {i > 0 && ', '}
                          {n?.visible !== false && n ? (
                            <Anchor component={Link} to={`/data-elements/${enc(id)}`} size="sm" className="mono">
                              {n.label}
                            </Anchor>
                          ) : (
                            <Text span size="sm" className="mono">
                              {n?.label ?? t('ports.anElement')}
                            </Text>
                          )}
                        </span>
                      );
                    })
                  : '–'}
              </Text>
              {/* 0.25.0: the S3 locations of a file port's bound elements – the ODCS server of type s3 */}
              {binding.elementIds.some((id) => names.get(id)?.label.startsWith('s3://')) && (
                <Text size="sm" style={{ overflowWrap: 'anywhere' }} data-testid="binding-object-storage">
                  {t('bindings.objectStorage')}:{' '}
                  <span className="mono">
                    {binding.elementIds
                      .map((id) => names.get(id)?.label ?? '')
                      .filter((l) => l.startsWith('s3://'))
                      .join(', ')}
                  </span>
                </Text>
              )}
              {port.direction === 'output' && (
                <Text size="sm" data-testid="binding-contract-line">
                  {t('bindings.contract')}:{' '}
                  {binding.contract ? (
                    <>
                      <RefLink r={binding.contract} base="/data-contracts" />
                      {` · ${binding.contractVersion ? t('bindings.versionN', { n: binding.contractVersion }) : t('bindings.currentVersion')}`}
                      {binding.contractServer && ` · ${t('bindings.serverNamed', { server: binding.contractServer })}`}
                    </>
                  ) : (
                    <Text span size="sm" c="dimmed">
                      {t('bindings.noContract')}
                    </Text>
                  )}
                </Text>
              )}
            </Stack>
          ) : (
            environment && (
              <Text size="sm" c="dimmed" mt={4}>
                {t('bindings.notBound', { environment })}
              </Text>
            )
          )}
        </Paper>
        {port.direction === 'output' && (
          <div>
            <Button
              size="compact-sm"
              variant="subtle"
              leftSection={<IconUsers size={14} />}
              rightSection={<IconChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} aria-hidden />}
              onClick={() => setOpen(!open)}
              aria-expanded={open}
              data-testid="port-consumers-toggle"
            >
              {t('consumers.summary', { registered: port.consumers.registered, count: port.consumers.derived })}
            </Button>
            <Collapse expanded={open}>{open && <Consumers p={p} port={port} canEdit={canEdit} onEdit={onConsumer} />}</Collapse>
            {/* 0.24.0 (ADR 0036 phase 2): who really reads, and asking for access */}
            {binding && <ActualConsumers p={p} port={port} environment={environment} />}
            <RequestAccessButton p={p} port={port} />
          </div>
        )}
      </Stack>
    </Paper>
  );
}

/** The registered consumers of an output port (loaded when opened). */
function Consumers({ p, port, canEdit, onEdit }: { p: DataProduct; port: DataPort; canEdit: boolean; onEdit: (c?: DataConsumer) => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const q = useConsumers(p.id, port.id);
  const invalidate = useInvalidateDataProducts();
  const subject = useSubjectLabel();
  const remove = async (c: DataConsumer) => {
    if (!(await confirmDanger({ action: 'remove', message: t('consumers.removeConfirm') }))) return;
    try {
      await del(`/data-products/${enc(p.id)}/ports/${enc(port.id)}/consumers/${enc(c.id)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const who = (c: DataConsumer) => (c.label === null ? t('hidden.item') : c.subject ? subject(c.subject) : c.label);
  const rows = q.data ?? [];
  return (
    <Stack gap="xs" mt="xs">
      {rows.length ? (
        <CardTable
          ariaLabel={t('consumers.title', { name: port.name })}
          rows={rows}
          rowKey={(c) => c.id}
          columns={[
            {
              key: 'who',
              header: t('consumers.who'),
              cell: (c) => (
                <>
                  <Text size="sm">{who(c)}</Text>
                  <Text size="xs" c="dimmed">
                    {t(`consumers.kinds.${c.kind}`)}
                  </Text>
                </>
              ),
            },
            { key: 'purpose', header: t('consumers.purpose'), cell: (c) => c.purpose || '–' },
            {
              key: 'since',
              header: t('consumers.since'),
              nowrap: true,
              cell: (c) => (
                <>
                  {c.since ? fmtDay(c.since) : '–'}
                  {c.endDate && ` – ${fmtDay(c.endDate)}`}
                </>
              ),
            },
            {
              key: 'agreement',
              header: t('consumers.agreement'),
              cell: (c) =>
                c.agreement ? (
                  c.agreement.kind === 'url' ? (
                    <Anchor href={c.agreement.ref} target="_blank" rel="noopener noreferrer" size="sm">
                      {c.agreement.label || c.agreement.ref}
                    </Anchor>
                  ) : (
                    `${t(`consumers.agreementKinds.${c.agreement.kind}`)}: ${c.agreement.label || c.agreement.ref}`
                  )
                ) : (
                  '–'
                ),
            },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    header: t('table.actions'),
                    actions: true,
                    cell: (c: DataConsumer) => (
                      <Group gap={2} wrap="nowrap">
                        <ActionIcon variant="subtle" color="gray" aria-label={t('consumers.editNamed', { name: who(c) })} onClick={() => onEdit(c)}>
                          <IconPencil size={14} />
                        </ActionIcon>
                        <ActionIcon variant="subtle" color="red" aria-label={t('consumers.removeNamed', { name: who(c) })} onClick={() => void remove(c)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    ),
                  },
                ]
              : []),
          ]}
        />
      ) : (
        q.isSuccess && (
          <Text size="sm" c="dimmed">
            {t('consumers.none')}
          </Text>
        )
      )}
      {port.consumers.derived > 0 && (
        <Alert variant="light" color="blue" p="xs">
          {t('consumers.derived', { count: port.consumers.derived })}
        </Alert>
      )}
      {canEdit && (
        <Group>
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => onEdit()} data-testid="consumer-add">
            {t('consumers.add')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
