import { z } from 'zod';
import type { StepUpAction } from './api.js';
import { boundedRecord } from './zodLimits.js';

/**
 * Assurance policy (#210, docs/ASSURANCE.md): one catalogue of the control points where Steward can require a second
 * person (four-eyes) and/or a fresh confirmation of the signed-in person (step-up), the rules an administrator sets
 * for them, and the baseline nobody can lower.
 *
 * The effective rule of a point is the strictest of three: the baseline (fixed in code), the instance policy
 * (Settings → Assurance policy) and – where the point has them – the overrides of single items (a process step, a
 * platform's MCP mode, a person review, a setting). Overrides only ever add to the rule (max), never take away.
 */

export const CONTROL_POINT_GROUPS = ['identity', 'audit', 'records', 'processes', 'mcp', 'catalogue', 'system'] as const;
export type ControlPointGroup = (typeof CONTROL_POINT_GROUPS)[number];

/** Four-eyes: off (only where an item asks for it) · optional (each item decides: its own switch) · required (always). */
export const FOUR_EYES_LEVELS = ['off', 'optional', 'required'] as const;
export type FourEyesLevel = (typeof FOUR_EYES_LEVELS)[number];
export const FOUR_EYES_RANK: Record<FourEyesLevel, number> = { off: 0, optional: 1, required: 2 };

/** Where the overrides of single items live (listed on the policy page with a link). */
export const ASSURANCE_OVERRIDE_KINDS = ['recordType', 'processStep', 'manualStep', 'platformMcp', 'personReview', 'setting', 'process', 'soa'] as const;
export type AssuranceOverrideKind = (typeof ASSURANCE_OVERRIDE_KINDS)[number];

export interface ControlPoint {
  /** Stable key (audit entries and the policy name it) */
  key: string;
  group: ControlPointGroup;
  /** The step-up actions of the routes this point governs (route config `stepUp.action`) */
  actions: readonly StepUpAction[];
  /** teams: may be decided in a Microsoft Teams card (0.10.0, ADR 0013) – only points without a step-up */
  supports: { fourEyes: boolean; stepUp: boolean; teams?: boolean };
  /** The floor: what is always enforced (the policy page shows it locked) */
  baseline: { fourEyes?: 'required'; stepUp?: true };
  /** The rule of a new installation – exactly what 0.4.0 enforced */
  defaults: { fourEyes?: FourEyesLevel; stepUp: boolean; teams?: boolean };
  /** The four-eyes levels an administrator can choose (points that support four-eyes) */
  fourEyesLevels?: readonly FourEyesLevel[];
  /** Where single items add to the rule */
  overrides?: AssuranceOverrideKind;
  /** The point exists in the catalogue but nothing reaches it yet (e.g. a record type that is not installed) */
  inert?: boolean;
}

const BOTH: readonly FourEyesLevel[] = ['optional', 'required'];
const ONOFF: readonly FourEyesLevel[] = ['off', 'required'];
const LOCKED: readonly FourEyesLevel[] = ['required'];

const sp = (key: string, group: ControlPointGroup, actions: StepUpAction[], baseline = false): ControlPoint => ({
  key,
  group,
  actions,
  supports: { fourEyes: false, stepUp: true },
  baseline: baseline ? { stepUp: true } : {},
  defaults: { stepUp: true },
});

/**
 * Every control point (docs/ASSURANCE.md lists them; server/test/assurance.test.ts keeps the table in sync). Label and
 * description: `assurance:points.<key>.label` / `.description` in the web app.
 */
