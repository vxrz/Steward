import { DATA_DISCOVERY_LIMITS, type Platform } from '@sm/shared';
import { registryGet } from '../../kafka/service.js';
import { buildUrl } from '../../platforms/http.js';
import { assertOutboundAllowed } from '../../platforms/outbound.js';
import { outboundContext } from '../../platforms/policyContext.js';

/**
 * The Schema Registry of a Kafka platform (its base URL, basic auth with registryKey / registrySecret – docs/KAFKA.md)
 * for discovery (ADR 0036 part 5): the subjects once per run, then the latest version of the subject `<topic>-value` of
 * the topics found – at most DATA_DISCOVERY_LIMITS.registrySubjects per run, four at a time. Only GET /subjects and GET
 * /subjects/{subject}/versions/latest (the schema text is not kept: its id, version and type are). Requests go through
 * the platform's request path: the outbound policy and address pinning of every platform call.
 */

export interface SubjectVersion {
  subject: string;
  version: number;
  id: number | null;
  type: string;
}

/** The registry of one run: the subject list, and the latest versions asked so far (the per-run cap). */
export class RunRegistry {
  private subjects: Set<string> | null = null;
  private asked = 0;
  private cut = false;

  constructor(
    private readonly platform: Platform,
    private readonly secrets: Record<string, string>,
  ) {}

  /** Whether the platform names a Schema Registry (its base URL). */
  get configured(): boolean {
    return !!this.platform.baseUrl;
  }

  private async subjectList(): Promise<Set<string>> {
    if (this.subjects) return this.subjects;
    // the registry's origin must be allowed by the outbound policy (an allow-list may leave out even the platform's own)
    await assertOutboundAllowed(await buildUrl(this.platform, this.secrets, '/'), outboundContext());
    const names: string[] = [];
    const page = 1000;
    // pages of offset/limit, like Confluent's; a registry without paging answers all at once (and the loop ends)
    for (let offset = 0; offset < 100_000; offset += page) {
      const body = await registryGet(this.platform, this.secrets, `/subjects?offset=${offset}&limit=${page}`);
      const list = Array.isArray(body) ? body.filter((x): x is string => typeof x === 'string') : [];
      names.push(...list);
      if (list.length < page) break;
    }
    this.subjects = new Set(names);
    return this.subjects;
  }

  /** The latest value schema of these topics (topics without a subject, or beyond the cap, are left out). */
  async latestOf(topics: readonly string[]): Promise<Map<string, SubjectVersion>> {
    const out = new Map<string, SubjectVersion>();
    if (!this.configured || !topics.length) return out;
    const subjects = await this.subjectList();
    const todo = topics.filter((t) => subjects.has(`${t}-value`));
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (next >= todo.length) return;
        if (this.asked >= DATA_DISCOVERY_LIMITS.registrySubjects) {
          this.cut = true;
          return;
        }
        const topic = todo[next++]!;
        this.asked++;
        const subject = `${topic}-value`;
        const v = (await registryGet(this.platform, this.secrets, `/subjects/${encodeURIComponent(subject)}/versions/latest`)) as {
          version?: number;
          id?: number;
          schemaType?: string;
        } | null;
        if (v && Number.isInteger(Number(v.version)))
          out.set(topic, {
            subject,
            version: Number(v.version),
            id: v.id === undefined ? null : Number(v.id),
            type: String(v.schemaType ?? 'AVRO').slice(0, 20),
          });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }

  /** Subjects whose versions were not read because of the cap (said on the run). */
  get capped(): boolean {
    return this.cut;
  }
}
