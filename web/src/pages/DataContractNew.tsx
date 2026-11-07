import { useState } from 'react';
import { Alert, Badge, Button, FileButton, Group, List, MultiSelect, Paper, SegmentedControl, Select, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconFileImport, IconWand } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATABASE_KIND,
  qualifiedTable,
  type ApiOperation,
  type DataContractDetail,
  type DataContractDraft,
  type DataContractDraftInput,
  type DataContractLinkInput,
  type DataContractPreview,
  type DatasetMeta,
  type DbSchemaSnapshot,
  type Platform,
  type PlatformRecording,
  type SystemSummary,
} from '@sm/shared';
import { get, getOptional, notifyError, post } from '../api';
import { EmptyState, PageHeader } from '../components/common';
import { dataContractKeys, platformKeys } from '../queryKeys';
import { useMe } from '../auth';
import { BLANK_CONTRACT, ContractYamlEditor } from '../components/contracts/parts';
import { readText } from './DataContracts';

type Source = 'blank' | 'table' | 'dataset' | 'openapi' | 'recording';
const SOURCES: Source[] = ['blank', 'table', 'dataset', 'openapi', 'recording'];

/** Database platforms and systems with a schema, for a draft from tables. */
function TableSource({ onDraft }: { onDraft: (input: DataContractDraftInput) => void }) {
  const { t } = useTranslation('contracts');
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems') });
  const [subject, setSubject] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [kind, id] = subject ? (subject.split(':') as ['platform' | 'system', string]) : [null, null];
  const snap = useQuery({
    queryKey: ['db-schema', kind, id, 'snapshot', 'latest'],
    queryFn: () => getOptional<DbSchemaSnapshot | null>(`/db-schemas/${kind}/${id}/snapshots/latest`, null),
    enabled: !!subject,
  });
  const options = [
    {
      group: t('new.databasePlatforms'),
      items: (platforms.data ?? []).filter((p) => p.kind === DATABASE_KIND).map((p) => ({ value: `platform:${p.id}`, label: p.name })),
    },
    { group: t('new.systems'), items: (systems.data ?? []).map((s) => ({ value: `system:${s.id}`, label: s.name })) },
  ].filter((g) => g.items.length);
  const names = (snap.data?.schema.tables ?? []).map(qualifiedTable);
  return (
    <Stack gap="sm">
      <Select
        label={t('new.database')}
        data={options}
        value={subject}
        onChange={(v) => {
          setSubject(v);
          setTables([]);
        }}
        searchable
        placeholder={t('new.chooseDatabase')}
        nothingFoundMessage={t('new.noDatabase')}
        data-testid="draft-database"
      />
      {subject && snap.isSuccess && !snap.data && (
        <Text size="sm" c="dimmed">
          {t('new.noSnapshot')}
        </Text>
      )}
      {names.length > 0 && (
        <MultiSelect
          label={t('new.tables')}
          description={t('new.tablesHint')}
          data={names}
          value={tables}
          onChange={setTables}
          searchable
          maxValues={50}
          data-testid="draft-tables"
        />
      )}
      <Group>
        <Button
          size="xs"
          leftSection={<IconWand size={14} />}
          disabled={!kind || !id || !tables.length}
          onClick={() => kind && id && onDraft({ source: 'table', subjectKind: kind, subjectId: id, tables })}
          data-testid="draft-make"
        >
          {t('new.draft')}
        </Button>
      </Group>
    </Stack>
  );
}

function DatasetSource({ onDraft }: { onDraft: (input: DataContractDraftInput) => void }) {
  const { t } = useTranslation('contracts');
  const datasets = useQuery({ queryKey: ['datasets'], queryFn: () => get<DatasetMeta[]>('/datasets') });
  const [key, setKey] = useState<string | null>(null);
  return (
    <Stack gap="sm">
      <Select
        label={t('new.dataset')}
        data={(datasets.data ?? []).map((d) => ({ value: d.key, label: `${d.title || d.key} (${d.key})` }))}
        value={key}
        onChange={setKey}
        searchable
        placeholder={t('new.chooseDataset')}
        nothingFoundMessage={t('new.noDataset')}
      />
      <Group>
        <Button size="xs" leftSection={<IconWand size={14} />} disabled={!key} onClick={() => key && onDraft({ source: 'dataset', dataset: key })}>
          {t('new.draft')}
        </Button>
      </Group>
    </Stack>
  );
}

