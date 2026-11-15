import { z } from 'zod';

/**
 * Contacts by name and role in the public API (/api/v1, CONTACT_EXPOSURE `names`; ADR 0038 and 0039): no e-mail
 * address or phone. 0.26.0: the role's label, whom a deputy stands in for and until when.
 */
export const ContactNameEntries = z.array(
  z.object({
    role: z.string().describe('The role’s key in the role catalogue (e.g. productOwner, businessOwner, an own role’s key)'),
    roleLabel: z.string().describe('The role’s English label (0.26.0)'),
    name: z.string(),
    deputyOf: z.string().optional().describe('0.26.0: the name of the contact this one stands in for (same role)'),
    until: z.string().optional().describe('0.26.0: named until this day (YYYY-MM-DD); after it the link is ended'),
  }),
);
