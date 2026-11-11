/**
 * InfluxDB (0.18.0, docs/MONITORS.md#freshness-in-influxdb): the platform kind and the limits of the freshness check
 * with `source: influxdb`. Steward builds the query itself – InfluxQL (1.x) or Flux (2.x) – from the names in the check;
 * names and values are quoted for the dialect and never written into a query as they are.
 */

import type { MonitorStatus } from './monitors.js';

export const INFLUX_KIND = 'influxdb';

/** The API generations Steward reads (an InfluxDB platform's variable `version`): 1.x InfluxQL, 2.x Flux. */
export const INFLUX_VERSIONS = ['1', '2'] as const;
export type InfluxVersion = (typeof INFLUX_VERSIONS)[number];

export const INFLUX_LIMITS = {
  /** Series (group values × fields) judged per check; more are cut off and the message says so */
  series: 200,
  /** Fields per check: each is a series of its own */
  fields: 10,
  /** Tag filters (key = value, all must match) */
  tags: 20,
  /** Values of the grouping tag that must be there (a series silent for longer than the look-back is not seen otherwise) */
  expectedSeries: 200,
  /** Characters of a name (database, bucket, measurement, field, tag key) or a tag value */
  nameChars: 256,
  /** Look-back of the query in hours: default 24 (or the freshness window and a half, when that is longer), at most 30 days */
  defaultLookbackHours: 24,
  maxLookbackHours: 720,
  /** Series whose observed delay is measured (the first by name); the status covers every series */
  delaySeries: 50,
} as const;

/** Control characters (also line breaks and tabs): refused in every name and value of the InfluxDB source. */
// eslint-disable-next-line no-control-regex -- the point is to find control characters
export const INFLUX_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The variable `version` of a platform as written ("2", "2.7", "v1" …), trimmed; '' when it is not set. */
export const influxVersionText = (variables: Record<string, unknown> | undefined | null): string => String(variables?.version ?? '').trim();

/** The API generation of a platform from its variable `version` ("2", "2.7", "v1" …); undefined when it names none Steward reads. */
export function influxVersionOf(variables: Record<string, unknown> | undefined | null): InfluxVersion | undefined {
  const major = influxVersionText(variables).replace(/^v/i, '').split('.')[0];
  return (INFLUX_VERSIONS as readonly string[]).includes(major ?? '') ? (major as InfluxVersion) : undefined;
}

/** Name of a series: the grouping tag's value and the field, as far as the check has them ('' for one series). */
export function influxSeriesName(group: string | null | undefined, field: string | null | undefined, grouped: boolean): string {
  const g = grouped ? (group === null || group === undefined || group === '' ? '(none)' : group) : '';
  const f = field ?? '';
  return g && f ? `${g}/${f}` : g || f;
}

/** One series of a freshness check as Check now shows it (POST /monitors/check-preview): newest timestamp, age, status. */
export interface SeriesFreshness {
  name: string;
  newest: string | null;
  ageSeconds: number | null;
  status: MonitorStatus;
}
