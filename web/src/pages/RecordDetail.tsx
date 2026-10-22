import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Grid,
  Group,
  Menu,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Timeline,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconDots,
  IconDownload,
  IconEdit,
  IconFileTypePdf,
  IconGitBranch,
  IconLock,
  IconMessage,
  IconPlus,
  IconSignature,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  REPORT_LANGS,
  type LinkTarget,
  type RecordActionInfo,
  type RecordAttachment,
  type RecordDetail,
  type RecordFieldDef,
  type RecordEvent,
  type RecordPdfDetails,
  type RecordVersion,
  type RecordsMeta,
  type SignedPdfDetails,
} from '@sm/shared';
import { api, apiUrl, del, get, notifyError, notifyOk, post } from '../api';
import { PageHeader } from '../components/common';
import { UnifiedDiff } from '../components/editor/VersionDiff';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field, LinksPanel, RecordStatusBadge, useTypeName, type LinkInput } from '../components/records/common';
import { fmtBytes, fmtDate, fmtDay } from '../format';
import { currentLanguage } from '../i18n';
import { codeText, errorText } from '../i18n/errors';
import { fieldLabel, optionLabel } from '../components/records/builtin';

const TABS = ['content', 'versions', 'links', 'attachments', 'discussion', 'pdfs'] as const;
type Tab = (typeof TABS)[number];

