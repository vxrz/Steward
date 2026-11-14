import { useState } from 'react';
import { Select } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RecordSummary, TicketList } from '@sm/shared';
import { getOptional } from '../../api';

/** Evidence kinds that name an item of Steward by its id: searched by number or title, not typed. */
export const ITEM_EVIDENCE_KINDS = ['record', 'document', 'ticket'] as const;
export type ItemEvidenceKind = (typeof ITEM_EVIDENCE_KINDS)[number];
export const isItemEvidence = (k: string): k is ItemEvidenceKind => (ITEM_EVIDENCE_KINDS as readonly string[]).includes(k);

const LIMIT = 20;

/**
 * Picks the document, living document or ticket reference a documented decision names as evidence (ADR 0038): a
 * search of what the person may see – documents by number and title (`/records`, living documents only for
 * `document`), ticket references by number and title (`/ticket-references`). The value is the item's id, as the server
 * takes it; `label` is what is shown for a value picked before (the decision as stored).
 */
export function EvidenceRefSelect({
  kind,
  value,
  label,
  onChange,
  ariaLabel,
  error,
  testId,
}: {
  kind: ItemEvidenceKind;
  value: string;
  label?: string;
  onChange: (id: string, label: string) => void;
  ariaLabel: string;
  error?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('dataProductGovernance');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [debounced] = useDebouncedValue(q.trim(), 250);
  const found = useQuery({
    queryKey: ['evidence-ref', kind, debounced],
    queryFn: async (): Promise<{ value: string; label: string }[]> => {
      if (kind === 'ticket') {
        const r = await getOptional<TicketList>(`/ticket-references?${new URLSearchParams({ q: debounced })}`, { items: [], canCreate: false });
        return r.items.slice(0, LIMIT).map((x) => ({ value: x.id, label: `${x.externalNumber} ${x.title}`.trim() }));
      }
      const qs = new URLSearchParams({ q: debounced, limit: String(LIMIT), ...(kind === 'document' ? { workflow: 'document' } : {}) });
      const r = await getOptional<RecordSummary[]>(`/records?${qs}`, []);
      return r.map((x) => ({ value: x.id, label: `${x.number} ${x.title}`.trim() }));
    },
    enabled: open || !!debounced,
    staleTime: 15_000,
  });
  const items = found.data ?? [];
  // the value picked before stays an option, also when the search does not find it now
  const data = value && !items.some((o) => o.value === value) ? [{ value, label: label || value }, ...items] : items;
  return (
    <Select
      aria-label={ariaLabel}
      placeholder={t(`documented.evidenceSearch.${kind}`)}
      searchable
      onSearchChange={setQ}
      onDropdownOpen={() => setOpen(true)}
      // opened by typing, a click or the arrow keys, not by the focus alone (as the contacts' search)
      openOnFocus={false}
      // the server searched already: show what it found
      filter={({ options }) => options}
      data={data}
      value={value || null}
      onChange={(id) => onChange(id ?? '', data.find((o) => o.value === id)?.label ?? '')}
      nothingFoundMessage={found.isFetching ? '…' : t('documented.evidenceNothingFound')}
      error={error}
      comboboxProps={{ withinPortal: true }}
      style={{ flex: 1, minWidth: 0 }}
      data-testid={testId}
    />
  );
}
