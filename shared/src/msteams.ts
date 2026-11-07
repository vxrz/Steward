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
