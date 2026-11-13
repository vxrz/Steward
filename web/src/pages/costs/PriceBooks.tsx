import { useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  FileButton,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconArrowLeft, IconBook, IconCheck, IconFileImport, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  COST_DERIVATION_KINDS,
  COST_DRIVER_SUGGESTIONS,
  COST_PRICE_CHARGES,
  COST_PRICE_CSV_FIELDS,
  ISO_4217_CODES,
  type CostConditionInput,
  type CostFxRate,
  type CostPriceBookKind,
  type CostPriceBook,
  type CostPriceBookDetail,
  type CostPriceCsvField,
  type CostPriceDiff,
  type CostPriceDiffItem,
  type CostPriceEntry,
  type CostPriceImportPreview,
  type CostPriceVersion,
  type Platform,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { EmptyState, QueryState } from '../../components/common';
import { ListPage } from '../../components/page/ListPage';
import { DetailPage } from '../../components/page/DetailPage';
import { ServiceTabs } from '../../components/page/LinkTabs';
import { DataTable, type DataColumn } from '../../components/DataTable';
import { OwningTeams } from '../../components/OwningTeams';
import { confirmDialog } from '../../components/confirm';
import { estimateKeys } from '../../components/costs/Estimates';
import { fmtChange } from '../../components/costs/common';
import { fmtDay, localToday } from '../../format';
import { platformKeys } from '../../queryKeys';
import { AccessTab } from '../../components/access/AccessTab';
import { ConditionsDialog, conditionText } from '../../components/costs/ContractPrices';
import { useSupplierOptions } from '../../components/suppliers/SupplierPicker';
import '../../components/dashboard/viz.css';

/**
 * Price books (0.21.0, ADR 0035 parts 1 and 2, docs/PRICE-BOOKS.md): the books the reader may see, one book's items with
 * its versions and What changed, a new version by hand or from a CSV file (mapping and preview), Mark as checked, and
 * the manual exchange rates of estimates.
 */

const CURRENCIES = [...ISO_4217_CODES].sort();
const unitLabel = (u: string) => u.replace(/[{}]/g, '');
const bookPath = (id: string) => `/costs/price-books/${encodeURIComponent(id)}`;

export function PriceBooksPage() {
  const { t } = useTranslation('costs');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: estimateKeys.books, queryFn: () => get<CostPriceBook[]>('/costs/price-books') });
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((b) => !needle || [b.name, b.provider].some((x) => x.toLowerCase().includes(needle)));
  const columns: DataColumn<CostPriceBook>[] = [
    {
      key: 'name',
      header: t('prices.columns.name'),
      cell: (b) => (
        <Anchor component={Link} to={bookPath(b.id)} size="sm" fw={500}>
          {b.name}
        </Anchor>
      ),
      sortValue: (b) => b.name,
    },
    { key: 'provider', header: t('prices.columns.provider'), cell: (b) => b.provider, sortValue: (b) => b.provider },
    { key: 'kind', header: t('prices.columns.kind'), cell: (b) => <KindBadge book={b} />, sortValue: (b) => b.kind },
    { key: 'currency', header: t('prices.columns.currency'), cell: (b) => b.currency, nowrap: true },
    { key: 'version', header: t('prices.columns.version'), cell: (b) => (b.version ? `v${b.version}` : '–'), nowrap: true },
    { key: 'entries', header: t('prices.columns.entries'), cell: (b) => b.entries, sortValue: (b) => b.entries, nowrap: true },
    { key: 'checked', header: t('prices.columns.checked'), cell: (b) => <CheckedText book={b} />, sortValue: (b) => b.checkedAt ?? b.createdAt },
  ];
  return (
    <ListPage
      tabs={<ServiceTabs active="/costs" />}
      testId="price-books-page"
      title={t('prices.title')}
      description={t('prices.description')}
      primaryAction={
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)} data-testid="price-book-add">
          {t('prices.add')}
        </Button>
      }
      actions={
        <Group gap="xs">
          <Button size="xs" variant="subtle" component={Link} to="/costs" leftSection={<IconArrowLeft size={14} />}>
            {t('commitments.back')}
          </Button>
          <Button size="xs" variant="default" component={Link} to="/costs/calculators">
            {t('calculators.title')}
          </Button>
        </Group>
      }
      search={{ value: search, onChange: setSearch, label: t('prices.search') }}
      empty={{ show: !q.isLoading && !(q.data ?? []).length, icon: IconBook, title: t('prices.empty.title'), text: t('prices.empty.text') }}
    >
      <QueryState query={q} />
      {rows.length > 0 && (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(b) => b.id}
          ariaLabel={t('prices.title')}
          rowHref={(b) => bookPath(b.id)}
          testId="price-books-table"
          card={(b) => (
            <Stack gap={4}>
              <Anchor component={Link} to={bookPath(b.id)} size="sm" fw={500}>
                {b.name}
              </Anchor>
              <Group gap={4}>
                <KindBadge book={b} />
                <Text size="xs" c="dimmed">
                  {b.provider} · {b.currency} · {b.version ? `v${b.version}` : '–'} · {t('prices.entriesCount', { count: b.entries })}
                </Text>
              </Group>
              <CheckedText book={b} />
            </Stack>
          )}
        />
      )}
      <FxRates />
      {adding && <BookDialog onClose={() => setAdding(false)} />}
    </ListPage>
  );
}

