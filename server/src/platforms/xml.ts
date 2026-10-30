/** Reading the few XML answers of AWS APIs (S3, STS, IAM) with indexOf – no XML parser, no regular expressions on remote input. */

/** The text between <tag> and </tag>, for each occurrence. */
export function xmlAll(xml: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const a = xml.indexOf(open, from);
    if (a < 0) break;
    const b = xml.indexOf(close, a + open.length);
    if (b < 0) break;
    out.push(xml.slice(a + open.length, b));
    from = b + close.length;
  }
  return out;
}

export const xmlOne = (xml: string, tag: string): string | undefined => xmlAll(xml, tag)[0];

export const unescapeXml = (s: string): string =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] ?? '');

export const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
