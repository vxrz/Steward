import { useState } from 'react';
import { ActionIcon, Alert, Badge, Box, Button, Group, Paper, Select, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconDownload, IconEye, IconFileCode, IconPlus, IconSparkles } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  OSSIE_REVISIONS,
  type DataProduct,
  type DataSemanticDraft,
  type DataSemanticFinding,
  type DataSemanticVersion,
  type DataSemanticVersionSummary,
  type OssieRevision,
} from '@sm/shared';
import { apiUrl, get, notifyOk, post } from '../../../api';
import { useMe } from '../../../auth';
import { QueryState } from '../../../components/common';
import { confirmDialog } from '../../../components/confirm';
import { FormModal } from '../../../components/FormModal';
import { UnifiedDiff } from '../../../components/editor/VersionDiff';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate, fmtDay } from '../../../format';
import { dpKeys, qs } from '../api';
import { CardTable, Section, useSortedEnvironments } from '../parts';
import { semKeys, useSemanticModel, useSemanticValid, useSemanticVersion } from './api';

const enc = encodeURIComponent;

/**
 * The _Semantic model_ tab of a product (ADR 0037 part 4): Steward's governed copy of the product's Apache Ossie model –
 * the version valid today and the newest, "which model was valid on a day", the versions with their sign-offs, a
 * version's text with its lint and drift findings, a comparison of two versions, a new version (with _Start from_ the
 * bound contracts and data objects) and the sign-off by a second person. Loaded only when the tab is open.
 */
export function SemanticModelTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProductSemantic', 'dataProducts', 'common']);
  const q = useSemanticModel(p.id);
  const qc = useQueryClient();
  const { username } = useMe();
  const [shown, setShown] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [signing, setSigning] = useState<DataSemanticVersionSummary | null>(null);
  const v = q.data;
  if (!v) return <QueryState query={q} />;
  const selected = shown ?? v.current?.version ?? null;
  const refresh = () => void qc.invalidateQueries({ queryKey: dpKeys.all });
  const own = (x: DataSemanticVersionSummary) => x.createdBy.toLowerCase() === username.toLowerCase();
  return (
    <Stack gap="md" data-testid="semantic-model">
      <Section
        title={t('title')}
        testId="semantic-summary"
        actions={
          v.mayEdit && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing(true)} data-testid="semantic-new">
              {t('newVersion')}
            </Button>
          )
        }
      >
        <Stack gap={6}>
          <Text size="sm" c="dimmed">
            {t('help')}
          </Text>
          {v.current ? (
            <>
              <Text size="sm" data-testid="semantic-valid-today">
                {v.validToday?.signOff
                  ? t('validToday', { version: v.validToday.version, by: v.validToday.signOff.by, date: fmtDay(v.validToday.signOff.at) })
                  : t('noValid')}
              </Text>
              <Text size="sm" c="dimmed" data-testid="semantic-current">
                {t('current', { version: v.current.version, by: v.current.createdBy, date: fmtDate(v.current.createdAt) })}
              </Text>
            </>
          ) : (
            <Text size="sm" c="dimmed" data-testid="semantic-none">
              {t('none')}
            </Text>
          )}
        </Stack>
      </Section>
      {v.current && <ValidOn productId={p.id} />}
      {v.versions.length > 0 && (
        <Section title={t('versions')} testId="semantic-versions">
          <CardTable
            rows={v.versions}
            rowKey={(x) => String(x.version)}
            ariaLabel={t('versions')}
            testId="semantic-version-table"
            rowTestId={(x) => `semantic-version-${x.version}`}
            columns={[
              { key: 'version', header: t('version'), nowrap: true, cell: (x) => t('versionN', { n: x.version }) },
              { key: 'saved', header: t('saved'), cell: (x) => `${fmtDate(x.createdAt)} · ${x.createdBy}` },
              { key: 'origin', header: t('origin'), nowrap: true, cell: (x) => t(`origins.${x.origin}`) },
              { key: 'lint', header: t('lint'), nowrap: true, cell: (x) => t('lintCount', { count: x.lintFindings }) },
              {
                key: 'signOff',
                header: t('signOff'),
                cell: (x) =>
                  x.signOff ? (
                    <Group gap={4} wrap="wrap">
                      {v.validToday?.version === x.version && (
                        <Badge color="teal" variant="light" tt="none" size="sm">
                          {t('validBadge')}
                        </Badge>
                      )}
                      <Text size="sm">{t('signedOff', { by: x.signOff.by, date: fmtDay(x.signOff.validFrom) })}</Text>
                    </Group>
                  ) : (
                    <Stack gap={0}>
                      <Text size="sm" c="dimmed">
                        {t('notSignedOff')}
                      </Text>
                      {/* who may sign off but saved this version learns why the button is missing (four eyes) */}
                      {v.maySignOff && own(x) && (
                        <Text size="xs" c="dimmed" data-testid="semantic-own-version">
                          {t('ownVersion')}
                        </Text>
                      )}
                    </Stack>
                  ),
              },
              { key: 'note', header: t('note'), cell: (x) => x.note || '–' },
              {
                key: 'actions',
                header: t('dataProducts:table.actions'),
                actions: true,
                cell: (x) => (
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label={t('view', { n: x.version })}>
                      <ActionIcon variant="subtle" aria-label={t('view', { n: x.version })} onClick={() => setShown(x.version)}>
                        <IconEye size={16} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label={t('export', { n: x.version })}>
                      <ActionIcon
                        component="a"
                        variant="subtle"
                        href={apiUrl(`/data-products/${enc(p.id)}/semantic-model/export?version=${x.version}`)}
                        aria-label={t('export', { n: x.version })}
                      >
                        <IconDownload size={16} />
                      </ActionIcon>
                    </Tooltip>
                    {v.maySignOff && !x.signOff && !own(x) && (
                      <Button size="compact-xs" variant="default" onClick={() => setSigning(x)} aria-label={t('signOffNamed', { n: x.version })}>
                        {t('signOffAction')}
                      </Button>
                    )}
                  </Group>
                ),
              },
            ]}
          />
        </Section>
      )}
      {selected && <VersionPanel productId={p.id} n={selected} />}
      {v.versions.length > 1 && <Compare productId={p.id} versions={v.versions} />}
      {editing && (
        <VersionForm
          p={p}
          current={v.current?.version ?? null}
          onClose={() => setEditing(false)}
          onSaved={(n) => {
            setEditing(false);
            setShown(n);
            refresh();
          }}
        />
      )}
      {signing && (
        <SignOffForm
          productId={p.id}
          version={signing}
          onClose={() => setSigning(null)}
          onSaved={() => {
            notifyOk(t('signedOffOk', { n: signing.version }));
            setSigning(null);
            refresh();
          }}
        />
      )}
    </Stack>
  );
}

