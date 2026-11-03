import { useState } from 'react';
import { Alert, Anchor, Button, Checkbox, Group, Modal, ScrollArea, Select, Stack, Switch, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconListSearch, IconRefresh } from '@tabler/icons-react';
import type { ApplicationDetail, Platform, TopicPrefixListing, TopicPrefixSync } from '@sm/shared';
import { del, get, notifyError, post } from '../../api';
import { confirmDanger } from '../confirm';
import { EnvironmentInput } from './environments';

type AddResult = { added: string[]; skipped: { name: string; reason: string }[]; sync: TopicPrefixSync | null; application: ApplicationDetail };

/**
 * "Add topics by prefix" (v0.4.0, docs/KAFKA.md): a Kafka platform and a prefix (smo-ie.dev.), the cluster's topics
 * under it, the chosen ones as Kafka topic components with an environment – and, optionally, the prefix kept in sync.
 */
export function TopicPrefixModal({ app, onClose, onSaved }: { app: ApplicationDetail; onClose: () => void; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const kafka = (platforms.data ?? []).filter((p) => p.kind === 'kafka' && p.permissions.includes('use'));
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [environment, setEnvironment] = useState('');
  const [listing, setListing] = useState<TopicPrefixListing | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sync, setSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const pid = platformId ?? (kafka.length === 1 ? kafka[0]!.id : null);

  const list = async () => {
    if (!pid) return;
    setBusy(true);
    try {
      const l = await post<TopicPrefixListing>(`/applications/${app.id}/kafka-topics/list`, { platformId: pid, prefix: prefix.trim(), environment });
      setListing(l);
      setChosen(l.topics.filter((x) => !x.added).map((x) => x.name));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!pid || !listing) return;
    setBusy(true);
    try {
      const r = await post<AddResult>(`/applications/${app.id}/kafka-topics`, {
        platformId: pid,
        prefix: listing.prefix,
        environment,
        topics: chosen,
        keepInSync: sync,
      });
      onSaved(r.application);
      qc.invalidateQueries({ queryKey: ['application', app.id, 'topic-prefixes'] });
      notifications.show({ color: 'green', message: t('topicPrefix.added', { count: r.added.length }) });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const open = listing?.topics.filter((x) => !x.added) ?? [];
  return (
    <Modal opened onClose={onClose} title={t('topicPrefix.title')} size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('topicPrefix.hint')}
        </Text>
        {platforms.isSuccess && !kafka.length && <Alert color="orange">{t('components.topic.noPlatforms')}</Alert>}
        <Group grow align="flex-end" wrap="wrap">
          <Select
            label={t('components.topic.platform')}
            data={kafka.map((p) => ({ value: p.id, label: p.name }))}
            value={pid}
            onChange={(v) => {
              setPlatformId(v);
              setListing(null);
            }}
            required
          />
          <TextInput
            label={t('topicPrefix.prefix')}
            placeholder="smo-ie.dev."
            classNames={{ input: 'mono' }}
            value={prefix}
            onChange={(e) => {
              setPrefix(e.currentTarget.value);
              setListing(null);
            }}
            maxLength={200}
            required
            data-testid="topic-prefix-input"
          />
        </Group>
        <EnvironmentInput label={t('environments.label')} value={environment} onChange={setEnvironment} />
        <Group>
          <Button
            leftSection={<IconListSearch size={16} />}
            variant="light"
            onClick={list}
            loading={busy && !listing}
            disabled={!pid || !prefix.trim()}
            data-testid="topic-prefix-list"
          >
            {t('topicPrefix.list')}
          </Button>
        </Group>
        {listing && (
          <Stack gap="xs" data-testid="topic-prefix-topics">
            {listing.topics.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('topicPrefix.none', { prefix: listing.prefix })}
              </Text>
            ) : (
              <>
                <Group justify="space-between">
                  <Text size="sm" fw={500}>
                    {t('topicPrefix.found', { count: listing.topics.length, prefix: listing.prefix })}
                  </Text>
                  {open.length > 1 && (
                    <Anchor size="xs" component="button" type="button" onClick={() => setChosen(chosen.length === open.length ? [] : open.map((x) => x.name))}>
                      {chosen.length === open.length ? t('topicPrefix.selectNone') : t('topicPrefix.selectAll')}
                    </Anchor>
                  )}
                </Group>
                <ScrollArea.Autosize mah={280}>
                  <Stack gap={4}>
                    {listing.topics.map((x) => (
                      <Checkbox
                        key={x.name}
                        label={
                          <Text span size="sm" className="mono">
                            {x.name}
                          </Text>
                        }
                        description={x.added ? t('topicPrefix.already') : undefined}
                        disabled={x.added}
                        checked={x.added || chosen.includes(x.name)}
                        onChange={(e) => setChosen((c) => (e.currentTarget.checked ? [...c, x.name] : c.filter((n) => n !== x.name)))}
                      />
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
                {listing.truncated && (
                  <Text size="xs" c="orange">
                    {t('topicPrefix.truncated')}
                  </Text>
                )}
              </>
            )}
            <Switch
              label={t('topicPrefix.keepInSync')}
              description={t('topicPrefix.keepInSyncHint')}
              checked={sync}
              onChange={(e) => setSync(e.currentTarget.checked)}
            />
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={add} loading={busy && !!listing} disabled={!listing || (!chosen.length && !sync)} data-testid="topic-prefix-add">
            {chosen.length ? t('topicPrefix.add', { count: chosen.length }) : t('topicPrefix.syncOnly')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Prefixes kept in sync: new topics under them are offered here until added or dismissed. */
export function TopicOffers({ app, editable, onSaved }: { app: ApplicationDetail; editable: boolean; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['application', app.id, 'topic-prefixes'], queryFn: () => get<TopicPrefixSync[]>(`/applications/${app.id}/topic-prefixes`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['application', app.id, 'topic-prefixes'] });
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const syncs = q.data ?? [];
  if (!syncs.length) return null;
  return (
    <Stack gap={6} data-testid="topic-offers">
      {syncs
        .filter((x) => x.offered.length)
        .map((x) => (
          <Alert key={x.id} color="blue" variant="light" title={t('topicPrefix.offered', { count: x.offered.length, prefix: x.prefix })}>
            <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
              {x.offered.join(', ')}
            </Text>
            {editable && (
              <Group gap="xs" mt="xs">
                <Button
                  size="compact-xs"
                  onClick={() =>
                    run(async () =>
                      onSaved(
                        (
                          await post<AddResult>(`/applications/${app.id}/kafka-topics`, {
                            platformId: x.platformId,
                            prefix: x.prefix,
                            environment: x.environment,
                            topics: x.offered,
                          })
                        ).application,
                      ),
                    )
                  }
                >
                  {t('topicPrefix.addOffered', { count: x.offered.length })}
                </Button>
                <Button
                  size="compact-xs"
                  variant="default"
                  onClick={() => run(() => post(`/applications/${app.id}/topic-prefixes/${x.id}/dismiss`, { topics: x.offered }))}
                >
                  {t('topicPrefix.dismiss')}
                </Button>
              </Group>
            )}
          </Alert>
        ))}
      <Text size="xs" c="dimmed">
        {t('topicPrefix.synced', { prefixes: syncs.map((x) => `${x.prefix}${x.environment ? ` (${x.environment})` : ''}`).join(', ') })}
        {editable &&
          syncs.map((x) => (
            <span key={x.id}>
              {' · '}
              <Anchor size="xs" component="button" type="button" onClick={() => run(() => post(`/applications/${app.id}/topic-prefixes/${x.id}/check`))}>
                <IconRefresh size={10} /> {t('topicPrefix.checkNow', { prefix: x.prefix })}
              </Anchor>
              {' · '}
              <Anchor
                size="xs"
                component="button"
                type="button"
                c="red"
                onClick={async () => {
                  if (await confirmDanger({ action: 'remove', message: t('topicPrefix.stopConfirm', { prefix: x.prefix }) }))
                    run(() => del(`/applications/${app.id}/topic-prefixes/${x.id}`));
                }}
              >
                {t('topicPrefix.stop', { prefix: x.prefix })}
              </Anchor>
            </span>
          ))}
      </Text>
      {syncs.some((x) => x.error) && (
        <Text size="xs" c="red">
          {syncs
            .filter((x) => x.error)
            .map((x) => `${x.prefix}: ${x.error}`)
            .join(' · ')}
        </Text>
      )}
    </Stack>
  );
}
