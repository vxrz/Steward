import { isEmailAddress, type UserInfo } from '@sm/shared';
import { logger } from '../log.js';
import { channelSecrets, getNotificationSettings, type ChannelSecrets } from './settings.js';
import { sendEmail, type OutgoingMessage } from './channels.js';
import { allowedDomainRules, domainAllowed } from './domains.js';

/**
 * One way out for e-mail (#18): notifications, the daily summary, report schedules (through notifications) and
 * audit checkpoints to auditors. The same rules everywhere: e-mail must be set up and turned on; a Steward user is
 * written to at the address of their profile; an address outside Steward only when its domain is allowed
 * (Settings → Notifications, see domains.ts). Sending runs in the background; every outcome is logged.
 */

export type EmailTarget = { user: UserInfo } | { address: string };

export interface EmailJob {
  event: string;
  to: EmailTarget;
  message: OutgoingMessage;
  /** For a batch: the allowed domains, read once */
  rules?: string[];
  /** For a batch: the channel secrets, read once */
  secrets?: ChannelSecrets;
}

export type EmailOutcome = { status: 'queued'; done: Promise<boolean> } | { status: 'off' | 'refused' | 'invalid' };

const pending = new Set<Promise<boolean>>();

/** Queues one e-mail; done resolves to whether it was sent (failures are logged, never thrown). */
export function queueEmail(job: EmailJob): EmailOutcome {
  const settings = getNotificationSettings();
  if (!settings.email.enabled || !settings.email.host) return { status: 'off' };
  const user = 'user' in job.to ? job.to.user : null;
  const address = user ? user.email : (job.to as { address: string }).address.trim().toLowerCase();
  if (!address || !isEmailAddress(address)) return { status: 'invalid' };
  if (!user && !domainAllowed(address, job.rules ?? allowedDomainRules())) {
    logger.warn({ event: job.event }, 'e-mail not sent to an address outside the allowed domains');
    return { status: 'refused' };
  }
  const to = user ? user.username : 'external address';
  const done = sendEmail(settings.email, job.secrets ?? channelSecrets(), address, job.message)
    .then(() => {
      logger.debug({ event: job.event, channel: 'email', to }, 'notification sent');
      return true;
    })
    .catch((err) => {
      logger.warn({ err: { message: (err as Error).message }, event: job.event, channel: 'email', to }, 'notification could not be sent');
      return false;
    })
    .finally(() => pending.delete(done));
  pending.add(done);
  return { status: 'queued', done };
}

/** For tests and shutdown: wait until queued e-mails are sent. */
export async function flushEmails(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
