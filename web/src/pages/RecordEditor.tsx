import { useEffect, useState } from 'react';
import { Alert, Button, Grid, Group, Paper, Select, Stack, Tabs, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RecordDetail, RecordFieldDef } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../api';
import { PageHeader } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { useTypeName } from '../components/records/common';
import { errorText } from '../i18n/errors';

interface Draft {
  title: string;
  body: string;
  fields: Record<string, string>;
  tags: string[];
}

const fromRecord = (r: RecordDetail): Draft => ({ title: r.title, body: r.body, fields: { ...r.fields }, tags: [...r.tags] });

/** datetime-local inputs want "YYYY-MM-DDTHH:mm" */
const localValue = (v: string | undefined) => (v ? v.slice(0, 16) : '');

function FieldInput({ def, value, onChange }: { def: RecordFieldDef; value: string; onChange: (v: string) => void }) {
  // Drafts may be incomplete: required fields are marked, but only checked on submit (by the server).
  const common = { label: def.label, description: def.help, withAsterisk: def.required, value };
  switch (def.kind) {
    case 'textarea':
      return <Textarea {...common} autosize minRows={2} maxRows={10} onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'date':
      return <TextInput {...common} type="date" onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'datetime':
      return <TextInput {...common} value={localValue(value)} type="datetime-local" onChange={(e) => onChange(e.currentTarget.value)} />;
    case 'select':
      return <Select {...common} value={value || null} data={def.options ?? []} clearable onChange={(v) => onChange(v ?? '')} />;
    default:
      return <TextInput {...common} onChange={(e) => onChange(e.currentTarget.value)} />;
  }
}

export function RecordEditorPage() {
  const { t } = useTranslation(['records', 'common']);
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wide = useMediaQuery('(min-width: 75em)') ?? false;
  const typeName = useTypeName();
  const q = useQuery({ queryKey: ['record', id], queryFn: () => get<RecordDetail>(`/records/${id}`), refetchOnWindowFocus: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<string | null>('write');
  const rec = q.data;
  useEffect(() => {
    if (rec && !draft) setDraft(fromRecord(rec));
  }, [rec, draft]);

  if (q.error) return <Alert color="red">{errorText(q.error)}</Alert>;
  if (!rec || !draft) return null;
  if (!rec.permissions.edit) {
    return (
      <Alert color="orange" title={`${rec.number} ${rec.title}`}>
        {rec.frozen ? t('editor.frozen') : t('editor.notAllowed')}
      </Alert>
    );
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromRecord(rec));
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const save = async () => {
    setBusy(true);
    try {
      const fields = Object.fromEntries(Object.entries(draft.fields).filter(([, v]) => v.trim()));
      const r = await put<RecordDetail>(`/records/${rec.id}`, {
        title: draft.title,
        body: draft.body,
        fields,
        tags: draft.tags,
        comment: comment.trim() || undefined,
        baseVersion: rec.version,
      });
      qc.setQueryData(['record', id], r);
      void qc.invalidateQueries({ queryKey: ['records'] });
      void qc.invalidateQueries({ queryKey: ['record-versions', id] });
      notifyOk(t('editor.saved', { version: r.version }));
      navigate(`/records/${rec.id}`);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const cancel = () => {
    if (dirty && !confirm(t('editor.discard'))) return;
    navigate(`/records/${rec.id}`);
  };

  const editorPane = (
    <Textarea
      label={t('editor.body')}
      description={t('editor.markdownHelp')}
      autosize
      minRows={18}
      maxRows={40}
      value={draft.body}
      onChange={(e) => set({ body: e.currentTarget.value })}
      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
    />
  );
  const previewPane = (
    <Paper withBorder p="md" aria-label={t('editor.preview')} role="region">
      {draft.body.trim() ? <MarkdownView text={draft.body} /> : <Text c="dimmed">{t('detail.noBody')}</Text>}
    </Paper>
  );

  return (
    <>
      <PageHeader
        back={['records', { to: `/records/${rec.id}`, label: rec.number }]}
        title={t('editor.title', { number: rec.number })}
        description={`${typeName(rec.type, rec.typeName)} · ${t('detail.revisionVersion', { revision: rec.revision, version: rec.version })}`}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap="sm">
              <TextInput label={t('editor.recordTitle')} value={draft.title} onChange={(e) => set({ title: e.currentTarget.value })} required maxLength={300} />
              {wide ? (
                <Grid gutter="sm">
                  <Grid.Col span={6}>{editorPane}</Grid.Col>
                  <Grid.Col span={6}>
                    <Text size="sm" fw={500} mb={4}>
                      {t('editor.preview')}
                    </Text>
                    {previewPane}
                  </Grid.Col>
                </Grid>
              ) : (
                <Tabs value={tab} onChange={setTab}>
                  <Tabs.List mb="xs">
                    <Tabs.Tab value="write">{t('editor.write')}</Tabs.Tab>
                    <Tabs.Tab value="preview">{t('editor.preview')}</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="write">{editorPane}</Tabs.Panel>
                  <Tabs.Panel value="preview">{previewPane}</Tabs.Panel>
                </Tabs>
              )}
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Stack gap="sm">
              {rec.type.fields.map((f) => (
                <FieldInput key={f.key} def={f} value={draft.fields[f.key] ?? ''} onChange={(v) => set({ fields: { ...draft.fields, [f.key]: v } })} />
              ))}
              <TagsInput
                label={t('editor.tags')}
                description={t('editor.tagsHelp')}
                value={draft.tags}
                onChange={(v) => set({ tags: v })}
                maxTags={30}
                clearable
              />
              <TextInput
                label={t('editor.comment')}
                placeholder={t('editor.commentPlaceholder')}
                value={comment}
                onChange={(e) => setComment(e.currentTarget.value)}
                maxLength={4000}
              />
              <Text size="xs" c="dimmed">
                {t('editor.requiredHint')}
              </Text>
            </Stack>
          </Grid.Col>
        </Grid>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={cancel}>
            {t('common:cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={!draft.title.trim()}>
            {t('common:save')}
          </Button>
        </Group>
      </form>
    </>
  );
}