export const CONTROL_POINTS: readonly ControlPoint[] = [
  // ---- identity and access ----
  sp('apiToken.create', 'identity', ['createToken'], true),
  sp('user.create', 'identity', ['createUser'], true),
  sp('user.change', 'identity', ['changeAccount'], true),
  sp('user.resetPassword', 'identity', ['resetPassword'], true),
  sp('user.pseudonymise', 'identity', ['pseudonymiseUser'], true),
  sp('team.members', 'identity', ['changeTeamMembers'], true),
  sp('access.grant', 'identity', ['grantAccess', 'grantNamedAccess'], true),
  sp('sso.providers', 'identity', ['addSsoProvider', 'changeSsoProvider', 'deleteSsoProvider'], true),
  sp('signIn.settings', 'identity', ['changeSignInSettings'], true),
  sp('vault.passphrase', 'identity', ['changeVaultPassphrase'], true),
  {
    key: 'assurance.policy',
    group: 'identity',
    actions: ['changeAssurancePolicy'],
    supports: { fourEyes: true, stepUp: true },
    // loosening the policy needs a second administrator; every change a step-up
    baseline: { fourEyes: 'required', stepUp: true },
    defaults: { fourEyes: 'required', stepUp: true },
    fourEyesLevels: LOCKED,
  },
  {
    key: 'accessCheck.decide',
    group: 'identity',
    actions: ['decideAccessCheck'],
    supports: { fourEyes: true, stepUp: true },
    baseline: {},
    // four-eyes dismissals of findings: the setting under Settings → Catalogue (findingDismissFourEyes)
    defaults: { fourEyes: 'off', stepUp: false },
    fourEyesLevels: ONOFF,
    overrides: 'setting',
  },
  {
    // 0.14.0 (ADR 0009 step 4): using a privileged platform identity – starting a run, saving a schedule or a webhook
    // trigger, a request explorer call, approving an MCP request with one. Four-eyes is a start approval before the run:
    // off – only where a process asks (its setting "Privileged runs need a second person"); required – every such run
    key: 'platform.privilegedIdentity',
    group: 'identity',
    actions: ['usePrivilegedIdentity'],
    supports: { fourEyes: true, stepUp: true },
    baseline: {},
    defaults: { fourEyes: 'off', stepUp: true },
    fourEyesLevels: ONOFF,
    overrides: 'process',
  },
  {
    key: 'personReview.decide',
    group: 'identity',
    actions: ['decidePersonReview'],
    supports: { fourEyes: true, stepUp: true },
    baseline: {},
    defaults: { fourEyes: 'optional', stepUp: false },
    fourEyesLevels: BOTH,
    overrides: 'personReview',
  },
  // ---- audit and evidence ----
  sp('audit.anchoring', 'audit', ['changeAuditAnchoring'], true),
  sp('audit.export', 'audit', ['exportAuditLog']),
  sp('evidencePack.export', 'audit', ['exportEvidencePack']),
  sp('credentials.export', 'audit', ['exportCredentials']),
  sp('personalData.export', 'audit', ['exportPersonalData']),
  {
    // corrective actions (0.17.0, ADR 0029): who confirms that a fix worked is a second person – not the finding's owner,
    // an action's owner or who marked an action done. Required by default; an administrator may set it off
    key: 'correctiveAction.verify',
    group: 'audit',
    actions: [],
    supports: { fourEyes: true, stepUp: false },
    baseline: {},
    defaults: { fourEyes: 'required', stepUp: false },
    fourEyesLevels: ONOFF,
  },
  {
    // the statement of applicability (0.17.0, ADR 0029): approving or returning a version – approvers and administrators,
    // after a fresh confirmation. Four-eyes optional: each SoA's switch "A second person approves" (on by default); the
    // policy may require it for every SoA (the submitter then never approves). Switching an SoA's second approver off is
    // protected like approving (administrators, with the same confirmation): changeSoaApproval
    key: 'soa.approve',
    group: 'audit',
    actions: ['approveSoa', 'changeSoaApproval'],
    supports: { fourEyes: true, stepUp: true },
    baseline: {},
    defaults: { fourEyes: 'optional', stepUp: true },
    fourEyesLevels: BOTH,
    overrides: 'soa',
  },
  // ---- changes and records ----
  {
    key: 'record.approve',
    group: 'records',
    actions: ['approveRecord'],
    supports: { fourEyes: true, stepUp: true },
    // the owner, author, submitter and content authors never approve their own record
    baseline: { fourEyes: 'required' },
    defaults: { fourEyes: 'required', stepUp: false },
    fourEyesLevels: LOCKED,
    overrides: 'recordType',
  },
  {
    key: 'document.reviewOwner',
    group: 'records',
    actions: [],
    supports: { fourEyes: true, stepUp: false },
    baseline: { fourEyes: 'required' },
    defaults: { fourEyes: 'required', stepUp: false },
    fourEyesLevels: LOCKED,
  },
  {
    key: 'firewallChange.close',
    group: 'records',
    actions: ['closeFirewallChange'],
    supports: { fourEyes: false, stepUp: true },
    baseline: {},
    defaults: { stepUp: false },
    overrides: 'recordType',
  },
  // ---- processes and runs ----
  {
    key: 'run.decide',
    group: 'processes',
    actions: [],
    supports: { fourEyes: true, stepUp: false, teams: true },
    baseline: {},
    // approve-mode steps may be decided in a Microsoft Teams card (ADR 0013), also as the second person
    defaults: { fourEyes: 'optional', stepUp: false, teams: true },
    fourEyesLevels: BOTH,
    overrides: 'processStep',
  },
  // shared procedure libraries (0.10.0, #238): trusting publishers and their keys; installing a release
  sp('library.publishers', 'processes', ['changeTrustedPublishers'], true),
  // 0.19.0 (security review L1): Git sync sources – a new source, another repository or API URL (where its token goes),
  // signed commits no longer required, a new allowed signer, auto-accept turned on
  sp('sync.sources', 'processes', ['changeSyncSources']),
  {
    key: 'library.install',
    group: 'processes',
    actions: [],
    supports: { fourEyes: true, stepUp: false },
    baseline: {},
    // off: the reviewer installs; required: a second designer or administrator confirms the install (libraries/install.ts)
    defaults: { fourEyes: 'off', stepUp: false },
    fourEyesLevels: ONOFF,
  },
  {
    key: 'manualStep.verify',
    group: 'processes',
    actions: ['verifyManualStep'],
    supports: { fourEyes: true, stepUp: true },
    // whoever completed a manual step (or added its evidence) never verifies it
    baseline: { fourEyes: 'required' },
    defaults: { fourEyes: 'required', stepUp: false },
    fourEyesLevels: LOCKED,
    overrides: 'manualStep',
  },
  {
    key: 'duty.skip',
    group: 'processes',
    actions: [],
    supports: { fourEyes: true, stepUp: false },
    baseline: { fourEyes: 'required' },
    defaults: { fourEyes: 'required', stepUp: false },
    fourEyesLevels: LOCKED,
  },
  // ---- MCP and AI ----
  {
    key: 'mcp.write',
    group: 'mcp',
    actions: [],
    supports: { fourEyes: true, stepUp: false, teams: true },
    baseline: {},
    // per platform: off / confirm (the token owner) / fourEyes (a second person); required: confirm becomes fourEyes.
    // Not in Teams by default: Steward shows the concrete request (path, query, body), a card cannot (security review 0.10.0)
    defaults: { fourEyes: 'optional', stepUp: false, teams: false },
    fourEyesLevels: BOTH,
    overrides: 'platformMcp',
  },
  sp('mcp.allowWrites', 'mcp', ['allowMcpWrites']),
  sp('mcp.allowClient', 'mcp', ['allowMcpClient']),
  // raising an AI token budget or removing its limit (0.6.0, #216); lowering one needs no confirmation
  sp('ai.budget', 'mcp', ['changeAiBudget']),
  // ---- catalogue ----
  sp('catalogue.ciaScale', 'catalogue', ['changeCiaScale']),
  // raising a monthly cost budget of a service, application or team, or removing it (0.9.0, #226); lowering one needs no confirmation
  sp('cost.budget', 'catalogue', ['changeCostBudget']),
  // ---- system and data ----
  sp('notifications.delivery', 'system', ['changeNotificationDelivery']),
  {
    // the Teams bot takes decisions at all (ADR 0013, preview): turning it on loosens the policy – a second administrator
    // approves it; the switches of run.decide and mcp.write then say which decisions
    key: 'teams.bot',
    group: 'system',
    actions: [],
    supports: { fourEyes: false, stepUp: false, teams: true },
    baseline: {},
    defaults: { stepUp: false, teams: false },
  },
  sp('backup.settings', 'system', ['changeBackups']),
  // 0.16.0 (ADR 0027): a scheduled export sends readable data out of Steward to S3
  sp('export.settings', 'system', ['changeExports']),
  // 0.19.0 (security review H1): a platform's stored credentials would go to a new address – always asks
  sp('platform.destination', 'system', ['changePlatformDestination'], true),
  sp('migration.export', 'system', ['exportMigration']),
  sp('migration.apply', 'system', ['applyMigration']),
  // where the map of sites fetches its tiles from (0.10.0, #234): a new style, URL, key or file; turning it off never asks
  sp('plant.mapSource', 'system', ['changeMapSource']),
  // 0.14: adding, changing or removing a source of security advisories – Steward fetches from it
  sp('plant.advisorySources', 'system', ['changeAdvisorySources']),
  // switching a module on or off (0.11.0, ADR 0016): its routes, pages and jobs come or go for everyone
  sp('modules.switch', 'system', ['changeModules']),
  // the plant registry (0.11.0, docs/PLANT.md#changing-ids): changing one entry's id asks only when the policy says so;
  // renaming or removing more than one entry at once, or editing many, asks by default
  { ...sp('plant.renameId', 'catalogue', ['renamePlantId']), defaults: { stepUp: false } },
  sp('plant.bulkChange', 'catalogue', ['changePlantInBulk']),
  // 0.24.0 (ADR 0036 part 15, phase 2): a data products import in mode replace that removes more than one entry or list item
  sp('dataproduct.bulkChange', 'catalogue', ['changeDataProductsInBulk']),
  {
    // 0.13.0 (ADR 0020): a second person applies changes to the plant registry – off (nothing changes on upgrade),
    // optional (each site's switch "Changes need a second person", the catalogue's in the plant settings) or required.
    // Under review no author applies, administrators included; applying keeps its step-ups per source (above)
    key: 'plant.changeSet',
    group: 'catalogue',
    actions: [],
    supports: { fourEyes: true, stepUp: false },
    baseline: {},
    defaults: { fourEyes: 'off', stepUp: false },
    fourEyesLevels: ['off', 'optional', 'required'],
  },
];

