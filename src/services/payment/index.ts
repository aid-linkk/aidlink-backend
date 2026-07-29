import { PaymentProvider } from './types';
import { MockPaymentProvider } from './mockProvider';
import { StripeProvider } from './stripeProvider';
import { StellarProvider } from './stellarProvider';
import { config } from '../../config';

let cachedProvider: PaymentProvider | null = null;

/**
 * @notice Returns the configured PaymentProvider singleton, selected via the
 * PAYMENT_PROVIDER env var (`stripe` | `stellar` | `mock`, default `mock`).
 * `mock` should only ever be used outside of production.
 */
export function getPaymentProvider(): PaymentProvider {
  if (cachedProvider) return cachedProvider;

  const providerName = (process.env.PAYMENT_PROVIDER ?? 'mock').toLowerCase();

  switch (providerName) {
    case 'stripe': {
      const secretKey = process.env.STRIPE_SECRET_KEY;
      if (!secretKey) {
        throw new Error('STRIPE_SECRET_KEY is required when PAYMENT_PROVIDER=stripe');
      }
      cachedProvider = new StripeProvider(secretKey);
      break;
    }
    case 'stellar': {
      const secretKey = process.env.STELLAR_ESCROW_SECRET_KEY;
      if (!secretKey) {
        throw new Error('STELLAR_ESCROW_SECRET_KEY is required when PAYMENT_PROVIDER=stellar');
      }
      cachedProvider = new StellarProvider(secretKey, config.soroban.networkUrl, config.soroban.networkPassphrase);
      break;
    }
    case 'mock':
      cachedProvider = new MockPaymentProvider();
      break;
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: "${providerName}" (expected stripe | stellar | mock)`);
  }

  return cachedProvider;
}

/** Test-only: clears the cached singleton so each test can install its own provider. */
export function __resetPaymentProviderForTests(): void {
  cachedProvider = null;
}

export * from './types';
