import { useRef, useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';

/**
 * Searchable pickers whose options come from the server as one types (link targets, tag targets, vault secrets).
 *
 * Mantine's `Select` puts the selected option's label into its input and reports it through `onSearchChange`. Used as
 * the search text, that label asks the server for something it may not find (a label with its detail, "Gateway
 * (server · Invented AG)", while the server matches the name only) – the option then falls back to another label, the
 * input changes, the search changes again, and the field flickers between two labels with a request each time. So:
 *
 * - the selected item's label is never a search: the server is asked for what the person types, else for nothing;
 * - every id keeps one label – the first one the server gave for it (else the fallback the form knows) – however the
 *   found options change.
 */

export interface PickOption {
  value: string;
  label: string;
}

/** Remembers the label of every option the server gave (the first one stays: one stable label per id). */
export function rememberLabels(memory: Map<string, string>, options: readonly PickOption[]): void {
  for (const o of options) if (!memory.has(o.value)) memory.set(o.value, o.label);
}

/** The label of an id: the remembered one, else the form's fallback, else the id itself. */
export function labelOf(memory: ReadonlyMap<string, string>, id: string, fallback?: string | null): string {
  return memory.get(id) ?? (fallback || id);
}

/** What the server is asked for: the text the person typed – the selected item's own label in the input is no search. */
export function searchTermOf(search: string, selectedLabel: string | null | undefined): string {
  const s = search.trim();
  return selectedLabel && s === selectedLabel.trim() ? '' : s;
}

/**
 * The options to show: the found ones with their remembered labels, and the selected ids the search did not find in
 * front of them (with their remembered label, so the field does not change while one searches).
 */
export function pickOptions(
  memory: Map<string, string>,
  found: readonly PickOption[],
  selected: readonly string[],
  fallback?: (id: string) => string | null | undefined,
): PickOption[] {
  rememberLabels(memory, found);
  const out = found.map((o) => ({ value: o.value, label: memory.get(o.value)! }));
  const missing = selected.filter((id) => !out.some((o) => o.value === id)).map((id) => ({ value: id, label: labelOf(memory, id, fallback?.(id)) }));
  return [...missing, ...out];
}

/**
 * The search state of a server-searched `Select` (pass `searchValue={search}`, `onSearchChange={setSearch}`,
 * `filter={({ options }) => options}` where the server filters): `term` is the debounced text to ask the server for,
 * `options()` turns the found options into the ones to show.
 */
export function useRemoteSelect({
  value,
  fallback,
  delay = 250,
}: {
  value: string | readonly string[] | null;
  fallback?: (id: string) => string | null | undefined;
  delay?: number;
}) {
  const memory = useRef(new Map<string, string>()).current;
  const [search, setSearch] = useState('');
  const selected = value === null ? [] : typeof value === 'string' ? (value ? [value] : []) : value;
  const selectedLabel = typeof value === 'string' && value ? labelOf(memory, value, fallback?.(value)) : null;
  const [term] = useDebouncedValue(searchTermOf(search, selectedLabel), delay);
  return {
    search,
    setSearch,
    term,
    options: (found: readonly PickOption[]) => pickOptions(memory, found, selected, fallback),
    labelOf: (id: string) => labelOf(memory, id, fallback?.(id)),
  };
}