/** "Which model was valid on a day, and who approved it?" */
function ValidOn({ productId }: { productId: string }) {
  const { t } = useTranslation('dataProductSemantic');
  const [date, setDate] = useState('');
  const [asked, setAsked] = useState('');
  const q = useSemanticValid(productId, asked);
  const a = q.data;
  return (
    <Paper withBorder p="md" data-testid="semantic-valid-on">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(date);
        }}
      >
        <Group gap="sm" align="flex-end" wrap="wrap">
          <TextInput type="date" label={t('validOn.title')} value={date} onChange={(e) => setDate(e.currentTarget.value)} data-testid="semantic-valid-date" />
          <Button type="submit" variant="default" disabled={!date} data-testid="semantic-valid-check">
            {t('validOn.check')}
          </Button>
        </Group>
      </form>
      {a && (
        <Stack gap={2} mt="sm" data-testid="semantic-valid-answer">
          <Text size="sm">
            {a.valid?.signOff
              ? t('validOn.valid', { version: a.valid.version, by: a.valid.signOff.by, from: fmtDay(a.valid.signOff.validFrom) })
              : t('validOn.none', { date: fmtDay(a.date) })}
          </Text>
          {a.latest && (
            <Text size="sm" c="dimmed">
              {t('validOn.latest', { version: a.latest.version, by: a.latest.createdBy, date: fmtDate(a.latest.createdAt) })}
            </Text>
          )}
        </Stack>
      )}
    </Paper>
  );
}

/** A finding in the reader's language (schema findings name the schema's own words). */
function useFindingText(): (f: DataSemanticFinding) => string {
  const { t } = useTranslation('dataProductSemantic');
  return (f) => {
    const p = f.params;
    if (f.kind === 'schema') return t('findings.schema', { path: f.path || '/', detail: String(p.detail ?? f.message) });
    if (f.kind === 'columnMissing') return p.from === 'snapshot' ? t('findings.columnMissingSnapshot', p) : t('findings.columnMissingContract', p);
    return t(`findings.${f.kind}`, p);
  };
}

function Findings({ findings, more, testId }: { findings: DataSemanticFinding[]; more: number; testId: string }) {
  const { t } = useTranslation('dataProductSemantic');
  const text = useFindingText();
  return (
    <Stack gap={2} data-testid={testId}>
      {findings.map((f, i) => (
        <Text key={`${f.kind}${f.path}${i}`} size="sm" c={f.severity === 'error' ? 'red' : 'orange'} style={{ overflowWrap: 'anywhere' }}>
          {text(f)}
        </Text>
      ))}
      {more > 0 && (
        <Text size="sm" c="dimmed">
          {t('more', { count: more })}
        </Text>
      )}
    </Stack>
  );
}

