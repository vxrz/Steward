import { drawRecordPdf } from '../../records/pdf-draw.js';
import { renderRunReport } from '../run-report.js';
import { renderSummaryReport } from '../summary-report.js';
import { renderScheduledReport } from '../scheduled-report.js';
import { drawPackPdf } from '../../compliance/pack-pdf.js';
// sections of scheduled reports registered by other features (as in reports/schedules.ts)
import '../../records/report-section.js';
import '../../tickets/report-section.js';
import '../../duties/report-section.js';
import '../../scorecard/report-section.js';

/**
 * Every kind of PDF Steward draws (#13). Each takes only collected data – no database – so it can run in the
 * PDF worker (pool.ts, worker-entry.ts).
 */
export const PDF_DRAWERS = {
  record: drawRecordPdf,
  run: renderRunReport,
  summary: renderSummaryReport,
  scheduled: renderScheduledReport,
  pack: drawPackPdf,
};

export type PdfDrawers = typeof PDF_DRAWERS;
