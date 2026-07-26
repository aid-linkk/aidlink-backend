import { PaymentProvider, ChargeOptions, ChargeResult } from './types';

/**
 * @notice Deterministic, idempotent in-memory provider. Mirrors how a real
 * provider (Stripe) behaves when the same idempotencyKey is sent twice: the
 * second call returns the first call's result instead of creating a new
 * charge. `distinctChargeCount` tracks how many *real* charges were made
 * (the property that must never exceed 1 per billing cycle); `callCount`
 * tracks raw invocations, which may legitimately be >1 across a
 * crash-and-retry scenario without indicating a double-charge.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  private charges = new Map<string, ChargeResult>();
  callCount = 0;
  distinctChargeCount = 0;

  /** Optional hook for tests to simulate a provider-side failure. */
  public failNext = false;
  public failNextError = 'Mock provider: simulated payment failure';

  async charge(options: ChargeOptions): Promise<ChargeResult> {
    this.callCount += 1;

    const existing = this.charges.get(options.idempotencyKey);
    if (existing) {
      return existing;
    }

    if (this.failNext) {
      this.failNext = false;
      throw new Error(this.failNextError);
    }

    this.distinctChargeCount += 1;
    const result: ChargeResult = {
      providerReference: options.idempotencyKey,
      provider: 'mock',
    };
    this.charges.set(options.idempotencyKey, result);
    return result;
  }

  reset(): void {
    this.charges.clear();
    this.callCount = 0;
    this.distinctChargeCount = 0;
    this.failNext = false;
  }
}
