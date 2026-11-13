import { useState } from 'react';
import { Alert, Badge, Group, List, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { DATA_PRODUCT_LIMITS as L, type DataLineageEnd } from '@sm/shared';
import { post } from '../../api';
import { QueryState, useFieldErrors } from '../common';
import { FormModal } from '../FormModal';
import { HealthBadge } from '../../pages/dataproducts/views';
import { fmtNumber } from '../../format';
import { useConnectorDraft, useConnectors } from '../../pages/dataproducts/generic';
import { FormButtons, useBusy } from './form';
import { TechnologyBadge } from './GenericParts';

const enc = encodeURIComponent;

/**
 * _Create step from connector_ (0.25.0, ADR 0037 part 1): a Kafka Connect or Confluent connector of a platform the
 * person may see becomes a step of kind bridge – the connector as its runner, its inputs and outputs as its
 * configuration's allow-listed keys and the readout name them, matched to the catalogue. What no element matches is
 * listed (discover or enter it, then create the step); the step is written as one written by hand.
 */
export function ConnectorStepModal({ productId, onClose, onSaved }: { productId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'common']);
  const connectors = useConnectors(true);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [connector, setConnector] = useState<string | null>(null);
  const [name, setName] = useState('');
  const draft = useConnectorDraft(productId, platformId, connector);
  const [busy, run] = useBusy();
  const platform = (connectors.data ?? []).find((p) => p.platformId === platformId);
  const d = draft.data;
  const v = useFieldErrors({ connector: !connector && t('connectorStep.chooseConnector') });
  const save = () =>
    run(async () => {
      await post(`/data-products/${enc(productId)}/steps/from-connector`, { platformId, connector, ...(name.trim() ? { name: name.trim() } : {}) });
      onSaved();
    }, t('form.notSaved'));
  const ends = (xs: DataLineageEnd[], hidden: number, unmatched: string[], testId: string) => (
    <Stack gap={4} data-testid={testId}>
      {xs.length ? (
        <List size="sm" spacing={2}>
          {xs.map((e) => (
            <List.Item key={e.id}>
              <Text span size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {e.qualifiedName}
              </Text>{' '}
              <Text span size="xs" c="dimmed">
                {[t(`dataProductViews:elementKinds.${e.kind}`), e.environment].filter(Boolean).join(' · ')}
              </Text>
            </List.Item>
          ))}
        </List>
      ) : (
        <Text size="sm" c="dimmed">
          {t('connectorStep.noElements')}
        </Text>
      )}
      {hidden > 0 && (
        <Text size="xs" c="dimmed">
          {t('hidden.count', { count: hidden })}
        </Text>
      )}
      {unmatched.length > 0 && (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {t('connectorStep.unmatched', { names: unmatched.join(', ') })}
        </Text>
      )}
    </Stack>
  );
  return (
    <FormModal onClose={onClose} size="lg" title={t('connectorStep.title')}>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.validate() && d && d.outputs.length) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('connectorStep.help')}
          </Text>
          <QueryState query={connectors} />
          {connectors.isSuccess && !connectors.data.length && (
            <Alert color="gray" variant="light">
              {t('connectorStep.noPlatforms')}
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('connectorStep.platform')}
              data={(connectors.data ?? []).map((p) => ({ value: p.platformId, label: p.platformName }))}
              value={platformId}
              onChange={(v) => {
                setPlatformId(v);
                setConnector(null);
              }}
              searchable
              data-autofocus
              data-testid="connector-platform"
            />
            <Select
              label={t('connectorStep.connector')}
              data={(platform?.connectors ?? []).map((c) => ({ value: c.key, label: `${c.name} (${t(`connectorStep.types.${c.type}`)})` }))}
              value={connector}
              onChange={setConnector}
              searchable
              disabled={!platform}
              error={v.error('connector')}
              nothingFoundMessage={t('connectorStep.noConnectors')}
              data-testid="connector-name"
            />
          </SimpleGrid>
          {connector && <QueryState query={draft} />}
          {d && (
            <Stack gap="sm" data-testid="connector-draft">
              <Group gap="xs">
                <Badge variant="light" tt="none">
                  {t('dataProductViews:stepKinds.bridge')}
                </Badge>
                {d.runner.technology && <TechnologyBadge value={d.runner.technology} />}
                <Text size="xs" c="dimmed">
                  {t(`connectorStep.families.${d.family}`)}
                </Text>
                {d.health && <HealthBadge status={d.health.status} size="xs" />}
              </Group>
              <Text size="sm">{d.description}</Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <div>
                  <Text size="sm" fw={500}>
                    {t('steps.inputs')}
                  </Text>
                  {ends(d.inputs, d.hiddenInputs, d.unmatchedInputs, 'connector-draft-inputs')}
                </div>
                <div>
                  <Text size="sm" fw={500}>
                    {t('steps.outputs')}
                  </Text>
                  {ends(d.outputs, d.hiddenOutputs, d.unmatchedOutputs, 'connector-draft-outputs')}
                </div>
              </SimpleGrid>
              {d.reasons.length > 0 && (
                // what the configuration does not name plainly enough: left out or unmatched – never guessed – and why
                <Stack gap={2} data-testid="connector-draft-reasons">
                  {d.reasons.map((r) => (
                    <Text key={r.reason} size="sm" c="dimmed">
                      {t(`connectorStep.reasons.${r.reason}`, { count: r.count, n: fmtNumber(r.count) })}
                    </Text>
                  ))}
                </Stack>
              )}
              {!d.outputs.length && (
                <Alert color="orange" variant="light" data-testid="connector-no-outputs">
                  {t('connectorStep.noOutputs')}
                </Alert>
              )}
              <TextInput
                label={t('steps.name')}
                placeholder={d.name}
                maxLength={L.name}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                data-testid="connector-step-name"
              />
            </Stack>
          )}
          <FormButtons busy={busy} submit={t('connectorStep.create')} testId="connector-step-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
