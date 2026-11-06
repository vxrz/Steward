import { useState } from 'react';
import { Alert, Badge, Button, Divider, FileButton, Group, List, Modal, NumberInput, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconDeviceFloppy, IconFileImport, IconFileText } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DB_SCHEMA_LIMITS, dbSchemaPushPath, type DbSchemaImportPreview, type DbSchemaSettings } from '@sm/shared';
import { notifyError, notifyOk, post, put } from '../../api';
import { fmtNumber } from '../../format';
import { CopyBlock, origin } from '../monitors/dialogs';
import type { SchemaSubject } from './SchemaView';

/** The tbls import (with its preview and the CI commands) and the settings of a schema (#222). */

const MB = 1024 * 1024;

export function ciCommands(s: SchemaSubject): { plain: string; lint: string } {
  const url = `${origin()}${dbSchemaPushPath(s.kind, s.id)}`;
  return {
    plain: `tbls out -t json -o schema.json\ncurl -sS -f -X POST '${url}' \\\n  -H "Authorization: Bearer $STEWARD_PUSH_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  --data-binary @schema.json`,
    lint: `tbls lint > lint.txt || true\njq -n --rawfile schema schema.json --rawfile lint lint.txt '{schema: $schema, lint: $lint, fileName: "schema.json"}' |\n  curl -sS -f -X POST '${url}' \\\n    -H "Authorization: Bearer $STEWARD_PUSH_TOKEN" \\\n    -H 'Content-Type: application/json' \\\n    --data-binary @-`,
  };
}

function FileChooser({
  label,
  accept,
  file,
  onFile,
  testId,
}: {
  label: string;
  accept: string;
  file: { name: string } | null;
  onFile: (f: File) => void;
  testId: string;
}) {
  const { t } = useTranslation('platforms');
  return (
    <Group gap="sm" wrap="wrap">
      <FileButton accept={accept} onChange={(f) => f && onFile(f)}>
        {(props) => (
          <Button {...props} variant="default" size="xs" leftSection={<IconFileImport size={14} />} data-testid={testId}>
            {label}
          </Button>
        )}
      </FileButton>
      <Text size="sm" c={file ? undefined : 'dimmed'} style={{ wordBreak: 'break-all' }}>
        {file ? file.name : t('schema.noFile')}
      </Text>
    </Group>
  );
}