export type ControlPointKey = string;

const BY_KEY = new Map(CONTROL_POINTS.map((p) => [p.key, p]));
const BY_ACTION = new Map<StepUpAction, ControlPoint>(CONTROL_POINTS.flatMap((p) => p.actions.map((a) => [a, p] as const)));

export const controlPoint = (key: string): ControlPoint | undefined => BY_KEY.get(key);
/** The control point of a route's step-up action. */
export const controlPointOfAction = (action: StepUpAction): ControlPoint | undefined => BY_ACTION.get(action);

// ---------- the policy ----------

/** The rule of one point. maxAgeMinutes: how old the confirmation may be (null: SM_STEP_UP_MINUTES, the longest). */
export interface PointRule {
  fourEyes: FourEyesLevel | null;
  stepUp: boolean;
  maxAgeMinutes: number | null;
  mfa: boolean;
  /** May be decided in Microsoft Teams (0.10.0, ADR 0013): only points that support it, never with a step-up */
  teams?: boolean;
}

/** What counts as multi-factor in an ID token (RFC 8176 amr values, acr values of the provider). */
export interface AssuranceMfaSettings {
  amrValues: string[];
  acrValues: string[];
}

/** The stored instance policy: only what differs from the defaults is kept per point. */
export interface AssurancePolicy {
  /** Counts every change (0: never changed, the defaults) */
  version: number;
  points: Record<string, Partial<PointRule>>;
  mfa: AssuranceMfaSettings;
}