export function RecordDetailPage() {
  const { t } = useTranslation(['records', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const tab = (TABS.includes(search.get('tab') as Tab) ? search.get('tab') : 'content') as Tab;
  const q = useQuery({ queryKey: ['record', id], queryFn: () => get<RecordDetail>(`/records/${id}`) });
  const meta = useQuery({ queryKey: ['records-meta'], queryFn: () => get<RecordsMeta>('/records/meta') });
  const typeName = useTypeName();
  const [action, setAction] = useState<RecordActionInfo | null>(null);
  const [revising, setRevising] = useState(false);
  const [pdf, setPdf] = useState(false);
  const refresh = (r?: RecordDetail) => {
    if (r) qc.setQueryData(['record', id], r);
    else void qc.invalidateQueries({ queryKey: ['record', id] });
    void qc.invalidateQueries({ queryKey: ['records'] });
    void qc.invalidateQueries({ queryKey: ['record-versions', id] });
  };

  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  const rec = q.data;
  if (!rec) return null;
  const tampered = rec.tampered;
  const visibleActions = rec.actions.filter((a) => a.allowed || (a.approval && meta.data?.canApprove));

  return (
    <>
      <PageHeader
        title={
          <Group gap="sm" wrap="wrap">
            <span>{rec.title}</span>
            <RecordStatusBadge status={rec.status} size="lg" />
          </Group>
        }
        description={
          <>
            <span className="mono">{rec.number}</span> · {typeName(rec.type, rec.typeName)} · {t('detail.owner', { owner: rec.owner })} ·{' '}
            {t('detail.revisionVersion', { revision: rec.revision, version: rec.version })}
          </>
        }
      />
      <Group gap="xs" mb="sm" mt={-8} wrap="wrap">
        {rec.permissions.edit && (
          <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => navigate(`/records/${rec.id}/edit`)}>
            {t('detail.edit')}
          </Button>
        )}
        {visibleActions.map((a) => {
          const button = (
            <Button
              key={a.action}
              size="xs"
              variant={a.approval ? 'filled' : 'default'}
              color={a.action === 'reject' ? 'red' : a.approval ? 'green' : undefined}
              disabled={!a.allowed}
              onClick={() => setAction(a)}
            >
              {t(`actions.${a.action as 'submit'}`, { defaultValue: a.action })}
            </Button>
          );
          return a.allowed ? (
            button
          ) : (
            <Tooltip key={a.action} label={codeText(a.reasonCode, undefined, a.reason) ?? a.reason} multiline w={260}>
              <span>{button}</span>
            </Tooltip>
          );
        })}
        {rec.permissions.revise && (
          <Button size="xs" variant="default" leftSection={<IconGitBranch size={14} />} onClick={() => setRevising(true)}>
            {rec.status === 'rejected' ? t('detail.rework') : t('detail.revise')}
          </Button>
        )}
        <Menu position="bottom-end">
          <Menu.Target>
            <Button size="xs" variant="default" aria-label={t('detail.moreActions')} px={8}>
              <IconDots size={16} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {rec.permissions.generatePdf && (
              <Menu.Item leftSection={<IconFileTypePdf size={14} />} onClick={() => setPdf(true)}>
                {t('pdf.generate')}
              </Menu.Item>
            )}
            <Menu.Item leftSection={<IconDownload size={14} />} component="a" href={apiUrl(`/records/${rec.id}/export`)}>
              {t('detail.exportMd')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      {tampered && (
        <Alert color="red" icon={<IconAlertTriangle size={16} />} mb="sm" title={t('detail.tamperedTitle')}>
          {t('detail.tampered')}
        </Alert>
      )}
      {rec.frozen && !tampered && (
        <Alert color="gray" variant="light" icon={<IconLock size={16} />} mb="sm">
          <Text size="sm">{rec.permissions.revise ? t('detail.frozenRevisable') : t('detail.frozen')}</Text>
          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {t('detail.frozenHash', { hash: rec.frozenHash })}
          </Text>
        </Alert>
      )}
      {rec.supersededBy && (
        <Alert color="orange" mb="sm">
          {t('detail.supersededBy')}{' '}
          <Anchor component={Link} to={`/records/${rec.supersededBy.id}`}>
            {rec.supersededBy.number} {rec.supersededBy.title}
          </Anchor>
        </Alert>
      )}
      {typeof rec.importMeta?.originalStatus === 'string' && rec.status === 'draft' && (
        <Alert color="blue" variant="light" mb="sm">
          {t('detail.importedStatus', { status: rec.importMeta.originalStatus, file: String(rec.importMeta.filename ?? '') })}
        </Alert>
      )}
      <Tabs value={tab} onChange={(v) => setSearch(v && v !== 'content' ? { tab: v } : {}, { replace: true })} keepMounted={false}>
        <Tabs.List mb="md" style={{ flexWrap: 'wrap' }}>
          <Tabs.Tab value="content">{t('tabs.content')}</Tabs.Tab>
          <Tabs.Tab value="versions">{t('tabs.versions', { count: rec.version })}</Tabs.Tab>
          <Tabs.Tab value="links">{t('tabs.links', { count: rec.links.length + rec.backlinks.length })}</Tabs.Tab>
          <Tabs.Tab value="attachments">{t('tabs.attachments', { count: rec.attachments.filter((a) => a.kind === 'file').length })}</Tabs.Tab>
          <Tabs.Tab value="discussion">{t('tabs.discussion', { count: rec.events.length })}</Tabs.Tab>
          <Tabs.Tab value="pdfs">{t('tabs.pdfs', { count: rec.attachments.filter((a) => a.kind !== 'file').length })}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="content">
          <ContentTab rec={rec} />
        </Tabs.Panel>
        <Tabs.Panel value="versions">
          <VersionsTab rec={rec} />
        </Tabs.Panel>
        <Tabs.Panel value="links">
          <LinksPanel
            links={rec.links}
            backlinks={rec.backlinks}
            canEdit={rec.permissions.link}
            self={{ kind: 'record', id: rec.id }}
            onAdd={async (l: LinkInput) => {
              await post(`/records/${rec.id}/links`, l);
              refresh();
            }}
            onRemove={async (lid) => {
              await del(`/records/${rec.id}/links/${lid}`);
              refresh();
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="attachments">
          <AttachmentsTab rec={rec} onChange={refresh} />
        </Tabs.Panel>
        <Tabs.Panel value="discussion">
          <DiscussionTab rec={rec} onChange={refresh} />
        </Tabs.Panel>
        <Tabs.Panel value="pdfs">
          <PdfTab rec={rec} onGenerate={() => setPdf(true)} onChange={refresh} />
        </Tabs.Panel>
      </Tabs>
      {action && <TransitionModal rec={rec} action={action} onClose={() => setAction(null)} onDone={refresh} />}
      {revising && <ReviseModal rec={rec} onClose={() => setRevising(false)} onDone={refresh} />}
      {pdf && (
        <PdfModal
          rec={rec}
          onClose={() => setPdf(false)}
          onDone={() => {
            refresh();
            setSearch({ tab: 'pdfs' }, { replace: true });
          }}
        />
      )}
    </>
  );
}

function fieldValue(typeKey: string, f: RecordFieldDef, v: string | undefined): string {
  if (!v) return '–';
  if (f.kind === 'datetime') return fmtDate(new Date(v).toISOString());
  // a calendar date: midnight local time, not UTC (which would show the day before west of Greenwich)
  if (f.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDay(new Date(`${v}T00:00:00`));
  if (f.kind === 'select') return optionLabel(typeKey, f, v);
  return v;
}

function ContentTab({ rec }: { rec: RecordDetail }) {
  const { t } = useTranslation('records');
  return (
    <Grid gutter="lg">
      {rec.fieldDefs.length > 0 && (
        <Grid.Col span={{ base: 12, md: 4 }} order={{ base: 1, md: 2 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              {rec.fieldDefs.map((f) => (
                <Field key={f.key} label={fieldLabel(rec.typeKey, f)}>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                    {fieldValue(rec.typeKey, f, rec.fields[f.key])}
                  </Text>
                </Field>
              ))}
              {rec.tags.length > 0 && (
                <Field label={t('editor.tags')}>
                  <Group gap={4}>
                    {rec.tags.map((tag) => (
                      <Badge
                        key={tag}
                        size="sm"
                        variant="default"
                        component={Link}
                        to={`/records?tag=${encodeURIComponent(tag)}`}
                        style={{ cursor: 'pointer' }}
                      >
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Field>
              )}
            </Stack>
          </Paper>
        </Grid.Col>
      )}
      <Grid.Col span={{ base: 12, md: rec.fieldDefs.length ? 8 : 12 }} order={{ base: 2, md: 1 }}>
        {rec.body.trim() ? <MarkdownView text={rec.body} /> : <Text c="dimmed">{t('detail.noBody')}</Text>}
        <Text size="xs" c="dimmed" mt="md" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {t('detail.contentHash', { hash: rec.contentHash })}
        </Text>
      </Grid.Col>
    </Grid>
  );
}

const asText = (v: RecordVersion, labels: Map<string, string>) =>
  [`# ${v.title}`, '', ...Object.entries(v.fields).map(([k, x]) => `${labels.get(k) ?? k}: ${x}`), '', v.body].join('\n');

function VersionsTab({ rec }: { rec: RecordDetail }) {
  const { t } = useTranslation('records');
  const versions = useQuery({ queryKey: ['record-versions', rec.id], queryFn: () => get<RecordVersion[]>(`/records/${rec.id}/versions`) });
  const list = versions.data ?? [];
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [context, setContext] = useState(true);
  const labels = useMemo(() => new Map(rec.fieldDefs.map((f) => [f.key, fieldLabel(rec.typeKey, f)])), [rec.fieldDefs, rec.typeKey]);
  const a = list.find((v) => String(v.version) === (from ?? String(list[1]?.version ?? '')));
  const b = list.find((v) => String(v.version) === (to ?? String(list[0]?.version ?? '')));
  const options = list.map((v) => ({ value: String(v.version), label: t('versions.option', { version: v.version, revision: v.revision, author: v.author }) }));
  return (
    <Stack gap="md">
      <div className="table-scroll">
        <Table fz="sm" aria-label={t('versions.title')}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('versions.version')}</Table.Th>
              <Table.Th>{t('versions.revision')}</Table.Th>
              <Table.Th>{t('versions.author')}</Table.Th>
              <Table.Th>{t('versions.date')}</Table.Th>
              <Table.Th>{t('versions.comment')}</Table.Th>
              <Table.Th>{t('versions.hash')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((v) => (
              <Table.Tr key={v.version}>
                <Table.Td>v{v.version}</Table.Td>
                <Table.Td>{v.revision}</Table.Td>
                <Table.Td>{v.author}</Table.Td>
                <Table.Td className="nowrap">{fmtDate(v.createdAt)}</Table.Td>
                <Table.Td>{v.comment}</Table.Td>
                <Table.Td className="mono" title={v.hash}>
                  {v.hash.slice(0, 12)}…
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {list.length < 2 ? (
        <Text size="sm" c="dimmed">
          {t('versions.onlyOne')}
        </Text>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
            <Select size="xs" label={t('versions.from')} data={options} value={from ?? String(list[1]!.version)} onChange={setFrom} allowDeselect={false} />
            <Select size="xs" label={t('versions.to')} data={options} value={to ?? String(list[0]!.version)} onChange={setTo} allowDeselect={false} />
          </SimpleGrid>
          <Switch size="xs" label={t('versions.contextOnly')} checked={context} onChange={(e) => setContext(e.currentTarget.checked)} />
          {a &&
            b &&
            (asText(a, labels) === asText(b, labels) ? (
              <Text size="sm">{t('versions.same')}</Text>
            ) : (
              <UnifiedDiff
                oldText={asText(a, labels)}
                newText={asText(b, labels)}
                oldName={`v${a.version}`}
                newName={`v${b.version}`}
                context={context ? 3 : 100000}
              />
            ))}
        </>
      )}
    </Stack>
  );
}

async function uploadFile(url: string, file: File, extra: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', file, file.name);
  return api('POST', url, form);
}

function AttachmentsTab({ rec, onChange }: { rec: RecordDetail; onChange: () => void }) {
  const { t } = useTranslation('records');
  const [busy, setBusy] = useState(false);
  const files = rec.attachments.filter((a) => a.kind === 'file');
  const upload = async (list: File[]) => {
    setBusy(true);
    try {
      for (const f of list) await uploadFile(`/records/${rec.id}/attachments`, f);
      onChange();
    } catch (e) {
      notifyError(e);
      onChange();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {rec.permissions.attach ? t('attachments.help') : rec.frozen ? t('attachments.frozen') : t('attachments.readOnly')}
        </Text>
        {rec.permissions.attach && (
          <FileButton onChange={(f) => void upload(f)} multiple>
            {(props) => (
              <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} loading={busy} {...props}>
                {t('attachments.upload')}
              </Button>
            )}
          </FileButton>
        )}
      </Group>
      {files.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('attachments.empty')}
        </Text>
      ) : (
        <AttachmentTable rec={rec} items={files} canRemove={rec.permissions.attach} onChange={onChange} />
      )}
    </Stack>
  );
}

function AttachmentTable({ rec, items, canRemove, onChange }: { rec: RecordDetail; items: RecordAttachment[]; canRemove?: boolean; onChange: () => void }) {
  const { t } = useTranslation('records');
  return (
    <div className="table-scroll">
      <Table fz="sm" aria-label={t('attachments.title')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('attachments.file')}</Table.Th>
            <Table.Th>{t('attachments.size')}</Table.Th>
            <Table.Th>{t('attachments.sha256')}</Table.Th>
            <Table.Th>{t('attachments.added')}</Table.Th>
            {canRemove && <Table.Th aria-label={t('attachments.actions')} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((a) => (
            <Table.Tr key={a.id}>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>
                <Anchor href={apiUrl(`/records/${rec.id}/attachments/${a.id}/download`)} size="sm">
                  {a.filename}
                </Anchor>
              </Table.Td>
              <Table.Td className="nowrap">{fmtBytes(a.size)}</Table.Td>
              <Table.Td className="mono" title={a.sha256}>
                {a.sha256.slice(0, 16)}…
              </Table.Td>
              <Table.Td className="nowrap">
                {fmtDate(a.createdAt)} · {a.createdBy}
              </Table.Td>
              {canRemove && (
                <Table.Td>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('attachments.removeNamed', { name: a.filename })}
                    onClick={async () => {
                      if (!confirm(t('attachments.removeConfirm', { name: a.filename }))) return;
                      try {
                        await del(`/records/${rec.id}/attachments/${a.id}`);
                        onChange();
                      } catch (e) {
                        notifyError(e);
                      }
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function eventText(e: RecordEvent, t: ReturnType<typeof useTranslation<'records'>>['t']): string {
  if (e.kind === 'transition')
    return t('discussion.transition', {
      action: t(`actions.${e.action as 'submit'}`, { defaultValue: e.action ?? '' }),
      from: t(`status.${e.fromStatus as 'draft'}`),
      to: t(`status.${e.toStatus as 'draft'}`),
    });
  if (e.kind === 'revision') return t('discussion.revision', { revision: e.revision });
  return t(`discussion.events.${e.kind}`);
}

function DiscussionTab({ rec, onChange }: { rec: RecordDetail; onChange: (r?: RecordDetail) => void }) {
  const { t } = useTranslation('records');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      onChange(await post<RecordDetail>(`/records/${rec.id}/comments`, { text }));
      setText('');
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="md">
      <Timeline bulletSize={22} lineWidth={2}>
        {rec.events.map((e) => (
          <Timeline.Item
            key={e.id}
            bullet={e.kind === 'comment' ? <IconMessage size={12} aria-hidden /> : undefined}
            color={e.action === 'reject' ? 'red' : e.action === 'approve' || e.action === 'accept' ? 'green' : 'blue'}
            title={
              <Text size="sm" fw={600}>
                {eventText(e, t)}
              </Text>
            }
          >
            <Text size="xs" c="dimmed">
              {t('discussion.by', { actor: e.actor, date: fmtDate(e.createdAt) })}
              {e.contentHash && e.kind === 'transition' && (
                <Text span className="mono" size="xs" title={e.contentHash}>
                  {' '}
                  · {e.contentHash.slice(0, 12)}…
                </Text>
              )}
            </Text>
            {e.comment && (
              <Text size="sm" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {e.comment}
              </Text>
            )}
          </Timeline.Item>
        ))}
      </Timeline>
      {rec.permissions.comment && (
        <Stack gap="xs">
          <Textarea
            label={t('discussion.comment')}
            placeholder={t('discussion.placeholder')}
            autosize
            minRows={2}
            maxRows={8}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={4000}
          />
          <Group justify="flex-end">
            <Button size="xs" onClick={send} loading={busy} disabled={!text.trim()}>
              {t('discussion.send')}
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

function PdfTab({ rec, onGenerate, onChange }: { rec: RecordDetail; onGenerate: () => void; onChange: () => void }) {
  const { t } = useTranslation('records');
  const generated = rec.attachments.filter((a) => a.kind === 'generated');
  const signed = rec.attachments.filter((a) => a.kind === 'signed');
  const [busy, setBusy] = useState(false);
  const [plain, setPlain] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  const upload = async (f: File | null) => {
    if (!f) return;
    setBusy(true);
    setLast(null);
    try {
      await uploadFile(`/records/${rec.id}/signed${plain ? '?plain=1' : ''}`, f);
      notifyOk(t('pdf.uploaded'));
      onChange();
    } catch (e) {
      setLast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="lg">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>{t('pdf.generatedTitle')}</Text>
          {rec.permissions.generatePdf && (
            <Button size="xs" variant="default" leftSection={<IconFileTypePdf size={14} />} onClick={onGenerate}>
              {t('pdf.generate')}
            </Button>
          )}
        </Group>
        {generated.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('pdf.none')}
          </Text>
        ) : (
          <div className="table-scroll">
            <Table fz="sm" aria-label={t('pdf.generatedTitle')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('attachments.file')}</Table.Th>
                  <Table.Th>{t('pdf.state')}</Table.Th>
                  <Table.Th>{t('pdf.signers')}</Table.Th>
                  <Table.Th>{t('attachments.sha256')}</Table.Th>
                  <Table.Th>{t('attachments.added')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {generated.map((a) => {
                  const d = a.details as RecordPdfDetails | null;
                  return (
                    <Table.Tr key={a.id}>
                      <Table.Td style={{ overflowWrap: 'anywhere' }}>
                        <Anchor href={apiUrl(`/records/${rec.id}/attachments/${a.id}/download`)} size="sm">
                          {a.filename}
                        </Anchor>
                      </Table.Td>
                      <Table.Td className="nowrap">{d ? `${t(`status.${d.status as 'draft'}`)} · r${d.revision} v${d.version} · ${d.lang}` : ''}</Table.Td>
                      <Table.Td>{d?.signers.map((s) => (s.role ? `${s.name} (${s.role})` : s.name)).join(', ') || '–'}</Table.Td>
                      <Table.Td className="mono" title={a.sha256}>
                        {a.sha256.slice(0, 16)}…
                      </Table.Td>
                      <Table.Td className="nowrap">
                        {fmtDate(a.createdAt)} · {a.createdBy}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Stack>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-end">
          <Text fw={600}>{t('pdf.signedTitle')}</Text>
          {rec.permissions.uploadSigned && (
            <Group gap="xs">
              {rec.permissions.attachPlainPdf && (
                <Checkbox size="xs" label={t('pdf.plain')} checked={plain} onChange={(e) => setPlain(e.currentTarget.checked)} />
              )}
              <FileButton onChange={(f) => void upload(f)} accept="application/pdf,.pdf">
                {(props) => (
                  <Button size="xs" variant="default" leftSection={<IconSignature size={14} />} loading={busy} {...props}>
                    {t('pdf.upload')}
                  </Button>
                )}
              </FileButton>
            </Group>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          {t('pdf.uploadHelp')}
        </Text>
        {last && (
          <Alert color="red" withCloseButton onClose={() => setLast(null)}>
            {last}
          </Alert>
        )}
        {signed.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('pdf.noneSigned')}
          </Text>
        ) : (
          signed.map((a) => {
            const d = a.details as SignedPdfDetails | null;
            return (
              <Paper key={a.id} withBorder p="sm">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <Anchor href={apiUrl(`/records/${rec.id}/attachments/${a.id}/download`)} size="sm" fw={600}>
                    {a.filename}
                  </Anchor>
                  {d?.validation === 'structure' ? (
                    <Badge color="green" variant="light">
                      {t('pdf.derivedBadge')}
                    </Badge>
                  ) : (
                    <Badge color="orange" variant="light">
                      {t('pdf.unverifiedBadge')}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed">
                  {fmtDate(a.createdAt)} · {a.createdBy} · {fmtBytes(a.size)} ·{' '}
                  <span className="mono" title={a.sha256}>
                    {a.sha256.slice(0, 16)}…
                  </span>
                </Text>
                {d?.validation === 'structure' && <Text size="xs">{t('pdf.derivedFrom', { file: d.derivedFromFilename })}</Text>}
                {(d?.signatures ?? []).map((s, i) => (
                  <Text key={i} size="sm" mt={4}>
                    <IconSignature size={14} aria-hidden style={{ verticalAlign: 'middle' }} />{' '}
                    {t('pdf.signatureLine', { name: s.name ?? t('pdf.unknownSigner'), date: s.signedAt ? fmtDate(s.signedAt) : '–', field: s.field ?? '–' })}
                    {s.reason ? ` · ${s.reason}` : ''}
                    {!s.byteRangeOk && (
                      <Text span c="orange" size="xs">
                        {' '}
                        · {t('pdf.byteRangeOdd')}
                      </Text>
                    )}
                  </Text>
                ))}
                <Text size="xs" c="dimmed" mt={4}>
                  {d?.validation === 'structure' ? t('pdf.structureOnly') : t('pdf.notChecked')}
                </Text>
              </Paper>
            );
          })
        )}
      </Stack>
    </Stack>
  );
}

function TransitionModal({
  rec,
  action,
  onClose,
  onDone,
}: {
  rec: RecordDetail;
  action: RecordActionInfo;
  onClose: () => void;
  onDone: (r: RecordDetail) => void;
}) {
  const { t } = useTranslation(['records', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 250);
  const [target, setTarget] = useState<string | null>(null);
  const targets = useQuery({
    queryKey: ['link-targets', 'record', debounced],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=record&q=${encodeURIComponent(debounced)}`),
    enabled: action.needsRecord,
  });
  const label = t(`actions.${action.action as 'submit'}`, { defaultValue: action.action });
  const valid = (!action.commentRequired || comment.trim()) && (!action.needsRecord || target);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(
        await post<RecordDetail>(`/records/${rec.id}/transition`, {
          action: action.action,
          comment: comment.trim() || undefined,
          supersededBy: target ?? undefined,
        }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('transition.title', { action: label, number: rec.number })}>
      <Stack gap="sm">
        <Text size="sm">{t('transition.to', { status: t(`status.${action.to as 'draft'}`) })}</Text>
        {action.approval && (
          <Text size="xs" c="dimmed">
            {t('transition.approvalNote', { hash: rec.frozenHash ?? rec.contentHash })}
          </Text>
        )}
        {rec.status === 'draft' && (
          <Text size="xs" c="dimmed">
            {t('transition.freezeNote')}
          </Text>
        )}
        {action.needsRecord && (
          <Select
            label={t('transition.supersededBy')}
            placeholder={t('links.search')}
            searchable
            searchValue={q}
            onSearchChange={setQ}
            data={(targets.data ?? []).filter((x) => x.id !== rec.id).map((x) => ({ value: x.id, label: x.label }))}
            value={target}
            onChange={setTarget}
            filter={({ options }) => options}
            required
          />
        )}
        <Textarea
          label={t('transition.comment')}
          description={action.commentRequired ? t('transition.commentRequired') : t('transition.commentOptional')}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          required={action.commentRequired}
          maxLength={4000}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!valid} color={action.action === 'reject' ? 'red' : undefined}>
            {label}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReviseModal({ rec, onClose, onDone }: { rec: RecordDetail; onClose: () => void; onDone: (r: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(await post<RecordDetail>(`/records/${rec.id}/revise`, { comment: comment.trim() }));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('revise.title', { number: rec.number })}>
      <Stack gap="sm">
        <Text size="sm">{t('revise.help', { revision: rec.revision + 1 })}</Text>
        <Textarea
          label={t('revise.reason')}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          required
          maxLength={4000}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!comment.trim()}>
            {t('revise.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

interface SignerRow {
  name: string;
  role: string;
  email: string;
}

function PdfModal({ rec, onClose, onDone }: { rec: RecordDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const [lang, setLang] = useState<string>(REPORT_LANGS.includes(currentLanguage() as 'en') ? currentLanguage() : 'en');
  const [signers, setSigners] = useState<SignerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<RecordAttachment | null>(null);
  const update = (i: number, patch: Partial<SignerRow>) => setSigners((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const valid = signers.every((s) => s.name.trim() && (!s.email.trim() || /^\S+@\S+\.\S+$/.test(s.email.trim())));
  const submit = async () => {
    setBusy(true);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await post<RecordAttachment>(`/records/${rec.id}/pdf`, {
        lang,
        timeZone,
        signers: signers.map((s) => ({ name: s.name.trim(), role: s.role.trim(), ...(s.email.trim() ? { email: s.email.trim() } : {}) })),
      });
      setCreated(r);
      onDone();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('pdf.title', { number: rec.number })} size="lg">
      {created ? (
        <Stack gap="sm">
          <Alert color="green">{t('pdf.created')}</Alert>
          <Anchor href={apiUrl(`/records/${rec.id}/attachments/${created.id}/download`)}>
            <IconDownload size={14} aria-hidden /> {created.filename}
          </Anchor>
          <Text size="xs" c="dimmed">
            {t('pdf.signHowTo')}
          </Text>
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common:close')}</Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm">
          {!rec.frozen && <Alert color="orange">{t('pdf.draftWarning')}</Alert>}
          <Select
            label={t('pdf.lang')}
            data={REPORT_LANGS.map((l) => ({ value: l, label: t(`pdf.langs.${l}`) }))}
            value={lang}
            onChange={(v) => v && setLang(v)}
            allowDeselect={false}
            w={200}
          />
          <Text fw={600} size="sm">
            {t('pdf.signers')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('pdf.signersHelp')}
          </Text>
          {signers.map((s, i) => (
            <Paper key={i} withBorder p="xs">
              <Group align="flex-end" gap="xs" wrap="wrap">
                <TextInput
                  size="xs"
                  label={t('pdf.signerName')}
                  value={s.name}
                  onChange={(e) => update(i, { name: e.currentTarget.value })}
                  required
                  maxLength={120}
                  style={{ flex: '1 1 160px' }}
                />
                <TextInput
                  size="xs"
                  label={t('pdf.signerRole')}
                  placeholder={t('pdf.rolePlaceholder')}
                  value={s.role}
                  onChange={(e) => update(i, { role: e.currentTarget.value })}
                  maxLength={120}
                  style={{ flex: '1 1 140px' }}
                />
                <TextInput
                  size="xs"
                  label={t('pdf.signerEmail')}
                  value={s.email}
                  onChange={(e) => update(i, { email: e.currentTarget.value })}
                  maxLength={200}
                  style={{ flex: '1 1 180px' }}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('pdf.removeSigner', { n: i + 1 })}
                  onClick={() => setSigners((x) => x.filter((_, j) => j !== i))}
                  mb={4}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            </Paper>
          ))}
          {signers.length < 8 && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => setSigners((x) => [...x, { name: '', role: '', email: '' }])}
              w="fit-content"
            >
              {t('pdf.addSigner')}
            </Button>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button onClick={submit} loading={busy} disabled={!valid} leftSection={<IconFileTypePdf size={14} />}>
              {t('pdf.generateButton')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
