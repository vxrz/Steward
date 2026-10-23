import jsonata from 'jsonata';
import type { ZodError } from 'zod';
import {
  CHECK_TYPES,
  definitionIssues,
  monitorDefinitionSchema,
  monitorFileSchema,
  templateParamSchema,
  type MonitorDefinition,
  type TemplateParam,
} from '@sm/shared';
import { HttpError } from '../util.js';
import { renderTemplate, sampleParams } from './templates.js';

/** Validation of monitor definitions, templates and monitor files (no database access; used by the CLI too). */

export function zodMessage(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export function parseDefinitionInput(raw: unknown): MonitorDefinition {
  const r = monitorDefinitionSchema.safeParse(raw);
  if (!r.success) throw new HttpError(400, `Invalid monitor definition – ${zodMessage(r.error)}`, 'MONITOR_INVALID', { details: zodMessage(r.error) });
  return r.data;
}

/** JSONata syntax of conditions, status expressions, timestamps and process input mappings. */
export function checkExpressions(def: MonitorDefinition): void {
  const exprs: [string, string | undefined][] = [];
  for (const c of def.checks) {
    if ('condition' in c) exprs.push([`${c.id}.condition`, c.condition]);
    if (c.type === 'heartbeat') exprs.push([`${c.id}.statusExpression`, c.statusExpression]);
    if (c.type === 'freshness') exprs.push([`${c.id}.timestamp`, c.timestamp]);
  }
  for (const o of def.outputs) if (o.type === 'process') for (const [k, v] of Object.entries(o.inputs)) exprs.push([`outputs.${o.id}.inputs.${k}`, v]);
  for (const [where, e] of exprs) {
    if (!e?.trim()) continue;
    try {
      jsonata(e);
    } catch (err) {
      throw new HttpError(400, `${where}: invalid expression – ${(err as Error).message}`, 'EXPRESSION_INVALID', { where, detail: (err as Error).message });
    }
  }
}

/** Templates: the stored definition may hold {{ params.x }} anywhere; it must render into a valid definition. */
export async function validateTemplate(raw: unknown): Promise<{ def: Record<string, unknown>; parameters: TemplateParam[] }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Invalid template definition', 'TEMPLATE_INVALID', { context: 'shape' });
  const def = raw as Record<string, unknown>;
  const params = (Array.isArray(def.parameters) ? def.parameters : []).map((p, i) => {
    const r = templateParamSchema.safeParse(p);
    if (!r.success)
      throw new HttpError(400, `Template parameter ${i + 1}: ${zodMessage(r.error)}`, 'TEMPLATE_PARAM_INVALID', { n: i + 1, details: zodMessage(r.error) });
    return r.data;
  });
  if (new Set(params.map((p) => p.name)).size !== params.length)
    throw new HttpError(400, 'Template parameter names must be unique', 'TEMPLATE_PARAM_DUPLICATE');
  const sample = parseDefinitionInput(await renderTemplate(def, sampleParams(params)));
  const issues = definitionIssues(sample);
  if (issues.length) {
    const details = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new HttpError(400, `Template: ${details}`, 'TEMPLATE_INVALID', { details });
  }
  checkExpressions(sample);
  return { def: { ...def, parameters: params }, parameters: params };
}

/** Validation of a monitor file (examples/monitors/*.yaml, `npm run validate`). */
export async function validateMonitorFile(raw: unknown): Promise<{ ok: boolean; issues: string[]; kind?: string; checks?: number }> {
  const obj = (raw ?? {}) as Record<string, unknown>;
  try {
    if (obj.kind === 'monitorTemplate') {
      const { kind: _k, key: _key, enabled: _e, ...def } = obj;
      const t = await validateTemplate(def);
      return { ok: true, issues: [], kind: 'monitorTemplate', checks: Array.isArray(t.def.checks) ? t.def.checks.length : 0 };
    }
    const r = monitorFileSchema.safeParse(raw);
    if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    const def = r.data;
    const issues = definitionIssues(def).map((i) => `${i.path}: ${i.message}`);
    checkExpressions(def);
    for (const c of def.checks) if (!(CHECK_TYPES as readonly string[]).includes(c.type)) issues.push(`${c.id}: unknown type`);
    return { ok: !issues.length, issues, kind: 'monitor', checks: def.checks.length };
  } catch (e) {
    return { ok: false, issues: [(e as Error).message] };
  }
}
