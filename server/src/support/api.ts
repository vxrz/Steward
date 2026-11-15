import { z } from 'zod';
import { SUPPORT_PURPOSES, SUPPORT_TOOLS, type ItemSupport, type SupportChannel, type SupportLevelRef } from '@sm/shared';

/**
 * Support channels, levels and guides in the public API (/api/v1) and the MCP tools (0.26.0, ADR 0039 part 7): one
 * shape for data products, services and applications. Channels name shared addresses, never people.
 */

export const ApiSupportChannel = z.object({
  purpose: z.enum(SUPPORT_PURPOSES).describe('questions, issues (and incidents), announcements, access (and onboarding)'),
  tool: z.enum(SUPPORT_TOOLS),
  name: z.string(),
  address: z.string().describe('https://, mailto: or tel:'),
  hours: z.string(),
  note: z.string().describe('The queue, category or assignment group to use'),
});

export const ApiSupportLevel = z
  .object({
    id: z.string(),
    name: z.string().describe('English'),
    nameDe: z.string(),
    hours: z.string(),
    firstResponse: z.string().describe('What the providing team promises as its first response (documentation, not measured)'),
    note: z.string(),
    slaUrl: z.string().describe('The SLA document ("" for none)'),
  })
  .describe('The support level the item picks (Settings → Support levels)');

export const ApiGuide = z.object({ title: z.string(), url: z.string() });

export const ApiSupportedBy = z
  .object({
    service: z.object({ id: z.string(), name: z.string() }),
    channels: z.array(ApiSupportChannel),
    level: ApiSupportLevel.nullable(),
  })
  .describe(
    'The service that supports it, with its channels and level – what applies where the item names none of its own. Null: none, or a service the token owner may not see',
  );

export const apiChannel = (c: SupportChannel) => ({ purpose: c.purpose, tool: c.tool, name: c.name, address: c.address, hours: c.hours, note: c.note });

export const apiLevel = (l: SupportLevelRef | null) =>
  l ? { id: l.id, name: l.nameEn, nameDe: l.nameDe, hours: l.hours, firstResponse: l.firstResponse, note: l.note, slaUrl: l.slaUrl } : null;

export const apiSupportedBy = (s: ItemSupport['supportedBy']) =>
  s ? { service: s.service, channels: s.channels.map(apiChannel), level: apiLevel(s.level) } : null;
