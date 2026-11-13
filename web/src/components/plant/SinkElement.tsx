import { useState } from 'react';
import { Anchor, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconDatabasePlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { IE_DATABUS_BROKER, mqttBroker, type DataElement, type DataElementInput, type Platform, type PlantCollectionSink } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { useModuleOn } from '../../modules';
import { useCanCreate } from '../../pages/dataproducts/rights';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * _Create element from this sink_ (0.25.0, ADR 0037 part 3): an MQTT topic a collection writes – to an MQTT broker or the
 * Industrial Edge Databus – becomes an `mqtt.topic` element of the data products catalogue, linked to the sink, so a
 * pipeline step can read it (Databus topic → application on the edge device → Kafka topic). Only while the data products
 * module is on, for who may add elements.
 */

/** Whether a sink writes an MQTT topic: its format or protocol says MQTT, or it is the Databus. */
export const isMqttSink = (s: Pick<PlantCollectionSink, 'format' | 'ref' | 'name'>): boolean =>
  /mqtt/i.test(s.format) || /databus/i.test(s.ref) || /databus/i.test(s.name);

/** The broker a sink names: the Databus, a host[:port] or MQTT URL as its target, else none. */
const brokerOf = (s: Pick<PlantCollectionSink, 'ref' | 'name'>): string =>
  /databus/i.test(s.ref) || /databus/i.test(s.name) ? IE_DATABUS_BROKER : (mqttBroker(s.ref) ?? '');

export function SinkElementButton({ assetId, collectionId, sink }: { assetId: string; collectionId: string; sink: PlantCollectionSink }) {
  const { t } = useTranslation('plantDocs');
  const on = useModuleOn('dataProducts');
  const can = useCanCreate();
  const [open, setOpen] = useState(false);
  if (!on || !can || !isMqttSink(sink)) return null;
  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconDatabasePlus size={12} />}
        onClick={() => setOpen(true)}
        data-testid={`sink-element-${sink.id}`}
        style={{ alignSelf: 'flex-start' }}
      >
        {t('sinkElement.button')}
      </Button>
      {open && <SinkElementModal assetId={assetId} collectionId={collectionId} sink={sink} onClose={() => setOpen(false)} />}
    </>
  );
}

function SinkElementModal({ assetId, collectionId, sink, onClose }: { assetId: string; collectionId: string; sink: PlantCollectionSink; onClose: () => void }) {
  const { t } = useTranslation(['plantDocs', 'common']);
  const platforms = useQuery({ queryKey: ['dataProducts', 'platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const mqttPlatforms = (platforms.data ?? []).filter((p) => p.kind === 'mqtt');
  const [topic, setTopic] = useState(sink.object);
  const [platformId, setPlatformId] = useState<string | null>(sink.kind === 'platform' && mqttPlatforms.some((p) => p.id === sink.ref) ? sink.ref : null);
  const [broker, setBroker] = useState(brokerOf(sink));
  const [environment, setEnvironment] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<DataElement | null>(null);
  const save = async () => {
    if (!topic.trim()) return;
    setBusy(true);
    try {
      const body: DataElementInput = {
        kind: 'mqtt.topic',
        platformId,
        qualifiedName: topic.trim(),
        environment: environment.trim(),
        description: sink.description,
        plantSink: { assetId, collectionId, sinkId: sink.id },
        // the broker in the namespace field of the element (host:port is enough: mqtt://host:port)
        ...(!platformId && broker.trim() ? { namespace: broker.trim() } : {}),
      };
      setMade(await post<DataElement>('/data-elements', body));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={t('sinkElement.title', { name: sink.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {made ? (
          <Stack gap="sm" data-testid="sink-element-made">
            <Text size="sm">{t('sinkElement.made', { name: made.qualifiedName })}</Text>
            <Anchor component={Link} to={`/data-elements/${encodeURIComponent(made.id)}`} size="sm">
              {t('sinkElement.open')}
            </Anchor>
          </Stack>
        ) : (
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              {t('sinkElement.help')}
            </Text>
            <TextInput
              label={t('sinkElement.topic')}
              required
              className="mono"
              value={topic}
              onChange={(e) => setTopic(e.currentTarget.value)}
              maxLength={1000}
              error={!topic.trim() ? t('sinkElement.topicRequired') : undefined}
              data-autofocus
            />
            <Select
              label={t('sinkElement.platform')}
              description={t('sinkElement.platformHint')}
              data={mqttPlatforms.map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
              clearable
            />
            {!platformId && (
              <TextInput
                label={t('sinkElement.broker')}
                description={t('sinkElement.brokerHint')}
                className="mono"
                value={broker}
                onChange={(e) => setBroker(e.currentTarget.value)}
                maxLength={300}
                placeholder={IE_DATABUS_BROKER}
              />
            )}
            <TextInput label={t('sinkElement.environment')} value={environment} onChange={(e) => setEnvironment(e.currentTarget.value)} maxLength={60} />
          </Stack>
        )}
        <FormModalButtons made={!!made} busy={busy} onClose={onClose} />
      </form>
    </FormModal>
  );
}

function FormModalButtons({ made, busy, onClose }: { made: boolean; busy: boolean; onClose: () => void }) {
  const { t } = useTranslation(['plantDocs', 'common']);
  return (
    <Stack gap={0} mt="md" align="flex-end">
      {made ? (
        <Button onClick={onClose}>{t('common:close')}</Button>
      ) : (
        <Group gap="xs">
          <FormModalCancel />
          <Button type="submit" loading={busy} data-testid="sink-element-create">
            {t('sinkElement.create')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
