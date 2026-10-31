/**
 * Vega-Lite chart of a dataset (#120). Loaded on demand, so dashboards without such a widget never download Vega.
 *
 * Safe by construction:
 * - expressions run in vega-interpreter (no code generation, the CSP needs no `unsafe-eval`)
 * - the loader refuses every request, so nothing is fetched even if a spec tried
 * - the only data is the rows handed in, under the name "dataset"
 */
import { useEffect, useRef } from 'react';
import { useComputedColorScheme } from '@mantine/core';
import { compile, type TopLevelSpec } from 'vega-lite';
import { Error as VEGA_LOG_ERROR, None as VEGA_LOG_NONE, View, logger, loader as vegaLoader, parse, scheme } from 'vega';
import { expressionInterpreter } from 'vega-interpreter';
import { VEGA_DATA_NAME } from '@sm/shared';

const STATUS_ORDER = ['good', 'warning', 'serious', 'critical', 'unknown'] as const;

function blockedLoader() {
  const l = vegaLoader();
  const refuse = () => Promise.reject(new Error('Dashboard charts load nothing'));
  return Object.assign(l, { load: refuse, sanitize: refuse, http: refuse, file: refuse });
}

/** Colours, fonts and lines of the other dashboard charts, read from the chart tokens of the current theme. */
function themeConfig(root: Element): Record<string, unknown> {
  const style = getComputedStyle(root);
  const c = (name: string) => style.getPropertyValue(`--viz-${name}`).trim();
  const series = [1, 2, 3, 4, 5, 6].map((i) => c(`series-${i}`));
  // named schemes a spec can use: "steward" (series colours) and "steward-status" (in the order good … unknown)
  scheme('steward', series);
  scheme(
    'steward-status',
    STATUS_ORDER.map((s) => c(s)),
  );
  const text = c('text-secondary');
  return {
    background: 'transparent',
    font: style.fontFamily,
    view: { stroke: null },
    axis: { domainColor: c('axis'), tickColor: c('axis'), gridColor: c('grid'), labelColor: text, titleColor: text, titleFontWeight: 500 },
    legend: { labelColor: text, titleColor: text },
    header: { labelColor: text, titleColor: text },
    title: { color: c('text-primary'), subtitleColor: text },
    text: { color: c('text-primary') },
    mark: { color: series[0] },
    range: { category: series },
  };
}

/** The spec's own config wins over the theme, key by key. */
function mergeConfig(base: Record<string, unknown>, own: unknown): Record<string, unknown> {
  if (!own || typeof own !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(own)) {
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v) ? { ...b, ...v } : v;
  }
  return out;
}

export default function VegaChart({
  spec,
  rows,
  label,
  onError,
}: {
  spec: Record<string, unknown>;
  rows: Record<string, unknown>[];
  label: string;
  onError: (message: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const colorScheme = useComputedColorScheme('light');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let view: View | undefined;
    let done = false;
    try {
      const own = spec.config;
      const full = {
        width: 'container',
        height: 220,
        description: label,
        ...spec,
        datasets: { [VEGA_DATA_NAME]: rows },
        data: { name: VEGA_DATA_NAME },
        autosize: { type: 'fit', contains: 'padding' },
        config: mergeConfig(themeConfig(el.closest('.viz-root') ?? el), own),
      } as unknown as TopLevelSpec;
      const compiled = compile(full, { logger: logger(VEGA_LOG_NONE) }).spec;
      view = new View(parse(compiled, undefined, { ast: true }), {
        expr: expressionInterpreter,
        renderer: 'svg',
        container: el,
        hover: true,
        loader: blockedLoader(),
        logLevel: VEGA_LOG_ERROR,
      });
      view.runAsync().catch((e: Error) => !done && onError(e.message));
    } catch (e) {
      onError((e as Error).message);
    }
    return () => {
      done = true;
      view?.finalize();
    };
  }, [spec, rows, label, colorScheme, onError]);

  // Vega names this container itself: role graphics-document, aria-label from the spec's description (default: the title)
  return <div ref={ref} className="vega-chart" style={{ width: '100%', minWidth: 0 }} />;
}
