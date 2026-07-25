/**
 * Deterministic construction of the message a wallet owner must sign to
 * authenticate, per issue #170 ("Implement Ed25519 Stellar signature
 * verification in walletAuth").
 *
 * The message embeds three things that together prevent the attacks called
 * out in the issue:
 *   - `nonce`     — a fresh random value per challenge, consumed on first
 *                   use, so a captured signature can't be replayed later
 *                   (issue: "replay attack using a previously captured
 *                   signature").
 *   - `domain`    — binds the signature to this specific service, so a
 *                   signature obtained by a different site can't be
 *                   replayed here (issue: "signature produced for one
 *                   service can be replayed on AidLink").
 *   - `issuedAt`  — recorded alongside the nonce; combined with the Redis
 *                   TTL on the stored challenge, this bounds how long a
 *                   challenge stays valid (5 minutes per the issue).
 *
 * Kept pure and dependency-free (no Redis/Prisma) so it's cheap to unit
 * test and so the exact signed string can never drift between the
 * challenge-issuing code path and the verification code path — both call
 * this same function.
 */
export interface WalletChallengePayload {
  nonce: string;
  domain: string;
  issuedAt: string; // ISO 8601
}

export function buildWalletChallengeMessage(
  walletAddress: string,
  payload: WalletChallengePayload
): string {
  return [
    'AidLink wallet authentication',
    `domain: ${payload.domain}`,
    `address: ${walletAddress}`,
    `nonce: ${payload.nonce}`,
    `issuedAt: ${payload.issuedAt}`,
  ].join('\n');
}

/** Structural check only (format/checksum). Not a substitute for
 * `Keypair.fromPublicKey`, which does full cryptographic validation — this
 * is just a cheap pre-filter so obviously malformed input is rejected with
 * a clear 400 before touching Redis. */
export const STELLAR_PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
