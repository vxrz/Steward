import type { Person } from './model.js';

/** "Display Name (username)", or the username alone; drawing code imports it without the report model's queries. */
export const personLabel = (p: Person | null | undefined): string =>
  !p ? '–' : p.displayName && p.displayName !== p.username ? `${p.displayName} (${p.username})` : p.username;
