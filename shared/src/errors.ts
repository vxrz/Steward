/**
 * Details of an API error for its translated text in the web UI (errors:codes.<CODE>, i18next
 * interpolation). The English `error` message of the response already contains them.
 *
 * - `context` picks a variant of the text (`<CODE>_<context>`, falling back to `<CODE>`).
 * - A nested error (`{ message, code?, params? }`) is translated on its own, e.g. the cause in "Row 3: …",
 *   or a value the UI translates (a record status, the label of a built-in field).
 * - A list is joined in the UI language ("A, B and C").
 */
export type ErrorParam = string | number | boolean | null | ErrorParamText | ErrorParam[];
export interface ErrorParamText {
  message: string;
  code?: string;
  params?: ErrorParams;
}
export type ErrorParams = Record<string, ErrorParam>;
