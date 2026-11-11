import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  FileInput,
  Group,
  Modal,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconFileImport, IconTrash } from '@tabler/icons-react';
import {
  COST_ENTRY_IMPORT_LIMITS,
  COST_IMPORT_DATE_FORMATS,
  COST_IMPORT_DECIMALS,
  ISO_4217_CODES,
  type CostEntryImportMapping,
  type CostEntryImportPreview,
  type CostEntryImports,
  type CostImportDateFormat,
  type CostImportDecimal,
  type CostPlanYear,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../../api';
import { confirmDanger } from '../confirm';
import { costKeys } from '../../queryKeys';
import { fmtDate, fmtDay } from '../../format';
import { fmtMoney } from './common';

/**
 * Import entries (CSV) of a service's cost plan (0.18.0, ADR 0030, docs/COSTS.md#importing-entries-csv): upload,
 * map the columns (the date format and the decimal separator are chosen, never guessed; the service's last mapping is
 * offered again), preview every row with its problems and duplicates, import the rows without problems in one step –
 * and the import records with "Remove import".
 */

type Field = 'date' | 'amount' | 'currency' | 'reference' | 'note' | 'planLine' | 'supplier' | 'contract' | 'target';
const FIELDS: Field[] = ['date', 'amount', 'currency', 'reference', 'note', 'planLine', 'supplier', 'contract', 'target'];

/** The header of a CSV text: its first line, split at the separator that occurs most (comma, semicolon or tab), quotes respected. */
export function csvHeader(text: string): string[] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let end = 0;
  let quoted = false;
  for (; end < s.length; end++) {
    const c = s[end]!;
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\n' || c === '\r')) break;
  }
  const line = s.slice(0, end);
  const count = (ch: string) => {
    let n = 0;
    let q = false;
    for (const c of line) {
      if (c === '"') q = !q;
      else if (!q && c === ch) n++;
    }
    return n;
  };
  const sep = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const out: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      out.push(cell.trim());
      cell = '';
    } else cell += c;
  }
  out.push(cell.trim());
  return out.filter((x, i) => x || i < out.length - 1);
}

