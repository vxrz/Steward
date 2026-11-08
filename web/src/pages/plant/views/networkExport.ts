import type { PlantFlowEdge, PlantFlowGraph, PlantFlowNode, ZoneLevel } from '@sm/shared';
import { clip, cssColor, escapeXml, exportTheme, svgDocument } from './exportImage';
import { edgeWidth } from './FlowGraph';
import type { NetLayout } from './networkLayout';

/**
 * The OT network diagram as a standalone SVG (#230), in the layout of the screen: the bands with their levels, zones
 * and VLANs as boxes, the parts as chips with their status in words, the conduits as gates, the ways with their
 * protocols. The theme's colours resolved; no animation (a picture for documents). The PNG is drawn from it.
 */
export function networkSvg(
  graph: PlantFlowGraph,
  layout: NetLayout,
  o: {
    title: string;
    subtitle: string;
    kind: (n: PlantFlowNode) => string;
    status: (n: PlantFlowNode) => string;
    pill: (e: PlantFlowEdge) => string;
    hidden: string;
    outside: string;
    level: (l: ZoneLevel) => { short: string; name: string };
  },
): { svg: string; width: number; height: number } {
  const th = exportTheme();
  const edgeColor = cssColor('--pv-edge', '#adb5bd');
  const problem = cssColor('--pv-problem', '#fa5252');
  const warn = cssColor('--pv-warn', '#e8590c');
  const conduit = cssColor('--pv-conduit', '#5c7cfa');
  const ok = cssColor('--pv-ok', '#2f9e44');
  const live = { ok, warn, fail: cssColor('--pv-fail', '#e03131'), unknown: cssColor('--pv-unknown', '#868e96') };
  const band = th.dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)';
  const marker = (id: string, color: string) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${color}"/></marker>`;
  const defs = [marker('a', edgeColor), marker('ap', problem), marker('aw', warn), marker('ac', conduit), marker('ao', ok)].join('');
  const out: string[] = [];
  const W = layout.width;
  for (const b of layout.bands) {
    const w = o.level(b.level);
    out.push(
      `<rect x="0" y="${b.y - 34}" width="${W}" height="${b.h + 68}" fill="${band}" stroke="${th.border}" stroke-dasharray="4 4"/>`,
      `<text x="14" y="${b.y + 10}" font-size="13" font-weight="700" fill="${th.text}">${escapeXml(w.short)}</text>`,
      `<text x="14" y="${b.y + 26}" font-size="11.5" fill="${th.dimmed}">${escapeXml(clip(w.name, 18))}</text>`,
    );
  }
  if (layout.outside) {
    const r = layout.outside;
    out.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="12" fill="none" stroke="${th.border}" stroke-width="1.5" stroke-dasharray="6 4"/>`,
      `<text x="${r.x + 12}" y="${r.y + 18}" font-size="12" font-weight="600" fill="${th.dimmed}">${escapeXml(o.outside)}</text>`,
    );
  }
  const areas = graph.nodes.filter((n) => (n.kind === 'zone' || n.kind === 'vlan') && layout.rects.has(n.id));
  areas.sort((a, b) => (a.kind === 'zone' ? 0 : 1) - (b.kind === 'zone' ? 0 : 1));
  for (const n of areas) {
    const r = layout.rects.get(n.id)!;
    const zone = n.kind === 'zone';
    const text = `${o.kind(n)} ${n.hidden ? o.hidden : n.label}${n.tags?.length ? ` · ${n.tags.join(' · ')}` : ''}`;
    out.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${zone ? 12 : 10}" fill="${zone ? cssColor('--pv-zone-bg', th.surface) : cssColor('--pv-vlan-bg', th.surface)}" stroke="${zone ? conduit : th.border}" stroke-width="${zone ? 1.5 : 1}"/>`,
    );
    if (zone)
      out.push(
        `<rect x="${r.x + 10}" y="${r.y - 10}" width="${Math.min(r.w - 20, text.length * 6.2 + 18)}" height="20" rx="10" fill="${th.background}" stroke="${conduit}"/>`,
        `<text x="${r.x + 19}" y="${r.y + 4}" font-size="11" font-weight="600" fill="${th.text}">${escapeXml(clip(text, Math.floor((r.w - 38) / 6.2)))}</text>`,
      );
    else
      out.push(
        `<text x="${r.x + 10}" y="${r.y + 17}" font-size="11" font-weight="600" fill="${th.text}">${escapeXml(clip(text, Math.floor((r.w - 20) / 6.2)))}</text>`,
      );
  }
  const labels: string[] = [];
  // labels that would cover another are left out (the table has them all)
  const taken: { x: number; y: number; w: number }[] = [];
  for (const e of graph.edges) {
    const g = layout.edges.get(e.id);
    if (!g) continue;
    const bad = e.problem || e.live === 'offline';
    const color = bad ? problem : e.noConduit ? warn : e.conduit ? conduit : e.live === 'online' ? ok : edgeColor;
    const m = bad ? 'ap' : e.noConduit ? 'aw' : e.conduit ? 'ac' : e.live === 'online' ? 'ao' : 'a';
    const dash = e.inactive || e.problem || e.noConduit ? ' stroke-dasharray="7 6"' : '';
    out.push(
      `<path d="${g.d}" fill="none" stroke="${color}" stroke-width="${e.conduit ? 8 : edgeWidth(e).toFixed(1)}"${dash} marker-end="url(#${m})"${e.both ? ` marker-start="url(#${m})"` : ''}${e.conduit ? ' stroke-opacity="0.55"' : ''}/>`,
    );
    const label = e.conduit ? '' : o.pill(e);
    const w = label.length * 5.8 + 12;
    if (label && !taken.some((t) => Math.abs(t.x - g.mx) < (t.w + w) / 2 + 4 && Math.abs(t.y - g.my) < 18)) {
      taken.push({ x: g.mx, y: g.my, w });
      labels.push(
        `<rect x="${g.mx - w / 2}" y="${g.my - 8}" width="${w}" height="16" rx="8" fill="${th.background}" stroke="${bad ? problem : e.noConduit ? warn : th.border}"/>`,
        `<text x="${g.mx}" y="${g.my + 3.5}" font-size="10" text-anchor="middle" fill="${bad ? problem : th.text}">${escapeXml(label)}</text>`,
      );
    }
  }
  for (const n of graph.nodes) {
    if (n.kind === 'zone' || n.kind === 'vlan') continue;
    const r = layout.rects.get(n.id);
    if (!r) continue;
    const name = n.hidden ? o.hidden : n.label;
    if (n.kind === 'conduit') {
      out.push(
        `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${r.h / 2}" fill="${th.background}" stroke="${conduit}" stroke-width="2"/>`,
        `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 4}" font-size="11.5" font-weight="600" text-anchor="middle" fill="${th.text}">${escapeXml(clip(name, 22))}</text>`,
      );
      continue;
    }
    const accent = n.live ? live[n.live.state] : n.checks.length ? problem : th.border;
    out.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="8" fill="${th.surface}" stroke="${th.border}"${n.inactive ? ' stroke-dasharray="6 4"' : ''}/>`,
      `<rect x="${r.x}" y="${r.y}" width="4" height="${r.h}" rx="2" fill="${accent}"/>`,
      `<text x="${r.x + 11}" y="${r.y + 14}" font-size="8.5" font-weight="600" letter-spacing="0.4" fill="${th.dimmed}">${escapeXml(o.kind(n).toUpperCase())}</text>`,
      `<text x="${r.x + 11}" y="${r.y + 30}" font-size="12" font-weight="600" fill="${th.text}">${escapeXml(clip(name, 24))}</text>`,
      `<text x="${r.x + 11}" y="${r.y + 44}" font-size="9.5" fill="${n.live ? live[n.live.state] : th.dimmed}">${escapeXml(clip(n.live || n.checks.length ? o.status(n) : (n.detail.split('\n')[0] ?? ''), 32))}</text>`,
    );
  }
  out.push(...labels);
  return {
    svg: svgDocument({ width: W, height: layout.height, title: o.title, subtitle: o.subtitle, body: out.join(''), defs }),
    width: W,
    height: layout.height + 44,
  };
}