export const DEFAULT_MFA_AMR = ['mfa', 'mca', 'otp', 'hwk', 'swk', 'sc', 'fido', 'ngcmfa'] as const;
export const ASSURANCE_LIMITS = { maxAgeMinutes: 24 * 60, values: 20, valueChars: 200, pendingDays: 7, comment: 1000 };

export const defaultAssurancePolicy = (): AssurancePolicy => ({ version: 0, points: {}, mfa: { amrValues: [...DEFAULT_MFA_AMR], acrValues: [] } });

const pointRuleInput = z
  .object({
    // null: the point has no four-eyes (the web app sends every point's rule as it shows it)
    fourEyes: z.enum(FOUR_EYES_LEVELS).nullable().optional(),
    stepUp: z.boolean().optional(),
    maxAgeMinutes: z.number().int().min(1).max(ASSURANCE_LIMITS.maxAgeMinutes).nullable().optional(),
    mfa: z.boolean().optional(),
    teams: z.boolean().optional(),
  })
  .strict();

const valueList = z
  .array(z.string().trim().min(1).max(ASSURANCE_LIMITS.valueChars))
  .max(ASSURANCE_LIMITS.values)
  .transform((v) => [...new Set(v)]);

/** PUT /api/assurance/policy: the whole policy (points left out get their defaults). */
export const assurancePolicyInput = z
  .object({
    points: boundedRecord(pointRuleInput, 100).default({}),
    mfa: z.object({ amrValues: valueList, acrValues: valueList }).strict().optional(),
    /** Why (kept with the change, shown to the second administrator) */
    comment: z.string().trim().max(ASSURANCE_LIMITS.comment).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const [key, r] of Object.entries(v.points)) {
      const p = controlPoint(key);
      if (!p) {
        ctx.addIssue({ code: 'custom', path: ['points', key], message: `Unknown control point "${key}"` });
        continue;
      }
      if (r.fourEyes !== undefined && r.fourEyes !== null && (!p.supports.fourEyes || !(p.fourEyesLevels ?? []).includes(r.fourEyes)))
        ctx.addIssue({ code: 'custom', path: ['points', key, 'fourEyes'], message: `"${key}" does not take four-eyes "${r.fourEyes}"` });
      if (!p.supports.stepUp && (r.stepUp || r.mfa || (r.maxAgeMinutes ?? null) !== null))
        ctx.addIssue({ code: 'custom', path: ['points', key, 'stepUp'], message: `"${key}" has no step-up` });
      if (r.teams && (!p.supports.teams || r.stepUp))
        ctx.addIssue({ code: 'custom', path: ['points', key, 'teams'], message: `"${key}" cannot be decided in Microsoft Teams` });
    }
  });
