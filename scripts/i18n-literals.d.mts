export interface LiteralFinding {
  file: string;
  line: number;
  col: number;
  kind: 'jsx-text' | 'attribute' | 'property' | 'call';
  /** Attribute, property or function name */
  context: string;
  text: string;
}
export interface LiteralScanResult {
  ok: boolean;
  files: number;
  findings: LiteralFinding[];
}
export interface LiteralAllow {
  exact: Set<string>;
  patterns: RegExp[];
}
/** Scan web/src under `root` (or the given files) for texts that do not go through i18next. */
export function scan(root: string, files?: string[]): LiteralScanResult;
/** Scan one source text. */
export function scanSource(file: string, text: string, allow: LiteralAllow): LiteralFinding[];
/** True when a string reads like words a person would translate. */
export function isText(raw: string, allow: LiteralAllow): boolean;
/** scripts/i18n-allow.json → literals */
export function loadAllow(root: string): LiteralAllow;
