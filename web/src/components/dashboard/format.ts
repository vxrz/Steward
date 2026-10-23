import { dateTimeFormat, numberFormat } from '../../format';

/** In the UI language: 1284 → "1,284" / "1.284"; 12900 → "12.9K" / "12.900"; 4200000 → "4.2M" / "4,2 Mio." */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  if (Math.abs(v) >= 1e4) return numberFormat({ notation: 'compact', maximumFractionDigits: Math.abs(v) >= 1e5 && Math.abs(v) < 1e6 ? 0 : 1 }).format(v);
  return numberFormat({ maximumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
}

/** 0.42 → "42%" / "42 %" */
export const percent = (share: number): string => numberFormat({ style: 'percent', maximumFractionDigits: 0 }).format(share);

/** Clean axis ticks from 0: steps of 1, 2 or 5 × 10^n. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

export function shortDate(ts: string | number): string {
  return dateTimeFormat({ month: 'short', day: 'numeric' }).format(new Date(ts));
}

/** Axis label: time of day for short ranges (< 2 days), date otherwise. */
export function axisLabel(ts: number, spanMs: number): string {
  return spanMs < 2 * 86400000 ? dateTimeFormat({ hour: '2-digit', minute: '2-digit' }).format(new Date(ts)) : shortDate(ts);
}

export function dateTime(ts: string | number): string {
  return dateTimeFormat({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n');
}

export function download(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