function KindBadge({ book }: { book: Pick<CostPriceBook, 'kind' | 'platform'> }) {
  const { t } = useTranslation('costs');
  return (
    <Badge size="xs" variant="light" color={book.kind === 'list' ? 'blue' : book.kind === 'derived' ? 'teal' : 'grape'}>
      {t(`prices.kinds.${book.kind}`)}
      {book.platform ? ` · ${book.platform.name}` : ''}
    </Badge>
  );
}

function CheckedText({ book }: { book: CostPriceBook }) {
  const { t } = useTranslation('costs');
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="xs" c="dimmed">
        {book.checkedAt ? t('prices.checkedOn', { date: fmtDay(book.checkedAt), by: book.checkedBy }) : t('prices.neverChecked')}
      </Text>
      {book.reviewDue && (
        <Badge size="xs" color="orange" variant="light" data-testid="review-due">
          {t('prices.reviewDue')}
        </Badge>
      )}
    </Group>
  );
}

function BookDialog({ book, onClose }: { book?: CostPriceBook; onClose: () => void }) {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const books = useQuery({ queryKey: estimateKeys.books, queryFn: () => get<CostPriceBook[]>('/costs/price-books') });
  const suppliers = useSupplierOptions();
  const [name, setName] = useState(book?.name ?? '');
  const [kind, setKind] = useState<CostPriceBookKind>(book?.kind ?? 'list');
  const [provider, setProvider] = useState(book?.provider ?? '');
  const [currency, setCurrency] = useState(book?.currency ?? 'USD');
  const [platformId, setPlatformId] = useState<string | null>(book?.platform?.id ?? null);
  const [baseBookId, setBaseBookId] = useState<string | null>(book?.base?.id ?? null);
  const [supplierId, setSupplierId] = useState<string | null>(book?.supplier?.id ?? null);
  const [contractId, setContractId] = useState<string | null>(book?.supplierContract?.id ?? null);
  const [reviewDays, setReviewDays] = useState<number>(book?.reviewDays ?? 90);
  const [description, setDescription] = useState(book?.description ?? '');
  const [busy, setBusy] = useState(false);
  const bases = (books.data ?? []).filter((b) => b.id !== book?.id);
  const contracts = (suppliers.data ?? []).find((x) => x.id === supplierId)?.contracts ?? [];
  const save = async () => {
    setBusy(true);
    try {
      const base = kind === 'derived' ? bases.find((b) => b.id === baseBookId) : undefined;
      const body = {
        name: name.trim(),
        kind,
        // a derived book prices the items of its base: its provider
        provider: base ? base.provider : provider.trim(),
        currency,
        platformId: kind !== 'list' ? platformId : null,
        supplierId: kind !== 'list' ? supplierId : null,
        supplierContractId: kind !== 'list' ? contractId : null,
        baseBookId: kind === 'derived' ? baseBookId : null,
        reviewDays,
        description,
      };
      const b = book
        ? await put<CostPriceBookDetail>(`/costs/price-books/${encodeURIComponent(book.id)}`, body)
        : await post<CostPriceBookDetail>('/costs/price-books', body);
      void qc.invalidateQueries({ queryKey: ['costs'] });
      onClose();
      if (!book) navigate(bookPath(b.id));
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={book ? t('prices.edit') : t('prices.add')} centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('prices.columns.name')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            required
            data-autofocus
            data-testid="book-name"
          />
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as CostPriceBookKind)}
            disabled={!!book?.platform || book?.kind === 'derived'}
            data={[
              { value: 'list', label: t('prices.kinds.list') },
              { value: 'contracted', label: t('prices.kinds.contracted') },
              // a book stays derived or not (its prices come from elsewhere)
              { value: 'derived', label: t('prices.kinds.derived'), disabled: !!book && book.kind !== 'derived' },
            ]}
            data-testid="book-kind"
          />
          <Text size="xs" c="dimmed">
            {t(`prices.kindHelp.${kind}`)}
          </Text>
          {kind === 'derived' ? (
            <Select
              label={t('prices.baseBook')}
              description={t('prices.baseHint')}
              searchable
              required
              data={bases.map((b) => ({ value: b.id, label: `${b.name} (${b.provider}, ${t(`prices.kinds.${b.kind}`)})` }))}
              value={baseBookId}
              onChange={setBaseBookId}
              data-testid="book-base"
            />
          ) : (
            <TextInput
              label={t('prices.columns.provider')}
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value)}
              required
              data-testid="book-provider"
            />
          )}
          <Select label={t('prices.columns.currency')} searchable data={CURRENCIES} value={currency} onChange={(v) => v && setCurrency(v)} />
          {kind !== 'list' && (
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Select
                label={t('prices.supplier')}
                description={t('prices.supplierHint')}
                searchable
                clearable
                data={(suppliers.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
                value={supplierId}
                onChange={(v) => {
                  setSupplierId(v);
                  setContractId(null);
                }}
                data-testid="book-supplier"
              />
              <Select
                label={t('prices.contract')}
                description={t('prices.contractHint')}
                clearable
                disabled={!supplierId}
                data={contracts.map((c) => ({ value: c.id, label: c.reference ? `${c.title} (${c.reference})` : c.title }))}
                value={contractId}
                onChange={setContractId}
                data-testid="book-contract"
              />
            </SimpleGrid>
          )}
          {kind !== 'list' && (
            <Select
              label={t('prices.platform')}
              description={t('prices.platformHint')}
              clearable
              disabled={!!book}
              data={(platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={platformId}
              onChange={setPlatformId}
            />
          )}
          <NumberInput label={t('prices.reviewDays')} min={1} max={3650} value={reviewDays} onChange={(v) => setReviewDays(Number(v) || 90)} />
          <Textarea label={t('prices.descriptionLabel')} value={description} onChange={(e) => setDescription(e.currentTarget.value)} autosize minRows={2} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('estimates.cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim() || (kind === 'derived' ? !baseBookId : !provider.trim())} data-testid="book-save">
              {t('prices.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------- one book ----------

export function PriceBookPage() {
  const { t } = useTranslation('costs');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: estimateKeys.book(id, search, offset),
    queryFn: () => get<CostPriceBookDetail>(`/costs/price-books/${encodeURIComponent(id)}?offset=${offset}${search ? `&q=${encodeURIComponent(search)}` : ''}`),
  });
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState<CostPriceEntry | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [version, setVersion] = useState<number | null>(null);
  const b = q.data;
  if (!b) return <QueryState query={q} />;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['costs'] });
  const check = async () => {
    try {
      await post(`/costs/price-books/${encodeURIComponent(id)}/check`);
      notifyOk(t('prices.checked'));
      refresh();
    } catch (err) {
      notifyError(err);
    }
  };
  const removeBook = async () => {
    if (!(await confirmDialog({ action: 'delete', message: t('prices.removeConfirm', { name: b.name }) }))) return;
    try {
      await del(`/costs/price-books/${encodeURIComponent(id)}`);
      refresh();
      navigate('/costs/price-books');
    } catch (err) {
      notifyError(err);
    }
  };
  const removeEntry = async (e: CostPriceEntry) => {
    if (!(await confirmDialog({ action: 'remove', message: t('prices.removeEntryConfirm', { sku: e.sku }) }))) return;
    try {
      await put(`/costs/price-books/${encodeURIComponent(id)}/entries`, { remove: [{ sku: e.sku, priceId: e.priceId, validFrom: e.validFrom }] });
      refresh();
    } catch (err) {
      notifyError(err);
    }
  };
  const columns: DataColumn<CostPriceEntry>[] = [
    {
      key: 'sku',
      header: t('prices.item.sku'),
      cell: (e) => (
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {e.name}
          </Text>
          <Text size="xs" c="dimmed">
            {[e.sku, e.priceId, e.service].filter(Boolean).join(' · ')}
          </Text>
        </Stack>
      ),
    },
    { key: 'driver', header: t('prices.item.driver'), cell: (e) => `${e.driver || '–'} (${unitLabel(e.unit)})` },
    { key: 'charge', header: t('prices.item.charge'), cell: (e) => t(`prices.charges.${e.charge}`), nowrap: true },
    {
      key: 'price',
      header: t('prices.item.price'),
      cell: (e) => (
        <Stack gap={0}>
          <Text size="sm" className="viz-num">
            {t('estimates.unitPrice', {
              price: e.price,
              currency: e.currency ?? unitLabel(`{${e.creditSku}}`),
              block: e.block.toLocaleString(),
              unit: unitLabel(e.unit),
            })}
          </Text>
          {(e.tiers?.length || e.included || e.minimum) && (
            <Text size="xs" c="dimmed">
              {[
                e.tiers?.length ? t('prices.item.tiersText', { count: e.tiers.length, mode: t(`prices.tierModes.${e.tierMode}`) }) : '',
                e.included ? t('prices.item.includedText', { q: e.included }) : '',
                e.minimum ? t('prices.item.minimumText', { m: e.minimum }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          )}
        </Stack>
      ),
    },
    {
      key: 'valid',
      header: t('prices.item.valid'),
      cell: (e) => (e.validFrom || e.validTo ? `${e.validFrom ?? '…'} – ${e.validTo ?? '…'}` : '–'),
      nowrap: true,
    },
    ...(b.canEdit && b.kind !== 'derived'
      ? [
          {
            key: 'actions',
            header: '',
            cell: (e: CostPriceEntry) => (
              <Group gap={2} wrap="nowrap">
                <ActionIcon variant="subtle" aria-label={t('prices.item.edit', { sku: e.sku })} onClick={() => setEntry(e)}>
                  <IconPencil size={14} />
                </ActionIcon>
                <ActionIcon variant="subtle" color="red" aria-label={t('prices.item.remove', { sku: e.sku })} onClick={() => void removeEntry(e)}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ),
          },
        ]
      : []),
  ];
  return (
    <DetailPage
      back={[
        { to: '/costs', label: t('title') },
        { to: '/costs/price-books', label: t('prices.title') },
      ]}
      title={b.name}
      status={
        <Group gap={4}>
          <KindBadge book={b} />
          <Badge size="xs" variant="outline" color="gray">
            {b.version ? `v${b.version}` : t('prices.noVersion')}
          </Badge>
          {b.reviewDue && (
            <Badge size="xs" color="orange" variant="light">
              {t('prices.reviewDue')}
            </Badge>
          )}
        </Group>
      }
      description={b.description || t('prices.bookHelp', { provider: b.provider, currency: b.currency })}
      actions={
        b.canEdit && b.kind !== 'derived' ? (
          <Group gap="xs">
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEntry('new')} data-testid="entry-add">
              {t('prices.item.add')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)} data-testid="book-import">
              {t('prices.import.title')}
            </Button>
            <Button size="xs" variant="default" leftSection={<IconCheck size={14} />} onClick={() => void check()} data-testid="book-check">
              {t('prices.markChecked')}
            </Button>
          </Group>
        ) : undefined
      }
      menu={
        b.canEdit
          ? {
              items: [
                { label: t('prices.edit'), icon: IconPencil, onClick: () => setEditing(true) },
                { label: t('prices.remove'), icon: IconTrash, color: 'red', onClick: () => void removeBook() },
              ],
            }
          : undefined
      }
    >
      <Stack gap="lg" data-testid="price-book-page">
        {b.kind === 'derived' ? <DerivedInfo book={b} onSaved={refresh} /> : <CheckedText book={b} />}
        <Group gap="xs" align="flex-end">
          <TextInput
            label={t('prices.searchItems')}
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setOffset(0);
            }}
            w={260}
          />
          <Text size="xs" c="dimmed">
            {t('prices.entriesCount', { count: b.entries })}
          </Text>
        </Group>
        {b.items.length ? (
          <DataTable
            rows={b.items}
            columns={columns}
            rowKey={(e) => `${e.sku}|${e.priceId}|${e.validFrom ?? ''}`}
            ariaLabel={t('prices.items')}
            testId="price-items"
            card={(e) => (
              <Stack gap={2}>
                <Text size="sm" fw={500}>
                  {e.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {e.sku} · {unitLabel(e.unit)} · {t(`prices.charges.${e.charge}`)}
                </Text>
                <Text size="sm" className="viz-num">
                  {t('estimates.unitPrice', {
                    price: e.price,
                    currency: e.currency ?? e.creditSku ?? '',
                    block: e.block.toLocaleString(),
                    unit: unitLabel(e.unit),
                  })}
                </Text>
              </Stack>
            )}
          />
        ) : (
          <EmptyState icon={IconBook} title={t('prices.noItems')} compact>
            {t('prices.noItemsText')}
          </EmptyState>
        )}
        {(offset > 0 || b.more) && (
          <Group>
            <Button size="xs" variant="default" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 500))}>
              {t('prices.previous')}
            </Button>
            <Button size="xs" variant="default" disabled={!b.more} onClick={() => setOffset(offset + 500)}>
              {t('prices.next')}
            </Button>
          </Group>
        )}
        <Versions book={b} onOpen={setVersion} />
        {version !== null && <VersionDiff bookId={id} n={version} onClose={() => setVersion(null)} />}
        {/* shares (ADR 0033): a list or derived book – a rate card published to other teams; a contracted book follows its contract */}
        {b.kind === 'contracted' ? !b.platform && <OwningTeams kind="cost_price_book" id={b.id} /> : <AccessTab kind="cost_price_book" id={b.id} />}
      </Stack>
      {editing && <BookDialog book={b} onClose={() => setEditing(false)} />}
      {entry && <EntryDialog book={b} entry={entry === 'new' ? null : entry} onClose={() => setEntry(null)} onSaved={refresh} />}
      {importing && <ImportDialog book={b} onClose={() => setImporting(false)} onSaved={refresh} />}
    </DetailPage>
  );
}

