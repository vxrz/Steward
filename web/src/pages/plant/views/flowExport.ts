import type { PlantFlowGraph, PlantFlowNodeKind } from '@sm/shared';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from './exportImage';
import { NODE_H, NODE_W, edgeWidth, flowLayout } from './FlowGraph';

/**
 * A graph as a standalone SVG (#230): the same layout as on the screen, the theme's colours resolved, statuses in
 * words beside their colour, dashed ways that are not active or fail a check. No animation (a picture for documents).
 */
export function flowSvg(
  graph: PlantFlowGraph,
  o: {
    title: string;
    subtitle: string;
    kind: (k: PlantFlowNodeKind) => string;
    status: (n: PlantFlowGraph['nodes'][number]) => string;
    pill: (e: PlantFlowGraph['edges'][number]) => string;
    hidden: string;
  },
): { svg: string; width: number; height: number } {
  const th = exportTheme();
  const layout = flowLayout(graph);
  const pos = layout.pos;
  const lr = layout.dir === 'LR';
  const xs = [...pos.values()];
  const minX = Math.min(...xs.map((p) => p.x), 0);
  const minY = Math.min(...xs.map((p) => p.y), 0);
  const width = Math.max(...xs.map((p) => p.x + NODE_W), NODE_W) - minX + 32;
  const height = Math.max(...xs.map((p) => p.y + NODE_H), NODE_H) - minY + 32;
  const at = (id: string) => {
    const p = pos.get(id) ?? { x: 0, y: 0 };
    return { x: p.x - minX + 16, y: p.y - minY + 16 };
  };
  const edgeColor = cssColor('--pv-edge', '#adb5bd');
  const problem = cssColor('--pv-problem', '#fa5252');
  const live = {
    ok: cssColor('--pv-ok', '#2f9e44'),
    warn: cssColor('--pv-warn', '#e8590c'),
    fail: cssColor('--pv-fail', '#e03131'),
    unknown: cssColor('--pv-unknown', '#868e96'),
  };
  const defs = [
    `<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${edgeColor}"/></marker>`,
    `<marker id="ap" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${problem}"/></marker>`,
  ].join('');
  const out: string[] = [];
  for (const e of graph.edges) {
    const a = at(e.from);
    const b = at(e.to);
    const sx = lr ? a.x + NODE_W : a.x + NODE_W / 2;
    const sy = lr ? a.y + NODE_H / 2 : a.y + NODE_H;
    const tx = lr ? b.x : b.x + NODE_W / 2;
    const ty = lr ? b.y + NODE_H / 2 : b.y;
    const c = Math.max(30, (lr ? tx - sx : ty - sy) / 2);
    const d = lr ? `M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}` : `M${sx} ${sy} C${sx} ${sy + c} ${tx} ${ty - c} ${tx} ${ty}`;
    const dash = e.inactive || e.problem ? ' stroke-dasharray="7 6"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${e.problem ? problem : edgeColor}" stroke-width="${edgeWidth(e).toFixed(1)}"${dash} marker-end="url(#${e.problem ? 'ap' : 'a'})"/>`,
    );
    const label = o.pill(e);
    if (label) {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const w = label.length * 6 + 14;
      out.push(
        `<rect x="${mx - w / 2}" y="${my - 9}" width="${w}" height="18" rx="9" fill="${th.background}" stroke="${e.problem ? problem : th.border}"/>`,
        `<text x="${mx}" y="${my + 4}" font-size="10.5" text-anchor="middle" fill="${e.problem ? problem : th.text}">${escapeXml(label)}</text>`,
      );
    }
  }
  for (const n of graph.nodes) {
    const p = at(n.id);
    const accent = n.live ? live[n.live.state] : n.checks.length ? problem : th.border;
    const dash = n.inactive ? ' stroke-dasharray="6 4"' : '';
    out.push(
      `<g>`,
      `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10" fill="${th.surface}" stroke="${th.border}"${dash}/>`,
      `<rect x="${p.x}" y="${p.y}" width="5" height="${NODE_H}" rx="2" fill="${accent}"/>`,
      `<text x="${p.x + 14}" y="${p.y + 20}" font-size="9.5" font-weight="600" letter-spacing="0.5" fill="${th.dimmed}">${escapeXml(o.kind(n.kind).toUpperCase())}</text>`,
      `<text x="${p.x + 14}" y="${p.y + 40}" font-size="13" font-weight="600" fill="${th.text}">${escapeXml(clip(n.hidden ? o.hidden : n.label, 30))}</text>`,
      n.detail
        ? `<text x="${p.x + 14}" y="${p.y + 58}" font-size="10.5" font-family="ui-monospace, monospace" fill="${th.dimmed}">${escapeXml(clip(n.detail.split('\n')[0]!, 36))}</text>`
        : '',
      `<text x="${p.x + 14}" y="${p.y + 88}" font-size="10.5" fill="${n.live ? live[n.live.state] : n.checks.length ? problem : th.dimmed}">${escapeXml(clip(o.status(n), 38))}</text>`,
      `</g>`,
    );
  }
  return { svg: svgDocument({ width, height, title: o.title, subtitle: o.subtitle, body: out.join(''), defs }), width, height: height + 44 };
}
