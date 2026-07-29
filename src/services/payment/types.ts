/**
 * @notice Adapter-pattern payment provider abstraction for the pledge
 * worker (see issue #171). The worker never talks to a payment SDK
 * directly — it only depends on this interface, so providers are freely
 * swappable via PAYMENT_PROVIDER and mockable in tests.
 */

export interface ChargeOptions {
  /**
   * Stable key derived from (pledgeId, billingCycleDate) — NOT Date.now().
   * Passed through to the underlying provider's own idempotency mechanism
   * (e.g. Stripe's `idempotencyKey`) so that re-sending the same charge
   * request after a crash/retry does not create a second real-world charge.
   */
  idempotencyKey: string;
  amount: number;
  currency: string;
  donorId: string;
  campaignId: string;
  pledgeId: string;
  /** Optional provider-specific routing info (e.g. a saved Stripe payment method). */
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChargeResult {
  /** The value written to PledgeAttempt.providerReference / Donation.blockchainTxHash. */
  providerReference: string;
  provider: 'stripe' | 'stellar' | 'mock';
  raw?: unknown;
}

/**
 * @notice Thrown by providers on a failed charge. `retryable` lets the
 * worker distinguish transient failures (network blip, card declined —
 * eligible for backoff retry) from ones that never will succeed, though
 * the current worker treats all failures as retryable up to MAX_RETRIES.
 */
export class PaymentError extends Error {
  constructor(message: string, public readonly retryable: boolean = true) {
    super(message);
    this.name = 'PaymentError';
  }
}

export interface PaymentProvider {
  readonly name: 'stripe' | 'stellar' | 'mock';
  charge(options: ChargeOptions): Promise<ChargeResult>;
}