/** A derived book: its base, where its terms are, and – for who sees them – the terms (a rate card's editable). */
function DerivedInfo({ book, onSaved }: { book: CostPriceBookDetail; onSaved: () => void }) {
  const { t } = useTranslation('costs');
  const [editing, setEditing] = useState(false);
  const save = async (conditions: CostConditionInput[]) => {
    await put(`/costs/price-books/${encodeURIComponent(book.id)}/terms`, { conditions });
    notifyOk(t('conditions.saved'));
    onSaved();
  };
  return (
    <Paper withBorder p="sm" data-testid="derived-info">
      <Stack gap={4}>
        <Text size="sm">{t('prices.derivedNoEdit')}</Text>
        {book.base && (
          <Text size="sm">
            <Anchor component={Link} to={bookPath(book.base.id)} size="sm">
              {t('prices.basedOn', { name: book.base.name, version: book.base.version })}
            </Anchor>
          </Text>
        )}
        {!book.termsVisible ? (
          <Text size="xs" c="dimmed" data-testid="terms-hidden">
            {t('conditions.termsHidden')}
          </Text>
        ) : book.termsOn === 'contract' && book.supplier && book.supplierContract ? (
          <Text size="xs">
            <Anchor
              component={Link}
              to={`/suppliers/${encodeURIComponent(book.supplier.id)}/contracts/${encodeURIComponent(book.supplierContract.id)}`}
              size="xs"
            >
              {t('conditions.termsOnContract', { title: book.supplierContract.title })}
            </Anchor>
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            {t('conditions.termsHelp')}
          </Text>
        )}
        {book.termsVisible && (book.terms ?? []).length > 0 && (
          <Stack gap={2} data-testid="derived-terms">
            {(book.terms ?? []).map((c) => (
              <Text key={c.id} size="sm">
                {t(`conditions.kinds.${c.kind}`)}: {conditionText(t, c)}
              </Text>
            ))}
          </Stack>
        )}
        {book.termsVisible && book.termsOn === 'book' && book.canEdit && (
          <Group>
            <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="terms-edit">
              {t('conditions.editTerms')}
            </Button>
          </Group>
        )}
      </Stack>
      {editing && (
        <ConditionsDialog
          title={t('conditions.editTermsTitle', { name: book.name })}
          initial={book.terms ?? []}
          kinds={COST_DERIVATION_KINDS}
          provider={book.provider}
          onSave={save}
          onClose={() => setEditing(false)}
        />
      )}
    </Paper>
  );
}

