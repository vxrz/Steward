import { drawRecordPdf } from '../../records/pdf-draw.js';
import { renderRunReport } from '../run-report.js';
import { renderSummaryReport } from '../summary-draw.js';
import { renderScheduledReport } from '../scheduled-draw.js';
import { drawPackPdf } from '../../compliance/pack-pdf.js';
import { drawAssurancePdf } from '../../compliance/assurance-pdf.js';
import { drawSoaPdf } from '../../compliance/soa-pdf.js';
import type { ReportSectionDraw } from '../section-draw.js';
import { availabilitySectionDraw, credentialsSectionDraw, gatusSectionDraw, runsSectionDraw } from '../builtin-sections-draw.js';
import { recordsSectionDraw } from '../../records/report-section-draw.js';
import { ticketsSectionDraw } from '../../tickets/report-section-draw.js';
import { dutiesSectionDraw } from '../../duties/report-section-draw.js';
import { scorecardSectionDraw } from '../../scorecard/report-section-draw.js';
import { ismsSectionDraw } from '../../compliance/isms-report-section-draw.js';
import { aiSectionDraw } from '../../ai/report-section-draw.js';
import { costsSectionDraw } from '../../costs/report-section-draw.js';
import { contractsSectionDraw } from '../../datacontracts/report-section-draw.js';

/**
 * Every kind of PDF Steward draws (#13). Each takes only collected data – no database – so it can run in the
 * PDF worker (pool.ts, worker-entry.ts). The worker loads this file and what it imports, nothing else: drawing code
 * only (npm run check:imports keeps it so).
 */
export const PDF_DRAWERS = {
  record: drawRecordPdf,
  run: renderRunReport,
  summary: renderSummaryReport,
  scheduled: renderScheduledReport,
  pack: drawPackPdf,
  assurance: drawAssurancePdf,
  soa: drawSoaPdf,
};

export type PdfDrawers = typeof PDF_DRAWERS;

/**
 * The draw halves of the sections of scheduled reports the worker draws (the collect halves come with the features,
 * features/). A section missing here is drawn in the main thread (pool.ts); a test checks that none is missing.
 */
export const SECTION_DRAWERS: readonly ReportSectionDraw<never>[] = [
  availabilitySectionDraw,
  gatusSectionDraw,
  credentialsSectionDraw,
  runsSectionDraw,
  recordsSectionDraw,
  ticketsSectionDraw,
  dutiesSectionDraw,
  scorecardSectionDraw,
  ismsSectionDraw,
  aiSectionDraw,
  costsSectionDraw,
  contractsSectionDraw,
];
