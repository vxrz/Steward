import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconHistory, IconPlus, IconShieldLock, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import YAML from 'yaml';
import { PLANT_ID_KINDS, PLANT_ID_RULE_TYPES, type PlantIdKind, type PlantIdMapInput, type PlantIdRuleType, type PlantImportPreview } from '@sm/shared';
import { useCountsText, useProblemText } from './ids';

/**
 * The import's optional id mapping step and what its preview adds (0.11.0, docs/PLANT.md#changing-ids): old → new ids
 * pasted or loaded from a CSV or YAML file, rules, "Remove entries that are not in the files" with "Also remove what
 * belongs to it"; the preview lists renames, old ids found in the files and removals apart from the other changes.
 */

export interface IdOptions {
  text: string;
  rules: { type: PlantIdRuleType; from: string; to: string; kinds: PlantIdKind[] }[];
  removeMissing: boolean;
  cascade: boolean;
}
export const NO_ID_OPTIONS: IdOptions = { text: '', rules: [], removeMissing: false, cascade: false };

type Entry = PlantIdMapInput['entries'][number];
const KIND_SET = new Set<string>(PLANT_ID_KINDS);

/** The old → new ids of a pasted text: CSV lines `kind,old,new` or `old,new` (a header line is skipped), or YAML. */
export function parseIdMap(text: string): { entries: Entry[]; errors: { line: number; text: string }[] } {
  const entries: Entry[] = [];
  const errors: { line: number; text: string }[] = [];
  const trimmed = text.trim();
  if (!trimmed) return { entries, errors };
  if (/^-\s|^\[|^\{/.test(trimmed) || /^\s*(kind|old)\s*:/m.test(trimmed)) {
    try {
      const doc: unknown = YAML.parse(trimmed);
      const list = Array.isArray(doc)
        ? doc
        : doc && typeof doc === 'object' && Array.isArray((doc as { entries?: unknown }).entries)
          ? (doc as { entries: unknown[] }).entries
          : [];
      list.forEach((x, i) => {
        const o = (x ?? {}) as Record<string, unknown>;
        const kind = typeof o.kind === 'string' && KIND_SET.has(o.kind) ? (o.kind as PlantIdKind) : null;
        if (typeof o.old === 'string' && typeof o.new === 'string' && (o.kind === undefined || kind))
          entries.push({ kind, old: o.old.trim(), new: o.new.trim() });
        else errors.push({ line: i + 1, text: JSON.stringify(x) });
      });
      return { entries, errors };
    } catch {
      // not YAML after all: read as CSV
    }
  }
  trimmed.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (i === 0 && cells.some((c) => /^(kind|old|new)$/i.test(c))) return;
    if (cells.length === 2 && cells[0] && cells[1]) entries.push({ kind: null, old: cells[0], new: cells[1] });
    else if (cells.length === 3 && KIND_SET.has(cells[0]!) && cells[1] && cells[2])
      entries.push({ kind: cells[0] as PlantIdKind, old: cells[1], new: cells[2] });
    else errors.push({ line: i + 1, text: line });
  });
  return { entries, errors };
}

/** The import body's part of these options. */
export function idOptionsBody(o: IdOptions): { idMap?: PlantIdMapInput; removeMissing: boolean; cascade: boolean } {
  const { entries } = parseIdMap(o.text);
  const rules = o.rules.filter((r) => r.type === 'lowerCase' || r.to || r.from);
  return {
    ...(entries.length || rules.length ? { idMap: { entries, rules } } : {}),
    removeMissing: o.removeMissing,
    cascade: o.cascade,
  };
}

