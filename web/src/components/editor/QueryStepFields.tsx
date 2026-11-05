import { useMemo } from 'react';
import { ActionIcon, Alert, Box, Button, Group, SegmentedControl, Stack, Table, Text, Textarea, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DB_DIALECTS, DB_DIALECT_INFO, readOnlyStatementProblem, type DbDialect, type FlowNode } from '@sm/shared';
import { ExpressionInput } from './ExpressionInput';
import type { LocalizedField } from '../../i18n/meta';

/**
 * Fields of "Query a database" (0.7.0, docs/DATABASES.md): catalog query or SQL, the statement with the read-only check
 * of the server (the same code), its parameters as templates, and a table view of a query result for the "Last run"
 * panel.
 */

function Label({ field }: { field: LocalizedField }) {
  return (
    <>
      {field.label}
      {field.required && <span style={{ color: 'var(--mantine-color-red-filled)' }}> *</span>}
    </>
  );
}

type QueryNode = Extract<FlowNode, { type: 'query' }>;

/** Catalog query or own SQL: switching clears the other (a step has exactly one). */
export function QueryModeSection({ node, onChange }: { node: QueryNode; onChange: (patch: Partial<QueryNode>) => void }) {
  const { t } = useTranslation('editor');
  const mode = node.sql !== undefined ? 'sql' : 'catalog';
  return (
    <Box>
      <Text size="sm" fw={500} mb={4} id={`query-mode-${node.id}`}>
        {t('query.mode')}
      </Text>
      <SegmentedControl
        aria-labelledby={`query-mode-${node.id}`}
        fullWidth
        size="xs"
        value={mode}
        data={[
          { value: 'catalog', label: t('query.modes.catalog') },
          { value: 'sql', label: t('query.modes.sql') },
        ]}
        onChange={(v) =>
          v === 'sql'
            ? onChange({ catalog: undefined, sql: node.sql ?? 'SELECT 1' })
            : onChange({ sql: undefined, params: undefined, dialect: undefined, catalog: node.catalog ?? 'status' })
        }
        data-testid="query-mode"
      />
      <Text size="xs" c="dimmed" mt={4}>
        {mode === 'catalog' ? t('query.catalogHint') : t('query.sqlHint')}
      </Text>
    </Box>
  );
}

/** Why the statement is refused: for the DBMS the step names, else for every DBMS (the run checks the platform's). */
function statementProblem(sql: string, dialect: DbDialect | undefined, params: number) {
  const list = dialect ? [dialect] : [...DB_DIALECTS];
  const problems = list.map((d) => ({ d, p: readOnlyStatementProblem(sql, d, params) }));
  const refused = problems.filter((x) => x.p);
  if (!refused.length) return null;
  return { all: refused.length === problems.length, first: refused[0]!, dialects: refused.map((x) => x.d) };
}

export function SqlField({
  field,
  value,
  onChange,
  node,
}: {
  field: LocalizedField;
  value: unknown;
  onChange: (v: unknown) => void;
  node: Partial<QueryNode>;
}) {
  const { t } = useTranslation('editor');
  const sql = typeof value === 'string' ? value : '';
  const problem = useMemo(() => (sql.trim() ? statementProblem(sql, node.dialect, node.params?.length ?? 0) : null), [sql, node.dialect, node.params?.length]);
  const placeholders = node.dialect
    ? DB_DIALECT_INFO[node.dialect].placeholder(1)
    : DB_DIALECTS.map((d) => `${DB_DIALECT_INFO[d].placeholder(1)} (${DB_DIALECT_INFO[d].label})`).join(', ');
  return (
    <Stack gap={4}>
      <Textarea
        label={<Label field={field} />}
        description={field.help}
        placeholder={field.placeholder}
        autosize
        minRows={4}
        maxRows={18}
        spellCheck={false}
        classNames={{ input: 'mono' }}
        value={sql}
        onChange={(e) => onChange(e.currentTarget.value)}
        error={problem?.all ? problem.first.p!.message : undefined}
        data-testid="query-sql"
      />
      {problem && !problem.all && (
        <Alert color="yellow" variant="light" p="xs" icon={<IconAlertTriangle size={14} />}>
          <Text size="xs">
            {t('query.refusedFor', { dbms: problem.dialects.map((d) => DB_DIALECT_INFO[d].label).join(', '), reason: problem.first.p!.message })}
          </Text>
        </Alert>
      )}
      <Text size="xs" c="dimmed">
        {t('query.placeholders', { placeholders })}
      </Text>
    </Stack>
  );
}

export function SqlParamsField({ field, value, onChange }: { field: LocalizedField; value: unknown; onChange: (v: unknown) => void }) {
  const { t } = useTranslation('editor');
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  const setAt = (i: number, v: unknown) => {
    const next = [...list];
    next[i] = v;
    onChange(next);
  };
  return (
    <Box>
      <Text size="sm" fw={500} mb={2}>
        <Label field={field} />
      </Text>
      {field.help && (
        <Text size="xs" c="dimmed" mb={4}>
          {field.help}
        </Text>
      )}
      <Stack gap={6}>
        {list.map((v, i) => (
          <Group key={i} gap={6} wrap="nowrap" align="flex-start">
            <Text size="xs" c="dimmed" className="mono" pt={8} w={28} ta="right" style={{ flexShrink: 0 }}>
              {i + 1}
            </Text>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <ExpressionInput
                template
                aria-label={t('query.paramLabel', { n: i + 1 })}
                value={typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)}
                onChange={(s) => setAt(i, s)}
              />
            </Box>
            <Tooltip label={t('query.removeParam')}>
              <ActionIcon
                variant="subtle"
                color="red"
                mt={4}
                aria-label={t('query.removeParamNamed', { n: i + 1 })}
                onClick={() => {
                  const next = list.filter((_, j) => j !== i);
                  onChange(next.length ? next : undefined);
                }}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => onChange([...list, ''])} data-testid="query-add-param">
            {t('query.addParam')}
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}

/** A query step's output: { columns, rows, rowCount, truncated }. */
export function isQueryResult(v: unknown): v is { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated?: boolean } {
  const o = v as { columns?: unknown; rows?: unknown } | null;
  return !!o && typeof o === 'object' && Array.isArray(o.columns) && Array.isArray(o.rows);
}

const cellText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The first rows of a query result as a table (Last run panel). */
export function QueryResultTable({
  value,
  max = 10,
}: {
  value: { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated?: boolean };
  max?: number;
}) {
  const { t } = useTranslation('editor');
  const cols = value.columns.slice(0, 12);
  const rows = value.rows.slice(0, max);
  return (
    <Box data-testid="query-result-preview">
      <Text size="xs" c="dimmed" mb={4}>
        {t('query.previewLine', { shown: rows.length, count: value.rowCount })}
        {value.truncated ? ` · ${t('query.truncated')}` : ''}
        {value.columns.length > cols.length ? ` · ${t('query.moreColumns', { count: value.columns.length - cols.length })}` : ''}
      </Text>
      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={200} maxHeight={260}>
          <Table striped withTableBorder fz="xs" verticalSpacing={2} horizontalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                {cols.map((c) => (
                  <Table.Th key={c} className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {c}
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r, i) => (
                <Table.Tr key={i}>
                  {cols.map((c) => (
                    <Table.Td key={c} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cellText(r[c])}>
                      {cellText(r[c])}
                    </Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Box>
  );
}
