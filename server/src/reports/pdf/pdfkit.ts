/**
 * Typed access to PDFKit 0.20. @types/pdfkit lags behind (no registerFile, no
 * typings for the low-level object API used for signature fields), so the few
 * extra members are declared here.
 */
import PDFDocument from 'pdfkit';
import * as pdfkitModule from 'pdfkit';

export { PDFDocument };

export const registerFile = (pdfkitModule as unknown as { registerFile(path: string, data: Uint8Array): void }).registerFile;

/** Indirect PDF object as created by doc.ref(). */
export interface PdfRef {
  data: Record<string, unknown>;
  end(chunk?: string | Uint8Array): void;
}

/** Internals of PDFKit used to build AcroForm signature fields without NeedAppearances (not allowed in PDF/A). */
export interface PdfDocInternals {
  ref(data: Record<string, unknown>): PdfRef;
  _root: PdfRef;
  page: PDFKit.PDFPage & { dictionary: PdfRef; annotations: PdfRef[] };
  endAcroForm(): unknown;
}

export const internals = (doc: PDFKit.PDFDocument): PdfDocInternals => doc as unknown as PdfDocInternals;

/** Opens (and caches) an image in a document and returns its pixel size. */
export const openImage = (doc: PDFKit.PDFDocument, data: Buffer): { width: number; height: number } =>
  (doc as unknown as { openImage(d: Buffer): { width: number; height: number } }).openImage(data);