export type AssurancePolicyInput = z.input<typeof assurancePolicyInput>;

/** The instance rule of a point: the stored setting or the default, never below the baseline. */
export function instanceRule(p: ControlPoint, policy: Pick<AssurancePolicy, 'points'>): PointRule {
  const s = policy.points[p.key] ?? {};
  let fourEyes: FourEyesLevel | null = p.supports.fourEyes ? (s.fourEyes ?? p.defaults.fourEyes ?? 'off') : null;
  if (fourEyes && p.baseline.fourEyes && FOUR_EYES_RANK[fourEyes] < FOUR_EYES_RANK[p.baseline.fourEyes]) fourEyes = p.baseline.fourEyes;
  if (fourEyes && p.fourEyesLevels && !p.fourEyesLevels.includes(fourEyes)) fourEyes = p.defaults.fourEyes ?? p.fourEyesLevels[0]!;
  const stepUp = p.supports.stepUp && (!!p.baseline.stepUp || (s.stepUp ?? p.defaults.stepUp));
  return {
    fourEyes,
    stepUp,
    maxAgeMinutes: stepUp ? (s.maxAgeMinutes ?? null) : null,
    mfa: stepUp && !!s.mfa,
    // never with a step-up: Teams cannot show one (ADR 0013)
    ...(p.supports.teams ? { teams: !stepUp && (s.teams ?? p.defaults.teams ?? false) } : {}),
  };
}

