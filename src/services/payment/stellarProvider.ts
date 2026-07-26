import { Keypair, TransactionBuilder, Operation, Asset, Server, BASE_FEE, Memo } from 'soroban-client';
import { PaymentProvider, ChargeOptions, ChargeResult, PaymentError } from './types';
import logger from '../../config/logger';

/**
 * @notice Direct-XLM payment provider for the campaign's Soroban escrow
 * wallet, per the issue's "escrow model" hint: a payment operation is
 * submitted from the escrow wallet to itself, and the resulting txHash
 * becomes the providerReference / Donation.blockchainTxHash. The caller
 * (pledge worker) is responsible for feeding that hash to
 * sorobanIndexer.indexTransaction — this provider does not bypass the
 * indexer.
 *
 * IMPORTANT — idempotency caveat: unlike Stripe, the Stellar network has no
 * native concept of an idempotency key; submitting a payment operation
 * twice submits two real transactions. The memo carries our idempotencyKey
 * for auditability, but it does NOT prevent a double-charge on its own.
 * Double-charge protection for this path comes from the pledge worker's own
 * durable state (the PledgeAttempt SUCCESS-row check before charge() is
 * ever called) — see pledge.worker.ts. Do not rely on this provider alone
 * for idempotency.
 */
export class StellarProvider implements PaymentProvider {
  readonly name = 'stellar' as const;
  private server: Server;
  private escrowKeypair: Keypair;
  private networkPassphrase: string;

  constructor(escrowSecretKey: string, networkUrl: string, networkPassphrase: string) {
    this.server = new Server(networkUrl);
    this.escrowKeypair = Keypair.fromSecret(escrowSecretKey);
    this.networkPassphrase = networkPassphrase;
  }

  async charge(options: ChargeOptions): Promise<ChargeResult> {
    try {
      const account = await this.server.getAccount(this.escrowKeypair.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: this.escrowKeypair.publicKey(),
            asset: Asset.native(),
            amount: options.amount.toFixed(7),
          }),
        )
        .addMemo(Memo.text(options.idempotencyKey.slice(0, 28)))
        .setTimeout(30)
        .build();

      tx.sign(this.escrowKeypair);

      const result: any = await this.server.sendTransaction(tx);

      if (result.status === 'ERROR' || result.status === 'FAILED') {
        throw new PaymentError(
          `Stellar transaction failed (status: ${result.status}): ${JSON.stringify(result.errorResult ?? '')}`,
          true,
        );
      }

      return { providerReference: result.hash, provider: 'stellar', raw: result };
    } catch (error: any) {
      if (error instanceof PaymentError) throw error;
      logger.error('Stellar charge failed', { pledgeId: options.pledgeId, error: error.message });
      throw new PaymentError(error.message ?? 'Stellar charge failed', true);
    }
  }
}
