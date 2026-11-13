import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { DataGraphColumn, DataGraphEdge, DataGraphNode } from '@sm/shared';

/** The words of the data products pictures: a node's kind, name and status as a sentence, an edge's text, a column's name. */

type T = TFunction<'dataProductViews'>;

export interface GraphText {
  kind: (n: DataGraphNode) => string;
  label: (n: DataGraphNode) => string;
  status: (n: DataGraphNode) => string;
  aria: (n: DataGraphNode) => string;
  edge: (e: DataGraphEdge) => string;
  edgeAria: (e: DataGraphEdge, name: (id: string) => string) => string;
  column: (c: DataGraphColumn) => string;
  t: T;
}

export function graphText(t: T): GraphText {
  const kind = (n: DataGraphNode): string => {
    switch (n.kind) {
      case 'element':
        return n.elementKind ? t(`elementKinds.${n.elementKind}`) : t('kinds.element');
      case 'step':
        return n.stepKind ? t('kinds.stepOf', { kind: t(`stepKinds.${n.stepKind}`) }) : t('kinds.step');
      case 'collapsed':
        return n.collapsedBy === 'domain' || n.collapsedBy === 'noDomain' ? t('kinds.products') : t('kinds.elements');
      default:
        return t(`kinds.${n.kind}`);
    }
  };
  const label = (n: DataGraphNode): string => {
    if (n.kind === 'collapsed') {
      const count = n.count ?? 0;
      switch (n.collapsedBy) {
        case 'parent':
          return t('collapsed.parent', { count, name: n.label });
        case 'column':
          return t('collapsed.column', { count });
        case 'domain':
          return t('collapsed.domain', { count, name: n.label });
        case 'noDomain':
          return t('collapsed.noDomain', { count });
        default:
          return t('collapsed.hidden', { count });
      }
    }
    if (n.hidden) return t(`hidden.${n.kind === 'product' || n.kind === 'step' || n.kind === 'plant' ? n.kind : 'element'}`);
    return n.label;
  };
  const status = (n: DataGraphNode): string => {
    const out: string[] = [];
    if (n.health) out.push(t('aria.health', { status: t(`health.${n.health}`) }));
    if (n.checks && (n.checks.visible || n.checks.hidden)) out.push(t('aria.checks', { count: n.checks.visible + n.checks.hidden }));
    if (n.missing) out.push(t('node.missing'));
    if (n.kind === 'product' && n.lifecycle) out.push(t(`lifecycle.${n.lifecycle}`));
    return out.join(', ');
  };
  const aria = (n: DataGraphNode): string => {
    const parts = [`${kind(n)}: ${label(n)}${n.detail && !n.hidden ? `, ${n.detail}` : ''}.`];
    if (n.role) parts.push(t('aria.role', { role: t(`roles.${n.role}`) }));
    if (n.layer) parts.push(t('aria.layer', { layer: n.layer }));
    if (n.outside && n.kind === 'element') parts.push(n.products?.length ? t('aria.inProducts', { names: n.products.join(', ') }) : t('aria.outside'));
    if (n.outside && n.kind === 'product') parts.push(t('aria.outsideFilter'));
    if (n.distance !== undefined && n.distance !== 0)
      parts.push(n.distance < 0 ? t('aria.upstream', { count: -n.distance }) : t('aria.downstream', { count: n.distance }));
    const s = status(n);
    if (s) parts.push(`${s}.`);
    if (n.path) parts.push(t('aria.opens'));
    return parts.join(' ');
  };
  const edge = (e: DataGraphEdge): string => {
    if (e.hidden) return '';
    const more = e.count - e.labels.length;
    const names = e.labels.join(', ');
    const text = more > 0 ? (names ? t('edge.more', { names, count: more }) : t('edge.count', { count: e.count })) : names;
    return e.deprecated ? [t('edge.deprecated'), text].filter(Boolean).join(' · ') : text;
  };
  const edgeAria = (e: DataGraphEdge, name: (id: string) => string): string =>
    [t('edge.from', { from: name(e.from), to: name(e.to) }), e.hidden ? t('hidden.step') : edge(e)].filter(Boolean).join(', ');
  const column = (c: DataGraphColumn): string => (c.kind === 'layer' ? c.layer || t('columns.noLayer') : t(`columns.${c.kind}`));
  return { kind, label, status, aria, edge, edgeAria, column, t };
}

export function useGraphText(): GraphText {
  const { t } = useTranslation('dataProductViews');
  return useMemo(() => graphText(t), [t]);
}
