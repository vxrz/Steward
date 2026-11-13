import type { DataGraphEdge, DataGraphNode } from '@sm/shared';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from '../../plant/views/exportImage';
import { nodeSize, type GraphLayout } from './graphLayout';
import type { GraphText } from './text';

/**
 * A data products picture as a standalone SVG (for documents; the PNG is drawn from it), as the plant registry's
 * export: the same layout as on the screen, the theme's colours resolved, health and status in words beside every
 * colour, areas and column headers, no animation.
 */
export function graphSvg(
  g: { nodes: DataGraphNode[]; edges: DataGraphEdge[] },
  layout: GraphLayout,
  o: { title: string; subtitle: string; text: GraphText; header?: (index: number) => string },
): { svg: string; width: number; height: number } {
  const th = exportTheme();
  const text = o.text;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const edgeColor = cssColor('--pv-edge', '#adb5bd');
  const problem = cssColor('--pv-problem', '#fa5252');
  const health = {
    up: cssColor('--pv-ok', '#2f9e44'),
    degraded: cssColor('--pv-warn', '#e8590c'),
    blocked: cssColor('--pv-warn', '#e8590c'),
    down: cssColor('--pv-fail', '#e03131'),
    maintenance: cssColor('--pv-flow', '#1c7ed6'),
  } as Record<string, string>;
  const colourOf = (n: DataGraphNode) => (n.health ? (health[n.health] ?? cssColor('--pv-unknown', '#868e96')) : th.border);
  const box = (id: string) => {
    const n = byId.get(id);
    const p = layout.pos.get(id) ?? { x: 0, y: 0 };
    return { ...p, ...(n ? nodeSize(n) : { width: 0, height: 0 }) };
  };
  const out: string[] = [];
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`;
  const defs = marker('a', edgeColor) + marker('ap', problem);
  // areas: the largest first
  for (const [id, b] of [...layout.boxes].sort((x, y) => y[1].width * y[1].height - x[1].width * x[1].height)) {
    const n = byId.get(id);
    const label = n ? `${text.kind(n)} ${text.label(n)}` : '';
    out.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="12" fill="${th.surface}" stroke="${th.border}" stroke-width="1.5"/>`,
      label
        ? `<text x="${b.x + 12}" y="${b.y + 18}" font-size="11" font-weight="600" fill="${th.text}">${escapeXml(clip(label, Math.floor(b.width / 6.5)))}</text>`
        : '',
    );
  }
  for (const h of layout.headers)
    out.push(
      `<text x="${h.x + h.width / 2}" y="24" font-size="10.5" font-weight="600" text-anchor="middle" fill="${th.dimmed}">${escapeXml((o.header?.(h.column.index) ?? text.column(h.column)).toUpperCase())}</text>`,
    );
  for (const e of g.edges) {
    const a = box(e.from);
    const b = box(e.to);
    const sx = a.x + a.width;
    const sy = a.y + a.height / 2;
    const tx = b.x;
    const ty = b.y + b.height / 2;
    const c = Math.max(30, Math.abs(tx - sx) / 2);
    const color = e.deprecated ? problem : edgeColor;
    const dash = e.proposed ? ' stroke-dasharray="2 5" stroke-linecap="round"' : e.deprecated || e.hidden ? ' stroke-dasharray="7 6"' : '';
    out.push(
      `<path d="M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}" fill="none" stroke="${color}" stroke-width="1.6"${dash} marker-end="url(#${e.deprecated ? 'ap' : 'a'})"/>`,
    );
    const label = text.edge(e);
    if (label) {
      const w = Math.min(label.length, 40) * 6 + 14;
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      out.push(
        `<rect x="${mx - w / 2}" y="${my - 9}" width="${w}" height="18" rx="9" fill="${th.background}" stroke="${e.deprecated ? problem : th.border}"/>`,
        `<text x="${mx}" y="${my + 4}" font-size="10.5" text-anchor="middle" fill="${e.deprecated ? problem : th.text}">${escapeXml(clip(label, 40))}</text>`,
      );
    }
  }
  for (const n of g.nodes) {
    if (n.group) continue;
    const p = box(n.id);
    const dash = n.outside || n.hidden ? ' stroke-dasharray="6 4"' : '';
    if (n.kind === 'step') {
      out.push(
        `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${p.height / 2}" fill="${th.surface}" stroke="${th.border}"/>`,
        `<text x="${p.x + p.width / 2}" y="${p.y + p.height / 2 + 4}" font-size="11" font-weight="600" text-anchor="middle" fill="${th.text}">${escapeXml(clip(text.label(n), 22))}</text>`,
      );
      continue;
    }
    const status = n.health ? text.t(`health.${n.health}`) : '';
    out.push(
      `<g>`,
      `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="10" fill="${th.surface}" stroke="${th.border}"${dash}/>`,
      `<rect x="${p.x}" y="${p.y}" width="5" height="${p.height}" rx="2" fill="${colourOf(n)}"/>`,
      `<text x="${p.x + 14}" y="${p.y + 20}" font-size="9.5" font-weight="600" letter-spacing="0.5" fill="${th.dimmed}">${escapeXml(clip(text.kind(n).toUpperCase(), 30))}</text>`,
      `<text x="${p.x + 14}" y="${p.y + 40}" font-size="13" font-weight="600" fill="${th.text}"${n.hidden ? ' font-style="italic"' : ''}>${escapeXml(clip(text.label(n), 30))}</text>`,
      n.detail && !n.hidden
        ? `<text x="${p.x + 14}" y="${p.y + 58}" font-size="10.5" font-family="ui-monospace, monospace" fill="${th.dimmed}">${escapeXml(clip(n.detail, 36))}</text>`
        : '',
      status ? `<text x="${p.x + 14}" y="${p.y + p.height - 12}" font-size="10.5" fill="${colourOf(n)}">${escapeXml(clip(status, 36))}</text>` : '',
      `</g>`,
    );
  }
  return {
    svg: svgDocument({ width: layout.width, height: layout.height, title: o.title, subtitle: o.subtitle, body: out.join(''), defs }),
    width: layout.width,
    height: layout.height + 44,
  };
}
