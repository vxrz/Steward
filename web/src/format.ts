export function fmtDate(s?: string | null): string {
  if (!s) return '–';
  const d = new Date(s);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtRelative(s?: string | null): string {
  if (!s) return '–';
  const diff = (new Date(s).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function fmtDuration(ms?: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}

export function runDuration(start: string, end?: string | null): string {
  return fmtDuration((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime());
}
