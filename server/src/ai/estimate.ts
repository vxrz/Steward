import crypto from 'node:crypto';
import { AI_ESTIMATE } from '@sm/shared';

/**
 * The token estimate made before a call (docs/AI.md#limits): no tokenizer, on purpose – a dependency per model family
 * would still not know a gateway's models. Characters divided by `charsPerToken` (default 3.5), rounded up, plus a
 * fixed overhead per message and per call. Real tokenizers average about 4 characters per token for English and
 * German prose and JSON, so the estimate is a little high: a call is refused rather than sent too large. Text in
 * scripts with few characters per token (Chinese, Japanese) needs a lower value on the model.
 */
export function estimateTokens(parts: string[], charsPerToken: number = AI_ESTIMATE.charsPerToken): number {
  const cpt = charsPerToken > 0 ? charsPerToken : AI_ESTIMATE.charsPerToken;
  const messages = parts.filter((p) => p.length > 0);
  // code points, not UTF-16 units: an emoji is one character
  const chars = messages.reduce((n, p) => n + [...p].length, 0);
  return Math.ceil(chars / cpt) + messages.length * AI_ESTIMATE.perMessage + AI_ESTIMATE.perCall;
}

/** SHA-256 (hex) of the parts, each length-prefixed so that moving text between parts changes the fingerprint. */
export function fingerprint(...parts: (string | undefined)[]): string {
  const h = crypto.createHash('sha256');
  for (const p of parts) {
    const s = p ?? '';
    h.update(`${Buffer.byteLength(s)}:`);
    h.update(s);
  }
  return h.digest('hex');
}