/** The baseline of a point as a rule (what the policy page shows locked). */
export function baselineRule(p: ControlPoint): PointRule {
  return {
    fourEyes: p.supports.fourEyes ? (p.baseline.fourEyes ?? (p.fourEyesLevels?.[0] as FourEyesLevel | undefined) ?? 'off') : null,
    stepUp: !!p.baseline.stepUp,
    maxAgeMinutes: null,
    mfa: false,
    ...(p.supports.teams ? { teams: false } : {}),
  };
}

/** What an item adds to a point (its own four-eyes switch). */
export interface ItemOverride {
  fourEyes?: boolean;
}

/** The effective rule for one item: max(baseline, instance policy, the item's override). fourEyes: required or not. */
export function effectiveRule(
  p: ControlPoint,
  policy: Pick<AssurancePolicy, 'points'>,
  item: ItemOverride = {},
): Omit<PointRule, 'fourEyes'> & { fourEyes: boolean } {
  const r = instanceRule(p, policy);
  return { ...r, fourEyes: r.fourEyes === 'required' || (p.supports.fourEyes && !!item.fourEyes) };
}

/** The strictest rule of several points (a request that reaches more than one). */
export function strictestRule(rules: Omit<PointRule, 'fourEyes'>[]): Omit<PointRule, 'fourEyes'> {
  const on = rules.filter((r) => r.stepUp);
  const ages = on.map((r) => r.maxAgeMinutes).filter((x): x is number => x !== null);
  return { stepUp: on.length > 0, maxAgeMinutes: ages.length ? Math.min(...ages) : null, mfa: on.some((r) => r.mfa) };
}

// ---------- tightening and loosening ----------

export type RuleField = 'fourEyes' | 'stepUp' | 'maxAgeMinutes' | 'mfa' | 'teams';
export interface PolicyChange {
  /** A control point key, or "mfa.amrValues" / "mfa.acrValues" */
  point: string;
  field: RuleField | 'values';
  from: unknown;
  to: unknown;
  direction: 'tighten' | 'loosen';
}

/** null (the longest age, SM_STEP_UP_MINUTES) is looser than every number. */
const ageLooser = (a: number | null, b: number | null) => (a === null ? b !== null : b !== null && a > b);

