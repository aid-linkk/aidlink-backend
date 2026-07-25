import Stripe from 'stripe';
import { PaymentProvider, ChargeOptions, ChargeResult, PaymentError } from './types';
import logger from '../../config/logger';

/**
 * @notice Fiat on-ramp payment provider using Stripe's Payment Intents API.
 * Idempotency is delegated to Stripe: passing the same `idempotencyKey`
 * twice returns the original PaymentIntent instead of creating a new charge
 * (https://stripe.com/docs/api/idempotent_requests), which is what makes
 * this safe to retry after a crash.
 *
 * Scope note: this is the "minimum acceptable integration shape" called for
 * by issue #171 — the charge API path only. Full webhook-based confirmation,
 * SCA/3DS handling, and donor payment-method management are out of scope
 * and are expected to be wired in separately; `stripeCustomerId` /
 * `stripePaymentMethodId` on ChargeOptions are the seam for that future work.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  }

  async charge(options: ChargeOptions): Promise<ChargeResult> {
    if (!options.stripeCustomerId || !options.stripePaymentMethodId) {
      throw new PaymentError(
        'Pledge has no saved Stripe customer/payment method on file; cannot charge off-session',
        false,
      );
    }

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: Math.round(options.amount * 100),
          currency: options.currency.toLowerCase(),
          customer: options.stripeCustomerId,
          payment_method: options.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: {
            pledgeId: options.pledgeId,
            donorId: options.donorId,
            campaignId: options.campaignId,
          },
        },
        { idempotencyKey: options.idempotencyKey },
      );

      if (intent.status !== 'succeeded') {
        throw new PaymentError(
          `Stripe payment intent ${intent.id} did not succeed (status: ${intent.status})`,
          true,
        );
      }

      return { providerReference: intent.id, provider: 'stripe', raw: intent };
    } catch (error: any) {
      if (error instanceof PaymentError) throw error;
      logger.error('Stripe charge failed', { pledgeId: options.pledgeId, error: error.message });
      // Stripe card errors are declines and not worth infinite retry, but the
      // worker's existing MAX_RETRIES + dead-letter path already bounds
      // retries, so we mark everything retryable here and let that path work.
      throw new PaymentError(error.message ?? 'Stripe charge failed', true);
    }
  }
}
