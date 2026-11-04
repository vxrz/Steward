import { ActionIcon, Badge, Button, Checkbox, Group, Paper, Select, Stack, Table, TagsInput, Text, TextInput, VisuallyHidden } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { TABLE_COLUMN_KINDS, TABLE_LIMITS, tableRows, type RecordFieldDef, type RecordTableColumn, type TableColumnKind } from '@sm/shared';
import { fmtDay } from '../../format';
import { columnLabel, columnOptionLabel, fieldHelp, fieldLabel } from './builtin';

/**
 * Table fields of records (#208): rows with a fixed set of columns (text, choice, date), e.g. the rule lines of a
 * firewall change. The value is stored as JSON in the field like every other field value.
 */

type Row = Record<string, string>;

/** What a rule line does against the approved rules (firewall changes), shown as a badge per row. */
export type RowNote = { label: string; color: string } | null;

const cellText = (typeKey: string, def: RecordFieldDef, c: RecordTableColumn, v: string | undefined) => {
  if (!v) return '–';
  if (c.kind === 'select') return columnOptionLabel(typeKey, def.key, c, v);
  // a calendar date: midnight local time, not UTC
  if (c.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDay(new Date(`${v}T00:00:00`));
  return v;
};

/** The value of a table field (read-only). */
export function TableFieldView({
  typeKey,
  def,
  value,
  notes,
  notesLabel,
}: {
  typeKey: string;
  def: RecordFieldDef;
  value: string | undefined;
  /** One note per row (e.g. "new", "removes an approved rule") */
  notes?: RowNote[];
  notesLabel?: string;
}) {
  const { t } = useTranslation('records');
  const columns = def.columns ?? [];
  const rows = tableRows(value);
  const label = fieldLabel(typeKey, def);
  if (!rows.length)
    return (
      <Text size="sm" c="dimmed">
        {t('table.empty')}
      </Text>
    );
  return (
    <div className="table-scroll">
      <Table fz="sm" withTableBorder striped aria-label={label}>
        <Table.Thead>
          <Table.Tr>
            {columns.map((c) => (
              <Table.Th key={c.key}>{columnLabel(typeKey, def.key, c)}</Table.Th>
            ))}
            {notes && <Table.Th>{notesLabel}</Table.Th>}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>
              {columns.map((c) => (
                <Table.Td key={c.key} style={{ overflowWrap: 'anywhere' }}>
                  {cellText(typeKey, def, c, r[c.key])}
                </Table.Td>
              ))}
              {notes && (
                <Table.Td>
                  {notes[i] ? (
                    <Badge size="sm" variant="light" color={notes[i]!.color}>
                      {notes[i]!.label}
                    </Badge>
                  ) : (
                    '–'
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

/** Editing a table field: one line of inputs per row, rows added and removed. Checked on the server when saved. */
export function TableFieldInput({ typeKey, def, value, onChange }: { typeKey: string; def: RecordFieldDef; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('records');
  const columns = def.columns ?? [];
  const rows = tableRows(value);
  const label = fieldLabel(typeKey, def);
  const write = (next: Row[]) => onChange(next.length ? JSON.stringify(next) : '');
  const set = (i: number, key: string, v: string) => write(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const empty = () => Object.fromEntries(columns.map((c) => [c.key, ''])) as Row;
  return (
    <Stack gap={6} data-testid={`table-field-${def.key}`}>
      <div>
        <Text size="sm" fw={500}>
          {label}
          {def.required && (
            <Text span c="red" aria-hidden>
              {' *'}
            </Text>
          )}
        </Text>
        {fieldHelp(typeKey, def) && (
          <Text size="xs" c="dimmed">
            {fieldHelp(typeKey, def)}
          </Text>
        )}
      </div>
      {rows.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" withTableBorder aria-label={label}>
            <Table.Thead>
              <Table.Tr>
                {columns.map((c) => (
                  <Table.Th key={c.key} miw={c.kind === 'text' ? 140 : 120}>
                    {columnLabel(typeKey, def.key, c)}
                    {c.required ? ' *' : ''}
                  </Table.Th>
                ))}
                <Table.Th>
                  <VisuallyHidden>{t('table.actions')}</VisuallyHidden>
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r, i) => (
                <Table.Tr key={i}>
                  {columns.map((c) => {
                    const a11y = t('table.cell', { column: columnLabel(typeKey, def.key, c), row: i + 1 });
                    return (
                      <Table.Td key={c.key}>
                        {c.kind === 'select' ? (
                          <Select
                            size="xs"
                            aria-label={a11y}
                            data={(c.options ?? []).map((o) => ({ value: o, label: columnOptionLabel(typeKey, def.key, c, o) }))}
                            value={r[c.key] || null}
                            onChange={(v) => set(i, c.key, v ?? '')}
                            clearable={!c.required}
                            comboboxProps={{ withinPortal: true }}
                          />
                        ) : (
                          <TextInput
                            size="xs"
                            aria-label={a11y}
                            type={c.kind === 'date' ? 'date' : 'text'}
                            maxLength={TABLE_LIMITS.cell}
                            value={r[c.key] ?? ''}
                            onChange={(e) => set(i, c.key, e.currentTarget.value)}
                          />
                        )}
                      </Table.Td>
                    );
                  })}
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('table.removeRow', { n: i + 1 })}
                      onClick={() => write(rows.filter((_, j) => j !== i))}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      <Button
        size="xs"
        variant="default"
        leftSection={<IconPlus size={14} />}
        onClick={() => write([...rows, empty()])}
        disabled={rows.length >= TABLE_LIMITS.rows}
        w="fit-content"
      >
        {t('table.addRow')}
      </Button>
    </Stack>
  );
}

/** The columns of a table field (record types page). */
export function TableColumnsEditor({ columns, onChange }: { columns: RecordTableColumn[]; onChange: (c: RecordTableColumn[]) => void }) {
  const { t } = useTranslation('records');
  const update = (i: number, patch: Partial<RecordTableColumn>) => onChange(columns.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Stack gap={6} mt={6}>
      <Text size="xs" fw={600}>
        {t('table.columns')}
      </Text>
      {columns.map((c, i) => (
        <Paper key={i} withBorder p={6}>
          <Group align="flex-end" gap="xs" wrap="wrap">
            <TextInput
              size="xs"
              label={t('table.columnKey')}
              value={c.key}
              onChange={(e) => update(i, { key: e.currentTarget.value })}
              required
              className="mono"
              style={{ flex: '1 1 110px' }}
            />
            <TextInput
              size="xs"
              label={t('table.columnLabel')}
              value={c.label}
              onChange={(e) => update(i, { label: e.currentTarget.value })}
              required
              style={{ flex: '1 1 130px' }}
            />
            <Select
              size="xs"
              label={t('table.columnKind')}
              data={TABLE_COLUMN_KINDS.map((k) => ({ value: k, label: t(`table.kinds.${k}`) }))}
              value={c.kind}
              onChange={(v) => v && update(i, { kind: v as TableColumnKind })}
              allowDeselect={false}
              style={{ flex: '1 1 110px' }}
            />
            <Checkbox
              size="xs"
              label={t('types.field.required')}
              checked={!!c.required}
              onChange={(e) => update(i, { required: e.currentTarget.checked })}
              mb={6}
            />
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('table.removeColumn', { n: i + 1 })}
              onClick={() => onChange(columns.filter((_, j) => j !== i))}
              mb={2}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
          {c.kind === 'select' && (
            <TagsInput size="xs" mt={6} label={t('types.field.options')} value={c.options ?? []} onChange={(v) => update(i, { options: v })} />
          )}
        </Paper>
      ))}
      <Button
        size="xs"
        variant="default"
        leftSection={<IconPlus size={14} />}
        onClick={() => onChange([...columns, { key: '', label: '', kind: 'text' }])}
        disabled={columns.length >= TABLE_LIMITS.columns}
        w="fit-content"
      >
        {t('table.addColumn')}
      </Button>
    </Stack>
  );
}

/** A table value as text lines (comparing versions): a header line, then one line per row. */
export function tableText(typeKey: string, def: RecordFieldDef, value: string | undefined): string {
  const columns = def.columns ?? [];
  const rows = tableRows(value);
  return [
    columns.map((c) => columnLabel(typeKey, def.key, c)).join(' | '),
    ...rows.map((r) => columns.map((c) => (r[c.key] ? cellText(typeKey, def, c, r[c.key]) : '')).join(' | ')),
  ].join('\n');
}
