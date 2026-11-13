import { useMemo, useState } from 'react';
import { ActionIcon, Anchor, Button, Group, Stack, Text, Tooltip } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconDownload, IconPencil, IconPlugConnected, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataProduct, DataStep } from '@sm/shared';
import { apiUrl, del, notifyError } from '../../api';
import { confirmDanger } from '../../components/confirm';
import { StepForm } from '../../components/dataproducts/StepForm';
import { ConnectorStepModal } from '../../components/dataproducts/ConnectorStep';
import { TechnologyBadge } from '../../components/dataproducts/GenericParts';
import type { PickedElement } from '../../components/dataproducts/ElementPicker';
import { HealthBadge, PipelineView } from './views';
import { usePipelineView } from './views/queries';
import { pagesOf, qs, useInvalidateDataProducts, useMembers, useSteps } from './api';
import { Breakable, CardTable, Section } from './parts';
import { useCanCreate } from './rights';

const enc = encodeURIComponent;

/**
 * The pipeline of a product (ADR 0036 parts 9 and 13): WP6's picture with its table, and below it the steps – how data
 * moves between elements, documented where its result lives (documentation only, Steward runs nothing).
 */
export function ProductPipelineTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews']);
  const [params] = useSearchParams();
  const steps = useSteps(p.id);
  const view = usePipelineView(p.id, params.get('environment'));
  const members = useMembers(p.id, qs({ limit: 100 }));
  const invalidate = useInvalidateDataProducts();
  const canCreate = useCanCreate();
  const canAdd = p.permissions.includes('edit') && canCreate;
  const [editing, setEditing] = useState<{ step?: DataStep } | null>(null);
  const [fromConnector, setFromConnector] = useState(false);
  // names of the elements the steps name: the members and the picture's elements (neighbours of other products too)
  const names = useMemo(() => {
    const m = new Map<string, PickedElement>();
    for (const x of pagesOf(members.data)) m.set(x.elementId, { id: x.elementId, label: x.element.qualifiedName, visible: x.element.visible });
    for (const n of view.data?.nodes ?? [])
      if (n.kind === 'element' && !n.hidden && !m.has(n.id)) m.set(n.id, { id: n.id, label: n.detail || n.label, visible: !!n.path });
    return m;
  }, [members.data, view.data]);
  const remove = async (s: DataStep) => {
    if (!(await confirmDanger({ action: 'delete', message: t('steps.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/data-products/${enc(p.id)}/steps/${enc(s.id)}`);
      invalidate();
    } catch (e) {
      notifyError(e);
    }
  };
  const ends = (ids: string[], hidden: number) => (
    <Stack gap={8}>
      {ids.map((id) => {
        const n = names.get(id);
        return n?.visible ? (
          <Anchor key={id} component={Link} to={`/data-elements/${enc(id)}`} size="sm" className="mono" style={{ overflowWrap: 'break-word' }}>
            <Breakable text={n.label} />
          </Anchor>
        ) : (
          <Text key={id} size="sm" className="mono" style={{ overflowWrap: 'break-word' }}>
            {n ? <Breakable text={n.label} /> : t('ports.anElement')}
          </Text>
        );
      })}
      {hidden > 0 && (
        <Text size="xs" c="dimmed">
          {t('hidden.count', { count: hidden })}
        </Text>
      )}
    </Stack>
  );
  const runner = (s: DataStep) => {
    if (s.runnerHidden) return t('steps.runnerYouMayNotSee');
    const r = s.runner;
    if (!r) return '–';
    if (r.kind === 'tool') return [r.tool, r.text].filter(Boolean).join(' · ') || t('steps.runnerKinds.tool');
    if (r.kind === 'connector') return t('steps.connectorText', { name: r.name });
    if (r.kind === 'element') return names.get(r.id)?.label ?? t('steps.runnerKinds.element');
    return t(`steps.runnerKinds.${r.kind}`);
  };
  const rows = steps.data ?? [];
  const environment = params.get('environment');
  return (
    <Stack gap="md">
      <PipelineView productId={p.id} />
      <Section
        title={t('steps.title')}
        testId="product-steps"
        actions={
          <Group gap="xs">
            {/* 0.25.0 (ADR 0037 part 5): the static lineage as OpenLineage events, in the environment shown */}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/data-products/${enc(p.id)}/openlineage${environment ? `?environment=${enc(environment)}` : ''}`)}
              leftSection={<IconDownload size={14} />}
              data-testid="steps-openlineage"
            >
              {t('openLineage.export')}
            </Button>
            {canAdd && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlugConnected size={14} />}
                onClick={() => setFromConnector(true)}
                data-testid="step-from-connector"
              >
                {t('connectorStep.open')}
              </Button>
            )}
            {canAdd && (
              <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="step-add">
                {t('steps.add')}
              </Button>
            )}
          </Group>
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          {t('steps.help')}
        </Text>
        {rows.length ? (
          <CardTable
            ariaLabel={t('steps.title')}
            rows={rows}
            rowKey={(s) => s.id}
            rowTestId={(s) => `step-${s.name}`}
            columns={[
              {
                key: 'name',
                header: t('steps.name'),
                cell: (s) => (
                  <>
                    <Text size="sm" fw={500}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t(`dataProductViews:stepKinds.${s.kind}`)}
                    </Text>
                  </>
                ),
              },
              { key: 'inputs', header: t('steps.inputs'), cell: (s) => ends(s.inputs, s.hiddenInputs) },
              { key: 'outputs', header: t('steps.outputs'), cell: (s) => ends(s.outputs, s.hiddenOutputs) },
              {
                key: 'runner',
                header: t('steps.runner'),
                cell: (s) => (
                  <Stack gap={4} align="flex-start">
                    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                      {runner(s)}
                    </Text>
                    {/* 0.25.0: a bridge's technology, and a connector's state through the Kafka Connect checks */}
                    {!s.runnerHidden && s.runner?.technology && <TechnologyBadge value={s.runner.technology} size="xs" />}
                    {s.health && (
                      <Group gap={4} data-testid="step-health">
                        <HealthBadge status={s.health.status} size="xs" />
                        {s.health.checks.hidden > 0 && (
                          <Text size="xs" c="dimmed">
                            {t('hidden.checks', { count: s.health.checks.hidden })}
                          </Text>
                        )}
                      </Group>
                    )}
                  </Stack>
                ),
              },
              { key: 'schedule', header: t('steps.schedule'), cell: (s) => s.schedule || '–' },
              {
                key: 'actions',
                header: t('table.actions'),
                actions: true,
                cell: (s) => (
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label={t('openLineage.exportStep')}>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        component="a"
                        href={apiUrl(`/data-products/${enc(p.id)}/steps/${enc(s.id)}/openlineage`)}
                        aria-label={t('openLineage.exportStepNamed', { name: s.name })}
                        data-testid="step-openlineage"
                      >
                        <IconDownload size={14} />
                      </ActionIcon>
                    </Tooltip>
                    {s.canEdit && (
                      <Tooltip label={t('steps.edit')}>
                        <ActionIcon variant="subtle" color="gray" aria-label={t('steps.editNamed', { name: s.name })} onClick={() => setEditing({ step: s })}>
                          <IconPencil size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {s.canEdit && (
                      <Tooltip label={t('steps.delete')}>
                        <ActionIcon variant="subtle" color="red" aria-label={t('steps.deleteNamed', { name: s.name })} onClick={() => void remove(s)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                ),
              },
            ]}
          />
        ) : (
          steps.isSuccess && (
            <Text size="sm" c="dimmed">
              {t('steps.none')}
            </Text>
          )
        )}
      </Section>
      {fromConnector && (
        <ConnectorStepModal
          productId={p.id}
          onClose={() => setFromConnector(false)}
          onSaved={() => {
            invalidate();
            setFromConnector(false);
          }}
        />
      )}
      {editing && (
        <StepForm
          productId={p.id}
          step={editing.step}
          names={names}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidate();
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}
