import { toolOfAddress } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { getSettings } from '../settings.js';
import { newId, nowIso, parseJson } from '../util.js';
import { insertLevel, levelOfTier, levelRows } from './levels.js';

/**
 * The upgrade to support channels and support levels (0.26.0, ADR 0039 part 8, docs/SUPPORT.md#upgrade). Called once
 * the vault is open (the audit log needs its key) and after a migration package is imported, as the system; each step
 * is idempotent and does only what is still open:
 *
 * 1. **Example levels**: an installation that has no support level and whose products use no support tier gets three
 *    examples – business hours, extended, 24×7 – once (the setting `support.examplesSeeded` remembers it, so levels an
 *    administrator removed do not come back).
 * 2. **Products**: a product's single support channel (`support`: channel, url, hours) becomes one channel with the
 *    purpose _questions_ – tool e-mail for a `mailto:` address, else other – with its hours; its support tier 1, 2 or 3
 *    picks the level "Tier n" (made once per tier in use, for administrators to rename or merge – nothing is guessed).
 *    Both old columns are emptied in the same transaction, so a second run finds nothing. Audited per product
 *    (`dataproduct.support_converted`); the levels made are audited as `support.level_created`.
 */

export const EXAMPLES_SEEDED_KEY = 'support.examplesSeeded';

const EXAMPLES = {
  en: [
    {
      nameEn: 'Business hours',
      nameDe: 'Geschäftszeiten',
      hours: 'Monday to Friday, 08:00–17:00',
      firstResponse: 'Next business day',
      note: 'Requests outside business hours are answered on the next business day.',
    },
    {
      nameEn: 'Extended',
      nameDe: 'Erweitert',
      hours: 'Monday to Saturday, 07:00–20:00',
      firstResponse: '4 hours within the hours',
      note: 'For products and services the business relies on during the day.',
    },
    {
      nameEn: '24×7',
      nameDe: '24×7',
      hours: 'Every day, around the clock',
      firstResponse: '30 minutes for incidents',
      note: 'On-call support for critical products and services. Response times per priority are in the SLA document.',
    },
  ],
  de: [
    {
      nameEn: 'Business hours',
      nameDe: 'Geschäftszeiten',
      hours: 'Montag bis Freitag, 08:00–17:00',
      firstResponse: 'Nächster Arbeitstag',
      note: 'Anfragen außerhalb der Geschäftszeiten werden am nächsten Arbeitstag beantwortet.',
    },
    {
      nameEn: 'Extended',
      nameDe: 'Erweitert',
      hours: 'Montag bis Samstag, 07:00–20:00',
      firstResponse: '4 Stunden innerhalb der Zeiten',
      note: 'Für Produkte und Services, auf die sich das Geschäft tagsüber verlässt.',
    },
    {
      nameEn: '24×7',
      nameDe: '24×7',
      hours: 'Täglich, rund um die Uhr',
      firstResponse: '30 Minuten bei Störungen',
      note: 'Bereitschaft für kritische Produkte und Services. Reaktionszeiten je Priorität stehen im SLA-Dokument.',
    },
  ],
};

/** Step 1: three example levels for an installation without levels and tiers, once. Returns the number made. */
export function seedExampleLevels(): number {
  if (db().get('SELECT 1 FROM settings WHERE key = ?', EXAMPLES_SEEDED_KEY)) return 0;
  const tiers = db().get('SELECT 1 FROM dp_products WHERE tier IN (1, 2, 3)');
  const levels = levelRows(0).length;
  let made = 0;
  if (!tiers && !levels) {
    const lang = String(getSettings().defaultLocale ?? 'en').startsWith('de') ? 'de' : 'en';
    for (const x of EXAMPLES[lang]) {
      insertLevel({ ...x, slaUrl: '' }, 'system', 'an example of a new installation, for administrators to change or remove');
      made++;
    }
  }
  db().run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', EXAMPLES_SEEDED_KEY, JSON.stringify(nowIso()));
  return made;
}

interface OldProduct {
  id: string;
  name: string;
  support: string;
  tier: number | null;
  support_level_id: string | null;
}

/** Step 2: each product's support and tier as a channel and a level. Returns the number of products converted. */
export function convertProductSupport(): number {
  const rows = db().all<OldProduct>(
    "SELECT id, name, support, tier, support_level_id FROM dp_products WHERE tier IS NOT NULL OR (support IS NOT NULL AND support NOT IN ('', '{}')) ORDER BY id",
  );
  let n = 0;
  for (const p of rows)
    db().tx(() => {
      const s = parseJson<Record<string, unknown>>(p.support, {});
      const text = (k: string) => (typeof s[k] === 'string' ? (s[k] as string).trim() : '');
      const old = { channel: text('channel'), url: text('url'), hours: text('hours') };
      const tier = p.tier === null ? null : Number(p.tier);
      const details: Record<string, unknown> = { release: '0.26.0' };
      const parts: string[] = [];
      if (old.channel || old.url || old.hours) {
        const tool = toolOfAddress(old.url);
        const first = db().get<{ p: number | null }>("SELECT MIN(position) AS p FROM support_channels WHERE kind = 'data_product' AND item_id = ?", p.id);
        const position = first?.p === null || first?.p === undefined ? 0 : Number(first.p) - 1;
        db().run(
          `INSERT INTO support_channels (id, kind, item_id, purpose, tool, name, address, hours, note, position, created_at, created_by)
           VALUES (?, 'data_product', ?, 'questions', ?, ?, ?, ?, '', ?, ?, 'system')`,
          newId('spc_'),
          p.id,
          tool,
          old.channel,
          old.url,
          old.hours,
          position,
          nowIso(),
        );
        details.channel = { purpose: 'questions', tool, name: old.channel, address: old.url, hours: old.hours };
        parts.push(`its support channel${old.channel ? ` "${old.channel}"` : ''} is a channel for questions (${tool === 'email' ? 'e-mail' : tool})`);
      }
      if (tier === 1 || tier === 2 || tier === 3) {
        const level = levelOfTier(tier);
        if (!p.support_level_id) db().run('UPDATE dp_products SET support_level_id = ? WHERE id = ?', level.id, p.id);
        details.tier = tier;
        details.level = { id: p.support_level_id ?? level.id, name: level.name_en };
        parts.push(
          p.support_level_id
            ? `its support tier ${tier} is dropped (it has a support level)`
            : `its support tier ${tier} is the support level "${level.name_en}"`,
        );
      }
      db().run("UPDATE dp_products SET support = '{}', tier = NULL WHERE id = ?", p.id);
      if (parts.length)
        audit({
          actor: 'system',
          action: 'dataproduct.support_converted',
          entityType: 'data_product',
          entityId: p.id,
          summary: `Data product "${p.name}": ${parts.join('; ')} (upgrade to 0.26.0)`,
          details,
        });
      n++;
    });
  return n;
}

/** Every open step of the upgrade (idempotent; never throws – a step that fails is tried again at the next start). */
export function convertSupport(): void {
  for (const [name, step] of [
    ['example levels', seedExampleLevels],
    ['product support', convertProductSupport],
  ] as const)
    try {
      const n = step();
      if (n) logger.info({ step: name, count: n }, 'support channels and levels: upgrade step done (0.26.0)');
    } catch (err) {
      logger.error({ err, step: name }, 'support channels and levels upgrade: a step failed – it is tried again at the next start');
    }
}
