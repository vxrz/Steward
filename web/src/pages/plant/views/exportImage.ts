/**
 * Export of the plant views (#230) as SVG or PNG, for documentation. Each view draws a standalone SVG of what it shows
 * (resolved colours, no styles from the page, no scripts); the PNG is that SVG drawn on a canvas at twice the size.
 */

export const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The value of a CSS custom property of the page (Mantine's colours), so the export looks like the screen. */
export function cssColor(name: string, fallback = '#868e96'): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Colours of the current theme an export needs. */
export function exportTheme() {
  const dark = document.documentElement.getAttribute('data-mantine-color-scheme') === 'dark';
  return {
    dark,
    background: cssColor('--mantine-color-body', dark ? '#242424' : '#ffffff'),
    text: cssColor('--mantine-color-text', dark ? '#c9c9c9' : '#000000'),
    dimmed: cssColor('--mantine-color-dimmed', '#868e96'),
    border: cssColor('--mantine-color-default-border', dark ? '#424242' : '#dee2e6'),
    surface: cssColor('--mantine-color-default', dark ? '#2e2e2e' : '#ffffff'),
    font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  };
}

/** A short text cut to a length (SVG text does not wrap). */
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a title: lower case, dashes. */
export const fileName = (title: string, ext: 'svg' | 'png'): string =>
  `${
    title
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 60) || 'plant-view'
  }.${ext}`;

export function downloadSvg(svg: string, title: string): void {
  save(new Blob([svg], { type: 'image/svg+xml' }), fileName(title, 'svg'));
}

export async function downloadPng(svg: string, title: string, width: number, height: number): Promise<void> {
  const scale = 2;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The picture could not be drawn'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The picture could not be drawn');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The picture could not be drawn');
    save(blob, fileName(title, 'png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The frame of an exported SVG: size, background, a title line and the content. */
export function svgDocument(o: { width: number; height: number; title: string; subtitle?: string; body: string; defs?: string }): string {
  const th = exportTheme();
  const head = 44;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height + head}" viewBox="0 0 ${o.width} ${o.height + head}" font-family='${th.font}'>`,
    `<title>${escapeXml(o.title)}</title>`,
    o.defs ? `<defs>${o.defs}</defs>` : '',
    `<rect width="100%" height="100%" fill="${th.background}"/>`,
    `<text x="16" y="24" font-size="15" font-weight="600" fill="${th.text}">${escapeXml(o.title)}</text>`,
    o.subtitle ? `<text x="16" y="39" font-size="11" fill="${th.dimmed}">${escapeXml(o.subtitle)}</text>` : '',
    `<g transform="translate(0 ${head})">${o.body}</g>`,
    '</svg>',
  ].join('');
}
