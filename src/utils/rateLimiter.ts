/**
 * TokenBucketRateLimiter
 *
 * A simple, in-process token-bucket implementation for rate-limiting outbound
 * HTTP requests to the Horizon REST API and Soroban RPC endpoint.
 *
 * The bucket starts full (capacity = rps tokens). One token is consumed per
 * request. If no token is available the caller awaits a promise that resolves
 * as soon as the next token is issued (at 1 000 / rps ms intervals).
 *
 * Thread-safety note: Node.js is single-threaded, so no mutex is required.
 */

export class TokenBucketRateLimiter {
  /** Current number of available tokens (may be fractional during refill). */
  private tokens: number;

  /** Maximum tokens the bucket can hold (== target requests per second). */
  private readonly capacity: number;

  /** Milliseconds between each token being added back to the bucket. */
  private readonly refillIntervalMs: number;

  /** Timestamp of the last refill calculation (Date.now()). */
  private lastRefillAt: number;

  /**
   * @param requestsPerSecond  Target maximum requests per second.
   *                           Must be a positive integer.
   */
  constructor(requestsPerSecond: number) {
    if (requestsPerSecond <= 0) {
      throw new RangeError(`requestsPerSecond must be > 0; got ${requestsPerSecond}`);
    }

    this.capacity = requestsPerSecond;
    this.tokens = requestsPerSecond; // start full
    this.refillIntervalMs = 1_000 / requestsPerSecond;
    this.lastRefillAt = Date.now();
  }

  /**
   * Consume one token, waiting if necessary until a token is available.
   *
   * Usage:
   * ```ts
   * await rateLimiter.throttle();
   * const response = await fetch(url);
   * ```
   */
  async throttle(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // No token available — wait until the next one is issued.
    const waitMs = this.refillIntervalMs * (1 - this.tokens);
    await sleep(waitMs);

    // Refill again after the wait and then consume.
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /**
   * Returns the number of tokens currently available (for observability /
   * tests).
   */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Resets the bucket to full capacity (useful in tests). */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Add tokens proportional to the elapsed time since the last refill.
   * Tokens are capped at the bucket capacity.
   */
  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;

    if (elapsedMs > 0) {
      const newTokens = elapsedMs / this.refillIntervalMs;
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefillAt = now;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