export function ImportModal({ subject, onClose, onImported }: { subject: SchemaSubject; onClose: () => void; onImported: () => void | Promise<void> }) {
  const { t } = useTranslation(['platforms', 'common']);
  const [schema, setSchema] = useState<{ name: string; text: string } | null>(null);
  const [lint, setLint] = useState<{ name: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [preview, setPreview] = useState<DbSchemaImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const cmds = ciCommands(subject);
  const read = (f: File, max: number, set: (x: { name: string; text: string }) => void) => {
    setPreview(null);
    if (f.size > max) {
      setProblem(t('schema.fileTooLarge', { name: f.name, mb: max / MB }));
      return;
    }
    setProblem(null);
    void f.text().then((text) => set({ name: f.name, text }));
  };
  const body = () => ({ schema: schema!.text, ...(lint ? { lint: lint.text } : {}), fileName: schema!.name });
  const show = async () => {
    if (!schema) return;
    setBusy(true);
    try {
      setPreview(await post<DbSchemaImportPreview>(`/db-schemas/${subject.kind}/${subject.id}/import/preview`, body()));
    } catch (e) {
      notifyError(e, t('schema.importFailed'));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!schema) return;
    setBusy(true);
    try {
      const r = await post<{ created: boolean }>(`/db-schemas/${subject.kind}/${subject.id}/import`, body());
      notifyOk(r.created ? t('schema.imported') : t('schema.importedUnchanged'));
      await onImported();
    } catch (e) {
      notifyError(e, t('schema.importFailed'));
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} size="lg" title={t('schema.importTitle', { name: subject.name })}>
      <Stack gap="sm" data-testid="schema-import-modal">
        <Text size="sm" c="dimmed">
          {t('schema.importHelp')}
        </Text>
        <FileChooser
          label={t('schema.chooseSchema')}
          accept=".json,application/json"
          file={schema}
          onFile={(f) => read(f, DB_SCHEMA_LIMITS.importBytes, setSchema)}
          testId="schema-choose-file"
        />
        <FileChooser
          label={t('schema.chooseLint')}
          accept=".txt,.json,.log,text/plain,application/json"
          file={lint}
          onFile={(f) => read(f, DB_SCHEMA_LIMITS.lintBytes, setLint)}
          testId="schema-choose-lint"
        />
        <Text size="xs" c="dimmed">
          {t('schema.lintHint')}
        </Text>
        {problem && (
          <Alert color="red" variant="light" p="xs">
            {problem}
          </Alert>
        )}
        {preview && (
          <Alert
            color={preview.diff && preview.diff.breaking > 0 ? 'orange' : 'blue'}
            variant="light"
            data-testid="schema-import-preview"
            icon={preview.diff?.breaking ? <IconAlertTriangle size={16} /> : <IconFileText size={16} />}
          >
            <Stack gap={4}>
              <Text size="sm">
                {[
                  t('schema.tableCount', { count: preview.tables, n: fmtNumber(preview.tables) }),
                  t('schema.columnCount', { count: preview.columns, n: fmtNumber(preview.columns) }),
                  t('schema.lintCount', { count: preview.checks, n: fmtNumber(preview.checks) }),
                ].join(', ')}
              </Text>
              <Text size="sm">
                {preview.unchanged
                  ? t('schema.previewUnchanged')
                  : preview.diff
                    ? t('schema.previewChanges', { count: preview.diff.total, breaking: preview.diff.breaking })
                    : t('schema.previewFirst')}
              </Text>
              {preview.warnings.length > 0 && (
                <List size="xs">
                  {preview.warnings.map((w) => (
                    <List.Item key={w}>{w}</List.Item>
                  ))}
                </List>
              )}
              <Text size="xs" c="dimmed" className="mono" style={{ wordBreak: 'break-all' }}>
                SHA-256 {preview.sha256}
              </Text>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {!preview ? (
            <Button onClick={() => void show()} loading={busy} disabled={!schema} data-testid="schema-preview">
              {t('schema.preview')}
            </Button>
          ) : (
            <Button onClick={() => void apply()} loading={busy} leftSection={<IconFileImport size={14} />} data-testid="schema-apply">
              {t('schema.import')}
            </Button>
          )}
        </Group>
        <Divider label={t('schema.fromCi')} labelPosition="left" />
        <Text size="sm" c="dimmed">
          {t('schema.fromCiHelp')}
        </Text>
        <CopyBlock label={t('schema.ciPlain')} text={cmds.plain} />
        <CopyBlock label={t('schema.ciLint')} text={cmds.lint} />
      </Stack>
    </Modal>
  );
}

export function SettingsModal({
  subject,
  settings,
  onClose,
  onSaved,
}: {
  subject: SchemaSubject;
  settings: DbSchemaSettings;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const [retention, setRetention] = useState<number>(settings.retention);
  const [hours, setHours] = useState<number>(settings.readIntervalHours);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/db-schemas/${subject.kind}/${subject.id}/settings`, { retention, readIntervalHours: subject.kind === 'platform' ? hours : 0 });
      notifyOk(t('schema.settingsSaved'));
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e, t('schema.settingsNotSaved'));
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('schema.settingsTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="schema-settings-modal">
          <NumberInput
            label={t('schema.retention')}
            description={t('schema.retentionHint', { max: DB_SCHEMA_LIMITS.retention.max })}
            min={1}
            max={DB_SCHEMA_LIMITS.retention.max}
            value={retention}
            onChange={(v) => setRetention(typeof v === 'number' ? v : settings.retention)}
            data-autofocus
          />
          {subject.kind === 'platform' && (
            <NumberInput
              label={t('schema.interval')}
              description={t('schema.intervalHint')}
              min={0}
              max={DB_SCHEMA_LIMITS.readIntervalHours.max}
              value={hours}
              onChange={(v) => setHours(typeof v === 'number' ? v : 0)}
              rightSection={
                <Badge size="xs" variant="transparent">
                  h
                </Badge>
              }
            />
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} leftSection={<IconDeviceFloppy size={14} />}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