function Versions({ book, onOpen }: { book: CostPriceBookDetail; onOpen: (n: number) => void }) {
  const { t } = useTranslation('costs');
  if (!book.versions.length) return null;
  return (
    <Stack gap="xs" data-testid="price-versions">
      <Title order={3} size="h5">
        {t('prices.versions.title')}
      </Title>
      <Table.ScrollContainer minWidth={480}>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('prices.columns.version')}</Table.Th>
              <Table.Th>{t('prices.versions.when')}</Table.Th>
              <Table.Th>{t('prices.versions.source')}</Table.Th>
              <Table.Th>{t('prices.versions.changes')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {book.versions.map((v) => (
              <Table.Tr key={v.number}>
                <Table.Td>
                  v{v.number}
                  {v.inUse && (
                    <Badge size="xs" variant="light" ml={4}>
                      {t('prices.versions.inUse')}
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{fmtDay(v.createdAt)}</Text>
                  <Text size="xs" c="dimmed">
                    {v.createdBy}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {t(`prices.sources.${v.source}`)}
                  {v.derivation && (
                    <Text size="xs" c="dimmed">
                      {t('prices.versions_cause', { cause: v.derivation.cause, version: v.derivation.baseVersion })}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <DiffCounts diff={v.diff} />
                </Table.Td>
                <Table.Td>
                  <Button size="xs" variant="subtle" onClick={() => onOpen(v.number)} data-testid={`version-${v.number}`}>
                    {t('prices.versions.whatChanged')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Stack>
  );
}

/** Added, changed and removed as a stacked bar and as words (never colour alone). */
function DiffCounts({ diff }: { diff: CostPriceDiff | null }) {
  const { t } = useTranslation('costs');
  if (!diff) return <Text size="xs">{t('prices.versions.first')}</Text>;
  const total = Math.max(1, diff.added + diff.changed + diff.removed);
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <Stack gap={2}>
      <div
        style={{ display: 'flex', width: 120, height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--mantine-color-default-border)' }}
        aria-hidden="true"
      >
        <div style={{ width: w(diff.added), background: 'var(--mantine-color-teal-filled)' }} />
        <div style={{ width: w(diff.changed), background: 'var(--mantine-color-orange-filled)' }} />
        <div style={{ width: w(diff.removed), background: 'var(--mantine-color-red-filled)' }} />
      </div>
      <Text size="xs">{t('prices.versions.counts', { added: diff.added, changed: diff.changed, removed: diff.removed })}</Text>
    </Stack>
  );
}

/** What changed in a version: per item before, after and the change in percent (a bar either side of zero), added and removed items. */
function VersionDiff({ bookId, n, onClose }: { bookId: string; n: number; onClose: () => void }) {
  const { t } = useTranslation('costs');
  const q = useQuery({
    queryKey: ['costs', 'price-book', bookId, 'version', n],
    queryFn: () => get<CostPriceVersion & { items: CostPriceEntry[] }>(`/costs/price-books/${encodeURIComponent(bookId)}/versions/${n}`),
  });
  const d = q.data?.diff;
  const maxPct = Math.max(1, ...(d?.items.changed ?? []).map((c) => Math.abs(c.pct ?? 0)));
  const bar = (pct: number | null) => {
    if (pct === null) return null;
    const half = 50;
    const len = (Math.abs(pct) / maxPct) * half;
    return (
      <svg width={100} height={10} aria-hidden="true">
        <line x1={half} x2={half} y1={0} y2={10} stroke="var(--mantine-color-default-border)" />
        <rect
          x={pct >= 0 ? half : half - len}
          y={2}
          width={Math.max(1, len)}
          height={6}
          fill={pct >= 0 ? 'var(--mantine-color-orange-filled)' : 'var(--mantine-color-teal-filled)'}
        />
      </svg>
    );
  };
  const row = (c: CostPriceDiffItem, kind: 'added' | 'removed' | 'changed') => (
    <Table.Tr key={`${kind}${c.sku}${c.priceId}${c.validFrom ?? ''}`}>
      <Table.Td>
        <Text size="sm">{c.name}</Text>
        <Text size="xs" c="dimmed">
          {c.sku}
          {c.priceId ? ` · ${c.priceId}` : ''}
          {c.validFrom ? ` · ${t('prices.versions.from', { date: c.validFrom })}` : ''}
        </Text>
      </Table.Td>
      <Table.Td>{t(`prices.versions.${kind}`)}</Table.Td>
      <Table.Td className="viz-num">{c.before ?? '–'}</Table.Td>
      <Table.Td className="viz-num">{c.after ?? '–'}</Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Text size="xs" className="viz-num">
            {kind === 'changed' ? fmtChange(c.pct) : '–'}
          </Text>
          {kind === 'changed' && bar(c.pct)}
        </Group>
        {c.fields.length > 0 && (
          <Text size="xs" c="dimmed">
            {t('prices.versions.fields', { fields: c.fields.join(', ') })}
          </Text>
        )}
      </Table.Td>
    </Table.Tr>
  );
  return (
    <Modal opened onClose={onClose} title={t('prices.versions.diffTitle', { n })} size="xl" centered>
      <QueryState query={q} />
      {q.data && (
        <Stack gap="sm" data-testid="version-diff">
          <DiffCounts diff={d ?? null} />
          {d && (
            <Table.ScrollContainer minWidth={560}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('prices.item.sku')}</Table.Th>
                    <Table.Th>{t('prices.versions.change')}</Table.Th>
                    <Table.Th>{t('prices.versions.before')}</Table.Th>
                    <Table.Th>{t('prices.versions.after')}</Table.Th>
                    <Table.Th>{t('prices.versions.pct')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.items.changed.map((c) => row(c, 'changed'))}
                  {d.items.added.map((c) => row(c, 'added'))}
                  {d.items.removed.map((c) => row(c, 'removed'))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function EntryDialog({ book, entry, onClose, onSaved }: { book: CostPriceBookDetail; entry: CostPriceEntry | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('costs');
  const [e, setE] = useState<CostPriceEntry>(
    entry ?? {
      sku: '',
      priceId: '',
      name: '',
      service: '',
      category: '',
      driver: '',
      unit: 'h',
      charge: 'usage',
      price: '',
      block: 1,
      currency: book.currency,
      creditSku: null,
      tiers: null,
      tierMode: 'graduated',
      included: null,
      minimum: null,
      validFrom: null,
      validTo: null,
      attributes: [],
      sourceNote: '',
    },
  );
  const [tiers, setTiers] = useState((entry?.tiers ?? []).map((x) => `${x.from}:${x.price}`).join(';'));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<CostPriceEntry>) => setE({ ...e, ...p });
  const save = async () => {
    setBusy(true);
    try {
      const bands = tiers
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => {
          const [from = '', price = ''] = x.split(':');
          return { from: from.trim(), price: price.trim() };
        });
      const out = {
        ...e,
        tiers: bands.length ? bands : null,
        included: e.included || null,
        minimum: e.minimum || null,
        validFrom: e.validFrom || null,
        validTo: e.validTo || null,
      };
      await put(`/costs/price-books/${encodeURIComponent(book.id)}/entries`, {
        entries: [out],
        remove:
          entry && (entry.sku !== e.sku || entry.priceId !== e.priceId || entry.validFrom !== out.validFrom)
            ? [{ sku: entry.sku, priceId: entry.priceId, validFrom: entry.validFrom }]
            : [],
      });
      onSaved();
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={entry ? t('prices.item.editTitle') : t('prices.item.add')} size="lg" centered>
      <form
        onSubmit={(ev) => {
          ev.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('prices.item.sku')}
              value={e.sku}
              onChange={(x) => set({ sku: x.currentTarget.value })}
              required
              data-autofocus
              data-testid="entry-sku"
            />
            <TextInput label={t('prices.item.name')} value={e.name} onChange={(x) => set({ name: x.currentTarget.value })} required data-testid="entry-name" />
            <Select
              label={t('prices.item.driver')}
              searchable
              data={COST_DRIVER_SUGGESTIONS.map((d) => ({ value: d.key, label: `${t(`prices.drivers.${d.key}`)} (${unitLabel(d.unit)})` }))}
              value={COST_DRIVER_SUGGESTIONS.some((d) => d.key === e.driver) ? e.driver : null}
              onChange={(v) => {
                const d = COST_DRIVER_SUGGESTIONS.find((x) => x.key === v);
                if (d) set({ driver: d.key, unit: d.unit });
              }}
              description={t('prices.item.driverHint')}
            />
            <TextInput
              label={t('prices.item.unit')}
              description={t('prices.item.unitHint')}
              value={e.unit}
              onChange={(x) => set({ unit: x.currentTarget.value })}
              required
              data-testid="entry-unit"
            />
            <Select
              label={t('prices.item.charge')}
              data={COST_PRICE_CHARGES.map((c) => ({ value: c, label: t(`prices.charges.${c}`) }))}
              value={e.charge}
              onChange={(v) => v && set({ charge: v as CostPriceEntry['charge'] })}
            />
            <Select
              label={t('prices.item.block')}
              data={['1', '1000', '1000000'].map((b) => ({ value: b, label: t('prices.item.per', { n: Number(b).toLocaleString() }) }))}
              value={String(e.block)}
              onChange={(v) => v && set({ block: Number(v) as CostPriceEntry['block'] })}
            />
            <TextInput
              label={t('prices.item.price')}
              description={t('prices.item.priceHint')}
              value={e.price}
              onChange={(x) => set({ price: x.currentTarget.value })}
              required
              data-testid="entry-price"
            />
            <Select
              label={t('prices.columns.currency')}
              searchable
              clearable
              data={CURRENCIES}
              value={e.currency}
              onChange={(v) => set({ currency: v, creditSku: v ? null : e.creditSku })}
              description={t('prices.item.currencyHint')}
            />
            {!e.currency && (
              <TextInput label={t('prices.item.creditSku')} value={e.creditSku ?? ''} onChange={(x) => set({ creditSku: x.currentTarget.value || null })} />
            )}
            <TextInput
              label={t('prices.item.tiers')}
              description={t('prices.item.tiersHint')}
              value={tiers}
              onChange={(x) => setTiers(x.currentTarget.value)}
            />
            <TextInput label={t('prices.item.included')} value={e.included ?? ''} onChange={(x) => set({ included: x.currentTarget.value || null })} />
            <TextInput label={t('prices.item.minimum')} value={e.minimum ?? ''} onChange={(x) => set({ minimum: x.currentTarget.value || null })} />
            <TextInput
              label={t('prices.item.validFrom')}
              placeholder={t('prices.item.datePlaceholder')}
              value={e.validFrom ?? ''}
              onChange={(x) => set({ validFrom: x.currentTarget.value || null })}
            />
            <TextInput
              label={t('prices.item.validTo')}
              placeholder={t('prices.item.datePlaceholder')}
              value={e.validTo ?? ''}
              onChange={(x) => set({ validTo: x.currentTarget.value || null })}
            />
          </SimpleGrid>
          <TextInput label={t('prices.item.sourceNote')} value={e.sourceNote} onChange={(x) => set({ sourceNote: x.currentTarget.value })} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('estimates.cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="entry-save">
              {t('prices.item.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The header of a CSV file (the separator detected as the server does), for the mapping. */
function headerOf(text: string): string[] {
  const first = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const sep = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  return first.split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
}

const GUESS: Record<CostPriceCsvField, string[]> = {
  sku: ['sku', 'item', 'id'],
  priceId: ['price_id', 'priceid'],
  name: ['name'],
  service: ['service'],
  category: ['category'],
  driver: ['driver'],
  unit: ['unit'],
  charge: ['charge'],
  price: ['price'],
  block: ['block', 'per'],
  currency: ['currency'],
  creditSku: ['credit_item', 'credit_sku', 'creditsku'],
  tiers: ['tiers'],
  included: ['included'],
  minimum: ['minimum'],
  validFrom: ['valid_from', 'validfrom'],
  validTo: ['valid_to', 'validto'],
  sourceNote: ['source_note', 'note', 'source'],
};

function ImportDialog({ book, onClose, onSaved }: { book: CostPriceBookDetail; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('costs');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Partial<Record<CostPriceCsvField, string | null>>>({});
  const [decimal, setDecimal] = useState<'.' | ','>('.');
  const [mode, setMode] = useState<'replace' | 'add'>('replace');
  const [preview, setPreview] = useState<CostPriceImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const headers = useMemo(() => (csv ? headerOf(csv) : []), [csv]);
  const load = async (f: File | null) => {
    if (!f) return;
    const text = await f.text();
    setCsv(text);
    setFileName(f.name);
    setPreview(null);
    const hs = headerOf(text);
    const guess: Partial<Record<CostPriceCsvField, string | null>> = {};
    for (const field of COST_PRICE_CSV_FIELDS) guess[field] = hs.find((h) => GUESS[field].includes(h.toLowerCase())) ?? null;
    setMapping(guess);
  };
  const body = () => ({ csv, fileName, mode, mapping: { ...Object.fromEntries(COST_PRICE_CSV_FIELDS.map((f) => [f, mapping[f] ?? null])), decimal } });
  const doPreview = async () => {
    setBusy(true);
    try {
      setPreview(await post<CostPriceImportPreview>(`/costs/price-books/${encodeURIComponent(book.id)}/import/preview`, body()));
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const doImport = async () => {
    setBusy(true);
    try {
      await post(`/costs/price-books/${encodeURIComponent(book.id)}/import`, body());
      notifyOk(t('prices.import.done'));
      onSaved();
      onClose();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('prices.import.title')} size="xl" centered>
      <Stack gap="sm" data-testid="price-import">
        <Text size="sm">{t('prices.import.help')}</Text>
        <Group>
          <FileButton onChange={(f) => void load(f)} accept=".csv,text/csv,text/plain">
            {(props) => (
              <Button variant="default" size="xs" {...props}>
                {t('prices.import.choose')}
              </Button>
            )}
          </FileButton>
          <Text size="xs" c="dimmed">
            {fileName}
          </Text>
        </Group>
        {headers.length > 0 && (
          <>
            <SimpleGrid cols={{ base: 2, sm: 4 }}>
              {COST_PRICE_CSV_FIELDS.map((f) => (
                <Select
                  key={f}
                  size="xs"
                  label={t(`prices.import.fields.${f}`)}
                  clearable={!['sku', 'unit', 'price'].includes(f)}
                  data={headers}
                  value={mapping[f] ?? null}
                  onChange={(v) => {
                    setMapping({ ...mapping, [f]: v });
                    setPreview(null);
                  }}
                />
              ))}
            </SimpleGrid>
            <Group>
              <SegmentedControl
                size="xs"
                value={decimal}
                onChange={(v) => setDecimal(v as '.' | ',')}
                data={[
                  { value: '.', label: t('prices.import.decimalPoint') },
                  { value: ',', label: t('prices.import.decimalComma') },
                ]}
              />
              <SegmentedControl
                size="xs"
                value={mode}
                onChange={(v) => setMode(v as 'replace' | 'add')}
                data={[
                  { value: 'replace', label: t('prices.import.replace') },
                  { value: 'add', label: t('prices.import.addMode') },
                ]}
              />
              <Button
                size="xs"
                variant="default"
                loading={busy}
                onClick={() => void doPreview()}
                disabled={!mapping.sku || !mapping.unit || !mapping.price}
                data-testid="import-preview"
              >
                {t('prices.import.preview')}
              </Button>
            </Group>
          </>
        )}
        {preview && (
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <Text size="sm">{t('prices.import.summary', { rows: preview.rows, entries: preview.entries })}</Text>
              <DiffCounts diff={preview.diff} />
              {preview.problems.length > 0 && (
                <Alert color="red" title={t('prices.import.problems', { count: preview.problems.length })}>
                  {preview.problems.slice(0, 10).map((p) => (
                    <Text key={`${p.line}${p.message}`} size="xs">
                      {p.line ? t('prices.import.line', { line: p.line, message: p.message }) : p.message}
                    </Text>
                  ))}
                </Alert>
              )}
              <Group justify="flex-end">
                <Button loading={busy} disabled={preview.problems.length > 0 || !preview.entries} onClick={() => void doImport()} data-testid="import-run">
                  {t('prices.import.run', { count: preview.entries })}
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}
      </Stack>
    </Modal>
  );
}

// ---------- exchange rates ----------

function FxRates() {
  const { t } = useTranslation('costs');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: estimateKeys.fx, queryFn: () => get<CostFxRate[]>('/costs/fx-rates') });
  const [date, setDate] = useState(localToday());
  const [base, setBase] = useState('USD');
  const [quote, setQuote] = useState('EUR');
  const [rate, setRate] = useState('');
  const add = async () => {
    try {
      await put('/costs/fx-rates', { date, base, quote, rate });
      setRate('');
      void qc.invalidateQueries({ queryKey: estimateKeys.fx });
    } catch (err) {
      notifyError(err);
    }
  };
  const remove = async (r: CostFxRate) => {
    try {
      await del(`/costs/fx-rates?date=${r.date}&base=${r.base}&quote=${r.quote}`);
      void qc.invalidateQueries({ queryKey: estimateKeys.fx });
    } catch (err) {
      notifyError(err);
    }
  };
  return (
    <Stack gap="xs" mt="lg" data-testid="fx-rates">
      <Title order={3} size="h5">
        {t('prices.fx.title')}
      </Title>
      <Text size="xs" c="dimmed">
        {t('prices.fx.help')}
      </Text>
      {(q.data ?? []).length > 0 && (
        <Table.ScrollContainer minWidth={480}>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('prices.fx.date')}</Table.Th>
                <Table.Th>{t('prices.fx.rate')}</Table.Th>
                <Table.Th>{t('prices.fx.setBy')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(q.data ?? []).map((r) => (
                <Table.Tr key={`${r.date}${r.base}${r.quote}`}>
                  <Table.Td>{r.date}</Table.Td>
                  <Table.Td className="viz-num">{t('prices.fx.text', { base: r.base, rate: r.rate, quote: r.quote })}</Table.Td>
                  <Table.Td>{r.setBy}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" aria-label={t('prices.fx.remove')} onClick={() => void remove(r)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <TextInput size="xs" label={t('prices.fx.date')} value={date} onChange={(e) => setDate(e.currentTarget.value)} w={120} />
        <Select size="xs" label={t('prices.fx.base')} searchable data={CURRENCIES} value={base} onChange={(v) => v && setBase(v)} w={100} />
        <Select size="xs" label={t('prices.fx.quote')} searchable data={CURRENCIES} value={quote} onChange={(v) => v && setQuote(v)} w={100} />
        <TextInput size="xs" label={t('prices.fx.rate')} value={rate} onChange={(e) => setRate(e.currentTarget.value)} w={120} data-testid="fx-rate" />
        <Button size="xs" variant="default" disabled={!rate.trim()} onClick={() => void add()} data-testid="fx-add">
          {t('prices.fx.add')}
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        <Anchor component={Link} to="/costs/calculators" size="xs">
          {t('calculators.title')}
        </Anchor>
      </Text>
    </Stack>
  );
}
