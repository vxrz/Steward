export interface I18nProblem {
  lang: string;
  file: string;
  type: 'missing' | 'extra' | 'empty' | 'placeholders' | 'tags' | 'type' | 'invalid' | 'untranslated';
  key: string;
  detail?: string;
}
export interface I18nCheckResult {
  ok: boolean;
  languages: string[];
  stats: Record<string, { files: number; keys: number }>;
  problems: I18nProblem[];
}
/** Compare every language under `root` with English. Throws for a missing English folder. */
export function check(root: string): I18nCheckResult;
