/**
 * Anonymity helpers for the donation system.
 *
 * Centralises all decisions about when to hide / strip donor identity so the
 * rules are applied consistently across services, controllers, webhooks, and
 * analytics.
 */

export const ANONYMOUS_DONOR = {
  id: null as null,
  username: 'Anonymous',
  email: null as null,
} as const;

export type DonorView = typeof ANONYMOUS_DONOR | { id: string; username: string | null; email: string };

/**
 * Returns true when the requesting user is allowed to see real donor identity.
 *
 * Admins and the donor themselves can always see it.
 * For all others the `isAnonymous` flag controls visibility.
 */
export function canViewDonorIdentity(
  donation: { isAnonymous: boolean; userId?: string | null },
  requestingUserId?: string,
  requestingUserRole?: string,
): boolean {
  if (requestingUserRole === 'ADMIN') return true;
  if (requestingUserId && requestingUserId === donation.userId) return true;
  return !donation.isAnonymous;
}

/**
 * Replaces donor identity on a donation object when the requester is not
 * allowed to see it. Returns a new object; does not mutate the original.
 */
export function sanitizeDonorIdentity<T extends { isAnonymous: boolean; userId?: string | null; user?: any }>(
  donation: T,
  requestingUserId?: string,
  requestingUserRole?: string,
): T {
  if (canViewDonorIdentity(donation, requestingUserId, requestingUserRole)) {
    return donation;
  }
  return { ...donation, user: ANONYMOUS_DONOR };
}

/**
 * Strips PII fields that must not be stored for anonymous donations.
 * Call this before persisting the donation record.
 */
export function sanitizeAnonymousInput<T extends Record<string, any>>(data: T): T {
  if (!data.isAnonymous) return data;
  const { donorName: _dn, donorEmail: _de, message: _msg, ...rest } = data;
  return rest as T;
}

/**
 * Strips donor PII from an outbound payload (e.g. webhooks, analytics).
 * Returns a new object with PII fields removed or replaced.
 */
export function stripDonorPII<T extends Record<string, any>>(payload: T): Omit<T, 'donorName' | 'donorEmail' | 'userId' | 'user'> & { user?: typeof ANONYMOUS_DONOR } {
  const { donorName: _dn, donorEmail: _de, userId: _uid, user: _u, ...rest } = payload;
  return { ...rest, user: ANONYMOUS_DONOR };
}
