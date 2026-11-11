import { db } from '../db.js';
import { logger } from '../log.js';
import { runAs } from '../auth/context.js';
import { findUserByName, listTeams, toAuthUser } from '../auth/users.js';
import { newId, nowIso } from '../util.js';
import { ensureCatalogues } from './controls.js';
import { addAction, caToday, insertFinding, updateAction, updateFinding } from './corrective.js';

/**
 * Demo data of the register of corrective actions (ADR 0029): two findings – one from an external audit with an open
 * action, one observation of an internal audit whose action is done, ready for the effectiveness check by a second
 * person – and one pending suggestion of a missed duty period. Everything is invented. Runs once, with the services
 * of the demo (catalogue/demo.ts).
 */

const DAY = 86_400_000;

export async function setupCorrectiveDemo(services: { shop: string; care: string }, now = Date.now()): Promise<void> {
  if (db().get('SELECT 1 FROM ca_findings LIMIT 1') || db().get('SELECT 1 FROM ca_suggestions LIMIT 1')) return;
  ensureCatalogues();
  const control = (ref: string) =>
    db().get<{ id: string }>("SELECT c.id FROM controls c JOIN control_catalogues k ON k.id = c.catalogue_id WHERE k.key = 'ISO27001' AND c.ref = ?", ref)?.id;
  const ids = (...refs: string[]) => refs.map(control).filter((x): x is string => !!x);
  const day = (offset: number) => caToday(now + offset * DAY);
  const dana = findUserByName('dana');
  const desk = listTeams().some((t) => t.name.toLowerCase() === 'service desk') ? ['team:service desk'] : [];
  const owners = desk.length ? desk : dana ? ['user:dana'] : [];
  try {
    const audit = insertFinding({
      title: 'Leaver accounts stay active after the last working day',
      description:
        'The external audit sampled five leavers of the online shop: two accounts on the order database were removed 9 and 14 days after the last working day. The access policy asks for removal on the last working day.',
      severity: 'minor',
      serviceId: services.shop,
      supplierId: null,
      controlIds: ids('5.18', '5.15'),
      owner: dana?.username ?? null,
      dueDate: day(45),
      cause: 'Leavers are reported by e-mail; the Service Desk removes access by hand once a week.',
      grcRef: 'RISK-ACC-07',
      grcUrl: 'https://grc.example.com/risks/RISK-ACC-07',
      source: 'externalAudit',
      sourceKind: 'url',
      sourceId: 'https://audit.example.com/reports/2026-isms/findings/4',
      sourceLabel: 'External ISMS audit 2026, finding 4',
      recordId: null,
      suggestionId: null,
    });
    if (owners.length)
      await addAction(audit.id, {
        title: 'Remove leaver access from the HR feed every day',
        owners,
        dueDate: day(21),
        note: 'A daily run reads the leavers of the HR feed and removes their database roles.',
      });

    const backup = insertFinding({
      title: 'Restore test of customer care backups not documented',
      description: 'The internal audit found no record of the quarterly restore test of the customer care database for the last quarter.',
      severity: 'observation',
      serviceId: services.care,
      supplierId: null,
      controlIds: ids('8.13'),
      owner: dana?.username ?? null,
      dueDate: day(10),
      cause: '',
      grcRef: '',
      grcUrl: '',
      source: 'internalAudit',
      sourceKind: 'url',
      sourceId: null,
      sourceLabel: 'Internal audit Q3, customer care',
      recordId: null,
      suggestionId: null,
    });
    if (owners.length) {
      const f = await addAction(backup.id, { title: 'Record the restore test as a duty with evidence', owners, dueDate: day(-3) });
      const actionId = f.actions[0]?.id;
      if (actionId && dana) {
        await runAs(toAuthUser(dana), () =>
          updateAction(backup.id, actionId, { done: true, note: 'The restore test is now the duty "Quarterly restore test".' }),
        );
        updateFinding(backup.id, { status: 'implemented' });
      }
    }

    // a missed period of a mandatory duty, waiting for a person to confirm or dismiss it
    const duty = db().get<{ id: string; service_id: string; process_id: string }>(
      "SELECT id, service_id, process_id FROM service_duties WHERE service_id = ? AND level = 'mandatory' ORDER BY created_at LIMIT 1",
      services.shop,
    );
    if (duty) {
      const period = `${day(-40).slice(0, 7)}`;
      db().run(
        `INSERT INTO ca_suggestions (id, source, source_key, source_kind, source_id, source_label, service_id, control_ids, record_id, title, details,
           severity, occurred_at, status, created_at)
         VALUES (?, 'duty', ?, 'duty', ?, ?, ?, ?, NULL, ?, ?, 'minor', ?, 'pending', ?) ON CONFLICT (source_key) DO NOTHING`,
        newId('cas_'),
        `demo:duty:${duty.id}:${period}`,
        duty.id,
        period,
        duty.service_id,
        JSON.stringify(ids('5.18')),
        // ids and figures only: the duty's name is read with the reader's rights (corrective-sources.ts)
        `Mandatory duty missed in period ${period}`,
        JSON.stringify({ kind: 'dutyMissed', period, level: 'mandatory' }),
        new Date(now - 30 * DAY).toISOString(),
        nowIso(),
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo corrective actions not complete');
  }
}
