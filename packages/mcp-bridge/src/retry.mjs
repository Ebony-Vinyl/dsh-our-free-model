/**
 * retry.mjs — bounded retry policy.
 *
 * Rules (kept deliberately strict so retries never amplify upstream load):
 * - At most ONE retry per category, at most TWO retries per user request.
 * - Exponential backoff with full jitter; `Retry-After` is honored when the
 *   upstream sends it.
 * - Budget rejections (max_tokens too large) are handled by halving, which is
 *   a correction rather than a retry and still counts toward the cap.
 */

const MAX_TOTAL_RETRIES = 2;

export class RetryBudget {
  constructor(maxTotal = MAX_TOTAL_RETRIES) {
    this.left = maxTotal;
  }
  take(cost = 1) {
    if (this.left < cost) return false;
    this.left -= cost;
    return true;
  }
}

export function sleepWithBackoff(attempt, retryAfterHeader) {
  let ms;
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) {
    ms = ra * 1000;
  } else {
    const base = Math.min(1000 * 2 ** attempt, 8000);
    ms = Math.floor(Math.random() * base); // full jitter
  }
  return new Promise((r) => setTimeout(r, ms));
}

/** True when an upstream error message suggests the max_tokens value was rejected. */
export function isBudgetRejection(message) {
  return /max_tokens|maximum context|context length|too large|reduce/i.test(String(message || ""));
}
