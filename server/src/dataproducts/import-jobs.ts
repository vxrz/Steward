import {
  DATA_PRODUCT_ID_PREFIX,
  DATA_PRODUCT_IMPORT_JOB_ELEMENTS,
  DATA_PRODUCT_IMPORT_JOBS_KEPT,
  type DataProductImportJob,
  type DataProductImportJobPhase,
  type DataProductImportJobState,
  type DataProductImportMode,
  type DataProductImportResult,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { me } from '../auth/access.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { marks, type ElementRow } from './store.js';
import { commitPlanned, commitPlannedStepwise, planImport, type ElementJournal, type ImportOptions } from './import.js';

/**
 * Large imports as background jobs (0.25.0, a carry-over of the 0.24.0 release review): an import of 20,000 elements
 * held the server for several seconds in one transaction. An import that writes more than
 * DATA_PRODUCT_IMPORT_JOB_ELEMENTS elements now runs as a job – `POST /api/data-products/import` answers 202 with it,
 * `GET /api/data-products/import/jobs/{id}` says how far it is (the web app shows a progress bar):
 *
 * 1. **elements** in transactions of at most BATCH_MS each, a turn of the event loop between them; each transaction
 *    writes the progress and the job's **journal** (`dp_import_job_elements`: each element it added, and the people's
 *    fields of each element it changed, as they were);
 * 2. **entries** – domains, data objects, products with their members, ports, steps and consumers, the removals of a
 *    replace, the origins and the audit entry `dataproduct.imported` – in one transaction, as an import always was.
 *
 * **All or nothing, for the person importing:** a failure in either phase – a refusal, an error, a server that stopped
 * (the next run of the job `data-products` finds the job still _running_) – takes back what the journal holds, in
 * batches: elements the job added are removed, changed elements get their fields back; the job ends _failed_ with the
 * reason and `dataproduct.import_rolled_back` is in the audit log. An element someone used or changed meanwhile (a
 * member of a product, bound to a port, a step's end, edited again) is kept and counted (`undone.kept`). While a job
 * runs, its elements show in the catalogue already; another import waits for it (409 DATA_PRODUCT_IMPORT_RUNNING).
 */

/** The longest transaction of a job's element phase (ms): well below the 50 ms a turn of the event loop should take. */
export const BATCH_MS = 25;

interface JobRow {
  id: string;
  state: DataProductImportJobState;
  phase: DataProductImportJobPhase;
  done: number;
  total: number;
  mode: DataProductImportMode;
  origin: string | null;
  result: string | null;
  error: string | null;
  undone: string | null;
  created_by: string;
  created_at: string;
  finished_at: string | null;
}

/** Jobs going on in this process (a job found _running_ in the database but not here was interrupted). */
const running = new Map<string, Promise<void>>();

function toJob(r: JobRow): DataProductImportJob {
  return {
    id: r.id,
    state: r.state,
    phase: r.phase,
    done: Number(r.done),
    total: Number(r.total),
    mode: r.mode,
    origin: r.origin,
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    result: parseJson<DataProductImportResult | null>(r.result ?? 'null', null),
    error: parseJson<DataProductImportJob['error']>(r.error ?? 'null', null),
    undone: parseJson<DataProductImportJob['undone']>(r.undone ?? 'null', null),
  };
}

const jobRow = (id: string) => db().get<JobRow>('SELECT * FROM dp_import_jobs WHERE id = ?', id);
const notFound = (id: string) => new HttpError(404, `Import ${id} not found`, 'DATA_PRODUCT_IMPORT_JOB_NOT_FOUND', { id: id.slice(0, 100) });

/** GET /api/data-products/import/jobs/:id – the person who started it (and administrators) only. */
export function getImportJob(id: string): DataProductImportJob {
  const u = me();
  const r = jobRow(id);
  if (!r || (r.created_by !== u.username && !isAdmin(u))) throw notFound(id);
  return toJob(r);
}

/** Refuses an import while a background import runs (its journal could not take back what another one changed). */
export function refuseWhileRunning(): void {
  // started here, awaited by nobody: a failure is logged (the job data-products tries again), never an unhandled rejection
  recoverInterrupted()?.catch((err: unknown) => logger.warn({ err }, 'an interrupted import of data products could not be taken back'));
  const r = db().get<{ id: string; created_by: string }>("SELECT id, created_by FROM dp_import_jobs WHERE state = 'running' LIMIT 1");
  if (r)
    throw new HttpError(409, `An import of ${r.created_by} is running – try again when it has ended`, 'DATA_PRODUCT_IMPORT_RUNNING', {
      by: r.created_by,
    });
}

/**
 * POST /api/data-products/import: the import at once (small), or as a background job (more than
 * DATA_PRODUCT_IMPORT_JOB_ELEMENTS elements) – `{ status: 202, job }`. The plan and its checks are the same either way:
 * problems and a changed preview are refused before anything is written.
 */
export function startImport(
  body: unknown,
  o: ImportOptions = {},
): { status: 200; result: DataProductImportResult } | { status: 202; job: DataProductImportJob } {
  const u = me();
  refuseWhileRunning();
  const t0 = performance.now();
  const p = planImport(body, o);
  const planMs = performance.now() - t0;
  if (p.elementWrites <= DATA_PRODUCT_IMPORT_JOB_ELEMENTS) return { status: 200, result: commitPlanned(p.planned) };
  const id = newId(DATA_PRODUCT_ID_PREFIX.importJob);
  const now = nowIso();
  db().tx(() => {
    db().run(
      "INSERT INTO dp_import_jobs (id, state, phase, done, total, mode, origin, created_by, created_at) VALUES (?, 'running', 'elements', 0, ?, ?, ?, ?, ?)",
      id,
      p.elementWrites,
      p.mode,
      p.origin,
      u.username,
      now,
    );
    // the newest jobs only (running ones stay)
    db().run(
      `DELETE FROM dp_import_jobs WHERE state <> 'running' AND id NOT IN (SELECT id FROM dp_import_jobs ORDER BY created_at DESC, id DESC LIMIT ${DATA_PRODUCT_IMPORT_JOBS_KEPT})`,
    );
    db().run('DELETE FROM dp_import_job_elements WHERE job_id NOT IN (SELECT id FROM dp_import_jobs)');
  });
  Object.assign(lastJobTimes, { planMs: Math.round(planMs), longestBatchMs: 0, restMs: 0 });
  // nobody awaits the job: a failure of its undo is logged, never an unhandled rejection – the job stays running, so the
  // next run of the job data-products (or the next import) takes it back as an interrupted one
  const done = runAs(u, () => runJob(id, u, p.planned))
    .catch((err: unknown) => logger.error({ err, job: id }, 'a background import of data products could not be taken back'))
    .finally(() => running.delete(id));
  running.set(id, done);
  return { status: 202, job: toJob(jobRow(id)!) };
}

/** For the tests: the job's end. */
export const importJobDone = (id: string): Promise<void> | undefined => running.get(id);

/** For the tests: how long the last job's synchronous parts took (ms) – the plan, the longest element batch, the rest. */
export const lastJobTimes = { planMs: 0, longestBatchMs: 0, restMs: 0 };

type JobError = NonNullable<DataProductImportJob['error']>;
const errorOf = (e: unknown): JobError =>
  e instanceof HttpError
    ? { message: e.message.slice(0, 1_000), code: e.code ?? null, params: (e.params as JobError['params']) ?? null }
    : { message: ((e as Error)?.message ?? String(e)).slice(0, 1_000), code: 'DATA_PRODUCT_IMPORT_FAILED', params: null };

async function runJob(id: string, u: AuthUser, planned: Parameters<typeof commitPlanned>[0]): Promise<void> {
  const journal: ElementJournal = {
    added: (elementId) => db().run('INSERT INTO dp_import_job_elements (job_id, element_id, before) VALUES (?, ?, NULL)', id, elementId),
    changed: (row: ElementRow) =>
      db().run(
        'INSERT INTO dp_import_job_elements (job_id, element_id, before) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        id,
        row.id,
        JSON.stringify({
          display_name: row.display_name,
          layer: row.layer,
          description: row.description,
          type_label: row.type_label,
          api_ref: row.api_ref,
          // 0.25.0: a generic part's technology, namespace and properties (an mqtt.topic's broker) – people's fields too
          technology: row.technology ?? null,
          properties: row.properties ?? '[]',
          ol_namespace: row.ol_namespace,
          ol_name: row.ol_name,
          revision: Number(row.revision),
          updated_at: row.updated_at,
          updated_by: row.updated_by,
        }),
      ),
  };
  try {
    await commitPlannedStepwise(planned, journal, {
      batchMs: BATCH_MS,
      job: id,
      batch: (done, total, ms) => {
        db().run('UPDATE dp_import_jobs SET done = ?, total = ? WHERE id = ?', done, total, id);
        lastJobTimes.longestBatchMs = Math.max(lastJobTimes.longestBatchMs, Math.round(ms));
      },
      beforeRest: () => db().run("UPDATE dp_import_jobs SET phase = 'entries' WHERE id = ?", id),
      rest: (ms) => (lastJobTimes.restMs = Math.round(ms)),
      // in the entries' transaction: a server that stops right after it finds the job succeeded, never half taken back
      committing: (result) => {
        db().run(
          "UPDATE dp_import_jobs SET state = 'succeeded', phase = 'done', result = ?, finished_at = ? WHERE id = ?",
          JSON.stringify(result),
          nowIso(),
          id,
        );
        db().run('DELETE FROM dp_import_job_elements WHERE job_id = ?', id);
      },
    });
  } catch (e) {
    if (!(e instanceof HttpError)) logger.warn({ err: e, job: id }, 'a background import of data products failed');
    await undo(id, u.username, errorOf(e));
  }
}

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Takes back what a job wrote (its journal), in batches: added elements that nothing uses are removed, changed ones that
 * nobody changed since get their fields back; the job ends failed. Idempotent: a journal entry is gone once handled.
 */
async function undo(id: string, actor: string, error: DataProductImportJob['error']): Promise<void> {
  db().run("UPDATE dp_import_jobs SET phase = 'undo', error = ? WHERE id = ?", JSON.stringify(error), id);
  const counts = { removed: 0, restored: 0, kept: 0 };
  for (;;) {
    const rows = db().all<{ element_id: string; before: string | null }>(
      'SELECT element_id, before FROM dp_import_job_elements WHERE job_id = ? LIMIT 250',
      id,
    );
    if (!rows.length) break;
    db().tx(() => {
      const ids = rows.map((r) => r.element_id);
      // an element used meanwhile stays (a member, a port's element, a step's end, a check, a data object's element)
      const used = new Set(
        db()
          .all<{ id: string }>(
            `SELECT element_id AS id FROM dp_members WHERE element_id IN (${marks(ids.length)})
             UNION SELECT element_id FROM dp_port_elements WHERE element_id IN (${marks(ids.length)})
             UNION SELECT element_id FROM dp_step_elements WHERE element_id IN (${marks(ids.length)})
             UNION SELECT element_id FROM dp_check_links WHERE element_id IN (${marks(ids.length)})
             UNION SELECT element_id FROM dp_object_elements WHERE element_id IN (${marks(ids.length)})
             UNION SELECT parent_id FROM dp_elements WHERE parent_id IN (${marks(ids.length)})
               AND id NOT IN (SELECT element_id FROM dp_import_job_elements WHERE job_id = ? AND before IS NULL)`,
            ...ids,
            ...ids,
            ...ids,
            ...ids,
            ...ids,
            ...ids,
            id,
          )
          .map((r) => r.id),
      );
      for (const r of rows) {
        if (r.before === null) {
          if (used.has(r.element_id)) counts.kept++;
          else {
            const n = db().run('DELETE FROM dp_elements WHERE id = ? AND revision = 1', r.element_id).changes;
            if (n) {
              db().run("DELETE FROM resource_teams WHERE kind = 'data_element' AND resource_id = ?", r.element_id);
              db().run("DELETE FROM dp_import_origins WHERE kind = 'element' AND item_id = ?", r.element_id);
              db().run('DELETE FROM dp_element_readouts WHERE element_id = ?', r.element_id);
              counts.removed++;
            } else counts.kept++;
          }
        } else {
          const b = parseJson<{
            display_name: string;
            layer: string;
            description: string;
            type_label: string;
            api_ref: string | null;
            technology?: string | null;
            properties?: string;
            ol_namespace?: string | null;
            ol_name?: string | null;
            revision: number;
            updated_at: string;
            updated_by: string;
          } | null>(r.before, null);
          // only when the import's own change is the last one (its update raised the revision by one)
          const n = b
            ? db().run(
                `UPDATE dp_elements SET display_name = ?, layer = ?, description = ?, type_label = ?, api_ref = ?, technology = ?, properties = ?, ol_namespace = ?,
                   ol_name = ?, revision = revision + 1, updated_at = ?, updated_by = ?
                 WHERE id = ? AND revision = ?`,
                b.display_name,
                b.layer,
                b.description,
                b.type_label,
                b.api_ref,
                b.technology ?? null,
                b.properties ?? '[]',
                b.ol_namespace ?? null,
                b.ol_name ?? null,
                nowIso(),
                actor,
                r.element_id,
                b.revision + 1,
              ).changes
            : 0;
          if (n) counts.restored++;
          else counts.kept++;
        }
      }
      db().run(`DELETE FROM dp_import_job_elements WHERE job_id = ? AND element_id IN (${marks(ids.length)})`, id, ...ids);
    });
    await yieldToLoop();
  }
  db().tx(() => {
    db().run("UPDATE dp_import_jobs SET state = 'failed', phase = 'done', undone = ?, finished_at = ? WHERE id = ?", JSON.stringify(counts), nowIso(), id);
    audit({
      actor,
      action: 'dataproduct.import_rolled_back',
      entityType: 'data_product',
      summary:
        `A background import of data products failed and was taken back: ${counts.removed} element(s) removed, ${counts.restored} restored, ${counts.kept} kept (used or changed since) – ${error?.message ?? 'no reason'}`.slice(
          0,
          500,
        ),
      details: { job: id, ...counts, error: error?.code ?? null },
    });
  });
}

/**
 * Jobs a stopped server left _running_: taken back now (the job `data-products` and every new import call this). Runs
 * the undo synchronously in batches – a server start finds at most one such job.
 */
let recovering: Promise<void> | null = null;
export function recoverInterrupted(): Promise<void> | null {
  if (recovering) return recovering;
  const stale = db()
    .all<{ id: string; created_by: string }>("SELECT id, created_by FROM dp_import_jobs WHERE state = 'running'")
    .filter((r) => !running.has(r.id));
  if (!stale.length) return null;
  recovering = (async () => {
    for (const r of stale)
      await undo(r.id, r.created_by, {
        message: 'The import was interrupted (the server stopped) – what it wrote was taken back',
        code: 'DATA_PRODUCT_IMPORT_FAILED',
        params: { context: 'interrupted' },
      });
  })().finally(() => {
    recovering = null;
  });
  return recovering;
}
