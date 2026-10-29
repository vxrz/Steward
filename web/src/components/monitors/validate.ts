import { checkIssueTarget, definitionIssues, issueLabel, monitorDefinitionSchema, type MonitorDefinition } from '@sm/shared';

/** A problem of a monitor definition as the editor shows it: on the card's field and in the summary (#141). */
export interface EditorIssue {
  path: string;
  /** Index of the check in `def.checks`, null for monitor-wide problems */
  index: number | null;
  /** The check's field, null when the problem is about the whole card */
  field: string | null;
  message: string;
  /** "Check "Name" (id) – field" */
  label: string;
}

const toIssue = (def: unknown, path: string, message: string): EditorIssue => {
  const target = checkIssueTarget(path);
  return { path, index: target?.index ?? null, field: target?.field ?? null, message, label: issueLabel(def, path) };
};

/**
 * The same validation as the server: the definition schema from `@sm/shared` and its structural rules (unique ids,
 * links, required fields per check type and mode). Positions and unknown extras do not matter here.
 */
export function editorIssues(def: MonitorDefinition): EditorIssue[] {
  const parsed = monitorDefinitionSchema.safeParse(def);
  const out: EditorIssue[] = parsed.success ? [] : parsed.error.issues.map((i) => toIssue(def, i.path.join('.'), i.message));
  try {
    for (const i of definitionIssues(parsed.success ? parsed.data : def)) out.push(toIssue(def, i.path, i.message));
  } catch {
    /* an incomplete definition: the schema issues say enough */
  }
  // one message per field
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.path) ? false : (seen.add(i.path), true)));
}

/** Issues by check index, then by field ('' for the whole card). */
export function issuesByCheck(issues: EditorIssue[]): Map<number, Map<string, string>> {
  const m = new Map<number, Map<string, string>>();
  for (const i of issues) {
    if (i.index === null) continue;
    const f = m.get(i.index) ?? new Map<string, string>();
    if (!f.has(i.field ?? '')) f.set(i.field ?? '', i.message);
    m.set(i.index, f);
  }
  return m;
}

/** Issues the server returned (`issues` of a MONITOR_INVALID error) in the editor's form. */
export function serverIssues(def: MonitorDefinition, issues: { path: string; message: string }[]): EditorIssue[] {
  return issues.map((i) => {
    const target = checkIssueTarget(i.path);
    return { path: i.path, index: target?.index ?? null, field: target?.field ?? null, message: i.message, label: issueLabel(def, i.path) };
  });
}