/** A platform the person may use, and an operation of its OpenAPI specifications or one of its recorded responses. */
function PlatformSource({ mode, onDraft }: { mode: 'openapi' | 'recording'; onDraft: (input: DataContractDraftInput) => void }) {
  const { t } = useTranslation('contracts');
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [item, setItem] = useState<string | null>(null);
  const ops = useQuery({
    queryKey: ['platform', platformId, 'operations'],
    queryFn: () => get<ApiOperation[]>(`/platforms/${platformId}/operations`),
    enabled: !!platformId && mode === 'openapi',
  });
  const recs = useQuery({
    queryKey: ['platform', platformId, 'recordings'],
    queryFn: () => get<PlatformRecording[]>(`/platforms/${platformId}/recordings`),
    enabled: !!platformId && mode === 'recording',
  });
  const usable = (platforms.data ?? []).filter((p) => p.kind !== DATABASE_KIND && p.permissions.includes('use'));
  const opItems = (ops.data ?? [])
    .filter((o) => o.method.toUpperCase() === 'GET' || o.method.toUpperCase() === 'POST')
    .map((o) => ({
      value: `${o.specId}|${o.method}|${o.specPath ?? o.path}`,
      label: `${o.method.toUpperCase()} ${o.path}${o.summary ? ` – ${o.summary}` : ''}`,
    }));
  const recItems = (recs.data ?? []).map((r) => ({ value: r.id, label: `${r.method} ${r.path}${r.note ? ` – ${r.note}` : ''}` }));
  const draft = () => {
    if (!platformId || !item) return;
    if (mode === 'recording') return onDraft({ source: 'recording', platformId, recordingId: item });
    const [specId, method, path] = item.split('|') as [string, string, string];
    onDraft({ source: 'openapi', platformId, specId, method, path });
  };
  return (
    <Stack gap="sm">
      <Select
        label={t('new.platform')}
        data={usable.map((p) => ({ value: p.id, label: p.name }))}
        value={platformId}
        onChange={(v) => {
          setPlatformId(v);
          setItem(null);
        }}
        searchable
        placeholder={t('new.choosePlatform')}
        nothingFoundMessage={t('new.noPlatform')}
      />
      {platformId && (
        <Select
          label={mode === 'openapi' ? t('new.operation') : t('new.recording')}
          data={mode === 'openapi' ? opItems : recItems}
          value={item}
          onChange={setItem}
          searchable
          nothingFoundMessage={mode === 'openapi' ? t('new.noOperation') : t('new.noRecording')}
        />
      )}
      <Group>
        <Button size="xs" leftSection={<IconWand size={14} />} disabled={!platformId || !item} onClick={draft}>
          {t('new.draft')}
        </Button>
      </Group>
    </Stack>
  );
}

/** A new data contract: start blank, from a file, or from a draft Steward makes from what it knows. */
export function DataContractNewPage() {
  const { t } = useTranslation(['contracts', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { caps } = useMe();
  const [source, setSource] = useState<Source>('blank');
  const [yaml, setYaml] = useState(BLANK_CONTRACT);
  const [links, setLinks] = useState<DataContractLinkInput[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<DataContractPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const narrow = useMediaQuery('(max-width: 40em)') ?? false;
  if (!caps.createProcesses)
    return (
      <>
        <PageHeader back="dataContracts" title={t('new.title')} />
        <EmptyState title={t('new.notAllowed')}>{t('list.whoCanAct')}</EmptyState>
      </>
    );
  const draft = async (input: DataContractDraftInput) => {
    setBusy(true);
    try {
      const d = await post<DataContractDraft>('/data-contracts/draft', input);
      setYaml(d.yaml);
      setLinks(d.links);
      setWarnings(d.warnings);
    } catch (e) {
      notifyError(e, t('new.draftFailed'));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true);
    try {
      const made = await post<DataContractDetail>('/data-contracts', { yaml, links });
      void qc.invalidateQueries({ queryKey: dataContractKeys.all });
      navigate(`/data-contracts/${encodeURIComponent(made.id)}`);
    } catch (e) {
      notifyError(e, t('new.notCreated'));
    } finally {
      setBusy(false);
    }
  };
  const invalid = !preview?.facts;
  return (
    <>
      <PageHeader back="dataContracts" title={t('new.title')} description={t('new.description')} />
      <Stack gap="md" maw={980}>
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Text size="sm" fw={600} id="contract-source">
              {t('new.startFrom')}
            </Text>
            <SegmentedControl
              aria-labelledby="contract-source"
              value={source}
              onChange={(v) => setSource(v as Source)}
              data={SOURCES.map((s) => ({ value: s, label: t(`new.sources.${s}`) }))}
              fullWidth
              orientation={narrow ? 'vertical' : 'horizontal'}
              data-testid="draft-source"
            />
            <Text size="sm" c="dimmed">
              {t(`new.sourceHints.${source}`)}
            </Text>
            {source === 'blank' && (
              <Group>
                <Button size="xs" variant="default" onClick={() => setYaml(BLANK_CONTRACT)}>
                  {t('new.reset')}
                </Button>
                <FileButton onChange={(f) => f && void readText(f).then(setYaml)} accept=".yaml,.yml,application/yaml,text/yaml">
                  {(props) => (
                    <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} {...props}>
                      {t('new.fromFile')}
                    </Button>
                  )}
                </FileButton>
              </Group>
            )}
            {source === 'table' && <TableSource onDraft={(i) => void draft(i)} />}
            {source === 'dataset' && <DatasetSource onDraft={(i) => void draft(i)} />}
            {(source === 'openapi' || source === 'recording') && <PlatformSource key={source} mode={source} onDraft={(i) => void draft(i)} />}
          </Stack>
        </Paper>
        {warnings.length > 0 && (
          <Alert color="yellow" variant="light" title={t('new.reviewTitle')} data-testid="draft-warnings">
            <List size="sm">
              {warnings.map((w, i) => (
                <List.Item key={i}>{w}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        {links.length > 0 && (
          <Group gap={6} data-testid="draft-links">
            <Text size="sm">{t('new.willLink')}</Text>
            {links.map((l, i) => (
              <Badge key={i} variant="light" style={{ textTransform: 'none' }}>
                {t(`links.kinds.${l.kind}`)}: {l.detail ?? l.targetId}
              </Badge>
            ))}
          </Group>
        )}
        <ContractYamlEditor value={yaml} onChange={setYaml} onPreview={setPreview} />
        <Group>
          <Button onClick={() => void create()} loading={busy} disabled={invalid} data-testid="contract-create">
            {t('new.create')}
          </Button>
          <Button variant="default" onClick={() => navigate('/data-contracts')}>
            {t('common:cancel')}
          </Button>
        </Group>
      </Stack>
    </>
  );
}