export function IdMappingStep({ value, onChange }: { value: IdOptions; onChange: (v: IdOptions) => void }) {
  const { t } = useTranslation(['plantIds', 'common']);
  // optional: folded until someone wants it (or it holds something)
  const used = !!value.text || value.rules.length > 0 || value.removeMissing || value.cascade;
  const [open, setOpen] = useState(used);
  const parsed = parseIdMap(value.text);
  const kinds = PLANT_ID_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }));
  const setRule = (i: number, patch: Partial<IdOptions['rules'][number]>) =>
    onChange({ ...value, rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const load = async (f: File | null) => {
    if (f) onChange({ ...value, text: await f.text() });
  };
  return (
    <Paper withBorder p="md" data-testid="import-id-mapping">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Title order={2} fz="h4">
            {t('mapping.title')}
          </Title>
          <Button
            size="xs"
            variant="subtle"
            aria-expanded={open || used}
            aria-controls="import-id-mapping-body"
            onClick={() => setOpen(!(open || used))}
            disabled={used}
            data-testid="import-id-mapping-toggle"
          >
            {open || used ? t('mapping.hide') : t('mapping.show')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {t('mapping.help')}
        </Text>
        {(open || used) && (
          <Stack gap="sm" id="import-id-mapping-body">
            <Textarea
              label={t('mapping.paste')}
              description={t('mapping.pasteHelp')}
              autosize
              minRows={3}
              maxRows={12}
              value={value.text}
              onChange={(e) => onChange({ ...value, text: e.currentTarget.value })}
              classNames={{ input: 'mono' }}
              // i18n-ignore: example ids, the same in every language
              placeholder={'asset,rvs-mill-01,rvs-mc-01\nhlc-im-01,hlc-moulding-01'}
              data-testid="import-id-map"
            />
            <Group gap="sm">
              <FileButton onChange={(f) => void load(f)} accept=".csv,.txt,.yaml,.yml,text/csv,text/plain,application/yaml">
                {(props) => (
                  <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} {...props}>
                    {t('mapping.upload')}
                  </Button>
                )}
              </FileButton>
              {parsed.entries.length > 0 && (
                <Text size="xs" c="dimmed" aria-live="polite" data-testid="import-id-map-count">
                  {t('mapping.parsed', { count: parsed.entries.length })}
                </Text>
              )}
            </Group>
            {parsed.errors.slice(0, 5).map((e) => (
              <Text key={e.line} size="xs" c="red">
                {t('mapping.parseError', { line: e.line, text: e.text })}
              </Text>
            ))}
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                {t('mapping.rules')}
              </Text>
              <Text size="xs" c="dimmed">
                {t('mapping.rulesHelp')}
              </Text>
              {value.rules.map((r, i) => (
                <Group key={i} gap="xs" align="flex-end" wrap="wrap" data-testid={`import-id-rule-${i}`}>
                  <Select
                    size="xs"
                    label={t('mapping.ruleType')}
                    data={PLANT_ID_RULE_TYPES.map((x) => ({ value: x, label: t(`mapping.types.${x}`) }))}
                    value={r.type}
                    onChange={(v) => v && setRule(i, { type: v as PlantIdRuleType })}
                    allowDeselect={false}
                    w={{ base: '100%', xs: 170 }}
                  />
                  {r.type === 'replacePrefix' && (
                    <TextInput
                      size="xs"
                      label={t('mapping.from')}
                      value={r.from}
                      onChange={(e) => setRule(i, { from: e.currentTarget.value })}
                      w={{ base: '100%', xs: 130 }}
                    />
                  )}
                  {r.type !== 'lowerCase' && (
                    <TextInput
                      size="xs"
                      label={r.type === 'replacePrefix' ? t('mapping.to') : t('mapping.text')}
                      value={r.to}
                      onChange={(e) => setRule(i, { to: e.currentTarget.value })}
                      w={{ base: '100%', xs: 130 }}
                    />
                  )}
                  <MultiSelect
                    size="xs"
                    label={t('mapping.kinds')}
                    data={kinds}
                    value={r.kinds}
                    onChange={(v) => setRule(i, { kinds: v as PlantIdKind[] })}
                    clearable
                    w={{ base: '100%', xs: 260 }}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('mapping.removeRule')}
                    onClick={() => onChange({ ...value, rules: value.rules.filter((_, j) => j !== i) })}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              ))}
              <Group>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => onChange({ ...value, rules: [...value.rules, { type: 'replacePrefix', from: '', to: '', kinds: [] }] })}
                  data-testid="import-id-add-rule"
                >
                  {t('mapping.addRule')}
                </Button>
              </Group>
            </Stack>
            <Stack gap={6}>
              <Text size="sm" fw={600}>
                {t('removal.title')}
              </Text>
              <Checkbox
                label={t('removal.removeMissing')}
                description={t('removal.removeMissingHelp')}
                checked={value.removeMissing}
                onChange={(e) => onChange({ ...value, removeMissing: e.currentTarget.checked })}
                data-testid="import-remove-missing"
              />
              <Checkbox
                label={t('removal.cascade')}
                description={t('removal.cascadeHelp')}
                checked={value.cascade}
                onChange={(e) => onChange({ ...value, cascade: e.currentTarget.checked })}
                data-testid="import-cascade"
              />
            </Stack>
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/** What the preview says about renames, old ids in the files and removals. */
export function ImportIdsPreview({ preview }: { preview: PlantImportPreview }) {
  const { t } = useTranslation('plantIds');
  const countsText = useCountsText();
  const problemText = useProblemText();
  const removals = preview.removals?.items ?? [];
  return (
    <>
      {preview.stepUp && preview.ok && (
        <Alert color="blue" variant="light" icon={<IconShieldLock size={16} />} p="xs">
          <Text size="sm">{t('preview.stepUp')}</Text>
        </Alert>
      )}
      {preview.renames.length > 0 && (
        <Stack gap={4} data-testid="import-renames">
          <Title order={3} fz="sm">
            {t('preview.renames', { count: preview.renames.length })}
          </Title>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('preview.renames', { count: preview.renames.length })}>
            <Table fz="sm" aria-label={t('preview.renames', { count: preview.renames.length })}>
              <Table.Tbody>
                {preview.renames.slice(0, 300).map((r) => (
                  <Table.Tr key={`${r.kind}|${r.scope}|${r.id}`}>
                    <Table.Td className="nowrap">{t(`kinds.${r.kind}`)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.name}</Text>
                      <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {r.scope ? `${r.scope} / ` : ''}
                        {t('preview.rename', { from: r.id, to: r.newId })}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {countsText(r.references)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        </Stack>
      )}
      {preview.aliasUses.length > 0 && (
        <Alert
          color="blue"
          variant="light"
          icon={<IconHistory size={16} />}
          title={t('preview.aliases', { count: preview.aliasUses.length })}
          data-testid="import-alias-uses"
        >
          <Text size="xs" mb={4}>
            {t('preview.aliasesHelp')}
          </Text>
          <Stack gap={2}>
            {preview.aliasUses.slice(0, 50).map((a) => (
              <Text key={`${a.kind}|${a.scope}|${a.oldId}`} size="xs" className="mono">
                {t(`kinds.${a.kind}`)}: {t('preview.rename', { from: a.oldId, to: a.newId })}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      {removals.length > 0 && (
        <Stack gap={4} data-testid="import-removals">
          <Title order={3} fz="sm">
            {t('preview.removals', { count: removals.filter((r) => !r.refused).length })}
          </Title>
          <div className="table-scroll" tabIndex={0} role="region" aria-label={t('removal.title')}>
            <Table fz="sm" aria-label={t('removal.title')}>
              <Table.Tbody>
                {removals.slice(0, 300).map((r) => (
                  <Table.Tr key={`${r.kind}|${r.scope}|${r.id}`}>
                    <Table.Td>
                      <Badge size="sm" color={!r.refused ? 'red' : r.refused.code === 'PLANT_ENTRY_NOT_FOUND' ? 'gray' : 'orange'} variant="light">
                        {!r.refused ? t('bulk.outcome.removed') : r.refused.code === 'PLANT_ENTRY_NOT_FOUND' ? t('bulk.outcome.skipped') : t('preview.refused')}
                      </Badge>
                    </Table.Td>
                    <Table.Td className="nowrap">{t(`kinds.${r.kind}`)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.name}</Text>
                      <Text size="xs" c="dimmed" className="mono">
                        {r.scope ? `${r.scope} / ` : ''}
                        {r.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {r.with.length > 0 && <Text size="xs">{t('bulk.with', { list: countsText(r.with) })}</Text>}
                      {r.refused && (
                        <Text size="xs" c="orange.8">
                          {problemText(r.refused)}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        </Stack>
      )}
    </>
  );
}