/** One version: its text as stored, its lint and drift findings. */
function VersionPanel({ productId, n }: { productId: string; n: number }) {
  const { t } = useTranslation('dataProductSemantic');
  const q = useSemanticVersion(productId, n);
  const v = q.data;
  if (!v) return <QueryState query={q} />;
  return (
    <Section title={t('versionN', { n })} testId="semantic-version">
      <Stack gap="sm">
        <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {t('sha')} {v.sha256}
        </Text>
        <div>
          <Text fw={600} size="sm">
            {t('driftTitle')}
          </Text>
          {v.drift.findings.length ? (
            <Findings findings={v.drift.findings} more={v.drift.more} testId="semantic-drift" />
          ) : (
            <Text size="sm" c="dimmed" data-testid="semantic-drift-none">
              {t('driftNone')}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('driftChecked', { count: v.drift.datasetsChecked })}
            {v.drift.hiddenContracts > 0 && ` ${t('driftHidden', { count: v.drift.hiddenContracts })}`}
          </Text>
        </div>
        <div>
          <Text fw={600} size="sm">
            {t('lintTitle', { revision: v.lint.revision })}
          </Text>
          {v.lint.findings.length ? (
            <Findings findings={v.lint.findings} more={v.lint.more} testId="semantic-lint" />
          ) : (
            <Text size="sm" c="dimmed" data-testid="semantic-lint-none">
              {t('lintNone')}
            </Text>
          )}
        </div>
        <DocumentText text={v.document} testId="semantic-document" />
      </Stack>
    </Section>
  );
}

function DocumentText({ text, testId }: { text: string; testId?: string }) {
  const { t } = useTranslation('dataProductSemantic');
  return (
    <div>
      <Text fw={600} size="sm">
        {t('document')}
      </Text>
      <Box
        component="pre"
        className="mono"
        tabIndex={0}
        aria-label={t('document')}
        data-testid={testId}
        style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, margin: 0, maxHeight: 480, overflow: 'auto' }}
      >
        {text}
      </Box>
    </div>
  );
}

/** Two versions side by side as a unified diff of their stored text. */
function Compare({ productId, versions }: { productId: string; versions: DataSemanticVersionSummary[] }) {
  const { t } = useTranslation('dataProductSemantic');
  const newest = versions[0]!.version;
  const [from, setFrom] = useState<string | null>(String(versions[1]!.version));
  const [to, setTo] = useState<string | null>(String(newest));
  const a = Number(from);
  const b = Number(to);
  const va = useSemanticVersion(productId, a);
  const vb = useSemanticVersion(productId, b);
  const options = versions.map((x) => ({ value: String(x.version), label: `${t('versionN', { n: x.version })} · ${fmtDate(x.createdAt)}` }));
  return (
    <Section title={t('compare')} testId="semantic-compare">
      <Group gap="sm" mb="md" wrap="wrap">
        <Select
          label={t('from')}
          data={options}
          value={from}
          onChange={setFrom}
          allowDeselect={false}
          w={{ base: '100%', xs: 260 }}
          data-testid="semantic-compare-from"
        />
        <Select
          label={t('to')}
          data={options}
          value={to}
          onChange={setTo}
          allowDeselect={false}
          w={{ base: '100%', xs: 260 }}
          data-testid="semantic-compare-to"
        />
      </Group>
      {a === b ? (
        <Text size="sm" c="dimmed">
          {t('same')}
        </Text>
      ) : va.data && vb.data ? (
        va.data.sha256 === vb.data.sha256 ? (
          <Text size="sm" c="dimmed">
            {t('noChanges')}
          </Text>
        ) : (
          <div data-testid="semantic-diff">
            <UnifiedDiff oldText={va.data.document} newText={vb.data.document} oldName={`v${a}`} newName={`v${b}`} context={3} />
          </div>
        )
      ) : null}
    </Section>
  );
}

