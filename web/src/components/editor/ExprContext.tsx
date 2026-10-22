import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ProcessDefinition, ScopeHints } from '@sm/shared';
import { buildSuggestions, type Suggestion } from './exprAssist';
import { useScopeHints } from './editorApi';

export interface ExprContextValue {
  /** Undefined for processes that are not saved yet – no live preview then. */
  processId?: string;
  def?: ProcessDefinition;
  /** Node whose fields are being edited (preview uses vars just before it ran). */
  nodeId?: string;
  scope?: ScopeHints;
  /** false = plain inputs (e.g. comments) */
  enabled: boolean;
  suggestions: Suggestion[];
}

const ExprContext = createContext<ExprContextValue>({ enabled: false, suggestions: [] });

export const useExprContext = () => useContext(ExprContext);

/** Provides definition + scope hints to every expression field of the process editor. */
export function ExprProvider({ processId, def, children }: { processId?: string; def: ProcessDefinition; children: ReactNode }) {
  const scope = useScopeHints(processId);
  const value = useMemo<ExprContextValue>(
    () => ({ processId, def, scope: scope.data, enabled: true, suggestions: buildSuggestions(def, scope.data, undefined) }),
    [processId, def, scope.data],
  );
  return <ExprContext.Provider value={value}>{children}</ExprContext.Provider>;
}

/** Narrows the context to one node (loop variables of enclosing for-each nodes, preview at that node). */
export function ExprNodeScope({ nodeId, enabled = true, children }: { nodeId: string; enabled?: boolean; children: ReactNode }) {
  const parent = useExprContext();
  const value = useMemo<ExprContextValue>(
    () => ({
      ...parent,
      nodeId,
      enabled: enabled && parent.enabled,
      suggestions: parent.def ? buildSuggestions(parent.def, parent.scope, nodeId) : parent.suggestions,
    }),
    [parent, nodeId, enabled],
  );
  return <ExprContext.Provider value={value}>{children}</ExprContext.Provider>;
}
