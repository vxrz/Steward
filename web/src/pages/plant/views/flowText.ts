/**
 * A card's second line (data flow, lineage): its first entry, and how many more there are. A collector or target that
 * several collections or publications share names each of them (0.23.0); the tooltip and the table show all.
 *
 * `clip` shortens the first entry for a fixed width (the exported picture: 30 characters, 36 without a count).
 */
export function detailLines(detail: string, more: (count: number) => string, clip?: (line: string, max: number) => string): string {
  const lines = detail.split('\n');
  if (lines.length === 1) return clip ? clip(detail, 36) : detail;
  const first = clip ? clip(lines[0]!, 30) : lines[0]!;
  return `${first}\n${more(lines.length - 1)}`;
}