/** A new version: the text as written, a note – or a draft from the bound contracts and data objects. */
function VersionForm({ p, current, onClose, onSaved }: { p: DataProduct; current: number | null; onClose: () => void; onSaved: (n: number) => void }) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const qc = useQueryClient();
  const latest = useSemanticVersion(p.id, current);
  const [document, setDocument] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [origin, setOrigin] = useState<'page' | 'draft'>('page');
  const envs = useSortedEnvironments(p.environments);
  const [environment, setEnvironment] = useState<string | null>(envs[0] ?? null);
  const [revision, setRevision] = useState<OssieRevision>('0.1.1');
  const [drafted, setDrafted] = useState<number | null>(null);
  // an empty document is not saved: the field says so after a try (it said nothing before)
  const [tried, setTried] = useState(false);
  const [busy, run] = useBusy();
  const text = document ?? latest.data?.document ?? '';
  const startFrom = () =>
    run(async () => {
      const d = await get<DataSemanticDraft>(`/data-products/${enc(p.id)}/semantic-model/draft?${qs({ environment, revision })}`);
      if (text.trim() && !(await confirmDialog({ action: 'confirm', message: t('form.replaceConfirm'), danger: false }))) return;
      setDocument(d.document);
      setOrigin('draft');
      setDrafted(d.datasets);
    });
  const save = () =>
    run(async () => {
      const r = await post<{ created: boolean; version: DataSemanticVersionSummary; lint: { findings: unknown[]; more: number } }>(
        `/data-products/${enc(p.id)}/semantic-model/versions`,
        { document: text, note: note.trim(), origin },
      );
      if (!r.created) notifyOk(t('form.unchanged'));
      else {
        const n = r.lint.findings.length + r.lint.more;
        notifyOk(n ? t('form.savedFindings', { n: r.version.version, count: n }) : t('form.saved', { n: r.version.version }));
        qc.setQueryData<DataSemanticVersion | undefined>(semKeys.version(p.id, r.version.version), undefined);
      }
      onSaved(r.version.version);
    });
  return (
    <FormModal onClose={onClose} title={t('form.title')} size="xl" dirty={document !== null || !!note}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (text.trim()) void save();
        }}
      >
        <Stack gap="sm">
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <Text size="sm" c="dimmed">
                {t('form.startHelp')}
              </Text>
              <Group gap="sm" align="flex-end" wrap="wrap">
                <Select
                  label={t('form.environment')}
                  data={envs}
                  value={environment}
                  onChange={setEnvironment}
                  allowDeselect={false}
                  w={{ base: '100%', xs: 200 }}
                  data-testid="semantic-draft-environment"
                />
                <Select
                  label={t('form.revision')}
                  data={[...OSSIE_REVISIONS]}
                  value={revision}
                  onChange={(x) => x && setRevision(x as OssieRevision)}
                  allowDeselect={false}
                  w={{ base: '100%', xs: 160 }}
                />
                <Button
                  variant="default"
                  leftSection={<IconSparkles size={14} />}
                  loading={busy}
                  onClick={() => void startFrom()}
                  data-testid="semantic-start-from"
                >
                  {t('startFrom')}
                </Button>
              </Group>
              {drafted !== null && (
                <Alert color="blue" icon={<IconFileCode size={16} />} data-testid="semantic-drafted">
                  {t('form.drafted', { count: drafted })}
                </Alert>
              )}
            </Stack>
          </Paper>
          <Textarea
            label={t('form.document')}
            description={t('form.documentHelp')}
            value={text}
            onChange={(e) => setDocument(e.currentTarget.value)}
            autosize
            minRows={12}
            maxRows={28}
            required
            error={tried && !text.trim() ? t('common:validation.required') : undefined}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
            data-testid="semantic-document-input"
          />
          <TextInput label={t('form.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={1000} data-testid="semantic-note" />
          <FormButtons busy={busy} testId="semantic-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The sign-off of one version: its text and SHA-256 shown, the hash sent back – what the person read. */
function SignOffForm({
  productId,
  version,
  onClose,
  onSaved,
}: {
  productId: string;
  version: DataSemanticVersionSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const q = useSemanticVersion(productId, version.version);
  const [note, setNote] = useState('');
  const [busy, run] = useBusy();
  const v = q.data;
  const save = () =>
    run(async () => {
      await post(`/data-products/${enc(productId)}/semantic-model/versions/${version.version}/sign-off`, { sha256: v!.sha256, note: note.trim() });
      onSaved();
    });
  return (
    <FormModal onClose={onClose} title={t('signOffTitle', { n: version.version })} size="xl" dirty={!!note}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v) void save();
        }}
      >
        <Stack gap="sm">
          {!v ? (
            <QueryState query={q} />
          ) : (
            <>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {t('signOffHelp', { sha: v.sha256 })}
              </Text>
              {v.drift.findings.length + v.lint.findings.length > 0 && (
                <Alert color="orange" data-testid="semantic-signoff-findings">
                  {t('lintCount', { count: v.drift.findings.length + v.drift.more + v.lint.findings.length + v.lint.more })}
                </Alert>
              )}
              <DocumentText text={v.document} />
            </>
          )}
          <Textarea
            label={t('signOffNote')}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            autosize
            minRows={2}
            data-testid="semantic-signoff-note"
          />
          <FormButtons busy={busy} submit={t('signOffAction')} testId="semantic-signoff-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