export function EntryImportDialog({ d, onClose, onSaved }: { d: CostPlanYear; onClose: () => void; onSaved: (y: CostPlanYear) => void }) {
  const { t } = useTranslation(['costs', 'common']);
  const qc = useQueryClient();
  const imports = useQuery({
    queryKey: costKeys.entryImports(d.serviceId),
    queryFn: () => get<CostEntryImports>(`/costs/plans/${encodeURIComponent(d.serviceId)}/imports`),
  });
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [cols, setCols] = useState<Partial<Record<Field, string | null>>>({});
  const [fixedCurrency, setFixedCurrency] = useState('');
  const [dateFormat, setDateFormat] = useState<CostImportDateFormat | null>(null);
  const [decimal, setDecimal] = useState<CostImportDecimal | null>(null);
  const [preview, setPreview] = useState<CostEntryImportPreview | null>(null);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choose = async (f: File | null) => {
    setFile(f);
    setPreview(null);
    setError(null);
    if (!f) return;
    if (f.size > COST_ENTRY_IMPORT_LIMITS.bytes) {
      setError(t('entryImport.tooLarge'));
      return;
    }
    const text = await f.text();
    const h = csvHeader(text);
    setCsv(text);
    setHeader(h);
    // the service's last mapping, where this file has those columns
    const last = imports.data?.lastMapping;
    const next: Partial<Record<Field, string | null>> = {};
    for (const k of FIELDS) {
      const v = last?.[k] ?? null;
      next[k] = v && h.includes(v) ? v : null;
    }
    setCols(next);
    if (last) {
      setDateFormat(last.dateFormat);
      setDecimal(last.decimal);
      setFixedCurrency(last.fixedCurrency ?? '');
    }
  };
  const mapping = (): CostEntryImportMapping | null => {
    if (!cols.date || !cols.amount || !dateFormat || !decimal) return null;
    const fixed = fixedCurrency.trim().toUpperCase();
    if (!cols.currency && !ISO_4217_CODES.has(fixed)) return null;
    return {
      date: cols.date,
      amount: cols.amount,
      currency: cols.currency ?? null,
      fixedCurrency: cols.currency ? null : fixed,
      reference: cols.reference ?? null,
      note: cols.note ?? null,
      planLine: cols.planLine ?? null,
      supplier: cols.supplier ?? null,
      contract: cols.contract ?? null,
      target: cols.target ?? null,
      dateFormat,
      decimal,
    };
  };
  const base = `/costs/plans/${encodeURIComponent(d.serviceId)}/entries/import`;
  const runPreview = async () => {
    const m = mapping();
    if (!m) {
      setError(t('entryImport.mappingIncomplete'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await post<CostEntryImportPreview>(`${base}/preview`, { csv, fileName: file?.name ?? '', mapping: m }));
      setInclude(new Set());
    } catch (e) {
      notifyError(e, t('entryImport.previewFailed'));
    } finally {
      setBusy(false);
    }
  };
  const runImport = async () => {
    const m = mapping();
    if (!m) return;
    setBusy(true);
    try {
      const y = await post<CostPlanYear & { added: number }>(base, { csv, fileName: file?.name ?? '', mapping: m, include: [...include] });
      onSaved(y);
      void qc.invalidateQueries({ queryKey: costKeys.entryImports(d.serviceId) });
      notifyOk(t('entryImport.done', { count: y.added }));
      onClose();
    } catch (e) {
      notifyError(e, t('entryImport.failed'));
    } finally {
      setBusy(false);
    }
  };
  const colSelect = (k: Field, required = false) => (
    <Select
      key={k}
      label={t(`entryImport.fields.${k}`)}
      required={required}
      clearable={!required}
      searchable
      data={header.map((h) => ({ value: h, label: h }))}
      value={cols[k] ?? null}
      onChange={(v) => {
        setCols((c) => ({ ...c, [k]: v }));
        setPreview(null);
      }}
      data-testid={`import-col-${k}`}
    />
  );
  const ready = preview ? preview.rows.filter((r) => !r.problems.length && (!r.duplicate || include.has(r.index))).length : 0;
  return (
    <Modal opened onClose={onClose} size="xl" title={t('entryImport.title')}>
      <Stack>
        <Text size="xs" c="dimmed">
          {t('entryImport.help')}
        </Text>
        <FileInput
          label={t('entryImport.file')}
          description={t('entryImport.fileHint')}
          accept=".csv,text/csv,text/plain"
          value={file}
          onChange={(f) => void choose(f)}
          clearable
          clearButtonProps={{ 'aria-label': t('entryImport.clearFile') }}
          data-testid="import-file"
        />
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        {header.length > 0 && (
          <>
            <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }}>
              {colSelect('date', true)}
              <Select
                label={t('entryImport.dateFormat')}
                description={t('entryImport.dateFormatHint')}
                required
                data={COST_IMPORT_DATE_FORMATS.map((f) => ({ value: f, label: f }))}
                value={dateFormat}
                onChange={(v) => {
                  setDateFormat(v as CostImportDateFormat | null);
                  setPreview(null);
                }}
                data-testid="import-date-format"
              />
              {colSelect('amount', true)}
              <Select
                label={t('entryImport.decimal')}
                description={t('entryImport.decimalHint')}
                required
                data={COST_IMPORT_DECIMALS.map((x) => ({ value: x, label: t(`entryImport.decimals.${x === '.' ? 'point' : 'comma'}`) }))}
                value={decimal}
                onChange={(v) => {
                  setDecimal(v as CostImportDecimal | null);
                  setPreview(null);
                }}
                data-testid="import-decimal"
              />
              {colSelect('currency')}
              {!cols.currency && (
                <Select
                  label={t('entryImport.fixedCurrency')}
                  searchable
                  data={[...new Set([...d.currencies.map((c) => c.currency), 'EUR', 'USD', 'GBP', 'CHF', 'JPY'])]}
                  value={fixedCurrency || null}
                  onChange={(v) => {
                    setFixedCurrency(v ?? '');
                    setPreview(null);
                  }}
                  data-testid="import-fixed-currency"
                />
              )}
              {colSelect('reference')}
              {colSelect('note')}
              {colSelect('planLine')}
              {colSelect('supplier')}
              {colSelect('contract')}
              {colSelect('target')}
            </SimpleGrid>
            <Group>
              <Button variant="default" onClick={() => void runPreview()} loading={busy && !preview} data-testid="import-preview">
                {t('entryImport.preview')}
              </Button>
            </Group>
          </>
        )}
        {preview && (
          <Stack gap="xs" data-testid="import-preview-rows">
            {preview.sameFile && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="import-same-file">
                {t('entryImport.sameFile', { name: preview.sameFile.fileName || '–', date: fmtDate(preview.sameFile.createdAt) })}
              </Alert>
            )}
            <Text size="sm">
              {t('entryImport.counts', {
                rows: preview.counts.rows,
                ready: preview.counts.ready,
                problems: preview.counts.problems,
                duplicates: preview.counts.duplicates,
              })}
            </Text>
            <ScrollArea.Autosize mah={360} type="auto">
              <Table fz="xs" striped withTableBorder stickyHeader>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('entryImport.columns.line')}</Table.Th>
                    <Table.Th>{t('plan.entry.date')}</Table.Th>
                    <Table.Th ta="right">{t('plan.entry.amount')}</Table.Th>
                    <Table.Th>{t('entryImport.columns.becomes')}</Table.Th>
                    <Table.Th>{t('plan.entry.reference')}</Table.Th>
                    <Table.Th>{t('entryImport.columns.problems')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.rows.map((r) => (
                    <Table.Tr key={r.index} data-testid="import-row">
                      <Table.Td>{r.line}</Table.Td>
                      <Table.Td>{r.date ? fmtDay(r.date) : '–'}</Table.Td>
                      <Table.Td ta="right" className="viz-num">
                        {r.amount && r.currency ? fmtMoney(r.amount, r.currency) : (r.amount ?? '–')}
                      </Table.Td>
                      <Table.Td>
                        {r.label ?? '–'}
                        {' · '}
                        {r.planLine ? r.planLine.title : t('plan.entry.unplanned')}
                        {r.supplier && ` · ${r.supplier.name}${r.contract ? ` – ${r.contract.title}` : ''}`}
                      </Table.Td>
                      <Table.Td>
                        {r.reference || (
                          <Text span size="xs" c="dimmed">
                            {t('entryImport.noReference')}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="wrap">
                          {r.problems.map((p) => (
                            <Badge key={p} size="xs" color="red" variant="light" data-testid="import-problem">
                              {t(`entryImport.problems.${p}`)}
                            </Badge>
                          ))}
                          {r.duplicate && (
                            <Checkbox
                              size="xs"
                              label={t('entryImport.duplicate')}
                              checked={include.has(r.index)}
                              onChange={(e) => {
                                const next = new Set(include);
                                if (e.currentTarget.checked) next.add(r.index);
                                else next.delete(r.index);
                                setInclude(next);
                              }}
                              data-testid="import-duplicate"
                            />
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void runImport()} loading={busy && !!preview} disabled={!preview || !ready} data-testid="import-run">
            {t('entryImport.import', { count: ready })}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The service's import records: file, rows, entries still there, and "Remove import". */
export function EntryImports({ serviceId, onChanged }: { serviceId: string; onChanged: () => void }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: costKeys.entryImports(serviceId),
    queryFn: () => get<CostEntryImports>(`/costs/plans/${encodeURIComponent(serviceId)}/imports`),
  });
  const list = q.data;
  if (!list?.imports.length) return null;
  const remove = async (id: string, name: string, entries: number) => {
    if (!(await confirmDanger({ action: 'remove', message: t('entryImport.removeConfirm', { name: name || '–', count: entries }) }))) return;
    try {
      qc.setQueryData(
        costKeys.entryImports(serviceId),
        await del<CostEntryImports>(`/costs/plans/${encodeURIComponent(serviceId)}/imports/${encodeURIComponent(id)}`),
      );
      onChanged();
      notifyOk(t('entryImport.removed'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap={4} data-testid="entry-imports">
      <Group gap="xs">
        <IconFileImport size={16} aria-hidden />
        <Text size="sm" fw={600}>
          {t('entryImport.records')}
        </Text>
      </Group>
      {list.imports.slice(0, 10).map((r) => (
        <Group key={r.id} justify="space-between" wrap="nowrap" gap="xs" data-testid="entry-import">
          <Text size="xs" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {t('entryImport.record', { name: r.fileName || '–', date: fmtDate(r.createdAt), by: r.createdBy, added: r.added, rows: r.rows })}
            {r.removedAt ? ` · ${t('entryImport.recordRemoved', { date: fmtDate(r.removedAt) })}` : ''}
          </Text>
          {list.canEdit && !r.removedAt && (
            <Tooltip label={t('entryImport.remove')} withArrow>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t('entryImport.remove')}
                onClick={() => void remove(r.id, r.fileName, r.entries)}
                data-testid="entry-import-remove"
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      ))}
    </Stack>
  );
}
