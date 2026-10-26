import { z } from 'zod';
import { CIA_DIMENSIONS, CIA_LEVEL_KEY_RE, SCORECARD_LIMITS, levelRank, type CiaDimension, type ScorecardRule } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, nowIso } from '../util.js';
import { forbid, me } from '../records/access.js';
import { checkLevel, currentScale, requireValidScale } from '../catalogue/cia.js';

/**
 * Expected-document rules of the scorecard (#86): "applications rated at least <level> in <dimension> should have a
 * document of <type>", e.g. an authorization concept for confidentiality "high" or above. A short list kept by
 * administrators; it starts empty (every installation has its own document types – docs/SCORECARD.md shows an
 * example). A rule whose type is no longer a document type, or whose level is no longer on the scale, is kept but
 * not applied (shown as not valid).
 */

export interface RuleRow {
  id: string;
  type_id: string;
  dimension: CiaDimension;
  min_level: string;
  enabled: number;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export const ruleInput = z
  .object({
    typeKey: z.string().trim().min(1).max(40),
    dimension: z.enum(CIA_DIMENSIONS),
    minLevel: z.string().trim().regex(CIA_LEVEL_KEY_RE),
    enabled: z.boolean().default(true),
    note: z.string().trim().max(SCORECARD_LIMITS.note).default(''),
  })
  .strict();
export type RuleInput = z.infer<typeof ruleInput>;

interface TypeRef {
  id: string;
  key: string;
  name: string;
  workflow: string;
  archived: number;
}

const types = () =>
  new Map(
    db()
      .all<TypeRef>('SELECT id, key, name, workflow, archived FROM record_types')
      .map((t) => [t.id, t]),
  );

/** Whether a rule is applied: a document type that exists, and a level on the dimension's (valid) scale. */
export function ruleValid(r: RuleRow, t: TypeRef | undefined, scale = currentScale()): boolean {
  return !!t && t.workflow === 'document' && !t.archived && !scale.storedInvalid && levelRank(scale.levels[r.dimension], r.min_level) >= 0;
}

export const ruleRows = (): RuleRow[] => db().all<RuleRow>('SELECT * FROM scorecard_rules ORDER BY created_at, id');

export function listRules(): ScorecardRule[] {
  me();
  const ts = types();
  const scale = currentScale();
  return ruleRows().map((r) => {
    const t = ts.get(r.type_id);
    return {
      id: r.id,
      typeId: r.type_id,
      typeKey: t?.key ?? null,
      typeName: t?.name ?? null,
      dimension: r.dimension,
      minLevel: r.min_level,
      enabled: !!r.enabled,
      note: r.note,
      valid: ruleValid(r, t, scale),
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    };
  });
}

function resolve(input: RuleInput): TypeRef {
  const t = db().get<TypeRef>('SELECT id, key, name, workflow, archived FROM record_types WHERE key = ?', input.typeKey);
  if (!t || t.archived) throw new HttpError(400, `Record type ${input.typeKey} not found`, 'SCORECARD_RULE_TYPE_UNKNOWN', { key: input.typeKey });
  if (t.workflow !== 'document')
    throw new HttpError(400, `${input.typeKey} is not a type of living documents`, 'SCORECARD_RULE_NOT_DOCUMENT', { key: input.typeKey });
  const scale = currentScale();
  requireValidScale(scale);
  checkLevel(input.dimension, input.minLevel, scale);
  return t;
}

const canManage = () => isAdmin(currentUser());
const describe = (t: TypeRef, input: RuleInput) => `${t.key} expected for ${input.dimension} ≥ ${input.minLevel}${input.enabled ? '' : ' (off)'}`;

export function createRule(input: RuleInput): ScorecardRule[] {
  const u = me();
  if (!canManage()) forbid('change the scorecard rules', 'manageScorecardRules');
  const t = resolve(input);
  if (ruleRows().length >= SCORECARD_LIMITS.rules)
    throw new HttpError(409, `At most ${SCORECARD_LIMITS.rules} rules`, 'SCORECARD_RULE_LIMIT', { max: SCORECARD_LIMITS.rules });
  if (db().get('SELECT 1 FROM scorecard_rules WHERE type_id = ? AND dimension = ? AND min_level = ?', t.id, input.dimension, input.minLevel))
    throw new HttpError(409, 'This rule exists already', 'SCORECARD_RULE_EXISTS');
  const ruleId = newId('scr_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO scorecard_rules (id, type_id, dimension, min_level, enabled, note, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ruleId,
      t.id,
      input.dimension,
      input.minLevel,
      input.enabled ? 1 : 0,
      input.note,
      now,
      u.username,
      now,
      u.username,
    );
    audit({
      action: 'scorecard.rule_created',
      entityType: 'scorecard_rule',
      entityId: ruleId,
      summary: `Scorecard rule added: ${describe(t, input)}`,
      details: { typeId: t.id, typeKey: t.key, dimension: input.dimension, minLevel: input.minLevel, enabled: input.enabled, note: input.note },
    });
  });
  return listRules();
}

function ruleRow(ruleId: string): RuleRow {
  const r = db().get<RuleRow>('SELECT * FROM scorecard_rules WHERE id = ?', ruleId);
  if (!r) throw new HttpError(404, `Rule ${ruleId} not found`, 'SCORECARD_RULE_NOT_FOUND', { id: ruleId });
  return r;
}

export function updateRule(ruleId: string, input: RuleInput): ScorecardRule[] {
  const u = me();
  if (!canManage()) forbid('change the scorecard rules', 'manageScorecardRules');
  const cur = ruleRow(ruleId);
  const t = resolve(input);
  if (
    db().get('SELECT 1 FROM scorecard_rules WHERE type_id = ? AND dimension = ? AND min_level = ? AND id <> ?', t.id, input.dimension, input.minLevel, ruleId)
  )
    throw new HttpError(409, 'This rule exists already', 'SCORECARD_RULE_EXISTS');
  db().tx(() => {
    db().run(
      'UPDATE scorecard_rules SET type_id = ?, dimension = ?, min_level = ?, enabled = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      t.id,
      input.dimension,
      input.minLevel,
      input.enabled ? 1 : 0,
      input.note,
      nowIso(),
      u.username,
      ruleId,
    );
    audit({
      action: 'scorecard.rule_updated',
      entityType: 'scorecard_rule',
      entityId: ruleId,
      summary: `Scorecard rule changed: ${describe(t, input)}`,
      details: {
        before: { typeId: cur.type_id, dimension: cur.dimension, minLevel: cur.min_level, enabled: !!cur.enabled, note: cur.note },
        after: { typeId: t.id, dimension: input.dimension, minLevel: input.minLevel, enabled: input.enabled, note: input.note },
      },
    });
  });
  return listRules();
}

export function deleteRule(ruleId: string): ScorecardRule[] {
  me();
  if (!canManage()) forbid('change the scorecard rules', 'manageScorecardRules');
  const cur = ruleRow(ruleId);
  db().tx(() => {
    db().run('DELETE FROM scorecard_rules WHERE id = ?', ruleId);
    audit({
      action: 'scorecard.rule_deleted',
      entityType: 'scorecard_rule',
      entityId: ruleId,
      summary: `Scorecard rule removed (${cur.dimension} ≥ ${cur.min_level})`,
      details: { typeId: cur.type_id, dimension: cur.dimension, minLevel: cur.min_level },
    });
  });
  return listRules();
}
