import fs from 'node:fs';
import type { RunDetail } from '@sm/shared';
import { getRunDetail, artifactFile, protocolHash } from './engine/store.js';
import { allAuditAscending } from './audit.js';
import { config } from './config.js';
import { BRAND } from '@sm/shared';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Very small markdown subset: headings, lists, bold, italics, code, paragraphs. */
export function miniMarkdown(md: string): string {
  const lines = esc(md).split('\n');
  const out: string[] = [];
  let list = false;
  const inline = (s: string) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  for (const l of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    const li = /^\s*[-*]\s+(.*)$/.exec(l);
    if (li) {
      if (!list) out.push('<ul>'), (list = true);
      out.push(`<li>${inline(li[1]!)}</li>`);
      continue;
    }
    if (list) out.push('</ul>'), (list = false);
    if (h) out.push(`<h${h[1]!.length + 2}>${inline(h[2]!)}</h${h[1]!.length + 2}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

function depth(key: string): number {
  return key.split('/').length - 1;
}

function fmtDate(s?: string | null): string {
  return s ? new Date(s).toLocaleString('en-GB', { timeZone: 'UTC' }) + ' UTC' : '–';
}

function statusBadge(s: string): string {
  return `<span class="badge s-${esc(s)}">${esc(s)}</span>`;
}

export function runReportHtml(runId: string): string {
  const run: RunDetail = getRunDetail(runId);
  const auditEntries = allAuditAscending(runId);
  const finished = auditEntries.filter((a) => /^run\.(succeeded|failed|cancelled)$/.test(a.action)).pop();
  const recordedHash = (finished?.details as { protocolHash?: string } | undefined)?.protocolHash;
  const currentHash = protocolHash(runId);
  const intact = recordedHash ? recordedHash === currentHash : null;
  const checks = run.steps.filter((s) => s.type === 'check');
  const writes = run.steps.filter((s) => s.type === 'http' && (s.input as { write?: boolean } | undefined)?.write);

  const imgs = run.artifacts
    .filter((a) => a.kind === 'screenshot')
    .map((a) => {
      let data = '';
      try {
        data = fs.readFileSync(artifactFile(a.id).path).toString('base64');
      } catch {
        /* missing */
      }
      return `<figure><img src="data:image/png;base64,${data}" alt="${esc(a.name)}"/><figcaption>${esc(a.name)} · step ${esc(
        a.stepKey,
      )} · sha256 ${esc(a.sha256.slice(0, 16))}…</figcaption></figure>`;
    })
    .join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Run protocol ${esc(run.processName)} – ${esc(run.id)}</title>
<style>
body{font:13px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2933;margin:32px;max-width:1100px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;border-bottom:1px solid #d9dee5;padding-bottom:4px;margin-top:28px}
h3,h4{font-size:14px}table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #d9dee5;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f3f5f8}code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}.muted{color:#6b7785}
.badge{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600;background:#e4e8ee}
.s-succeeded{background:#d3f4dd;color:#11643a}.s-failed{background:#fde0e0;color:#a11}.s-dryrun{background:#fff0c2;color:#7a5600}
.s-skipped{background:#eef0f3;color:#667}.s-waiting{background:#e2ebff;color:#2347a8}.s-cancelled,.s-interrupted{background:#eee;color:#555}
.kv td:first-child{width:200px;color:#556}.ok{color:#11643a;font-weight:600}.bad{color:#a11;font-weight:600}
figure{margin:12px 0;page-break-inside:avoid}img{max-width:100%;border:1px solid #d9dee5}figcaption{font-size:11px;color:#6b7785}
.dry{background:#fff7d6;border:1px solid #f0d77a;padding:8px 12px;border-radius:6px;margin:12px 0}
</style></head><body>
<h1>Run protocol: ${esc(run.processName)}</h1>
<div class="muted">Generated ${fmtDate(new Date().toISOString())} by ${BRAND.name} ${esc(config.version)}</div>
${run.dryRun ? '<div class="dry"><strong>DRY RUN</strong> – write operations were simulated and not executed.</div>' : ''}
<h2>Summary</h2>
<table class="kv">
<tr><td>Run ID</td><td class="mono">${esc(run.id)}</td></tr>
<tr><td>Status</td><td>${statusBadge(run.status)} ${run.error ? esc(run.error) : ''}</td></tr>
<tr><td>Process</td><td>${esc(run.processName)} (<span class="mono">${esc(run.processId)}</span>) version ${run.processVersion}</td></tr>
<tr><td>Definition hash</td><td class="mono">${esc(run.definitionHash)}</td></tr>
<tr><td>Started by</td><td>${esc(run.actor)} (${esc(run.trigger)}${run.triggerName ? `: ${esc(run.triggerName)}` : ''})</td></tr>
<tr><td>Started / finished</td><td>${fmtDate(run.startedAt)} / ${fmtDate(run.finishedAt)}</td></tr>
<tr><td>Steps</td><td>${run.stats.steps} executed, ${run.stats.failedSteps} failed · ${run.stats.writes} write call(s), ${run.stats.skippedWrites} simulated</td></tr>
<tr><td>Checks</td><td>${run.stats.checksPassed} passed, ${run.stats.checksFailed} failed</td></tr>
<tr><td>Protocol integrity</td><td>${
    intact === null
      ? '<span class="muted">Run not finished – no sealed fingerprint yet</span>'
      : intact
        ? `<span class="ok">✔ intact</span> <span class="mono">${esc(currentHash)}</span>`
        : `<span class="bad">✘ modified after completion</span> recorded <span class="mono">${esc(recordedHash)}</span>, now <span class="mono">${esc(currentHash)}</span>`
  }</td></tr>
</table>

<h2>Connections</h2>
<table><tr><th>Slot</th><th>Platform</th><th>Base URL</th></tr>
${Object.entries(run.bindings).map(([k, b]) => `<tr><td>${esc(k)}</td><td>${esc(b.platformName)}</td><td class="mono">${esc(b.baseUrl)}</td></tr>`).join('')}
</table>

<h2>Inputs</h2>
<table>${Object.entries(run.inputs).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="mono">${esc(typeof v === 'string' ? v : JSON.stringify(v))}</td></tr>`).join('') || '<tr><td class="muted">none</td></tr>'}</table>

${
  checks.length
    ? `<h2>Checks</h2><table><tr><th>Check</th><th>Result</th><th>Severity</th><th>Message</th></tr>${checks
        .map((c) => {
          const o = (c.output ?? {}) as { passed?: boolean; severity?: string; message?: string };
          return `<tr><td>${esc(c.name)}</td><td>${o.passed ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'}</td><td>${esc(o.severity)}</td><td>${esc(o.message ?? c.error)}</td></tr>`;
        })
        .join('')}</table>`
    : ''
}

${
  run.tasks.length
    ? `<h2>Decisions</h2>${run.tasks
        .map((t) => {
          const sel = new Set(t.decision?.selectedKeys ?? []);
          const rows =
            t.mode === 'select'
              ? `<table><tr><th>Selected</th>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>${t.items
                  .map((i) => `<tr><td>${t.status === 'completed' ? (sel.has(i.key) ? '☑' : '☐') : '–'}</td>${i.cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
                  .join('')}</table>`
              : '';
          return `<h3>${esc(t.title)}</h3><p>${statusBadge(t.status)} ${
            t.status === 'completed'
              ? `${t.mode === 'approve' ? (t.decision?.approved ? 'Approved' : 'Rejected') : `${sel.size} of ${t.items.length} selected`} by <strong>${esc(t.decidedBy)}</strong> at ${fmtDate(t.decidedAt)}`
              : ''
          }${t.decision?.comment ? `<br/>Comment: ${esc(t.decision.comment)}` : ''}</p>${t.instructions ? miniMarkdown(t.instructions) : ''}${rows}`;
        })
        .join('')}`
    : ''
}

${run.reports
  .map(
    (r) =>
      `<h2>${esc(r.title)}</h2>${r.text ? miniMarkdown(r.text) : ''}${
        r.rows ? `<table><tr>${(r.columns ?? []).map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${r.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : ''
      }`,
  )
  .join('')}

${
  writes.length
    ? `<h2>Changes made (write operations)</h2><table><tr><th>Step</th><th>Request</th><th>Result</th></tr>${writes
        .map((s) => {
          const i = s.input as { method?: string; url?: string };
          return `<tr><td>${esc(s.name)}<div class="muted mono">${esc(s.key)}</div></td><td class="mono">${esc(i?.method)} ${esc(i?.url)}</td><td>${statusBadge(s.status)} ${esc(s.summary ?? s.error ?? '')}</td></tr>`;
        })
        .join('')}</table>`
    : ''
}

<h2>Step timeline</h2>
<table><tr><th>Step</th><th>Type</th><th>Status</th><th>Started</th><th>Duration</th><th>Result</th></tr>
${run.steps
  .map(
    (s) =>
      `<tr><td style="padding-left:${6 + depth(s.key) * 16}px">${esc(s.name)}<div class="muted mono">${esc(s.key)}</div></td><td>${esc(s.type)}</td><td>${statusBadge(
        s.status,
      )}</td><td>${fmtDate(s.startedAt)}</td><td>${s.durationMs ?? ''} ms</td><td>${esc(s.error ?? s.summary ?? '')}</td></tr>`,
  )
  .join('')}
</table>

${imgs ? `<h2>Evidence (screenshots)</h2>${imgs}` : ''}

<h2>Log</h2>
<table><tr><th>Time</th><th>Level</th><th>Message</th></tr>
${run.logs.map((l) => `<tr><td>${fmtDate(l.ts)}</td><td>${esc(l.level)}</td><td>${esc(l.message)}</td></tr>`).join('')}
</table>

<h2>Audit trail</h2>
<p class="muted">Entries are HMAC-chained; any later change to the audit log is detected by "Verify audit chain".</p>
<table><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Summary</th><th>Hash</th></tr>
${auditEntries.map((a) => `<tr><td>${a.seq}</td><td>${fmtDate(a.ts)}</td><td>${esc(a.actor)}</td><td class="mono">${esc(a.action)}</td><td>${esc(a.summary)}</td><td class="mono">${esc(a.hash.slice(0, 16))}…</td></tr>`).join('')}
</table>
</body></html>`;
}
