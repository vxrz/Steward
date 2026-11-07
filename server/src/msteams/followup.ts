import { db } from '../db.js';
import { logger } from '../log.js';
import { getTask } from '../engine/store.js';
import { followUpDecision, type Outcome } from './cards.js';

/**
 * A decision was settled (decided in Steward or in Teams, the run cancelled, the request expired): the outcome follows
 * the decision cards to their channels (stage 1), and the bot's own cards are updated (stage 2, botcards.ts).
 */

type Updater = (kind: 'task' | 'mcp_request', id: string) => Promise<void>;
let botUpdate: Updater | null = null;
/** Set by the Teams bot (stage 2) while it is on: its posted cards show the outcome for everyone. */
export function setBotCardUpdater(fn: Updater | null): void {
  botUpdate = fn;
}

export function taskSettled(taskId: string, o: Outcome): void {
  let t: ReturnType<typeof getTask>;
  try {
    t = getTask(taskId);
  } catch {
    return; // the run was deleted
  }
  followUpDecision('task', taskId, t.title, `/runs/${t.runId}`, o);
  void botUpdate?.('task', taskId).catch((err) => logger.warn({ err, taskId }, 'Teams card could not be updated'));
}

export function mcpSettled(id: string, o: Outcome): void {
  const r = db().get<{ method: string | null; path_template: string | null; process_name: string | null; kind: string }>(
    'SELECT method, path_template, process_name, kind FROM mcp_requests WHERE id = ?',
    id,
  );
  if (!r) return;
  const title = r.kind === 'gateway' ? `${r.method ?? ''} ${r.path_template ?? ''}`.trim() : (r.process_name ?? id);
  followUpDecision('mcp_request', id, title, `/mcp-requests/${id}`, o);
  void botUpdate?.('mcp_request', id).catch((err) => logger.warn({ err, id }, 'Teams card could not be updated'));
}