/** Every difference between two policies and whether it makes the rules stricter or looser. */
export function policyChanges(before: Pick<AssurancePolicy, 'points' | 'mfa'>, after: Pick<AssurancePolicy, 'points' | 'mfa'>): PolicyChange[] {
  const out: PolicyChange[] = [];
  for (const p of CONTROL_POINTS) {
    const a = instanceRule(p, before);
    const b = instanceRule(p, after);
    if (a.fourEyes !== b.fourEyes && a.fourEyes && b.fourEyes)
      out.push({
        point: p.key,
        field: 'fourEyes',
        from: a.fourEyes,
        to: b.fourEyes,
        direction: FOUR_EYES_RANK[b.fourEyes] > FOUR_EYES_RANK[a.fourEyes] ? 'tighten' : 'loosen',
      });
    if (a.stepUp !== b.stepUp) out.push({ point: p.key, field: 'stepUp', from: a.stepUp, to: b.stepUp, direction: b.stepUp ? 'tighten' : 'loosen' });
    // a step-up turned on brings its age and MFA along (compared with an unset step-up); turned off, they go with it
    const age = a.stepUp ? a.maxAgeMinutes : null;
    const mfa = a.stepUp && a.mfa;
    if (b.stepUp && age !== b.maxAgeMinutes)
      out.push({ point: p.key, field: 'maxAgeMinutes', from: age, to: b.maxAgeMinutes, direction: ageLooser(b.maxAgeMinutes, age) ? 'loosen' : 'tighten' });
    if (b.stepUp && mfa !== b.mfa) out.push({ point: p.key, field: 'mfa', from: mfa, to: b.mfa, direction: b.mfa ? 'tighten' : 'loosen' });
    // deciding in Microsoft Teams: allowing it loosens the rule (a second administrator approves), forbidding it tightens
    if (p.supports.teams && !!a.teams !== !!b.teams)
      out.push({ point: p.key, field: 'teams', from: !!a.teams, to: !!b.teams, direction: b.teams ? 'loosen' : 'tighten' });
  }
  for (const k of ['amrValues', 'acrValues'] as const) {
    const a = before.mfa[k].map((x) => x.toLowerCase());
    const b = after.mfa[k].map((x) => x.toLowerCase());
    if (a.length === b.length && a.every((x) => b.includes(x))) continue;
    // a value that counts as multi-factor now and did not before is looser; only removing values is stricter
    out.push({ point: `mfa.${k}`, field: 'values', from: before.mfa[k], to: after.mfa[k], direction: b.some((x) => !a.includes(x)) ? 'loosen' : 'tighten' });
  }
  return out;
}

/** A stored point setting without what equals the default (the policy keeps only differences). */
function compact(p: ControlPoint, r: PointRule): Partial<PointRule> {
  const d = instanceRule(p, { points: {} });
  const out: Partial<PointRule> = {};
  if (r.fourEyes && r.fourEyes !== d.fourEyes) out.fourEyes = r.fourEyes;
  if (r.stepUp !== d.stepUp) out.stepUp = r.stepUp;
  if (r.stepUp && r.maxAgeMinutes !== null) out.maxAgeMinutes = r.maxAgeMinutes;
  if (r.stepUp && r.mfa) out.mfa = true;
  if (p.supports.teams && !!r.teams !== !!d.teams) out.teams = !!r.teams;
  return out;
}

/** The policy in normal form: every point's setting compacted, unknown points dropped. */
export function normalizePolicy(p: Pick<AssurancePolicy, 'points' | 'mfa'> & { version?: number }): AssurancePolicy {
  const points: Record<string, Partial<PointRule>> = {};
  for (const c of CONTROL_POINTS) {
    const x = compact(c, instanceRule(c, p));
    if (Object.keys(x).length) points[c.key] = x;
  }
  return { version: p.version ?? 0, points, mfa: { amrValues: [...p.mfa.amrValues], acrValues: [...p.mfa.acrValues] } };
}

/**
 * Splits a requested policy into what applies at once (every change that tightens) and what waits for a second
 * administrator (the loosening changes): `now` is the current policy with the tightening applied; `loosened` is the
 * requested policy as a whole, or null when nothing loosens.
 */
export function splitPolicyChange(
  current: AssurancePolicy,
  next: Pick<AssurancePolicy, 'points' | 'mfa'>,
): { now: AssurancePolicy; tightened: PolicyChange[]; loosened: PolicyChange[] } {
  const changes = policyChanges(current, next);
  const tightened = changes.filter((c) => c.direction === 'tighten');
  const loosened = changes.filter((c) => c.direction === 'loosen');
  const now = applyChanges(current, tightened);
  return { now, tightened, loosened };
}

