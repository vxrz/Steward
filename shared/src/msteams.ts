import { z } from 'zod';
import { NOTIFICATION_EVENTS, type NotificationEvent } from './ops.js';

/** Approvals from Microsoft Teams, stage 2 (0.10.0, ADR 0013): the bot's settings, a preview, off by default. */

export interface TeamsBotSettings {
  /** Marked preview: built and tested against a mock Bot Framework, not yet proven in many real tenants */
  preview: true;
  enabled: boolean;
  /** The Entra app (client) id of the bot */
  appId: string;
  /** Tenants whose people may use the bot */
  tenantIds: string[];
  /** The sign-in provider whose accounts the bot recognises (its stable identifier must be tid + oid) */
  providerId: string | null;
  credential: 'certificate' | 'secret';
  /** A certificate (with its key) or a secret is stored – never returned */
  hasCredential: boolean;
  /** Channel target → the bot's conversation for decision cards (instead of the webhook) */
  channels: Record<string, string>;
  /** A Teams decision needs a Steward sign-in within this many days (default 7) */
  signInDays: number;
  /** The assurance policy lets the bot decide (control point teams.bot, approved by a second administrator) */
  approved: boolean;
  /** Turning it on waits for a second administrator (Settings → Assurance policy) */
  approvalPending: boolean;
  /** Where the bot listens (SM_TEAMS_BOT_PORT); null: no listener */
  listener: { port: number; path: string } | null;
}

export interface TeamsBotConversation {
  id: string;
  kind: 'channel' | 'personal';
  name: string;
  tenantId: string;
  /** Personal chats: whose */
  user: string | null;
  installedAt: string;
  removedAt: string | null;
}

// ---------- personal notifications in the bot's chat (0.15.0, ADR 0025) ----------

/**
 * Events that are never offered for Teams (personal): decision cards come to the chat as cards anyway (ADR 0013), the
 * daily summary has its own path.
 */
export const TEAMS_PERSONAL_NOT_OFFERED: readonly NotificationEvent[] = ['task.assigned', 'mcp.request', 'summary.daily'];

/** Events a person may choose for Teams (personal) – the offer narrows it to those routed to e-mail. */
export const TEAMS_PERSONAL_EVENTS: readonly NotificationEvent[] = NOTIFICATION_EVENTS.filter((e) => !TEAMS_PERSONAL_NOT_OFFERED.includes(e));

export const teamsPersonalInputSchema = z
  .object({
    events: z
      .array(z.enum(NOTIFICATION_EVENTS))
      .max(NOTIFICATION_EVENTS.length)
      .refine((l) => l.every((e) => TEAMS_PERSONAL_EVENTS.includes(e)), 'This event cannot be chosen for Teams (personal)'),
  })
  .strict();
export type TeamsPersonalInput = z.infer<typeof teamsPersonalInputSchema>;

/** Profile → Teams (personal): the person's choice and whether the bot can reach them. */
export interface TeamsPersonalState {
  /** The bot is on and approved: otherwise the card is hidden and nothing is sent */
  available: boolean;
  /** Steward knows a chat with the bot for this person that it may use now */
  connected: boolean;
  /** Since when (the chat was recorded) */
  connectedSince: string | null;
  /** Why it cannot be used: the account is not linked through the bot's sign-in provider */
  notLinked: boolean;
  /** The events the person chose (nothing by default) */
  events: NotificationEvent[];
  /** The events that can be chosen now: routed to e-mail by the instance, not a decision card or the daily summary */
  offered: NotificationEvent[];
}
