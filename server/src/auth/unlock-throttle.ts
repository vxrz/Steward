/**
 * Throttle for wrong master passphrases (unlock and passphrase change): after 3 failures each
 * further attempt has to wait 5 s, doubling up to 15 minutes. Global (only administrators can try,
 * but a stolen admin session must not be able to guess quickly). Reset by a correct passphrase.
 */
const FREE = 3;
const BASE_S = 5;
const MAX_S = 15 * 60;

let failures = 0;
let until = 0;

export const unlockThrottle = {
  waitSeconds(now = Date.now()): number {
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  },
  failed(now = Date.now()): number {
    failures++;
    if (failures >= FREE) until = now + Math.min(MAX_S, BASE_S * 2 ** (failures - FREE)) * 1000;
    return failures;
  },
  succeeded(): void {
    failures = 0;
    until = 0;
  },
};