/** Applies a list of changes (from policyChanges) to a policy. */
export function applyChanges(base: AssurancePolicy, changes: PolicyChange[]): AssurancePolicy {
  const points: Record<string, PointRule> = {};
  for (const c of CONTROL_POINTS) points[c.key] = instanceRule(c, base);
  const mfa = { amrValues: [...base.mfa.amrValues], acrValues: [...base.mfa.acrValues] };
  for (const ch of changes) {
    if (ch.point === 'mfa.amrValues' || ch.point === 'mfa.acrValues') {
      mfa[ch.point === 'mfa.amrValues' ? 'amrValues' : 'acrValues'] = [...(ch.to as string[])];
      continue;
    }
    const r = points[ch.point];
    if (!r) continue;
    if (ch.field === 'fourEyes') r.fourEyes = ch.to as FourEyesLevel;
    else if (ch.field === 'stepUp') {
      r.stepUp = ch.to as boolean;
      if (!r.stepUp) {
        r.maxAgeMinutes = null;
        r.mfa = false;
      }
    } else if (ch.field === 'maxAgeMinutes') r.maxAgeMinutes = ch.to as number | null;
    else if (ch.field === 'mfa') r.mfa = ch.to as boolean;
    else if (ch.field === 'teams') r.teams = ch.to as boolean;
  }
  return normalizePolicy({ version: base.version, points, mfa });
}

/** Whether an amr / acr of an ID token shows multi-factor authentication under the policy's lists. */
export function claimsShowMfa(m: AssuranceMfaSettings, claims: { amr?: readonly string[] | null; acr?: string | null }): boolean {
  const amr = (claims.amr ?? []).map((x) => x.toLowerCase());
  const values = m.amrValues.map((x) => x.toLowerCase());
  if (amr.some((x) => values.includes(x))) return true;
  return !!claims.acr && m.acrValues.includes(claims.acr);
}

// ---------- what the API returns ----------

/** How a control-point event was confirmed (the audit proof's method). */
export const ASSURANCE_METHODS = ['password', 'sso', 'sso+mfa', 'emergency', 'notRequired'] as const;
export type AssuranceMethod = (typeof ASSURANCE_METHODS)[number];

export interface AssurancePendingChange {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  comment: string;
  /** The loosening changes that wait */
  changes: PolicyChange[];
  /** The policy version the request was made on */
  baseVersion: number;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The signed-in administrator may approve it (another administrator than the requester) */
  canApprove: boolean;
  /** …or reject / withdraw it */
  canReject: boolean;
  /** Why the signed-in administrator may not approve */
  approveBlocked: string | null;
}

export interface AssuranceOverride {
  point: string;
  kind: AssuranceOverrideKind;
  /** What the item is (a process, a platform, a record type, a setting) */
  label: string;
  /** The item's own setting, e.g. "fourEyes", "confirm", "verification required" */
  value: string;
  /** Where it is changed (web route) */
  link: string;
  /** The rule that applies to the item */
  effective: { fourEyes: boolean; stepUp: boolean };
}

export interface AssurancePolicyView {
  policy: AssurancePolicy;
  /** Per point: the baseline, the instance rule and the rule without item overrides */
  rules: Record<string, { baseline: PointRule; instance: PointRule; defaults: PointRule }>;
  /** SM_STEP_UP_MINUTES (the longest age of a confirmation) */
  windowMinutes: number;
  pending: AssurancePendingChange | null;
  overrides: AssuranceOverride[];
  /** When the current version took effect (null: never changed) */
  since: string | null;
  canChange: boolean;
}

/** PUT /api/assurance/policy: what happened. */
export interface AssurancePolicySaved {
  view: AssurancePolicyView;
  applied: PolicyChange[];
  /** The loosening changes, waiting for a second administrator */
  pending: AssurancePendingChange | null;
}

export interface AssurancePolicyVersion {
  version: number;
  at: string;
  /** Who made the change (and who approved a loosening) */
  by: string;
  approvedBy: string | null;
  changes: PolicyChange[];
  seq: number;
}
