import { useMemo, useState } from 'react';
import { ActionIcon, Anchor, Button, Group, Stack, Table, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconArrowRight, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataProduct, DataStep } from '@sm/shared';
import { del, notifyError } from '../../api';
import { confirmDanger } from '../../components/confirm';
import { TableScroll } from '../../components/TableScroll';
import { StepForm } from '../../components/dataproducts/StepForm';
import type { PickedElement } from '../../components/dataproducts/ElementPicker';
import { PipelineView } from './views';
import { usePipelineView } from './views/queries';
import { pagesOf, qs, useInvalidateDataProducts, useMembers, useSteps } from './api';
import { Section } from './parts';
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
  // names of the elements the steps name: the members and the picture's elements (neighbours of other products too)
  const names = useMemo(() => {
    const m = new Map<string, PickedElement>();
    for (const x of pagesOf(members.data)) m.set(x.elementId, { id: x.elementId, label: x.element.qualifiedName, visible: x.element.visible });
    for (const n of view.data?.nodes ?? []) if (n.kind === 'element' && !n.hidden && !m.has(n.id)) m.set(n.id, { id: n.id, label: n.detail || n.label, visible: !!n.path });
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
    <Stack gap={0}>
      {ids.map((id) => {
        const n = names.get(id);
        return n?.visible ? (
          <Anchor key={id} component={Link} to={`/data-elements/${enc(id)}`} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {n.label}
          </Anchor>
        ) : (
          <Text key={id} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {n?.label ?? t('ports.anElement')}
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
  return (
    <Stack gap="md">
      <PipelineView productId={p.id} />
      <Section
        title={t('steps.title')}
        testId="product-steps"
        actions={
          canAdd && (
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="step-add">
              {t('steps.add')}
            </Button>
          )
        }
      >
        <Text size="sm" c="dimmed" mb="sm">
          {t('steps.help')}
        </Text>
        {rows.length ? (
          <TableScroll>
            <Table fz="sm" aria-label={t('steps.title')} verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('steps.name')}</Table.Th>
                  <Table.Th scope="col">{t('steps.inputs')}</Table.Th>
                  <Table.Th scope="col">
                    <VisuallyHidden>{t('steps.to')}</VisuallyHidden>
                  </Table.Th>
                  <Table.Th scope="col">{t('steps.outputs')}</Table.Th>
                  <Table.Th scope="col">{t('steps.runner')}</Table.Th>
                  <Table.Th scope="col">{t('steps.schedule')}</Table.Th>
                  <Table.Th scope="col">
                    <VisuallyHidden>{t('table.actions')}</VisuallyHidden>
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((s) => (
                  <Table.Tr key={s.id} data-testid={`step-${s.name}`}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {s.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t(`dataProductViews:stepKinds.${s.kind}`)}
                      </Text>
                    </Table.Td>
                    <Table.Td>{ends(s.inputs, s.hiddenInputs)}</Table.Td>
                    <Table.Td>
                      <IconArrowRight size={14} aria-hidden />
                    </Table.Td>
                    <Table.Td>{ends(s.outputs, s.hiddenOutputs)}</Table.Td>
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>{runner(s)}</Table.Td>
                    <Table.Td className="nowrap">{s.schedule || '–'}</Table.Td>
                    <Table.Td>
                      {s.canEdit && (
                        <Group gap={2} wrap="nowrap">
                          <Tooltip label={t('steps.edit')}>
                            <ActionIcon variant="subtle" color="gray" aria-label={t('steps.editNamed', { name: s.name })} onClick={() => setEditing({ step: s })}>
                              <IconPencil size={14} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={t('steps.delete')}>
                            <ActionIcon variant="subtle" color="red" aria-label={t('steps.deleteNamed', { name: s.name })} onClick={() => void remove(s)}>
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
        ) : (
          steps.isSuccess && (
            <Text size="sm" c="dimmed">
              {t('steps.none')}
            </Text>
          )
        )}
      </Section>
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
