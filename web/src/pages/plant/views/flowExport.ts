import type { PlantFlowGraph } from '@sm/shared';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from './exportImage';
import { NODE_W, edgeWidth, flowLayout, nodeHeight } from './FlowGraph';

/**
 * A graph as a standalone SVG (#230): the same layout as on the screen, the theme's colours resolved, statuses in
 * words beside their colour, dashed ways that are not active or fail a check, areas (zones, VLANs) as boxes with their
 * names. No animation (a picture for documents).
 */
export function flowSvg(
  graph: PlantFlowGraph,
  o: {
    title: string;
    subtitle: string;
    kind: (n: PlantFlowGraph['nodes'][number]) => string;
    status: (n: PlantFlowGraph['nodes'][number]) => string;
    pill: (e: PlantFlowGraph['edges'][number]) => string;
    hidden: string;
  },
): { svg: string; width: number; height: number } {
  const th = exportTheme();
  const layout = flowLayout(graph);
  const lr = layout.dir === 'LR';
  // every node's box: a leaf's position and size, an area's box
  const box = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of graph.nodes) {
    const b = n.group ? layout.boxes.get(n.id) : undefined;
    const p = layout.pos.get(n.id);
    if (b) box.set(n.id, { x: b.x, y: b.y, w: b.width, h: b.height });
    else if (p) box.set(n.id, { x: p.x, y: p.y, w: NODE_W, h: nodeHeight(n) });
  }
  const all = [...box.values()];
  const minX = Math.min(...all.map((b) => b.x), 0);
  const minY = Math.min(...all.map((b) => b.y), 0);
  const width = Math.max(...all.map((b) => b.x + b.w), NODE_W) - minX + 32;
  const height = Math.max(...all.map((b) => b.y + b.h), 0) - minY + 40;
  const at = (id: string) => {
    const b = box.get(id) ?? { x: 0, y: 0, w: NODE_W, h: 0 };
    return { x: b.x - minX + 16, y: b.y - minY + 24, w: b.w, h: b.h };
  };
  const edgeColor = cssColor('--pv-edge', '#adb5bd');
  const problem = cssColor('--pv-problem', '#fa5252');
  const warn = cssColor('--pv-warn', '#e8590c');
  const conduit = cssColor('--pv-conduit', '#5c7cfa');
  const live = { ok: cssColor('--pv-ok', '#2f9e44'), warn, fail: cssColor('--pv-fail', '#e03131'), unknown: cssColor('--pv-unknown', '#868e96') };
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`;
  const defs = [marker('a', edgeColor), marker('ap', problem), marker('aw', warn), marker('ac', conduit)].join('');
  const out: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // areas first, outer before inner
  const depth = (id: string) => {
    let d = 0;
    for (let p = byId.get(id)?.parent; p && d < 8; p = byId.get(p)?.parent) d++;
    return d;
  };
  for (const n of graph.nodes.filter((x) => x.group).sort((a, b) => depth(a.id) - depth(b.id))) {
    const b = at(n.id);
    const zone = n.kind === 'zone';
    const text = `${o.kind(n)} ${n.hidden ? o.hidden : n.label}${n.tags?.length ? ` · ${n.tags.join(' · ')}` : ''}`;
    out.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="12" fill="${zone ? cssColor('--pv-zone-bg', th.surface) : cssColor('--pv-vlan-bg', th.surface)}" stroke="${zone ? conduit : th.border}" stroke-width="${zone ? 1.5 : 1}"/>`,
      `<rect x="${b.x + 12}" y="${b.y - 9}" width="${Math.min(b.w - 24, text.length * 6.3 + 16)}" height="18" rx="9" fill="${th.background}" stroke="${zone ? conduit : th.border}"/>`,
      `<text x="${b.x + 20}" y="${b.y + 4}" font-size="10.5" font-weight="600" fill="${th.text}">${escapeXml(clip(text, Math.floor((b.w - 40) / 6.3)))}</text>`,
    );
  }
  for (const e of graph.edges) {
    const a = at(e.from);
    const b = at(e.to);
    const sx = lr ? a.x + a.w : a.x + a.w / 2;
    const sy = lr ? a.y + a.h / 2 : a.y + a.h;
    const tx = lr ? b.x : b.x + b.w / 2;
    const ty = lr ? b.y + b.h / 2 : b.y;
    const c = Math.max(30, Math.abs(lr ? tx - sx : ty - sy) / 2);
    const d = lr ? `M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}` : `M${sx} ${sy} C${sx} ${sy + c} ${tx} ${ty - c} ${tx} ${ty}`;
    const bad = e.problem || e.live === 'offline';
    const color = bad ? problem : e.noConduit ? warn : e.conduit ? conduit : edgeColor;
    const m = bad ? 'ap' : e.noConduit ? 'aw' : e.conduit ? 'ac' : 'a';
    const dash = e.inactive || e.problem || e.noConduit ? ' stroke-dasharray="7 6"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${edgeWidth(e).toFixed(1)}"${dash} marker-end="url(#${m})"${e.both ? ` marker-start="url(#${m})"` : ''}${e.conduit ? ' stroke-opacity="0.55"' : ''}/>`,
    );
    const label = o.pill(e);
    if (label) {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const w = label.length * 6 + 14;
      out.push(
        `<rect x="${mx - w / 2}" y="${my - 9}" width="${w}" height="18" rx="9" fill="${th.background}" stroke="${bad ? problem : e.noConduit ? warn : th.border}"/>`,
        `<text x="${mx}" y="${my + 4}" font-size="10.5" text-anchor="middle" fill="${bad ? problem : th.text}">${escapeXml(label)}</text>`,
      );
    }
  }
  for (const n of graph.nodes.filter((x) => !x.group)) {
    const p = at(n.id);
    const accent = n.live ? live[n.live.state] : n.checks.length ? problem : th.border;
    const dash = n.inactive ? ' stroke-dasharray="6 4"' : '';
    out.push(
      `<g>`,
      `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${p.h}" rx="10" fill="${th.surface}" stroke="${th.border}"${dash}/>`,
      `<rect x="${p.x}" y="${p.y}" width="5" height="${p.h}" rx="2" fill="${accent}"/>`,
      `<text x="${p.x + 14}" y="${p.y + 20}" font-size="9.5" font-weight="600" letter-spacing="0.5" fill="${th.dimmed}">${escapeXml(o.kind(n).toUpperCase())}</text>`,
      `<text x="${p.x + 14}" y="${p.y + 40}" font-size="13" font-weight="600" fill="${th.text}">${escapeXml(clip(n.hidden ? o.hidden : n.label, 30))}</text>`,
      n.detail && !n.small
        ? `<text x="${p.x + 14}" y="${p.y + 58}" font-size="10.5" font-family="ui-monospace, monospace" fill="${th.dimmed}">${escapeXml(clip(n.detail.split('\n')[0]!, 36))}</text>`
        : '',
      `<text x="${p.x + 14}" y="${p.y + p.h - 14}" font-size="10.5" fill="${n.live ? live[n.live.state] : n.checks.length ? problem : th.dimmed}">${escapeXml(clip(o.status(n), 38))}</text>`,
      `</g>`,
    );
  }
  return { svg: svgDocument({ width, height, title: o.title, subtitle: o.subtitle, body: out.join(''), defs }), width, height: height + 44 };
}
